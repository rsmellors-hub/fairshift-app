import { and, eq, gt, inArray, lt } from "drizzle-orm";
import { assertRole, type Scope } from "@/server/auth/access";
import type { DatabaseSession } from "@/server/db/client";
import { outletTradingHours, outlets, regularCoverageWindows, shiftOffers, shifts, workAllocations, workers, workloadPolicies, workPolicies } from "@/server/db/schema";
import { commercialContext, consolidateCommercial, type CommercialContext, type WorkRate } from "@/server/intelligence/commerce-labour";
import { LOOKBACK_DAYS, shiftDate, startOfLocalDay, type SalesSource } from "@/server/intelligence/forecast";
import { loadTransactionSlots, referenceDatasetOf } from "@/server/intelligence/sales-history";
import { getWeeklyForecast, type OutletWeeklyForecast } from "@/server/intelligence/weekly";
import { calculateDayWorkload, coverageWindowsSchema, resolveWorkloadPolicy, tradingWindowsSchema, WORKLOAD_FORECAST_METHOD_VERSION, type CoverageWindow, type DayWorkload, type PlanningBlock, type ServicePeriod, type TradingWindow, type TransactionSlot, type UnavailableReason, type WorkloadPolicy, type WorkloadPolicyRecord } from "@/server/intelligence/workload";

export const STAFFING_METHOD_VERSION = "transaction-capacity-windows-v1";

export type StaffingUnavailableReason = UnavailableReason;
export type { PlanningBlock, ServicePeriod, WorkloadPolicy };

// One planning day. Operational demand drives the staffing figures. forecastSalesMinor is
// the separate commercial forecast: context only, and never an input to them.
export type StaffingDay = {
  planningDate: string;
  forecastSalesMinor: number | null;
  support: "LOW" | "MODERATE" | null;
  closed: boolean | null;
  expectedMilliTransactions: number | null;
  lowerMilliTransactions: number | null;
  upperMilliTransactions: number | null;
  outsideHoursMilliTransactions: number | null;
  requiredMinutes: number | null;
  regularMinutes: number | null;
  allocatedCasualMinutes: number;
  coverageMinutes: number | null;
  casualNeedMinutes: number | null;
  casualGapMinutes: number | null;
  indicativeShifts: number | null;
  blocks: PlanningBlock[];
  periods: ServicePeriod[];
  unavailable: StaffingUnavailableReason | null;
};
type Totals = { forecastSalesMinor: number; expectedMilliTransactions: number; requiredMinutes: number; regularMinutes: number; allocatedCasualMinutes: number; coverageMinutes: number; casualGapMinutes: number; indicativeShifts: number };
export type OutletEvidence = { source: SalesSource; kind: "PROVIDER" | "HISTORICAL"; dataThrough: string; ageDays: number; dataset: string | null };
export type OutletStaffing = {
  organisationId: string; outletId: string; outletName: string; timezone: string;
  currency: string | null; policy: WorkloadPolicy | null;
  evidence: OutletEvidence | null;
  regularCoverage: "REFERENCE" | "CONFIGURED" | null;
  tradingHours: "REFERENCE" | "CONFIGURED" | null;
  days: StaffingDay[];
  totals: Totals | null;
  commercial?: CommercialContext;
};

// What a week needs for one location, once read from storage.
export type WorkloadInputs = {
  trading: ReadonlyMap<number, { windows: TradingWindow[]; source: string }>;
  coverage: ReadonlyMap<number, { windows: CoverageWindow[]; source: string }>;
  policies: readonly WorkloadPolicyRecord[];
  slots: readonly TransactionSlot[];
  allocated: readonly { startsAt: Date; endsAt: Date }[];
  dataset?: string | null;
};

const isoWeekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay() || 7;
const sumTotals = (rows: readonly Totals[]): Totals => rows.reduce((sum, row) => ({
  forecastSalesMinor: sum.forecastSalesMinor + row.forecastSalesMinor, expectedMilliTransactions: sum.expectedMilliTransactions + row.expectedMilliTransactions,
  requiredMinutes: sum.requiredMinutes + row.requiredMinutes, regularMinutes: sum.regularMinutes + row.regularMinutes,
  allocatedCasualMinutes: sum.allocatedCasualMinutes + row.allocatedCasualMinutes, coverageMinutes: sum.coverageMinutes + row.coverageMinutes,
  casualGapMinutes: sum.casualGapMinutes + row.casualGapMinutes, indicativeShifts: sum.indicativeShifts + row.indicativeShifts,
}), { forecastSalesMinor: 0, expectedMilliTransactions: 0, requiredMinutes: 0, regularMinutes: 0, allocatedCasualMinutes: 0, coverageMinutes: 0, casualGapMinutes: 0, indicativeShifts: 0 });

