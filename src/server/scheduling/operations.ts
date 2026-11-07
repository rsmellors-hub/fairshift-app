import { tokenHash } from "@/server/auth/identity";
import { randomUUID } from "node:crypto";
import { and, desc, eq, getTableColumns, inArray, lt, gt, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database, DatabaseSession } from "@/server/db/client";
import { departments, organisations, outlets, workers, workerAvailability, teamInvitations, workPolicies, shifts, shiftOffers, workAcceptances, workAllocations, workPayables, workPayouts, auditEvents, shiftIncentives } from "@/server/db/schema";
import { expectedWorkEarnings, policyInput } from "@/server/domain/work-terms";
import { resolveLocationCurrency } from "@/server/domain/currency";
import { BASE_PAYABLE_METHOD, BasePayableUnavailableError, basePayableFromAcceptedTerms } from "@/server/domain/work-payable";
import { localDate } from "@/server/intelligence/forecast";
import { checkWage, termsForWageCheck, wageAllowsOffer, wageJurisdiction } from "@/server/domain/statutory-wage";

import { assertRole, type Scope } from "@/server/auth/access";
import { shiftInteraction } from "@/server/domain/shift-change";
import { UserFacingError } from "@/server/domain/errors";
import { acceptedIncentiveTerms, INDIVIDUAL_INCENTIVE_BASIS } from "@/server/domain/incentive";
import { availabilityForShift, isOfferable, shiftWeekdays, workerOpportunityState } from "@/server/scheduling/worker-pool";
import { latestPayAgentEvents, recordPayAgentEvent } from "@/server/pay-agent/journal";
import { toPayAgentEventView } from "@/server/pay-agent/presentation";

