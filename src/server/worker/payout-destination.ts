import { randomUUID } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Scope } from "@/server/auth/access";
import { auditActor } from "@/server/auth/audit-actor";
import { newToken, tokenHash } from "@/server/auth/identity";
import type { Database, DatabaseSession } from "@/server/db/client";
import { auditEvents, payoutDestinationChanges, users, workPayouts, workers } from "@/server/db/schema";
import { UserFacingError } from "@/server/domain/errors";
import { notify } from "@/server/notifications/service";

// A change of PayPal email (design, 10 Nov 2026, worker Profile): the worker re-confirms with their
// password and the address typed twice, then FairShift emails a link to the NEW address. Until that link
// is used, FairShift sends no new payout to the worker (payouts paused), so money never goes to an
// address nobody has shown they own. A payout already reserved keeps the address it was reserved with.
// The token travels only in the link's fragment (never stored, logged or sent as a request URL).
const LINK_HOURS = 24;
const maskEmail = (value: string) => { const [name, domain] = value.split("@"); return `${name.slice(0, 1)}•••@${domain}`; };

export async function payoutsPaused(db: DatabaseSession, workerId: string, now = new Date()) {
  const [row] = await db.select({ id: payoutDestinationChanges.id }).from(payoutDestinationChanges)
    .where(and(eq(payoutDestinationChanges.workerId, workerId), isNull(payoutDestinationChanges.confirmedAt), isNull(payoutDestinationChanges.cancelledAt), gt(payoutDestinationChanges.expiresAt, now))).limit(1);
  return !!row;
}

export async function pendingPayoutChange(db: DatabaseSession, workerId: string, now = new Date()) {
  const [row] = await db.select({ id: payoutDestinationChanges.id, newEmail: payoutDestinationChanges.newEmail, expiresAt: payoutDestinationChanges.expiresAt }).from(payoutDestinationChanges)
    .where(and(eq(payoutDestinationChanges.workerId, workerId), isNull(payoutDestinationChanges.confirmedAt), isNull(payoutDestinationChanges.cancelledAt), gt(payoutDestinationChanges.expiresAt, now))).limit(1);
  return row ? { ...row, newEmail: maskEmail(row.newEmail) } : null;
}

// Called once the password and repeated address are accepted. Replaces any earlier unconfirmed change.
export async function requestPayoutChange(db: Database, scope: Scope, worker: { id: string; email: string }, next: string, now = new Date()) {
  const token = newToken();
  const notificationId = await db.transaction(async tx => {
    await tx.update(payoutDestinationChanges).set({ cancelledAt: now }).where(and(eq(payoutDestinationChanges.workerId, worker.id), isNull(payoutDestinationChanges.confirmedAt), isNull(payoutDestinationChanges.cancelledAt)));
    const [change] = await tx.insert(payoutDestinationChanges).values({ id: randomUUID(), organisationId: scope.organisationId, workerId: worker.id, userId: scope.userId, newEmail: next, tokenHash: tokenHash(token), expiresAt: new Date(now.getTime() + LINK_HOURS * 3_600_000) }).returning();
    await tx.insert(auditEvents).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: scope.locationId, action: "PAYOUT_DESTINATION_CHANGE_REQUESTED", entityType: "worker", entityId: worker.id,
      correlationId: `payout-destination:${worker.id}:${change.id}`, metadata: { ...auditActor(scope), previous: maskEmail(worker.email), next: maskEmail(next), reconfirmed: "PASSWORD_AND_REPEATED_ADDRESS", payoutsPaused: true } });
    // The link goes to the new address; the in-app notice to the worker says where it went.
    const notice = await notify(tx, { id: randomUUID(), organisationId: scope.organisationId, userId: null, workerId: null, recipientEmail: next, eventKey: `payout-change:${change.id}`, kind: "PAYOUT_EMAIL_CONFIRM",
      entityId: change.id, title: "Confirm your new PayPal email for FairShift", body: `Use this link within ${LINK_HOURS} hours to confirm this address for your FairShift pay. Until you do, FairShift won't send new payouts. If you didn't ask for this, ignore this email and tell your manager.`,
      href: "/payout-email/confirm" });
    return notice!.id;
  });
  // The caller sends the email at once with secureLink: the fragment link is never stored.
  return { pendingUntil: new Date(now.getTime() + LINK_HOURS * 3_600_000), notificationId, secureLink: `/payout-email/confirm#${token}` };
}