const provenance = <T,>(rows: ReadonlyMap<number, T & { source: string }>) => !rows.size ? null : [...rows.values()].some(row => row.source === "CONFIGURED") ? "CONFIGURED" as const : "REFERENCE" as const;

// Pure assembly of one outlet's planning week from its forecast and workload inputs.
export function outletStaffing(organisationId: string, forecast: OutletWeeklyForecast, inputs: WorkloadInputs, rates?: readonly WorkRate[]): OutletStaffing {
  const selected = forecast.selection.status === "SELECTED" ? forecast.selection : null;
  const policy = resolveWorkloadPolicy(inputs.policies, forecast.outletId);
  const firstDate = shiftDate(forecast.today, 1);
  const days = Array.from({ length: 7 }, (_, i): StaffingDay => {
    const planningDate = shiftDate(firstDate, i);
    const commercial = forecast.days.find(day => day.targetDate === planningDate)?.forecast ?? null;
    const weekday = isoWeekday(planningDate);
    const workload: DayWorkload = calculateDayWorkload({ date: planningDate, timezone: forecast.timezone, trading: inputs.trading.get(weekday)?.windows ?? null, coverage: inputs.coverage.get(weekday)?.windows ?? null,
      policy, slots: inputs.slots, dataThrough: selected?.dataThrough ?? null, allocated: inputs.allocated });
    // Without stated trading hours the only knowable casual figure is the whole local day's.
    const dayStart = startOfLocalDay(planningDate, forecast.timezone), dayEnd = startOfLocalDay(shiftDate(planningDate, 1), forecast.timezone);
    const allocatedCasualMinutes = workload.closed === null ? inputs.allocated.reduce((sum, shift) => { const shared = Math.min(shift.endsAt.getTime(), dayEnd.getTime()) - Math.max(shift.startsAt.getTime(), dayStart.getTime()); return sum + (shared > 0 ? Math.floor(shared / 60_000) : 0); }, 0) : workload.allocatedCasualMinutes;
    const { remainingMinutes, ...rest } = workload;
    return { ...rest, planningDate, forecastSalesMinor: commercial?.forecastSalesMinor ?? null, support: workload.support ?? commercial?.support ?? null, allocatedCasualMinutes,
      coverageMinutes: workload.unavailable || workload.regularMinutes === null ? null : workload.regularMinutes + allocatedCasualMinutes, casualGapMinutes: remainingMinutes };
  });
  const complete = days.every(day => !day.unavailable);
  return {
    organisationId, outletId: forecast.outletId, outletName: forecast.outletName, timezone: forecast.timezone,
    currency: selected?.currency ?? null, policy,
    evidence: selected && { source: selected.source, kind: selected.kind, dataThrough: selected.dataThrough, dataset: inputs.dataset ?? null,
      ageDays: Math.round((Date.parse(`${firstDate}T12:00:00Z`) - Date.parse(`${selected.dataThrough}T12:00:00Z`)) / 86_400_000) },
    regularCoverage: provenance(inputs.coverage), tradingHours: provenance(inputs.trading),
    days,
    totals: complete ? sumTotals(days.map(day => ({ forecastSalesMinor: day.forecastSalesMinor ?? 0, expectedMilliTransactions: day.expectedMilliTransactions ?? 0, requiredMinutes: day.requiredMinutes ?? 0, regularMinutes: day.regularMinutes ?? 0,
      allocatedCasualMinutes: day.allocatedCasualMinutes, coverageMinutes: day.coverageMinutes ?? 0, casualGapMinutes: day.casualGapMinutes ?? 0, indicativeShifts: day.indicativeShifts ?? 0 }))) : null,
    ...(rates ? { commercial: commercialContext(forecast, days, rates, selected?.currency ?? null) } : {}),
  };
}

