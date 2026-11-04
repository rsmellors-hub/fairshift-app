import type { Scope } from "@/server/auth/access";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { FORECAST_RESOURCE, REGULAR_RESOURCE, toAllocationSchedule, type PlanningRange } from "@/app/manager/allocation-model";
import { money } from "@/app/components/format";
import { DEMO_ORGANISATION_ID, DEMO_OUTLET_ID } from "@/server/constants";
import type { DatabaseSession } from "@/server/db/client";
import { outlets, shiftOffers, shifts, workerAvailability, workers, workAllocations, workPayables, workPayouts, workPerformanceResults } from "@/server/db/schema";
import { shiftInteraction } from "@/server/domain/shift-change";
import { isSyntheticSource, localDate, shiftDate, startOfLocalDay } from "@/server/intelligence/forecast";
import { dayOpportunities, windowParam } from "@/server/intelligence/opportunity";
import type { OutletStaffing } from "@/server/intelligence/staffing";
import { localInstant } from "@/server/intelligence/workload";

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
export async function getAllocationSchedule(db: DatabaseSession, scope:Pick<Scope,"organisationId"|"locationId"> = {organisationId:DEMO_ORGANISATION_ID,locationId:DEMO_OUTLET_ID}, now = new Date(), planning: PlanningRange[] = []) {
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
    // The same capacity rule as sending an offer: live offers and acceptances hold their places.
    const unoffered = shift.requiredHeadcount - offers.filter(offer => offer.offerStatus === "OFFERED" || offer.offerStatus === "ACCEPTED").length;
    return places > 0 ? [{ shiftId: shift.id, roleName: shift.roleName, startsAt: shift.startsAt, endsAt: shift.endsAt, places, unoffered, termsVersion: shift.termsVersion, interaction: shiftInteraction(shift, offers, now), currencyCode: shift.currencyCode, guaranteedBasePayMinor: shift.guaranteedBasePayMinor,
      earningsModel: shift.earningsModel, commissionBps: shift.commissionBps, bonusLabel: bonusLabel(shift), fillHref: `/manager/fill?date=${shift.shiftDate}#requirement-${shift.id}` }] : [];
  });
  const [outlet] = await db.select({ timezone: outlets.timezone }).from(outlets).where(and(eq(outlets.id, scope.locationId), eq(outlets.organisationId, scope.organisationId)));
  const unavailable = outlet ? await unavailableRanges(db, team.map(row => row.id), outlet.timezone, now, [...published.map(row => row.endsAt), ...planning.map(range => new Date(range.endDate))]) : [];
  return toAllocationSchedule(schedule, team, gaps, { planning, unavailable });
}

