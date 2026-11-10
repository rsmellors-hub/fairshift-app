import { requestPayoutChange } from "@/server/worker/payout-destination";
import { passOnAfterDecline } from "@/server/scheduling/shift-suggestions";
import { requireEntitlement } from "@/server/billing/entitlement";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@/server/db/client";
import { randomUUID } from "node:crypto";
import { auditEvents, outlets, shiftOffers, shifts, users, workPayouts, workerAvailability, workers } from "@/server/db/schema";
import { workerLocationIds } from "@/server/people/worker-locations";
import { checkPassword, consumeLimit } from "./identity";
import { auditActor } from "./audit-actor";
import { UserFacingError } from "@/server/domain/errors";
import { assertRole, type Scope } from "./access";
import { respondToAssignment } from "@/server/scheduling/operations";
import { getWorkerWorkspace } from "@/server/product/workspace";
import { getWorkerTargets } from "@/server/performance/attribution";
export async function workerWorkspace(db:Database,scope:Scope) {
  assertRole(scope,["TEAM_MEMBER"]);
  await requireEntitlement(db,scope.organisationId);
  await workerIdentity(db,scope);
  const workspace = await getWorkerWorkspace(db,scope);
  return { ...workspace, targets: await getWorkerTargets(db,{ organisationId: scope.organisationId, locationId: scope.locationId, workerId: scope.workerId! }) };
}
export async function workerRespond(db:Database,scope:Scope,offerId:string,version:number,response:"ACCEPTED"|"DECLINED",acknowledged:boolean) {
  assertRole(scope,["TEAM_MEMBER"]);
  await requireEntitlement(db,scope.organisationId);
  await workerIdentity(db,scope);
  // A worker cannot take on work that has already finished. Repeating an earlier acceptance stays harmless.
  if(response==="ACCEPTED") {
    const [open]=await db.select({endsAt:shifts.endsAt}).from(shiftOffers).innerJoin(shifts,eq(shifts.id,shiftOffers.shiftId)).where(and(eq(shiftOffers.id,offerId),eq(shiftOffers.workerId,scope.workerId!),eq(shiftOffers.status,"OFFERED")));
    if(open&&open.endsAt<=new Date()) throw new UserFacingError("shift-ended","This shift has already finished.");
  }
  // The offer's own location decides the response (a worker may belong to several, Owner decision
  // 10 Nov 2026); it must be one of the worker's locations in this business.
  const [target]=await db.select({outletId:shifts.outletId}).from(shiftOffers).innerJoin(shifts,eq(shifts.id,shiftOffers.shiftId)).innerJoin(outlets,eq(outlets.id,shifts.outletId))
    .where(and(eq(shiftOffers.id,offerId),eq(shiftOffers.workerId,scope.workerId!),eq(outlets.organisationId,scope.organisationId)));
  if(!target || !(await workerLocationIds(db,scope.workerId!)).includes(target.outletId)) throw new Error("Offer unavailable.");
  const result=await respondToAssignment(db,scope.workerId!,offerId,version,response,acknowledged,{organisationId:scope.organisationId,locationId:target.outletId});
  // A decline passes the shift to the next people (round 2) once round 1 has no one left to answer.
  if(response==="DECLINED") await passOnAfterDecline(db,{organisationId:scope.organisationId,locationId:target.outletId},result.shiftId).catch(()=>undefined);
  return result;
}
// Day 6, Step 3b: the worker's PayPal payout destination. Adding the first one needs the address typed
// twice; changing an existing one also needs the worker's current password (rate-limited). Every save
// is audited with masked addresses, never the full ones. A payout already reserved keeps the address it
// was reserved with: resending an unsent payout reuses it (work-payouts.ts), so a change affects only
// payouts reserved afterwards.
const payoutEmailSchema = z.string().trim().email().max(254);
const maskEmail = (value: string) => { const [name, domain] = value.split("@"); return `${name.slice(0, 1)}•••@${domain}`; };
const sameEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

async function payoutWorker(db: Database, scope: Scope) {
  assertRole(scope,["TEAM_MEMBER"]);
  await requireEntitlement(db,scope.organisationId);
  if (!scope.workerId) throw new Error("Access denied.");
  const [row] = await db.select({ id: workers.id, email: workers.paypalPayoutEmail }).from(workers)
    .where(and(eq(workers.id,scope.workerId),eq(workers.userId,scope.userId),eq(workers.organisationId,scope.organisationId),eq(workers.locationId,scope.locationId)));
  if (!row) throw new Error("Access denied.");
  return row;
}