type OperatingScope = Pick<Scope,"organisationId" | "locationId">;
async function location(db: DatabaseSession, scope:OperatingScope) {
  const [row] = await db.select().from(outlets).where(and(eq(outlets.id, scope.locationId), eq(outlets.organisationId, scope.organisationId)));
  if (!row) throw new Error("Location unavailable.");
  return row;
}
// Work terms at a location are denominated in that location's currency.
async function locationCurrency(db: DatabaseSession, outlet: typeof outlets.$inferSelect) {
  const [organisation] = await db.select({ country: organisations.country }).from(organisations).where(eq(organisations.id, outlet.organisationId));
  return resolveLocationCurrency({ locationCountry: outlet.country, organisationCountry: organisation?.country });
}
// Which statutory wage reference applies here, from the same countries as the currency.
export async function locationWageJurisdiction(db: DatabaseSession, outlet: typeof outlets.$inferSelect) {
  const [organisation] = await db.select({ country: organisations.country }).from(organisations).where(eq(organisations.id, outlet.organisationId));
  return wageJurisdiction({ locationCountry: outlet.country, organisationCountry: organisation?.country });
}
// FS-WAGE-INTEL-DEC-001 / -DEC-002: where the demo wage floor applies, a shift is created and offered
// only on terms checked against the 21-and-over rate in force on its local date. Terms below it, terms
// that can't be checked, and dates without a verified rate are all refused here, whatever the UI shows.
// Locations outside the reference keep their existing behaviour.
async function assertWageAllowsOffer(db: DatabaseSession, outlet: typeof outlets.$inferSelect, shift: { earningsModel: string; rateMinor: number | null; currencyCode: string; startsAt: Date; endsAt: Date }) {
  const jurisdiction = await locationWageJurisdiction(db, outlet);
  const terms = termsForWageCheck(shift, shift) ?? { earningsModel: "HOURLY" as const, rateMinor: -1 };
  const check = checkWage({ jurisdiction, date: localDate(shift.startsAt, outlet.timezone), currencyCode: shift.currencyCode, terms });
  if (wageAllowsOffer(check)) return;
  if (check.status === "BELOW_DEMO_MINIMUM") throw new UserFacingError("wage-below-minimum", "This pay is below the FairShift demo minimum for the shift's date, so it can't be offered.");
  if (check.status === "REFERENCE_UNAVAILABLE") throw new UserFacingError("wage-reference-unavailable", "FairShift has no verified minimum wage for the shift's date, so it can't be offered.");
  throw new UserFacingError("wage-not-checkable", "This pay can't be checked against the FairShift demo minimum, so it can't be offered here.");
}
const teamInput = z.object({ firstName: z.string().trim().min(1).max(100), surname: z.string().trim().min(1).max(100), telephone: z.string().trim().regex(/^\+?[0-9 ()-]{6,30}$/), email: z.string().trim().email().max(254) });
export async function createTeamMember(db: Database, input: unknown, scope:OperatingScope) {
  const value = teamInput.parse(input);
  return db.transaction(async (tx) => {
    await location(tx, scope);
    const [worker] = await tx.insert(workers).values({ id: randomUUID(), organisationId: scope.organisationId, locationId: scope.locationId, ...value, displayName: `${value.firstName} ${value.surname}`, workerType: "CASUAL" }).returning();
    const [invitation] = await tx.insert(teamInvitations).values({ id: randomUUID(), workerId: worker.id, token: tokenHash(randomUUID()), state: "CREATED_NOT_SENT" }).returning();
    return { worker, invitation };
  });
}
export async function createDepartment(db: Database, name: string, scope:OperatingScope) {
  await location(db, scope);
  return db.insert(departments).values({ id: randomUUID(), outletId: scope.locationId, name: z.string().trim().min(1).max(100).parse(name) }).returning();
}
export async function createWorkPolicy(db: Database, input: unknown, name: string, scope:OperatingScope) {
  const outlet = await location(db, scope);
  const terms = policyInput.parse(input);
  // An optional target and fixed bonus, together and positive, on fixed-pay terms only.
  const { incentiveTargetMinor: target = null, incentiveBonusMinor: bonus = null } = input as { incentiveTargetMinor?: number | null; incentiveBonusMinor?: number | null };
  const validAmount = (value: number) => Number.isSafeInteger(value) && value > 0;
  if ((target !== null || bonus !== null) && (target === null || bonus === null || !validAmount(target) || !validAmount(bonus) || terms.earningsModel === "COMMISSION")) throw new UserFacingError("policy-incentive", "A sales target and bonus must both be set, on hourly or daily terms.");
  return db.insert(workPolicies).values({ id: randomUUID(), outletId: scope.locationId, name: z.string().trim().min(1).max(100).parse(name), ...terms, incentiveTargetMinor: target, incentiveBonusMinor: bonus, currencyCode: await locationCurrency(db, outlet) }).returning();
}
// Payout state shown to managers; the stored recipient address is not needed to review it.
type PayoutColumns = ReturnType<typeof getTableColumns<typeof workPayouts>>;
const managerPayoutColumns = (() => {
  const columns: Partial<PayoutColumns> = { ...getTableColumns(workPayouts) };
  delete columns.recipient;
  return columns as Omit<PayoutColumns, "recipient">;
})();
export async function getOperations(db: DatabaseSession, scope:OperatingScope) {
  const outlet = await location(db, scope);
  const team = await db.select({ worker: workers, invitation: teamInvitations }).from(workers)
    .leftJoin(teamInvitations, eq(teamInvitations.workerId, workers.id))
    .where(and(eq(workers.organisationId, scope.organisationId), eq(workers.locationId, scope.locationId)));
  const departmentRows = await db.select().from(departments).where(eq(departments.outletId, scope.locationId));
  const policies = await db.select().from(workPolicies).where(eq(workPolicies.outletId, scope.locationId));
  const requirements = await db.select().from(shifts).where(eq(shifts.outletId, scope.locationId));
  const offers = await db.select({ offer: shiftOffers, workerName: workers.displayName, allocation: workAllocations, acceptance: workAcceptances })
    .from(shiftOffers).innerJoin(shifts, eq(shifts.id, shiftOffers.shiftId))
    .innerJoin(workers, eq(workers.id, shiftOffers.workerId))
    .leftJoin(workAllocations, eq(workAllocations.offerId, shiftOffers.id))
    .leftJoin(workAcceptances, eq(workAcceptances.id, workAllocations.acceptanceId))
    .where(and(eq(shifts.outletId, scope.locationId), eq(workers.locationId, scope.locationId), eq(workers.organisationId, scope.organisationId)));
  const paymentIssues = await db.select({ id: shiftIncentives.id, status: shiftIncentives.status, shiftDate: shifts.shiftDate, workerName: workers.displayName }).from(shiftIncentives)
    .innerJoin(shifts, eq(shifts.id, shiftIncentives.shiftId)).innerJoin(workers, eq(workers.id, shiftIncentives.workerId))
    .where(and(eq(shifts.outletId, scope.locationId), eq(workers.organisationId, scope.organisationId), inArray(shiftIncentives.status, ["FAILED", "EARNED"])));
  // Base payables of confirmed work at this location, in one scoped query.
  // Each carries its payout, if any, and whether the worker has saved payment details
  // (not the details themselves).
  const payables = await db.select({ payable: workPayables, payout: managerPayoutColumns, workerName: workers.displayName, shiftDate: shifts.shiftDate, roleName: shifts.roleName,
    paymentDetailsSaved: sql<boolean>`${workers.paypalPayoutEmail} is not null` })
    .from(workPayables).innerJoin(workers, eq(workers.id, workPayables.workerId)).innerJoin(shifts, eq(shifts.id, workPayables.shiftId))
    .leftJoin(workPayouts, eq(workPayouts.payableId, workPayables.id))
    .where(and(eq(workPayables.organisationId, scope.organisationId), eq(workPayables.outletId, scope.locationId), eq(shifts.outletId, scope.locationId)))
    .orderBy(desc(workPayables.confirmedAt));
  const workerIds = team.map(row => row.worker.id);
  const availability = workerIds.length ? await db.select({ workerId: workerAvailability.workerId, isoWeekday: workerAvailability.isoWeekday, state: workerAvailability.state }).from(workerAvailability).where(inArray(workerAvailability.workerId, workerIds)) : [];
  // Each payable's latest Pay Agent event, as the manager's view of it (DEC-SA-011).
  const agentEvents = await latestPayAgentEvents(db, scope, payables.map(row => row.payable.id));
  const payablesWithAgent = payables.map(row => { const event = agentEvents.get(row.payable.id); return { ...row, payAgent: event ? toPayAgentEventView(event) : null }; });
  return { team, departments: departmentRows, policies, requirements, offers, paymentIssues, payables: payablesWithAgent, availability, currency: await locationCurrency(db, outlet), timezone: outlet.timezone, wageJurisdiction: await locationWageJurisdiction(db, outlet) };
}
// The planning location's time zone: the only basis for reading a Manager's local times.
export async function locationTimezone(db: DatabaseSession, scope: OperatingScope) {
  return (await location(db, scope)).timezone;
}
export async function createRequirement(db: Database, input: { departmentId: string; policyId: string; startsAt: Date; endsAt: Date; requiredHeadcount: number }, scope:OperatingScope) {
  z.object({ departmentId: z.uuid(), policyId: z.uuid(), startsAt: z.date(), endsAt: z.date(), requiredHeadcount: z.number().int().min(1).max(1000) }).parse(input);
  return db.transaction(async (tx) => {
    const outlet = await location(tx, scope);
    const [department] = await tx.select().from(departments).where(and(eq(departments.id, input.departmentId), eq(departments.outletId, scope.locationId)));
    const [policy] = await tx.select().from(workPolicies).where(and(eq(workPolicies.id, input.policyId), eq(workPolicies.outletId, scope.locationId)));
    if (!department || !policy) throw new Error("Department or work policy unavailable.");
    if (policy.currencyCode !== await locationCurrency(tx, outlet)) throw new UserFacingError("policy-currency", "This work policy is not in this location's currency.");
    if (policy.earningsModel !== "COMMISSION" && !(policy.rateMinor && policy.rateMinor > 0)) throw new UserFacingError("policy-rate", "This work policy has no pay rate.");
    if (input.endsAt <= input.startsAt) throw new UserFacingError("invalid-duration", "The end must be after the start.");
    let expected: number | null;
    try { expected = expectedWorkEarnings(policyInput.parse(policy), input.startsAt, input.endsAt); }
    catch (error) { throw new UserFacingError("earnings-not-whole", error instanceof Error ? error.message : "These terms cannot be calculated."); }
    await assertWageAllowsOffer(tx, outlet, { ...policy, startsAt: input.startsAt, endsAt: input.endsAt });
    const [row] = await tx.insert(shifts).values({ id: randomUUID(), outletId: scope.locationId, departmentId: department.id, roleName: department.name, policyId: policy.id,
      startsAt: input.startsAt, endsAt: input.endsAt, shiftDate: localDate(input.startsAt, outlet.timezone),
      requiredHeadcount: input.requiredHeadcount, status: "PUBLISHED", publishedAt: new Date(), currencyCode: policy.currencyCode, earningsModel: policy.earningsModel,
      rateMinor: policy.rateMinor, commissionBps: policy.commissionBps, commissionBasis: policy.commissionBasis, expectedEarningsMinor: expected,
      guaranteedBasePayMinor: expected ?? 0, gratuityPolicy: "No gratuity terms apply.",
      ...(policy.incentiveTargetMinor !== null && policy.incentiveBonusMinor !== null
        ? { incentiveBasis: INDIVIDUAL_INCENTIVE_BASIS, incentiveTargetMinor: policy.incentiveTargetMinor, incentiveAmountMinor: policy.incentiveBonusMinor, incentivePolicy: "A fixed bonus is earned if the worker's own attributed sales for this shift reach the target." }
        : { incentivePolicy: "No incentive applies to this assignment." }),
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
async function eligible(db: DatabaseSession, workerId: string, shift: typeof shifts.$inferSelect, checkConflicts: boolean, scope:OperatingScope, options: { requireActivation?: boolean } = {}) {
  const [worker] = await db.select().from(workers).where(and(eq(workers.id, workerId), eq(workers.locationId, scope.locationId), eq(workers.organisationId, scope.organisationId), eq(workers.status, "ACTIVE"))).for("update");
  if (!worker) throw new Error("Team member unavailable at this location.");
  if (!checkConflicts) return worker;
  const conflicts = await db.select({ id: shifts.id }).from(shiftOffers).innerJoin(shifts, eq(shifts.id, shiftOffers.shiftId))
    .where(and(eq(shiftOffers.workerId, workerId), eq(shiftOffers.status, "ACCEPTED"), inArray(shifts.status, ["PUBLISHED", "COMPLETED"]), lt(shifts.startsAt, shift.endsAt), gt(shifts.endsAt, shift.startsAt)));
  const outlet = await location(db, scope);
  const stated = await db.select({ isoWeekday: workerAvailability.isoWeekday, state: workerAvailability.state }).from(workerAvailability).where(eq(workerAvailability.workerId, workerId));
  const state = workerOpportunityState({ active: true, activated: !options.requireActivation || !!worker.userId, conflict: conflicts.some(row => row.id !== shift.id),
    availability: availabilityForShift(new Map(stated.map(row => [row.isoWeekday, row.state])), shiftWeekdays(shift, outlet.timezone)) });
  if (state === "ALREADY_WORKING") throw new UserFacingError("worker-working", "This assignment overlaps accepted work.");
  if (state === "UNAVAILABLE") throw new UserFacingError("worker-unavailable", "This worker has marked themselves unavailable for this shift.");
  if (state === "AWAITING_ACTIVATION") throw new UserFacingError("worker-not-activated", "This worker has not activated their FairShift account yet, so they cannot see an offer.");
  if (!isOfferable(state)) throw new Error("Team member unavailable at this location.");
  return worker;
}
export async function offerAssignment(db: Database, shiftId: string, workerId: string, scope:OperatingScope) {
  return db.transaction(async (tx) => {
    const shift = await scopedShift(tx, shiftId, scope);
    await assertWageAllowsOffer(tx, await location(tx, scope), { ...shift, rateMinor: shift.rateMinor ?? (shift.earningsModel === "DAILY" ? shift.guaranteedBasePayMinor : null) });
    await eligible(tx, workerId, shift, true, scope, { requireActivation: true });
    // Capacity / over-invitation policy is unresolved: do not create offers beyond headcount.
    const existing = await tx.select().from(shiftOffers).where(eq(shiftOffers.shiftId, shift.id));
    if (existing.some((o) => o.workerId === workerId)) throw new UserFacingError("already-offered", "An offer already exists for this member.");
    if (existing.filter((o) => ["OFFERED", "ACCEPTED"].includes(o.status)).length >= shift.requiredHeadcount) throw new Error("Requirement has no unoffered places. Capacity policy requires review.");
    const [offer] = await tx.insert(shiftOffers).values({ id: randomUUID(), shiftId, workerId }).returning();
    return offer;
  });
}
export async function respondToAssignment(db: Database, workerId: string, offerId: string, version: number, response: "ACCEPTED" | "DECLINED", acknowledged: boolean, scope:OperatingScope) {
  if (response === "ACCEPTED" && acknowledged !== true) throw new Error("Review and acknowledge all assignment terms.");
  return db.transaction(async (tx) => {
    const [initial] = await tx.select().from(shiftOffers).where(and(eq(shiftOffers.id, offerId), eq(shiftOffers.workerId, workerId)));
    if (!initial) throw new Error("Offer unavailable.");
    const shift = await scopedShift(tx, initial.shiftId, scope);
    const worker = await eligible(tx, workerId, shift, response === "ACCEPTED", scope);
    const [offer] = await tx.select().from(shiftOffers).where(eq(shiftOffers.id, offerId)).for("update");
    if (version !== shift.termsVersion) throw new UserFacingError("terms-changed", "Assignment terms changed. Review the new version.");
    if (offer.status === response) return offer;
    if (offer.status !== "OFFERED") throw new Error("Offer is closed.");
    const now = new Date();
    if (response === "ACCEPTED") {
      const [department] = shift.departmentId ? await tx.select().from(departments).where(eq(departments.id, shift.departmentId)) : [];
      const snapshot = { authUserId: worker.userId, workerId, workerName: worker.displayName, offerId, assignmentId: shift.id, locationId: scope.locationId, locationName: (await location(tx, scope)).name,
        departmentId: shift.departmentId, departmentName: department?.name ?? shift.roleName, startsAt: shift.startsAt.toISOString(), endsAt: shift.endsAt.toISOString(),
        earningsModel: shift.earningsModel, currencyCode: shift.currencyCode, rateMinor: shift.rateMinor ?? (shift.earningsModel === "DAILY" ? shift.guaranteedBasePayMinor : null),
        commissionBps: shift.commissionBps, commissionBasis: shift.commissionBasis, expectedEarningsMinor: shift.earningsModel === "COMMISSION" ? null : shift.expectedEarningsMinor ?? shift.guaranteedBasePayMinor,
        incentivePolicy: shift.incentivePolicy, incentiveBasis: shift.incentiveBasis, incentiveTargetMinor: shift.incentiveTargetMinor, incentiveAmountMinor: shift.incentiveAmountMinor, gratuityPolicy: shift.gratuityPolicy,
        termsVersion: version, acceptedAt: now.toISOString(), acknowledged: true };
      await tx.insert(workAcceptances).values({ id: randomUUID(), offerId, workerId, termsVersion: version, snapshot, acceptedAt: now });
      await tx.insert(auditEvents).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: scope.locationId, action: "SHIFT_ACCEPTED", entityType: "shift_offer", entityId: offerId, correlationId: `demo-cycle:${shift.id}`, metadata: { workerId, shiftId: shift.id, termsVersion: version } });
    }
    const [updated] = await tx.update(shiftOffers).set({ status: response, respondedAt: now, acceptedAt: response === "ACCEPTED" ? now : null, updatedAt: now }).where(eq(shiftOffers.id, offerId)).returning();
    return updated;
  });
}
export async function allocateAssignment(db: Database, offerId: string, scope:OperatingScope) {
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

// Confirms that allocated work was performed as scheduled and, for fixed terms,
// records its base payable from the accepted terms in the same transaction.
// Idempotent: a repeat or retry returns the existing confirmation and payable and
// never creates a second one. Commission work is confirmed without a payable, since
// no verified attribution exists. Nothing is approved or paid here.
// The payable's Pay Agent event (DEC-SA-011) is written in the same transaction, so
// confirmation, payable and orchestration intent commit together or not at all. No model
// or provider is called here; processing starts only after this transaction commits.
export async function confirmWork(db: Database, offerId: string, scope:OperatingScope & { userId?: string }) {
  return db.transaction(async (tx) => {
    const [offer] = await tx.select().from(shiftOffers).where(eq(shiftOffers.id, offerId));
    if (!offer || offer.status !== "ACCEPTED") throw new Error("Accepted work required.");
    const shift = await scopedShift(tx, offer.shiftId, scope);
    const [worker] = await tx.select({ id: workers.id }).from(workers).where(and(eq(workers.id, offer.workerId), eq(workers.organisationId, scope.organisationId)));
    if (!worker) throw new Error("Team member unavailable.");
    const [allocation] = await tx.select().from(workAllocations).where(and(eq(workAllocations.offerId, offerId), eq(workAllocations.state, "ALLOCATED"))).for("update");
    if (!allocation) throw new Error("Allocate accepted work first.");
    if (shift.endsAt > new Date()) throw new Error("Scheduled work has not ended.");
    const [acceptance] = await tx.select().from(workAcceptances).where(and(eq(workAcceptances.id, allocation.acceptanceId), eq(workAcceptances.offerId, offerId), eq(workAcceptances.termsVersion, shift.termsVersion)));
    if (!acceptance) throw new Error("Current terms require acceptance.");
    const terms = basePayableFromAcceptedTerms(acceptance.snapshot, { workerId: offer.workerId, offerId, shiftId: shift.id, locationId: shift.outletId, termsVersion: shift.termsVersion });
    // Unverifiable fixed terms block confirmation, which would lock them, rather than becoming a zero payable.
    if (terms.state === "UNAVAILABLE") throw new BasePayableUnavailableError(terms.reason);
    const confirmedAt = allocation.confirmedAt ?? new Date();
    if (!allocation.confirmedAt) {
      await tx.update(workAllocations).set({ confirmedAt }).where(eq(workAllocations.id, allocation.id));
      await tx.insert(auditEvents).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: scope.locationId, action: "WORK_CONFIRMED", entityType: "work_allocation", entityId: allocation.id, correlationId: `assignment:${shift.id}`, metadata: { offerId, termsVersion: shift.termsVersion } });
    }
    if (terms.state === "ATTRIBUTION_REQUIRED") return { allocationId: allocation.id, confirmedAt, payable: null, payableState: terms.state, payAgentEvent: null };
    const [created] = await tx.insert(workPayables).values({
      id: randomUUID(), organisationId: scope.organisationId, outletId: shift.outletId, shiftId: shift.id, workerId: offer.workerId, offerId,
      allocationId: allocation.id, acceptanceId: acceptance.id, termsVersion: terms.termsVersion, calculationMethod: BASE_PAYABLE_METHOD,
      earningsModel: terms.earningsModel, currencyCode: terms.currencyCode, rateMinor: terms.rateMinor,
      scheduledStartsAt: terms.scheduledStartsAt, scheduledEndsAt: terms.scheduledEndsAt, baseAmountMinor: terms.baseAmountMinor,
      confirmedAt, confirmedBy: scope.userId ?? null, incentiveRequired: acceptedIncentiveTerms(acceptance.snapshot) !== null,
    }).onConflictDoNothing({ target: workPayables.allocationId }).returning();
    if (created) await tx.insert(auditEvents).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: scope.locationId, action: "BASE_PAYABLE_CALCULATED", entityType: "work_payable", entityId: created.id, correlationId: `assignment:${shift.id}`, metadata: { allocationId: allocation.id, termsVersion: terms.termsVersion, currencyCode: terms.currencyCode, baseAmountMinor: terms.baseAmountMinor } });
    const [payable] = created ? [created] : await tx.select().from(workPayables).where(eq(workPayables.allocationId, allocation.id));
    const payAgentEvent = await recordPayAgentEvent(tx, scope, payable.id, "WORK_CONFIRMED", scope.userId ?? null);
    return { allocationId: allocation.id, confirmedAt, payable, payableState: terms.state, payAgentEvent };
  });
}