const AVAILABILITY_HORIZON_DAYS = 63;
// Each worker's stated unavailable weekdays as whole local days, from today to the last open
// shift or planning day on the schedule. Only what the worker told FairShift; a day they
// haven't set is not shown as unavailable, which is the rule the server applies to offers.
async function unavailableRanges(db: DatabaseSession, workerIds: string[], timezone: string, now: Date, horizon: Date[]): Promise<PlanningRange[]> {
  if (!workerIds.length) return [];
  const rows = await db.select({ workerId: workerAvailability.workerId, isoWeekday: workerAvailability.isoWeekday }).from(workerAvailability)
    .where(and(inArray(workerAvailability.workerId, workerIds), eq(workerAvailability.state, "UNAVAILABLE")));
  if (!rows.length) return [];
  const today = localDate(now, timezone);
  const last = horizon.reduce((latest, date) => { const day = localDate(date, timezone); return day > latest ? day : latest; }, shiftDate(today, 7));
  const days = Math.min(AVAILABILITY_HORIZON_DAYS, Math.round((Date.parse(`${last}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000) + 1);
  return Array.from({ length: days }, (_, i) => shiftDate(today, i)).flatMap(date => {
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay() || 7;
    return rows.filter(row => row.isoWeekday === weekday).map(row => ({ id: `unavailable:${row.workerId}:${date}`, resourceId: row.workerId, kind: "UNAVAILABLE" as const, name: "Unavailable",
      startDate: startOfLocalDay(date, timezone).toISOString(), endDate: startOfLocalDay(shiftDate(date, 1), timezone).toISOString(), cls: "range-unavailable", fillHref: null }));
  });
}

const hours = (minutes: number) => `${new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(minutes / 60)} h`;
const staffCount = (value: number) => new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 }).format(value);

// The planning week's calculated staffing for one location, as background ranges for the
// schedule. It is the Plan page's own calculation (getWeeklyStaffing), read and not changed:
// forecast transactions by time of day, the business's capacity policy, regular cover and
// allocated casual work. A Manager-accepted scenario is included only where the plan includes
// it. Nothing here creates a shift; an open window links to Fill shifts, which re-reads it.
export function planningRanges(outlet: OutletStaffing | null) {
  // Nothing is drawn unless at least one day can be calculated; Forecast & staffing says why.
  if (!outlet?.policy || outlet.days.every(day => day.unavailable)) return { ranges: [] as PlanningRange[], summary: null };
  const ranges: PlanningRange[] = [];
  const windows = outlet.days.flatMap(day => dayOpportunities(outlet, day));
  for (const window of windows) {
    const open = window.state === "OPEN";
    const scenario = window.acceptedContext ? " · includes your accepted scenario" : "";
    ranges.push({ id: `forecast:${window.localDate}:${windowParam(window)}`, resourceId: FORECAST_RESOURCE.id, startDate: window.startsAt, endDate: window.endsAt,
      kind: open ? "FORECAST_OPEN" : "FORECAST_FILLED", cls: open ? "range-forecast-open" : "range-forecast-filled",
      name: open ? `${hours(window.remainingCasualMinutes)} casual · up to ${window.peakCasualStaff}${scenario}` : `Filled by allocated casual${scenario}`,
      fillHref: open ? `/manager/fill?date=${window.localDate}&window=${windowParam(window)}#add-requirement` : null });
  }
  // Regular cover by planning block, joined into runs of the same number of people.
  for (const day of outlet.days) {
    let run: { start: number; end: number; staff: number } | null = null;
    const close = () => { if (run) ranges.push({ id: `regular:${day.planningDate}:${run.start}`, resourceId: REGULAR_RESOURCE.id, kind: "REGULAR", cls: "range-regular", fillHref: null,
      startDate: localInstant(day.planningDate, run.start, outlet.timezone).toISOString(), endDate: localInstant(day.planningDate, run.end, outlet.timezone).toISOString(), name: `Regular ×${staffCount(run.staff)}` }); run = null; };
    for (const block of day.blocks) {
      const staff = block.regularMinutes && block.end > block.start ? block.regularMinutes / (block.end - block.start) : 0;
      if (run && run.end === block.start && run.staff === staff) { run.end = block.end; continue; }
      close();
      if (staff > 0) run = { start: block.start, end: block.end, staff };
    }
    close();
  }
  const open = windows.filter(window => window.state === "OPEN");
  return {
    ranges,
    summary: {
      firstDate: outlet.days[0].planningDate, lastDate: outlet.days[6].planningDate,
      source: outlet.evidence ? { source: outlet.evidence.source, synthetic: isSyntheticSource(outlet.evidence.source), dataThrough: outlet.evidence.dataThrough } : null,
      unavailableDays: outlet.days.filter(day => day.unavailable).length,
      acceptedScenarios: outlet.days.filter(day => day.context).length,
      casualGapMinutes: open.reduce((sum, window) => sum + window.remainingCasualMinutes, 0),
      open: open.map(window => ({ id: `forecast:${window.localDate}:${windowParam(window)}`, date: window.localDate, windowStart: window.windowStart, windowEnd: window.windowEnd, remainingMinutes: window.remainingCasualMinutes, peakCasualStaff: window.peakCasualStaff, expectedTransactions: window.expectedTransactions, scenario: !!window.acceptedContext, fillHref: `/manager/fill?date=${window.localDate}&window=${windowParam(window)}#add-requirement` })),
    },
  };
}
export type PlanningSummary = NonNullable<ReturnType<typeof planningRanges>["summary"]>;
