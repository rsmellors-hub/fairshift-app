import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";

import { AccessError, type Scope } from "@/server/auth/access";
import { consumeLimit, newToken, tokenHash } from "@/server/auth/identity";
import type { Database, DatabaseSession } from "@/server/db/client";
import { auditEvents, organisations, outlets, staffDestinationEvents, staffStatementLinks, tipAllocationLines, tipAllocations, tipHoldDecisions, tipHolds, tipLocationSettings, workers, workPayouts } from "@/server/db/schema";
import { UserFacingError } from "@/server/domain/errors";
import { formatMinute } from "./policy";
import { assertTipOwner } from "./service";

// A permanent staff member's read-only tip statement (FS-TIP-AGENT-DEC-001; DEC-SA-008: no login,
// no fourth role). Access is a random 32-byte token sent as the URL fragment, so it never reaches
// server request logs or analytics; only its SHA-256 is stored, bound to one organisation,
// location and staff record, with an explicit expiry. Every failure looks the same, so a link
// reveals nothing about who or what exists. The statement shows only the person's own lines.

export const STATEMENT_LINK_TTL_MS = 72 * 60 * 60_000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

// Delivery isn't connected (no email provider call in this build). Outside production, and only
// with FAIRSHIFT_DEV_STATEMENT_LINKS=enabled, the Owner can open a freshly created link locally.
// In a production build this is impossible whatever the flag says.
export function devStatementLinksEnabled(env: Record<string, string | undefined> = process.env) {
  return env.NODE_ENV !== "production" && env.FAIRSHIFT_DEV_STATEMENT_LINKS === "enabled";
}

export async function createStatementLink(db: Database, scope: Pick<Scope, "userId" | "organisationId" | "locationId" | "role" | "demo">, workerId: string, now = new Date(), env: Record<string, string | undefined> = process.env) {
  assertTipOwner(scope);
  if (!devStatementLinksEnabled(env)) throw new UserFacingError("statement-delivery-unavailable", "Statement links can't be delivered from this environment yet.");
  if (!z.uuid().safeParse(workerId).success) throw new AccessError();
  const [worker] = await db.select({ id: workers.id }).from(workers).where(and(eq(workers.id, workerId), eq(workers.organisationId, scope.organisationId), eq(workers.locationId, scope.locationId), eq(workers.workerType, "REGULAR")));
  if (!worker) throw new AccessError();
  const token = newToken();
  const [link] = await db.insert(staffStatementLinks).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: scope.locationId, workerId, tokenHash: tokenHash(token),
    expiresAt: new Date(now.getTime() + STATEMENT_LINK_TTL_MS), createdBy: scope.userId, createdAt: now }).returning();
  await db.insert(auditEvents).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: scope.locationId, action: "STATEMENT_LINK_CREATED", entityType: "staff_statement_link", entityId: link.id,
    correlationId: `worker:${workerId}`, metadata: { actorUserId: scope.userId, expiresAt: link.expiresAt.toISOString(), delivery: "DEVELOPMENT_ONLY" } });
  return { path: `/staff/statement#${token}`, expiresAt: link.expiresAt };
}

async function resolveLink(db: DatabaseSession, token: unknown, now: Date) {
  if (typeof token !== "string" || !TOKEN.test(token)) return null;
  const [row] = await db.select({ link: staffStatementLinks, worker: workers }).from(staffStatementLinks)
    .innerJoin(workers, and(eq(workers.id, staffStatementLinks.workerId), eq(workers.organisationId, staffStatementLinks.organisationId), eq(workers.locationId, staffStatementLinks.outletId)))
    .where(and(eq(staffStatementLinks.tokenHash, tokenHash(token)), gt(staffStatementLinks.expiresAt, now), isNull(staffStatementLinks.revokedAt), eq(workers.workerType, "REGULAR")));
  return row ?? null;
}

const mask = (email: string | null) => {
  if (!email) return null;
  const [name, domain] = email.split("@");
  return `${name.slice(0, 1)}•••@${domain}`;
};

export type StatementStatus = "recorded" | "under review" | "released" | "paid";
const REASON_TEXT: Record<string, string> = {
  UNATTRIBUTED_TIPS: "Some tips weren't linked to a staff member", INACTIVE_STAFF_ATTRIBUTION: "Tips were linked to someone who isn't active",
  TIP_OUTLIER: "A tip looked unusual for its bill", RECONCILIATION_GAP: "The totals needed checking", DUPLICATE_ROWS: "Some rows looked like duplicates",
  ROSTER_MISMATCH: "The block members needed checking", AUTO_RELEASE_CAP_EXCEEDED: "Your share was above the daily automatic release limit",
  DESTINATION_RECENTLY_CHANGED: "Your PayPal account was changed in the last 24 hours",
};

