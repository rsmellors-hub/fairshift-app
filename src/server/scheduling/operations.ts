import { tokenHash } from "@/server/auth/identity";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, lt, gt } from "drizzle-orm";
import { z } from "zod";
import type { Database, DatabaseSession } from "@/server/db/client";
import { departments, outlets, workers, teamInvitations, workPolicies, shifts, shiftOffers, workAcceptances, workAllocations, auditEvents, shiftIncentives } from "@/server/db/schema";
import { DEMO_ORGANISATION_ID, DEMO_OUTLET_ID } from "@/server/constants";
import { expectedWorkEarnings, policyInput } from "@/server/domain/work-terms";

import type { Scope } from "@/server/auth/access";

// Internal demo compatibility only; HTTP entrypoints always supply authenticated scope.
const demoScope = {organisationId:DEMO_ORGANISATION_ID,locationId:DEMO_OUTLET_ID};
type OperatingScope = Pick<Scope,"organisationId" | "locationId">;
async function location(db: DatabaseSession, scope:OperatingScope=demoScope) {
  const [row] = await db.select().from(outlets).where(and(eq(outlets.id, scope.locationId), eq(outlets.organisationId, scope.organisationId)));
  if (!row) throw new Error("Location unavailable.");
  return row;
}
const teamInput = z.object({ firstName: z.string().trim().min(1).max(100), surname: z.string().trim().min(1).max(100), telephone: z.string().trim().regex(/^\+?[0-9 ()-]{6,30}$/), email: z.string().trim().email().max(254) });
export async function createTeamMember(db: Database, input: unknown, scope:OperatingScope=demoScope) {
  const value = teamInput.parse(input);
  return db.transaction(async (tx) => {
    await location(tx, scope);
    const [worker] = await tx.insert(workers).values({ id: randomUUID(), organisationId: scope.organisationId, locationId: scope.locationId, ...value, displayName: `${value.firstName} ${value.surname}`, workerType: "CASUAL" }).returning();
    const [invitation] = await tx.insert(teamInvitations).values({ id: randomUUID(), workerId: worker.id, token: tokenHash(randomUUID()), state: "CREATED_NOT_SENT" }).returning();
    return { worker, invitation };
  });
}
export async function createDepartment(db: Database, name: string, scope:OperatingScope=demoScope) {
  await location(db, scope);
  return db.insert(departments).values({ id: randomUUID(), outletId: scope.locationId, name: z.string().trim().min(1).max(100).parse(name) }).returning();
}
export async function createWorkPolicy(db: Database, input: unknown, name: string, scope:OperatingScope=demoScope) {
  await location(db, scope);
  const terms = policyInput.parse(input);
  return db.insert(workPolicies).values({ id: randomUUID(), outletId: scope.locationId, name: z.string().trim().min(1).max(100).parse(name), ...terms }).returning();
}
export async function getOperations(db: DatabaseSession, scope:OperatingScope=demoScope) {
  await location(db, scope);
  const team = await db.select({ worker: workers, invitation: teamInvitations }).from(workers)
    .leftJoin(teamInvitations, eq(teamInvitations.workerId, workers.id))
    .where(and(eq(workers.organisationId, scope.organisationId), eq(workers.locationId, scope.locationId)));
  const departmentRows = await db.select().from(departments).where(eq(departments.outletId, scope.locationId));
  const policies = await db.select().from(workPolicies).where(eq(workPolicies.outletId, scope.locationId));
  const requirements = await db.select().from(shifts).where(eq(shifts.outletId, scope.locationId));
  const offers = await db.select({ offer: shiftOffers, workerName: workers.displayName, allocation: workAllocations })
    .from(shiftOffers).innerJoin(shifts, eq(shifts.id, shiftOffers.shiftId))
    .innerJoin(workers, eq(workers.id, shiftOffers.workerId))
    .leftJoin(workAllocations, eq(workAllocations.offerId, shiftOffers.id))
    .where(and(eq(shifts.outletId, scope.locationId), eq(workers.locationId, scope.locationId), eq(workers.organisationId, scope.organisationId)));
  const paymentIssues = await db.select({ id: shiftIncentives.id, status: shiftIncentives.status, shiftDate: shifts.shiftDate, workerName: workers.displayName }).from(shiftIncentives)
    .innerJoin(shifts, eq(shifts.id, shiftIncentives.shiftId)).innerJoin(workers, eq(workers.id, shiftIncentives.workerId))
    .where(and(eq(shifts.outletId, scope.locationId), eq(workers.organisationId, scope.organisationId), inArray(shiftIncentives.status, ["FAILED", "EARNED"])));
  return { team, departments: departmentRows, policies, requirements, offers, paymentIssues };
}
export async function createRequirement(db: Database, input: { departmentId: string; policyId: string; startsAt: Date; endsAt: Date; requiredHeadcount: number }, scope:OperatingScope=demoScope) {
  z.object({ departmentId: z.uuid(), policyId: z.uuid(), startsAt: z.date(), endsAt: z.date(), requiredHeadcount: z.number().int().min(1).max(1000) }).parse(input);
  return db.transaction(async (tx) => {
    await location(tx, scope);
    const [department] = await tx.select().from(departments).where(and(eq(departments.id, input.departmentId), eq(departments.outletId, scope.locationId)));
    const [policy] = await tx.select().from(workPolicies).where(and(eq(workPolicies.id, input.policyId), eq(workPolicies.outletId, scope.locationId)));
    if (!department || !policy) throw new Error("Department or work policy unavailable.");
    const expected = expectedWorkEarnings(policyInput.parse(policy), input.startsAt, input.endsAt);
    const [row] = await tx.insert(shifts).values({ id: randomUUID(), outletId: scope.locationId, departmentId: department.id, roleName: department.name, policyId: policy.id,
      startsAt: input.startsAt, endsAt: input.endsAt, shiftDate: new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg", year: "numeric", month: "2-digit", day: "2-digit" }).format(input.startsAt),
      requiredHeadcount: input.requiredHeadcount, status: "PUBLISHED", publishedAt: new Date(), currencyCode: "USD", earningsModel: policy.earningsModel,
      rateMinor: policy.rateMinor, commissionBps: policy.commissionBps, commissionBasis: policy.commissionBasis, expectedEarningsMinor: expected,
      guaranteedBasePayMinor: expected ?? 0, gratuityPolicy: "No gratuity terms apply.", incentivePolicy: "No incentive applies to this assignment.",
    }).returning();
    return row;
  });
}
async function scopedShift(db: DatabaseSession, id: string, scope:OperatingScope) {
  await location(db, scope);
  const [shift] = await db.select().from(shifts).where(and(eq(shifts.id, id), eq(shifts.outletId, scope.locationId))).for("update");
  if (!shift || shift.status !== "PUBLISHED") throw new Error("Assignment unavailable.");
  return shift;
}
async function eligible(db: DatabaseSession, workerId: string, shift: typeof shifts.$inferSelect, checkConflicts = true, scope:OperatingScope=demoScope) {
  const [worker] = await db.select().from(workers).where(and(eq(workers.id, workerId), eq(workers.locationId, scope.locationId), eq(workers.organisationId, scope.organisationId), eq(workers.status, "ACTIVE"))).for("update");
  if (!worker) throw new Error("Team member unavailable at this location.");
  const conflicts = checkConflicts ? await db.select({ id: shifts.id }).from(shiftOffers).innerJoin(shifts, eq(shifts.id, shiftOffers.shiftId))
    .where(and(eq(shiftOffers.workerId, workerId), eq(shiftOffers.status, "ACCEPTED"), inArray(shifts.status, ["PUBLISHED", "COMPLETED"]), lt(shifts.startsAt, shift.endsAt), gt(shifts.endsAt, shift.startsAt))) : [];
  if (conflicts.some((row) => row.id !== shift.id)) throw new Error("This assignment overlaps accepted work.");
  return worker;
}
export async function offerAssignment(db: Database, shiftId: string, workerId: string, scope:OperatingScope=demoScope) {
  return db.transaction(async (tx) => {
    const shift = await scopedShift(tx, shiftId, scope);
    await eligible(tx, workerId, shift, true, scope);
    // Capacity / over-invitation policy is unresolved: do not create offers beyond headcount.
    const existing = await tx.select().from(shiftOffers).where(eq(shiftOffers.shiftId, shift.id));
    if (existing.some((o) => o.workerId === workerId)) throw new Error("An offer already exists for this member.");
    if (existing.filter((o) => ["OFFERED", "ACCEPTED"].includes(o.status)).length >= shift.requiredHeadcount) throw new Error("Requirement has no unoffered places. Capacity policy requires review.");
    const [offer] = await tx.insert(shiftOffers).values({ id: randomUUID(), shiftId, workerId }).returning();
    return offer;
  });
}
export async function respondToAssignment(db: Database, workerId: string, offerId: string, version: number, response: "ACCEPTED" | "DECLINED", acknowledged: boolean, scope:OperatingScope=demoScope) {
  if (response === "ACCEPTED" && acknowledged !== true) throw new Error("Review and acknowledge all assignment terms.");
  return db.transaction(async (tx) => {
    const [initial] = await tx.select().from(shiftOffers).where(and(eq(shiftOffers.id, offerId), eq(shiftOffers.workerId, workerId)));
    if (!initial) throw new Error("Offer unavailable.");
    const shift = await scopedShift(tx, initial.shiftId, scope);
    const worker = await eligible(tx, workerId, shift, response === "ACCEPTED", scope);
    const [offer] = await tx.select().from(shiftOffers).where(eq(shiftOffers.id, offerId)).for("update");
    if (version !== shift.termsVersion) throw new Error("Assignment terms changed. Review the new version.");
    if (offer.status === response) return offer;
    if (offer.status !== "OFFERED") throw new Error("Offer is closed.");
    const now = new Date();
    if (response === "ACCEPTED") {
      const [department] = shift.departmentId ? await tx.select().from(departments).where(eq(departments.id, shift.departmentId)) : [];
      const snapshot = { authUserId: worker.userId, workerId, workerName: worker.displayName, offerId, assignmentId: shift.id, locationId: scope.locationId, locationName: (await location(tx, scope)).name,
        departmentId: shift.departmentId, departmentName: department?.name ?? shift.roleName, startsAt: shift.startsAt.toISOString(), endsAt: shift.endsAt.toISOString(),
        earningsModel: shift.earningsModel, currencyCode: shift.currencyCode, rateMinor: shift.rateMinor ?? (shift.earningsModel === "DAILY" ? shift.guaranteedBasePayMinor : null),
        commissionBps: shift.commissionBps, commissionBasis: shift.commissionBasis, expectedEarningsMinor: shift.earningsModel === "COMMISSION" ? null : shift.expectedEarningsMinor ?? shift.guaranteedBasePayMinor,
        incentivePolicy: shift.incentivePolicy, incentiveTargetMinor: shift.incentiveTargetMinor, incentiveAmountMinor: shift.incentiveAmountMinor, gratuityPolicy: shift.gratuityPolicy,
        termsVersion: version, acceptedAt: now.toISOString(), acknowledged: true };
      await tx.insert(workAcceptances).values({ id: randomUUID(), offerId, workerId, termsVersion: version, snapshot, acceptedAt: now });
      await tx.insert(auditEvents).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: scope.locationId, action: "SHIFT_ACCEPTED", entityType: "shift_offer", entityId: offerId, correlationId: `demo-cycle:${shift.id}`, metadata: { workerId, shiftId: shift.id, termsVersion: version } });
    }
    const [updated] = await tx.update(shiftOffers).set({ status: response, respondedAt: now, acceptedAt: response === "ACCEPTED" ? now : null, updatedAt: now }).where(eq(shiftOffers.id, offerId)).returning();
    return updated;
  });
}
export async function allocateAssignment(db: Database, offerId: string, scope:OperatingScope=demoScope) {
  return db.transaction(async (tx) => {
    const [offer] = await tx.select().from(shiftOffers).where(eq(shiftOffers.id, offerId));
    if (!offer || offer.status !== "ACCEPTED") throw new Error("Accept the offer before allocation.");
    const shift = await scopedShift(tx, offer.shiftId, scope);
    await eligible(tx, offer.workerId, shift, true, scope);
    const [acceptance] = await tx.select().from(workAcceptances).where(and(eq(workAcceptances.offerId, offerId), eq(workAcceptances.termsVersion, shift.termsVersion)));
    if (!acceptance) throw new Error("Current terms require acceptance.");
    const [row] = await tx.insert(workAllocations).values({ id: randomUUID(), offerId, acceptanceId: acceptance.id }).onConflictDoUpdate({ target: workAllocations.offerId, set: { acceptanceId: acceptance.id, state: "ALLOCATED" } }).returning();
    return row;
  });
}