// The link's page posts the token here. A used, cancelled or expired link changes nothing.
export async function confirmPayoutChange(db: Database, token: string, now = new Date()) {
  return db.transaction(async tx => {
    const [change] = await tx.select().from(payoutDestinationChanges).where(eq(payoutDestinationChanges.tokenHash, tokenHash(token))).for("update");
    if (!change || change.confirmedAt || change.cancelledAt || change.expiresAt <= now) throw new UserFacingError("payout-link-invalid", "This link has expired or was already used. Ask for a new one from your Profile.");
    const [worker] = await tx.select({ id: workers.id, email: workers.paypalPayoutEmail, outletId: workers.locationId, userId: workers.userId }).from(workers).where(eq(workers.id, change.workerId));
    if (!worker || worker.userId !== change.userId) throw new UserFacingError("payout-link-invalid", "This link has expired or was already used. Ask for a new one from your Profile.");
    await tx.update(workers).set({ paypalPayoutEmail: change.newEmail, updatedAt: now }).where(eq(workers.id, worker.id));
    await tx.update(payoutDestinationChanges).set({ confirmedAt: now }).where(eq(payoutDestinationChanges.id, change.id));
    const [{ reserved }] = await tx.select({ reserved: sql<number>`count(*)::int` }).from(workPayouts)
      .where(and(eq(workPayouts.workerId, worker.id), sql`${workPayouts.status} in ('SUBMITTING', 'NOT_SENT', 'PROCESSING', 'RECONCILIATION_REQUIRED')`));
    const [user] = await tx.select({ email: users.email }).from(users).where(eq(users.id, change.userId));
    await tx.insert(auditEvents).values({ id: randomUUID(), organisationId: change.organisationId, outletId: worker.outletId, action: "PAYOUT_DESTINATION_CHANGED", entityType: "worker", entityId: worker.id,
      correlationId: `payout-destination:${worker.id}:${change.id}`, metadata: { actorUserId: change.userId, previous: worker.email ? maskEmail(worker.email) : null, next: maskEmail(change.newEmail), reconfirmed: "PASSWORD_REPEATED_ADDRESS_AND_EMAIL_LINK", reservedPayoutsUnchanged: reserved, signInEmail: user ? maskEmail(user.email) : null } });
    return { workerId: worker.id };
  });
}

// The worker can cancel a change they didn't mean; payouts resume to the confirmed address.
export async function cancelPayoutChange(db: Database, scope: Scope) {
  if (!scope.workerId) throw new Error("Access denied.");
  const now = new Date();
  const rows = await db.update(payoutDestinationChanges).set({ cancelledAt: now }).where(and(eq(payoutDestinationChanges.workerId, scope.workerId), eq(payoutDestinationChanges.userId, scope.userId), isNull(payoutDestinationChanges.confirmedAt), isNull(payoutDestinationChanges.cancelledAt))).returning();
  if (rows.length) await db.insert(auditEvents).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: scope.locationId, action: "PAYOUT_DESTINATION_CHANGE_CANCELLED", entityType: "worker", entityId: scope.workerId, correlationId: `payout-destination:${scope.workerId}:${rows[0].id}`, metadata: { ...auditActor(scope) } });
  return rows.length > 0;
}

export class PayoutsPausedError extends UserFacingError {
  constructor() { super("payouts-paused", "This person changed their PayPal email and hasn't confirmed it yet, so payouts are paused until they do."); }
}