async function writePayoutDestination(db: Database, scope: Scope, previous: string | null, next: string) {
  return db.transaction(async tx => {
    const [row] = await tx.update(workers).set({ paypalPayoutEmail: next, updatedAt: new Date() })
      .where(and(eq(workers.id,scope.workerId!),eq(workers.userId,scope.userId),eq(workers.organisationId,scope.organisationId),eq(workers.locationId,scope.locationId))).returning();
    if (!row) throw new Error("Access denied.");
    // Reserved payouts not yet final keep their own recipient; they are counted, not changed.
    const [{ reserved }] = await tx.select({ reserved: sql<number>`count(*)::int` }).from(workPayouts)
      .where(and(eq(workPayouts.workerId, row.id), inArray(workPayouts.status, ["SUBMITTING", "NOT_SENT", "PROCESSING", "RECONCILIATION_REQUIRED"])));
    await tx.insert(auditEvents).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: scope.locationId, action: previous ? "PAYOUT_DESTINATION_CHANGED" : "PAYOUT_DESTINATION_ADDED",
      entityType: "worker", entityId: row.id, correlationId: `payout-destination:${row.id}:${Date.now()}`,
      metadata: { ...auditActor(scope), previous: previous ? maskEmail(previous) : null, next: maskEmail(next), reconfirmed: previous ? "PASSWORD_AND_REPEATED_ADDRESS" : "REPEATED_ADDRESS", reservedPayoutsUnchanged: reserved } });
    return row;
  });
}

// The first destination only: an existing one is changed through changePayoutDestination.
export async function savePayoutDestination(db:Database,scope:Scope,value:string) {
  const current = await payoutWorker(db, scope);
  if (current.email) throw new UserFacingError("payout-change-needs-confirmation", "Changing your PayPal email needs your password.");
  return writePayoutDestination(db, scope, null, payoutEmailSchema.parse(value));
}

export async function changePayoutDestination(db: Database, scope: Scope, input: { email: string; confirmEmail: string; password?: string }) {
  const current = await payoutWorker(db, scope);
  const parsed = payoutEmailSchema.safeParse(input.email);
  if (!parsed.success) throw new UserFacingError("payout-email-invalid", "Enter a valid PayPal email.");
  if (!sameEmail(input.email, input.confirmEmail)) throw new UserFacingError("payout-email-mismatch", "The two email addresses don't match.");
  if (!current.email) return writePayoutDestination(db, scope, null, parsed.data);
  if (sameEmail(current.email, parsed.data)) throw new UserFacingError("payout-email-unchanged", "That's already your PayPal email.");
  await consumeLimit(db, `payout-destination:${scope.userId}`, 5);
  const [user] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, scope.userId));
  if (!user || !input.password || !await checkPassword(input.password, user.passwordHash)) throw new UserFacingError("payout-password", "Your password wasn't accepted, so your PayPal email wasn't changed.");
  // Design, 10 Nov 2026: a change also needs the link sent to the new address; payouts pause until then.
  return { ...current, pending: await requestPayoutChange(db, scope, { id: current.id, email: current.email }, parsed.data) };
}

// A worker's own weekly availability, Monday..Sunday. Null clears a day to not provided.
// wantsMoreHours: the worker's own "I want more hours" preference (FS-OFFER-ORDER-DEC-001), no reason asked.
export async function saveWorkerAvailability(db:Database,scope:Scope,states:unknown,wantsMoreHours?:boolean) {
  assertRole(scope,["TEAM_MEMBER"]);
  await requireEntitlement(db,scope.organisationId);
  await workerIdentity(db,scope);
  const days=z.array(z.enum(["AVAILABLE","UNAVAILABLE"]).nullable()).length(7).parse(states);
  const workerId=scope.workerId!;
  return db.transaction(async tx=>{
    if (wantsMoreHours !== undefined) await tx.update(workers).set({wantsMoreHours,updatedAt:new Date()}).where(and(eq(workers.id,workerId),eq(workers.organisationId,scope.organisationId)));
    for (const [i,state] of days.entries()) {
      if (state === null) await tx.delete(workerAvailability).where(and(eq(workerAvailability.workerId,workerId),eq(workerAvailability.isoWeekday,i+1)));
      else await tx.insert(workerAvailability).values({id:randomUUID(),workerId,isoWeekday:i+1,state}).onConflictDoUpdate({target:[workerAvailability.workerId,workerAvailability.isoWeekday],set:{state,updatedAt:new Date()}});
    }
  });
}

async function workerIdentity(db:Database,scope:Scope) {
 if (!scope.workerId) throw new Error("Access denied.");
 const [worker]=await db.select({id:workers.id}).from(workers).where(and(eq(workers.id,scope.workerId),eq(workers.userId,scope.userId),eq(workers.organisationId,scope.organisationId),eq(workers.locationId,scope.locationId),eq(workers.status,"ACTIVE")));
 if (!worker) throw new Error("Access denied.");
}