// The staff member's own statement, or null for any invalid, expired, revoked or unknown link.
export async function readStatement(db: Database, token: unknown, now = new Date()) {
  await consumeLimit(db, "staff-statement-global", 600);
  const found = await resolveLink(db, token, now);
  if (!found) return null;
  const { link, worker } = found;
  const [place] = await db.select({ name: outlets.name, business: organisations.name, policy: tipLocationSettings.policy }).from(outlets).innerJoin(organisations, eq(organisations.id, outlets.organisationId))
    .leftJoin(tipLocationSettings, eq(tipLocationSettings.outletId, outlets.id)).where(eq(outlets.id, link.outletId));
  const lines = await db.select({ line: tipAllocationLines, allocation: tipAllocations, payoutStatus: workPayouts.status }).from(tipAllocationLines)
    .innerJoin(tipAllocations, eq(tipAllocations.id, tipAllocationLines.allocationId)).leftJoin(workPayouts, eq(workPayouts.tipLineId, tipAllocationLines.id))
    .where(and(eq(tipAllocationLines.workerId, worker.id), eq(tipAllocationLines.organisationId, link.organisationId))).orderBy(desc(tipAllocations.localDate), asc(tipAllocations.blockStartMinute));
  const allocationIds = lines.map(row => row.allocation.id);
  const holds = allocationIds.length ? await db.select().from(tipHolds).where(and(inArray(tipHolds.allocationId, allocationIds), or(isNull(tipHolds.lineId), inArray(tipHolds.lineId, lines.map(row => row.line.id))))).orderBy(asc(tipHolds.createdAt)) : [];
  const decisions = holds.length ? await db.select().from(tipHoldDecisions).where(inArray(tipHoldDecisions.holdId, holds.map(hold => hold.id))).orderBy(asc(tipHoldDecisions.decidedAt)) : [];
  const released = new Set(decisions.filter(row => row.decision === "RELEASED").map(row => row.holdId));
  const statusOf = (row: (typeof lines)[number]): StatementStatus => {
    if (row.payoutStatus === "PAID") return "paid";
    if (row.payoutStatus && row.payoutStatus !== "FAILED") return "released";
    const open = holds.some(hold => !released.has(hold.id) && hold.allocationId === row.allocation.id && (hold.lineId === null || hold.lineId === row.line.id));
    return open || row.payoutStatus === "FAILED" ? "under review" : "recorded";
  };
  const [destination] = await db.select({ kind: staffDestinationEvents.kind, at: staffDestinationEvents.createdAt }).from(staffDestinationEvents).where(eq(staffDestinationEvents.workerId, worker.id)).orderBy(desc(staffDestinationEvents.createdAt)).limit(1);
  return {
    firstName: worker.firstName ?? worker.displayName.split(" ")[0], location: place?.name ?? "", business: place?.business ?? "",
    policy: place?.policy === "SHIFT_POOL" ? "Tips are pooled by shift block: each block's tips are split equally between everyone who worked it, to the cent."
      : "Each tip goes in full to the staff member named on the point-of-sale row.",
    credits: lines.map(row => ({ date: row.allocation.localDate, block: row.allocation.blockName ? `${row.allocation.blockName} ${formatMinute(row.allocation.blockStartMinute!)}–${formatMinute(row.allocation.blockEndMinute!)}` : "Whole day",
      shareMinor: row.line.shareMinor, currencyCode: row.line.currencyCode, status: statusOf(row) })),
    holds: holds.map(hold => ({ at: hold.createdAt, reason: REASON_TEXT[hold.reasonCode] ?? "A check was needed",
      decisions: decisions.filter(row => row.holdId === hold.id).map(row => ({ at: row.decidedAt, outcome: row.decision === "RELEASED" ? "Released by the owner" : "Kept on hold by the owner", reason: row.reason })) })),
    destination: { masked: mask(worker.paypalPayoutEmail), confirmed: destination?.kind === "CONFIRMED" || destination?.kind === "CHANGED", changeAvailable: !link.destinationUsedAt },
    expiresAt: link.expiresAt,
  };
}

// One-time destination confirmation or change through this link. A change needs a fresh link next
// time, is journaled, and a payout to a destination changed in the last 24 hours needs the Owner.
export async function updateStatementDestination(db: Database, token: unknown, input: { action: "CONFIRM" | "CHANGE"; email?: string }, now = new Date()) {
  await consumeLimit(db, "staff-statement-global", 600);
  const email = input.action === "CHANGE" ? z.string().trim().toLowerCase().email().max(254).safeParse(input.email ?? "") : null;
  if (email && !email.success) throw new UserFacingError("statement-destination-invalid", "Enter a valid PayPal email address.");
  return db.transaction(async tx => {
    const found = await resolveLink(tx, token, now);
    if (!found) throw new UserFacingError("statement-unavailable", "This link has expired or isn't valid.");
    // Single use: only one destination action per link, even under concurrent submissions.
    const [used] = await tx.update(staffStatementLinks).set({ destinationUsedAt: now })
      .where(and(eq(staffStatementLinks.id, found.link.id), isNull(staffStatementLinks.destinationUsedAt))).returning();
    if (!used) throw new UserFacingError("statement-link-used", "This link has already been used to confirm a PayPal account. Ask for a new link to change it.");
    if (email?.success) await tx.update(workers).set({ paypalPayoutEmail: email.data, updatedAt: now }).where(eq(workers.id, found.worker.id));
    const kind = email?.success ? "CHANGED" : "CONFIRMED";
    await tx.insert(staffDestinationEvents).values({ id: randomUUID(), organisationId: found.link.organisationId, workerId: found.worker.id, linkId: found.link.id, kind, createdAt: now });
    await tx.insert(auditEvents).values({ id: randomUUID(), organisationId: found.link.organisationId, outletId: found.link.outletId, action: `STAFF_DESTINATION_${kind}`, entityType: "worker", entityId: found.worker.id,
      correlationId: `worker:${found.worker.id}`, metadata: { linkId: found.link.id } });
    return { kind };
  });
}