// Seven-day demand and capacity per authorised outlet, by time of day: expected
// transactions, required staff capacity, regular and allocated casual coverage, and what
// remains for casual work. Deterministic and derived on read; nothing is stored, no shift
// is created and no AI is involved. A failed query rejects rather than reading as zero.
export async function getWeeklyStaffing(db: DatabaseSession, scope: Scope, now = new Date()) {
  assertRole(scope, ["OWNER", "MANAGER"]);
  const weekly = await getWeeklyForecast(db, scope, now);
  const outletIds = weekly.outlets.map(outlet => outlet.outletId);
  if (!outletIds.length) return { methodVersion: STAFFING_METHOD_VERSION, workloadMethodVersion: WORKLOAD_FORECAST_METHOD_VERSION, generatedAt: now.toISOString(), outlets: [], consolidated: null, commercial: null };
  const windows = weekly.outlets.map(outlet => ({ start: startOfLocalDay(shiftDate(outlet.today, 1), outlet.timezone), end: startOfLocalDay(shiftDate(outlet.today, 8), outlet.timezone) }));
  const from = new Date(Math.min(...windows.map(w => w.start.getTime()))), to = new Date(Math.max(...windows.map(w => w.end.getTime())));
  const [policyRows, tradingRows, coverageRows, allocatedRows, rateRows] = await Promise.all([
    db.select({ outletId: workloadPolicies.outletId, version: workloadPolicies.version, transactionsPerStaffHour: workloadPolicies.transactionsPerStaffHour, minimumStaffWhileOpen: workloadPolicies.minimumStaffWhileOpen, source: workloadPolicies.source })
      .from(workloadPolicies).where(and(eq(workloadPolicies.organisationId, scope.organisationId), eq(workloadPolicies.status, "ACTIVE"))),
    db.select().from(outletTradingHours).where(and(eq(outletTradingHours.organisationId, scope.organisationId), inArray(outletTradingHours.outletId, outletIds))),
    db.select().from(regularCoverageWindows).where(and(eq(regularCoverageWindows.organisationId, scope.organisationId), inArray(regularCoverageWindows.outletId, outletIds))),
    // Only final allocations of location-bound casual workers count. Offers,
    // pending or declined responses and acceptances awaiting allocation do not.
    db.select({ outletId: shifts.outletId, startsAt: shifts.startsAt, endsAt: shifts.endsAt }).from(workAllocations)
      .innerJoin(shiftOffers, eq(shiftOffers.id, workAllocations.offerId))
      .innerJoin(shifts, eq(shifts.id, shiftOffers.shiftId))
      .innerJoin(outlets, eq(outlets.id, shifts.outletId))
      .innerJoin(workers, eq(workers.id, shiftOffers.workerId))
      .where(and(eq(outlets.organisationId, scope.organisationId), inArray(shifts.outletId, outletIds),
        eq(workers.organisationId, scope.organisationId), eq(workers.locationId, shifts.outletId), eq(workers.workerType, "CASUAL"),
        eq(workAllocations.state, "ALLOCATED"), eq(shiftOffers.status, "ACCEPTED"), inArray(shifts.status, ["PUBLISHED", "COMPLETED"]),
        lt(shifts.startsAt, to), gt(shifts.endsAt, from))),
    // The location's own terms price its gap; there is no default rate.
    db.select({ outletId: workPolicies.outletId, earningsModel: workPolicies.earningsModel, rateMinor: workPolicies.rateMinor, currencyCode: workPolicies.currencyCode })
      .from(workPolicies).where(inArray(workPolicies.outletId, outletIds)),
  ]);
  const result: OutletStaffing[] = [];
  for (const outlet of weekly.outlets) {
    const selected = outlet.selection.status === "SELECTED" ? outlet.selection : null;
    // One location's own chosen history only: sources and currencies are never mixed.
    const slots = selected ? await loadTransactionSlots(db, outlet.outletId, selected.source, selected.currency, shiftDate(selected.dataThrough, -(LOOKBACK_DAYS - 1)), selected.dataThrough) : [];
    const dataset = selected?.source === "REFERENCE" ? await referenceDatasetOf(db, outlet.outletId) : null;
    result.push(outletStaffing(scope.organisationId, outlet, {
      trading: new Map(tradingRows.filter(row => row.outletId === outlet.outletId).map(row => [row.isoWeekday, { windows: tradingWindowsSchema.parse(row.windows), source: row.source }])),
      coverage: new Map(coverageRows.filter(row => row.outletId === outlet.outletId).map(row => [row.isoWeekday, { windows: coverageWindowsSchema.parse(row.windows), source: row.source }])),
      policies: policyRows, slots, dataset, allocated: allocatedRows.filter(row => row.outletId === outlet.outletId),
    }, rateRows.filter(row => row.outletId === outlet.outletId)));
  }
  return { methodVersion: STAFFING_METHOD_VERSION, workloadMethodVersion: WORKLOAD_FORECAST_METHOD_VERSION, generatedAt: now.toISOString(), outlets: result, consolidated: consolidate(result), commercial: consolidateCommercial(result) };
}

// Company totals only when every outlet has a complete week on the same dates, in the same
// currency. Each location's hours come from its own policy; hours add up, policies don't.
function consolidate(rows: readonly OutletStaffing[]) {
  const [first] = rows;
  if (!first?.totals || !rows.every(row => row.totals && row.currency === first.currency && row.days[0].planningDate === first.days[0].planningDate)) return null;
  return { currency: first.currency!, firstDate: first.days[0].planningDate, lastDate: first.days[6].planningDate,
    totals: sumTotals(rows.map(row => row.totals!)) };
}

export type WeeklyStaffing = Awaited<ReturnType<typeof getWeeklyStaffing>>;
