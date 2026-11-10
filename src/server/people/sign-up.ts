import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { auditActor } from "@/server/auth/audit-actor";
import { tokenHash } from "@/server/auth/identity";
import { redeemInvitation } from "@/server/auth/tenancy";
import type { Database, DatabaseSession } from "@/server/db/client";
import { auditEvents, organisations, outlets, teamInvitations, users, workerAvailability, workers } from "@/server/db/schema";
import { UserFacingError } from "@/server/domain/errors";

const maskEmail = (value: string) => { const [name, domain] = value.split("@"); return `${name.slice(0, 1)}•••@${domain}`; };

// An invited person completes sign-up themselves (Day 6, Owner decision 10 Nov 2026): signed in with the
// invited email (an account they set the password for), they confirm their name and contact details;
// a casual worker also gives their availability and the PayPal email they're paid at (typed twice,
// Step 3b). Only then is the invitation redeemed and the person active.

export type OpenInvitation = { id: string; role: "MANAGER" | "TEAM_MEMBER"; business: string; locations: string[]; firstName: string; surname: string; telephone: string; expiresAt: Date };

export async function openInvitation(db: DatabaseSession, user: { id: string; email: string }, token: string, now = new Date()): Promise<OpenInvitation> {
  z.string().min(20).max(200).parse(token);
  const [invitation] = await db.select().from(teamInvitations).where(eq(teamInvitations.token, tokenHash(token)));
  if (!invitation || !["CREATED_NOT_SENT", "SENT", "DELIVERY_FAILED"].includes(invitation.state) || invitation.expiresAt <= now || !invitation.organisationId)
    throw new UserFacingError("invitation-unavailable", "This invitation has expired, was already used, or was revoked. Ask the person who invited you to send a new one.");
  if (invitation.email !== user.email) throw new UserFacingError("invitation-email", "Sign in with the email address the invitation was sent to.");
  const [organisation] = await db.select({ name: organisations.name }).from(organisations).where(eq(organisations.id, invitation.organisationId));
  const batch = invitation.batchId
    ? await db.select({ outletId: teamInvitations.outletId }).from(teamInvitations).where(and(eq(teamInvitations.batchId, invitation.batchId), inArray(teamInvitations.state, ["CREATED_NOT_SENT", "SENT", "DELIVERY_FAILED"])))
    : [{ outletId: invitation.outletId }];
  const places = await db.select({ id: outlets.id, name: outlets.name }).from(outlets).where(inArray(outlets.id, batch.map(row => row.outletId!).filter(Boolean)));
  return { id: invitation.id, role: invitation.role as OpenInvitation["role"], business: organisation?.name ?? "", locations: places.map(row => row.name),
    firstName: invitation.firstName ?? "", surname: invitation.surname ?? "", telephone: invitation.telephone ?? "", expiresAt: invitation.expiresAt };
}

const details = z.object({
  firstName: z.string().trim().min(1).max(100), surname: z.string().trim().min(1).max(100),
  telephone: z.union([z.literal(""), z.string().trim().regex(/^\+?[0-9 ()-]{6,30}$/)]),
});
const workerDetails = details.extend({
  availability: z.array(z.enum(["AVAILABLE", "UNAVAILABLE"])).length(7),
  payoutEmail: z.string().trim().email().max(254), confirmPayoutEmail: z.string().trim().max(254),
});

export async function completeInvitedSignUp(db: Database, user: { id: string; email: string }, token: string, input: Record<string, unknown>) {
  const invitation = await openInvitation(db, user, token);
  // Everything is checked before the invitation is redeemed, so a mistake never leaves a half-made person.
  const parsed = (invitation.role === "TEAM_MEMBER" ? workerDetails : details).safeParse(input);
  if (!parsed.success) throw new UserFacingError("sign-up-details", invitation.role === "TEAM_MEMBER" ? "Check your name, phone, availability for every day and PayPal email." : "Check your name and phone number.");
  const value = parsed.data as z.infer<typeof workerDetails>;
  if (invitation.role === "TEAM_MEMBER" && value.payoutEmail.trim().toLowerCase() !== value.confirmPayoutEmail.trim().toLowerCase())
    throw new UserFacingError("payout-email-mismatch", "The two PayPal email addresses don't match.");
  // One transaction: the invitation is redeemed and the details saved together, or nothing changes.
  return db.transaction(async tx => {
    const membership = await redeemInvitation(tx as unknown as Database, user.id, { token });
    const telephone = value.telephone || null, now = new Date();
    await tx.update(users).set({ firstName: value.firstName, surname: value.surname, name: `${value.firstName} ${value.surname}`, telephone }).where(eq(users.id, user.id));
    const actor = { userId: user.id, role: membership.role };
    if (membership.workerId) {
      const email = value.payoutEmail.trim();
      await tx.update(workers).set({ firstName: value.firstName, surname: value.surname, displayName: `${value.firstName} ${value.surname}`, telephone, paypalPayoutEmail: email, updatedAt: now }).where(eq(workers.id, membership.workerId));
      for (const [i, state] of value.availability.entries())
        await tx.insert(workerAvailability).values({ id: randomUUID(), workerId: membership.workerId, isoWeekday: i + 1, state }).onConflictDoUpdate({ target: [workerAvailability.workerId, workerAvailability.isoWeekday], set: { state, updatedAt: now } });
      // The first PayPal email, typed twice (Step 3b), audited masked as any other save.
      await tx.insert(auditEvents).values({ id: randomUUID(), organisationId: membership.organisationId, outletId: membership.outletId, action: "PAYOUT_DESTINATION_ADDED", entityType: "worker", entityId: membership.workerId,
        correlationId: `payout-destination:${membership.workerId}:${now.getTime()}`, metadata: { ...auditActor(actor), previous: null, next: maskEmail(email), reconfirmed: "REPEATED_ADDRESS", reservedPayoutsUnchanged: 0 } });
    }
    await tx.insert(auditEvents).values({ id: randomUUID(), organisationId: membership.organisationId, outletId: membership.outletId, action: "PERSON_SIGNED_UP", entityType: membership.workerId ? "worker" : "manager",
      entityId: membership.workerId ?? user.id, correlationId: `sign-up:${membership.id}`, metadata: { ...auditActor(actor), role: membership.role, invitationId: invitation.id } });
    return membership;
  });
}
