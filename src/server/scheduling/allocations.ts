import type { Scope } from "@/server/auth/access";
import { and, desc, eq, sql } from "drizzle-orm";
import { toAllocationSchedule } from "@/app/manager/allocation-model";
import { money } from "@/app/components/format";
import { DEMO_ORGANISATION_ID, DEMO_OUTLET_ID } from "@/server/constants";
import type { DatabaseSession } from "@/server/db/client";
import { outlets, shiftOffers, shifts, workers, workAllocations, workPayables, workPayouts, workPerformanceResults } from "@/server/db/schema";
import { shiftInteraction } from "@/server/domain/shift-change";

const bonusLabel = (shift: { incentiveBasis: string | null; incentiveAmountMinor: number; incentiveTargetMinor: number; currencyCode: string }) =>
  shift.incentiveBasis ? `${money(shift.incentiveAmountMinor, shift.currencyCode)} bonus at ${money(shift.incentiveTargetMinor, shift.currencyCode)} attributed sales` : "No bonus on this shift";

function paymentLabel(payable: string | null, payout: string | null, paypalStatus: string | null) {
  switch (payout) {
    case "PAID": return "Paid · confirmed by PayPal";
    case "FAILED": return "Payment needs attention";
    case "RECONCILIATION_REQUIRED": return "Being confirmed with PayPal";
    case "SUBMITTING": return "Sent to PayPal";
    case "PROCESSING": return paypalStatus === "ONHOLD" ? "Held at PayPal" : paypalStatus === "UNCLAIMED" ? "Waiting for the worker to claim it" : "Processing at PayPal";
  }
  return payable === "APPROVED" ? "Approved · not yet paid" : payable === "PENDING_REVIEW" ? "Awaiting approval" : "Not yet payable";
}

// The Manager's schedule for one location, read from the same records as everything else:
// offers, acceptances, allocations, results and payments. It holds no state of its own.
export async function getAllocationSchedule(db: DatabaseSession, scope:Pick<Scope,"organisationId"|"locationId"> = {organisationId:DEMO_ORGANISATION_ID,locationId:DEMO_OUTLET_ID}, now = new Date()) {
  const rows = await db.select({
    shiftId: shifts.id, offerId: shiftOffers.id, workerId: workers.id, workerName: workers.displayName,
    roleName: shifts.roleName, startsAt: shifts.startsAt, endsAt: shifts.endsAt,
    shiftStatus: shifts.status, offerStatus: shiftOffers.status, allocationStatus: workAllocations.state, confirmedAt: workAllocations.confirmedAt,
    guaranteedBasePayMinor: shifts.guaranteedBasePayMinor, currencyCode: shifts.currencyCode,
    earningsModel: shifts.earningsModel, commissionBps: shifts.commissionBps, termsVersion: shifts.termsVersion,
    incentiveBasis: shifts.incentiveBasis, incentiveAmountMinor: shifts.incentiveAmountMinor, incentiveTargetMinor: shifts.incentiveTargetMinor,
    earnedMinor: workPerformanceResults.earnedMinor, payableStatus: workPayables.status, payoutStatus: workPayouts.status, paypalStatus: workPayouts.paypalStatus,
  }).from(shiftOffers)
    .innerJoin(shifts, eq(shiftOffers.shiftId, shifts.id))
    .innerJoin(workers, eq(shiftOffers.workerId, workers.id))
    .innerJoin(outlets, eq(shifts.outletId, outlets.id))
    .leftJoin(workAllocations, eq(workAllocations.offerId, shiftOffers.id))
    .leftJoin(workPerformanceResults, eq(workPerformanceResults.allocationId, workAllocations.id))
    .leftJoin(workPayables, eq(workPayables.allocationId, workAllocations.id))
    .leftJoin(workPayouts, eq(workPayouts.payableId, workPayables.id))
    .where(and(eq(outlets.id, scope.locationId), eq(outlets.organisationId, scope.organisationId),
      eq(workers.organisationId, scope.organisationId), eq(workers.locationId, scope.locationId)))
    .orderBy(desc(shifts.startsAt));
  const team = await db.select({ id: workers.id, name: workers.displayName }).from(workers)
    .where(and(eq(workers.locationId, scope.locationId), eq(workers.organisationId, scope.organisationId)));
  const published = await db.select({ id: shifts.id, roleName: shifts.roleName, startsAt: shifts.startsAt, endsAt: shifts.endsAt, shiftDate: shifts.shiftDate, status: shifts.status, requiredHeadcount: shifts.requiredHeadcount, termsVersion: shifts.termsVersion,
    currencyCode: shifts.currencyCode, guaranteedBasePayMinor: shifts.guaranteedBasePayMinor, earningsModel: shifts.earningsModel, commissionBps: shifts.commissionBps, incentiveBasis: shifts.incentiveBasis, incentiveAmountMinor: shifts.incentiveAmountMinor, incentiveTargetMinor: shifts.incentiveTargetMinor })
    .from(shifts).innerJoin(outlets, eq(shifts.outletId, outlets.id))
    .where(and(eq(shifts.outletId, scope.locationId), eq(outlets.organisationId, scope.organisationId), eq(shifts.status, "PUBLISHED"), sql`${shifts.endsAt} > ${now}`));
  const offersOn = (shiftId: string) => rows.filter(row => row.shiftId === shiftId).map(row => ({ offerStatus: row.offerStatus, allocationState: row.allocationStatus, confirmedAt: row.confirmedAt }));
  const schedule = rows.map(row => ({
    ...row,
    interaction: shiftInteraction({ status: row.shiftStatus, endsAt: row.endsAt }, offersOn(row.shiftId), now),
    bonusLabel: bonusLabel(row),
    performanceLabel: !row.incentiveBasis ? "No sales target" : row.earnedMinor === null ? row.allocationStatus === "ALLOCATED" ? "Not complete yet · imported, not provider-verified" : "Not started" : `${row.earnedMinor > 0 ? "Target reached" : "Target not reached"} · imported, not provider-verified`,
    paymentLabel: paymentLabel(row.payableStatus, row.payoutStatus, row.paypalStatus),
  }));
  const gaps = published.flatMap(shift => {
    const offers = offersOn(shift.id);
    const places = shift.requiredHeadcount - offers.filter(offer => offer.offerStatus === "ACCEPTED" && offer.allocationState === "ALLOCATED").length;
    return places > 0 ? [{ shiftId: shift.id, roleName: shift.roleName, startsAt: shift.startsAt, endsAt: shift.endsAt, places, termsVersion: shift.termsVersion, interaction: shiftInteraction(shift, offers, now), currencyCode: shift.currencyCode, guaranteedBasePayMinor: shift.guaranteedBasePayMinor,
      earningsModel: shift.earningsModel, commissionBps: shift.commissionBps, bonusLabel: bonusLabel(shift), fillHref: `/manager/fill?date=${shift.shiftDate}#requirement-${shift.id}` }] : [];
  });
  return toAllocationSchedule(schedule, team, gaps);
}