export async function confirmWork(db: Database, offerId: string, scope:OperatingScope=demoScope) {
  return db.transaction(async (tx) => {
    const [offer] = await tx.select().from(shiftOffers).where(eq(shiftOffers.id, offerId));
    if (!offer || offer.status !== "ACCEPTED") throw new Error("Accepted work required.");
    const shift = await scopedShift(tx, offer.shiftId, scope);
    const [allocation] = await tx.select().from(workAllocations).where(and(eq(workAllocations.offerId, offerId), eq(workAllocations.state, "ALLOCATED")));
    if (!allocation) throw new Error("Allocate accepted work first.");
    if (shift.endsAt > new Date()) throw new Error("Scheduled work has not ended.");
    await tx.update(workAllocations).set({ confirmedAt: allocation.confirmedAt ?? new Date() }).where(eq(workAllocations.id, allocation.id));
    await tx.insert(auditEvents).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: scope.locationId, action: "WORK_CONFIRMED", entityType: "work_allocation", entityId: allocation.id, correlationId: `assignment:${shift.id}`, metadata: { offerId, termsVersion: shift.termsVersion } });
  });
}

export async function changeAssignment(db:Database,scope:OperatingScope,id:string,input:{startsAt:Date;endsAt:Date}|{cancel:true}) {
 return db.transaction(async tx=>{
  const shift=await scopedShift(tx,id,scope);
  if ("cancel" in input) {
   const reviewed=await tx.select({id:workAllocations.id}).from(workAllocations).innerJoin(shiftOffers,eq(shiftOffers.id,workAllocations.offerId)).where(eq(shiftOffers.shiftId,id));
   const incentives=await tx.select({id:shiftIncentives.id}).from(shiftIncentives).where(eq(shiftIncentives.shiftId,id));
   const allocations=reviewed.length ? await tx.select().from(workAllocations).where(inArray(workAllocations.id,reviewed.map(r=>r.id))) : [];
   if (incentives.length || allocations.some(a=>a.confirmedAt)) throw new Error("Reviewed work cannot be cancelled.");
   await tx.update(shifts).set({status:"CANCELLED",updatedAt:new Date()}).where(eq(shifts.id,id));
  } else {
   const terms=policyInput.parse(shift.earningsModel === "COMMISSION" ? shift : {...shift,rateMinor:shift.rateMinor ?? shift.guaranteedBasePayMinor});
   const expected=expectedWorkEarnings(terms,input.startsAt,input.endsAt);
   await tx.update(shifts).set({...input,shiftDate:new Intl.DateTimeFormat("en-CA",{timeZone:"Africa/Johannesburg",year:"numeric",month:"2-digit",day:"2-digit"}).format(input.startsAt),expectedEarningsMinor:expected,guaranteedBasePayMinor:expected ?? 0,updatedAt:new Date()}).where(eq(shifts.id,id));
  }
 });
}