const rescheduleInput = z.object({ shiftId: z.uuid(), expectedTermsVersion: z.number().int().positive(), startsAt: z.date(), endsAt: z.date(), source: z.enum(["DRAG", "CHANGE"]), acknowledgeReacceptance: z.boolean() }).strict();

// A time change requested from the schedule. The client supplies only the shift, the terms
// version it was looking at and the proposed times; everything else is read here, so a
// forged event cannot set pay, a worker or a location. Moving a shift with live offers
// creates a new terms version through the database rule, which returns every acceptance
// and allocation to "must accept again". It can never leave accepted terms silently changed.
export async function rescheduleShift(db: Database, scope: OperatingScope & Pick<Scope, "role">, raw: unknown, now = new Date()) {
  assertRole(scope as Scope, ["OWNER", "MANAGER"]);
  const parsed = rescheduleInput.safeParse(raw);
  if (!parsed.success) throw new UserFacingError("schedule-invalid", "That change could not be read, so nothing was changed.");
  const input = parsed.data;
  return db.transaction(async tx => {
    const outlet = await location(tx, scope);
    const [shift] = await tx.select().from(shifts).where(and(eq(shifts.id, input.shiftId), eq(shifts.outletId, scope.locationId))).for("update");
    if (!shift) throw new UserFacingError("schedule-unavailable", "This shift is no longer available at this location.");
    if (shift.status === "PUBLISHED" && input.expectedTermsVersion !== shift.termsVersion) throw new UserFacingError("schedule-stale", "This shift changed since you opened the schedule, so nothing was moved. It now shows the latest details.");
    const offers = await tx.select({ workerId: shiftOffers.workerId, offerStatus: shiftOffers.status, allocationState: workAllocations.state, confirmedAt: workAllocations.confirmedAt })
      .from(shiftOffers).leftJoin(workAllocations, eq(workAllocations.offerId, shiftOffers.id)).where(eq(shiftOffers.shiftId, shift.id));
    const interaction = shiftInteraction(shift, offers, now);
    if (interaction === "LOCKED") throw new UserFacingError("schedule-locked", "This shift is finished, reviewed or closed, so it cannot be changed.");
    if (interaction === "CHANGE_ONLY" && input.source === "DRAG") throw new UserFacingError("schedule-allocated", "This shift is allocated, so it cannot be dragged. Use Change shift: its workers must then accept again.");
    if (interaction !== "MOVE" && !input.acknowledgeReacceptance) throw new UserFacingError("schedule-needs-confirmation", "Workers have live offers on this shift. Confirm that they must accept the new times.");
    if (input.endsAt <= input.startsAt) throw new UserFacingError("invalid-duration", "The end must be after the start.");
    if (input.startsAt <= now) throw new UserFacingError("schedule-past", "A shift cannot be moved to a time that has already started.");
    if (input.startsAt.getTime() === shift.startsAt.getTime() && input.endsAt.getTime() === shift.endsAt.getTime()) return { termsVersion: shift.termsVersion, changed: false };
    // The proposed times must suit everyone holding a live offer, under the same rule as sending one.
    const proposed = { ...shift, startsAt: input.startsAt, endsAt: input.endsAt };
    for (const offer of offers.filter(row => ["OFFERED", "ACCEPTED"].includes(row.offerStatus))) {
      try { await eligible(tx, offer.workerId, proposed, true, scope); }
      catch (error) { if (error instanceof UserFacingError) throw error; throw new UserFacingError("schedule-conflict", "A worker on this shift cannot work these times, so nothing was changed."); }
    }
    let expected: number | null;
    try { expected = expectedWorkEarnings(policyInput.parse(shift.earningsModel === "COMMISSION" ? shift : { ...shift, rateMinor: shift.rateMinor ?? shift.guaranteedBasePayMinor }), input.startsAt, input.endsAt); }
    catch (error) { throw new UserFacingError("earnings-not-whole", error instanceof Error ? error.message : "These terms cannot be calculated."); }
    const [updated] = await tx.update(shifts).set({ startsAt: input.startsAt, endsAt: input.endsAt, shiftDate: localDate(input.startsAt, outlet.timezone), expectedEarningsMinor: expected, guaranteedBasePayMinor: expected ?? 0, updatedAt: now }).where(eq(shifts.id, shift.id)).returning({ termsVersion: shifts.termsVersion });
    await tx.insert(auditEvents).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: scope.locationId, action: "SHIFT_RESCHEDULED", entityType: "shift", entityId: shift.id, correlationId: `assignment:${shift.id}`,
      metadata: { source: input.source, interaction, fromStartsAt: shift.startsAt.toISOString(), fromEndsAt: shift.endsAt.toISOString(), startsAt: input.startsAt.toISOString(), endsAt: input.endsAt.toISOString(), fromTermsVersion: shift.termsVersion, termsVersion: updated.termsVersion } });
    return { termsVersion: updated.termsVersion, changed: true };
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
   await tx.update(shifts).set({...input,shiftDate:localDate(input.startsAt,(await location(tx,scope)).timezone),expectedEarningsMinor:expected,guaranteedBasePayMinor:expected ?? 0,updatedAt:new Date()}).where(eq(shifts.id,id));
  }
 });
}
