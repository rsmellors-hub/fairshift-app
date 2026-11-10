import { and, eq, gt, inArray, lt, isNull } from "drizzle-orm";
import { assertRole, type Scope } from "@/server/auth/access";
import type { DatabaseSession } from "@/server/db/client";
import { demoCapacityScenario } from "@/server/demo/capacity-scenario";
import { outletTradingHours, outlets, regularCoverageWindows, shiftOffers, shifts, workAllocations, workers, workloadPolicies, workPolicies } from "@/server/db/schema";
import { loadStoredContext, resolveOutletContext, UNAVAILABLE_CONTEXT, type AppliedContext, type ContextDay, type OutletDemandContext, type StoredContext } from "@/server/intelligence/demand-context";
import { SCENARIO_ADJUSTMENT_BPS } from "@/server/intelligence/demand-context-policy";
import { commercialContext, consolidateCommercial, type CommercialContext, type WorkRate } from "@/server/intelligence/commerce-labour";
import { LOOKBACK_DAYS, shiftDate, startOfLocalDay, type SalesSource } from "@/server/intelligence/forecast";
import { loadShiftRules, type ShiftRules } from "@/server/scheduling/shift-rules";
import { cachedPlanning, planningCacheEnabled } from "@/server/intelligence/planning-cache";
import { isDemoOrganisation } from "@/server/demo/organisation";
import { loadTransactionSlots, referenceDatasetOf, syntheticHistoryAllowed } from "@/server/intelligence/sales-history";
import { getWeeklyForecast, type OutletWeeklyForecast } from "@/server/intelligence/weekly";
import { loadLocalIntelligence, resolveLocalIntelligence, UNAVAILABLE_LOCAL, type LocalApplied, type LocalDay, type OutletLocalIntelligence, type StoredLocalIntelligence } from "@/server/intelligence/local-intelligence-service";
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
  // Present only when a Manager's accepted scenario applies to this day. The figures above then
  // include it, and the baseline is kept beside them. Sales are never adjusted.
  context?: AppliedContext & { baseline: Omit<StaffingDay, "context" | "local"> };
  // Present only when a Manager chose to use this day's AI-found adjustments. The figures above then
  // include them, and the baseline is kept beside them. Sales are never adjusted.
  local?: { decisionId: string; blocks: { start: number; bps: number }[]; baseline: Omit<StaffingDay, "context" | "local"> };
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
  // The week's casual requirement before any accepted scenario, when one applies.
  baselineTotals?: Totals | null;
  // Always set by the planning week; absent only on a hand-built record.
  demandContext?: OutletDemandContext;
  localIntelligence?: OutletLocalIntelligence;
  // The location's shift-length rules, for suggested shifts; null when it has none.
  shiftRules?: ShiftRules | null;
};

// What a week needs for one location, once read from storage.
export type WorkloadInputs = {
  trading: ReadonlyMap<number, { windows: TradingWindow[]; source: string }>;
  coverage: ReadonlyMap<number, { windows: CoverageWindow[]; source: string }>;
  policies: readonly WorkloadPolicyRecord[];
  slots: readonly TransactionSlot[];
  allocated: readonly { startsAt: Date; endsAt: Date }[];
  dataset?: string | null;
  // Accepted scenarios by planning date. Without one a day is its baseline.
  accepted?: ReadonlyMap<string, AppliedContext>;
  // AI-found adjustments a Manager chose to use, by planning date. An accepted scenario wins.
  localAccepted?: ReadonlyMap<string, LocalApplied>;
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
// onlyDate: work out that one planning day only (a preview needs nothing else); the week's totals then
// cover that day alone and aren't used.
export function outletStaffing(organisationId: string, forecast: OutletWeeklyForecast, inputs: WorkloadInputs, rates?: readonly WorkRate[], onlyDate?: string): OutletStaffing {
  const selected = forecast.selection.status === "SELECTED" ? forecast.selection : null;
  const policy = resolveWorkloadPolicy(inputs.policies, forecast.outletId);
  const firstDate = shiftDate(forecast.today, 1);
  const days = Array.from({ length: 7 }, (_, i) => shiftDate(firstDate, i)).filter(date => !onlyDate || date === onlyDate).map((planningDate): StaffingDay => {
    const commercial = forecast.days.find(day => day.targetDate === planningDate)?.forecast ?? null;
    const weekday = isoWeekday(planningDate);
    const build = (demandAdjustmentBps?: number, demandAdjustmentPeriod?: TradingWindow | null, blockAdjustmentsBps?: ReadonlyMap<number, number>): Omit<StaffingDay, "context" | "local"> => {
      const workload: DayWorkload = calculateDayWorkload({ date: planningDate, timezone: forecast.timezone, trading: inputs.trading.get(weekday)?.windows ?? null, coverage: inputs.coverage.get(weekday)?.windows ?? null,
        policy, slots: inputs.slots, dataThrough: selected?.dataThrough ?? null, allocated: inputs.allocated, demandAdjustmentBps, demandAdjustmentPeriod, blockAdjustmentsBps });
      // Without stated trading hours the only knowable casual figure is the whole local day's.
      const dayStart = startOfLocalDay(planningDate, forecast.timezone), dayEnd = startOfLocalDay(shiftDate(planningDate, 1), forecast.timezone);
      const allocatedCasualMinutes = workload.closed === null ? inputs.allocated.reduce((sum, shift) => { const shared = Math.min(shift.endsAt.getTime(), dayEnd.getTime()) - Math.max(shift.startsAt.getTime(), dayStart.getTime()); return sum + (shared > 0 ? Math.floor(shared / 60_000) : 0); }, 0) : workload.allocatedCasualMinutes;
      const { remainingMinutes, ...rest } = workload;
      return { ...rest, planningDate, forecastSalesMinor: commercial?.forecastSalesMinor ?? null, support: workload.support ?? commercial?.support ?? null, allocatedCasualMinutes,
        coverageMinutes: workload.unavailable || workload.regularMinutes === null ? null : workload.regularMinutes + allocatedCasualMinutes, casualGapMinutes: remainingMinutes };
    };
    const applied = inputs.accepted?.get(planningDate);
    if (applied) return { ...build(applied.adjustmentBps, applied.period), context: { ...applied, baseline: build() } };
    const local = inputs.localAccepted?.get(planningDate);
    return local ? { ...build(undefined, undefined, local.blocks), local: { decisionId: local.decisionId, blocks: [...local.blocks].map(([start, bps]) => ({ start, bps })), baseline: build() } } : build();
  });
  const complete = days.every(day => !day.unavailable);
  const weekTotals = (rows: readonly Omit<StaffingDay, "context" | "local">[]) => sumTotals(rows.map(day => ({ forecastSalesMinor: day.forecastSalesMinor ?? 0, expectedMilliTransactions: day.expectedMilliTransactions ?? 0, requiredMinutes: day.requiredMinutes ?? 0, regularMinutes: day.regularMinutes ?? 0,
    allocatedCasualMinutes: day.allocatedCasualMinutes, coverageMinutes: day.coverageMinutes ?? 0, casualGapMinutes: day.casualGapMinutes ?? 0, indicativeShifts: day.indicativeShifts ?? 0 })));
  return {
    organisationId, outletId: forecast.outletId, outletName: forecast.outletName, timezone: forecast.timezone,
    currency: selected?.currency ?? null, policy,
    evidence: selected && { source: selected.source, kind: selected.kind, dataThrough: selected.dataThrough, dataset: inputs.dataset ?? null,
      ageDays: Math.round((Date.parse(`${firstDate}T12:00:00Z`) - Date.parse(`${selected.dataThrough}T12:00:00Z`)) / 86_400_000) },
    regularCoverage: provenance(inputs.coverage), tradingHours: provenance(inputs.trading),
    days,
    totals: complete ? weekTotals(days) : null,
    ...(days.some(day => day.context || day.local) ? { baselineTotals: complete ? weekTotals(days.map(day => day.context?.baseline ?? day.local?.baseline ?? day)) : null } : {}),
    demandContext: UNAVAILABLE_CONTEXT,
    ...(rates ? { commercial: commercialContext(forecast, days, rates, selected?.currency ?? null) } : {}),
  };
}

// Seven-day demand and capacity per authorised outlet, by time of day: expected
// transactions, required staff capacity, regular and allocated casual coverage, and what
// remains for casual work. Deterministic and derived on read; nothing is stored, no shift
// is created and no AI is involved. A failed query rejects rather than reading as zero.
// The demo business's week is cached between requests while nothing it reads has changed (planning-cache.ts).
export async function getWeeklyStaffing(db: DatabaseSession, scope: Scope, now = new Date()) {
  assertRole(scope, ["OWNER", "MANAGER"]);
  if (!planningCacheEnabled() || !isDemoOrganisation(scope.organisationId)) return computeWeeklyStaffing(db, scope, now);
  return cachedPlanning(db, `staffing:${scope.organisationId}:${scope.role === "OWNER" ? "*" : scope.locationId}:${now.toISOString().slice(0, 10)}`, () => computeWeeklyStaffing(db, scope, now), now.getTime());
}
async function computeWeeklyStaffing(db: DatabaseSession, scope: Scope, now: Date) {
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
      .from(workPolicies).where(and(inArray(workPolicies.outletId, outletIds), isNull(workPolicies.supersededAt))),
  ]);
  // The contextual layer falls back to the baseline: if it can't be read, planning still works.
  const firstDate = weekly.outlets.map(outlet => shiftDate(outlet.today, 1)).sort()[0], lastDate = weekly.outlets.map(outlet => shiftDate(outlet.today, 7)).sort().at(-1)!;
  // Independent reads, in parallel (Day 6, Step 2). Each falls back on its own: planning still works
  // from the baseline, and without rules a location simply has no suggested shifts.
  const [stored, local, shiftRules] = await Promise.all([
    loadStoredContext(db, scope.organisationId, outletIds, firstDate, lastDate).catch((): StoredContext | null => { console.error("Demand context unavailable; planning continues from the baseline."); return null; }),
    loadLocalIntelligence(db, scope.organisationId, outletIds, firstDate, lastDate, now).catch((): StoredLocalIntelligence | null => { console.error("Local intelligence unavailable; planning continues from the baseline."); return null; }),
    loadShiftRules(db, scope.organisationId, outletIds).catch(() => { console.error("Shift rules unavailable; no shifts are suggested."); return new Map<string, ShiftRules>(); }),
  ]);
  const demoOrganisationId = syntheticHistoryAllowed(scope) ? scope.organisationId : null;
  // Each location's own chosen history only (sources and currencies are never mixed), read in parallel.
  const histories = await Promise.all(weekly.outlets.map(async outlet => {
    const selected = outlet.selection.status === "SELECTED" ? outlet.selection : null;
    const [slots, dataset] = await Promise.all([
      selected ? loadTransactionSlots(db, outlet.outletId, selected.source, selected.currency, shiftDate(selected.dataThrough, -(LOOKBACK_DAYS - 1)), selected.dataThrough, demoOrganisationId) : Promise.resolve([]),
      selected?.source === "REFERENCE" ? referenceDatasetOf(db, outlet.outletId, demoOrganisationId) : Promise.resolve(null),
    ]);
    return { slots, dataset };
  }));
  const result: OutletStaffing[] = [];
  for (const [index, outlet] of weekly.outlets.entries()) {
    const { slots, dataset } = histories[index];
    const inputs: WorkloadInputs = {
      trading: new Map(tradingRows.filter(row => row.outletId === outlet.outletId).map(row => [row.isoWeekday, { windows: tradingWindowsSchema.parse(row.windows), source: row.source }])),
      coverage: new Map(coverageRows.filter(row => row.outletId === outlet.outletId).map(row => [row.isoWeekday, { windows: coverageWindowsSchema.parse(row.windows), source: row.source }])),
      policies: policyRows, slots, dataset, allocated: allocatedRows.filter(row => row.outletId === outlet.outletId),
    };
    const rates = rateRows.filter(row => row.outletId === outlet.outletId);
    result.push({ ...withDemandContext(scope.organisationId, outlet, inputs, rates, stored, local, now), shiftRules: shiftRules.get(outlet.outletId) ?? null });
  }
  return { methodVersion: STAFFING_METHOD_VERSION, workloadMethodVersion: WORKLOAD_FORECAST_METHOD_VERSION, generatedAt: now.toISOString(), outlets: result, consolidated: consolidate(result), commercial: consolidateCommercial(result) };
}

// The baseline first, always from the same calculation. Accepted scenarios and previews are then
// the same calculation again with the fixed policy assumption, so there is no second model.
function withDemandContext(organisationId: string, forecast: OutletWeeklyForecast, inputs: WorkloadInputs, rates: readonly WorkRate[], stored: StoredContext | null, storedLocal: StoredLocalIntelligence | null, now: Date): OutletStaffing {
  const baseline = outletStaffing(organisationId, forecast, inputs, rates);
  let context: OutletDemandContext | null = null;
  if (stored) {
    try { context = resolveOutletContext({ organisationId, outletId: forecast.outletId, stored, days: baseline.days, evidence: baseline.evidence && { source: baseline.evidence.source, dataThrough: baseline.evidence.dataThrough }, evidenceDays: forecast.evidenceDays, now }); }
    catch { console.error("Demand context could not be resolved; planning continues from the baseline."); }
  }
  // AI-found adjustments, from the baseline's own blocks. They reach staffing only through a
  // Manager's current decision, and never on a day with an accepted scenario.
  let local: OutletLocalIntelligence = UNAVAILABLE_LOCAL;
  // The fictional demo business's DEMO capacity scenario, at its one location; null everywhere else.
  const demo = demoCapacityScenario({ organisationId, outletId: forecast.outletId, timeZone: forecast.timezone, now });
  if (storedLocal || demo) {
    try { local = resolveLocalIntelligence({ outletId: forecast.outletId, stored: storedLocal ?? { runs: [], signals: [], decisions: [], outcomes: [] }, days: baseline.days, scenarioDates: new Set(context?.accepted.keys() ?? []), timeZone: forecast.timezone, now, demo: demo ? [demo] : [] }); }
    catch { console.error("Local intelligence could not be resolved; planning continues from the baseline."); }
  }
  const localPreview = (day: LocalDay): LocalDay["preview"] => {
    if (!day.adjusted.length) return null;
    const adjusted = outletStaffing(organisationId, forecast, { ...inputs, localAccepted: new Map([[day.date, { decisionId: "", blocks: new Map(day.adjusted.map(block => [block.start, block.bps])) }]]) }, undefined, day.date).days.find(row => row.planningDate === day.date);
    return adjusted ? { expectedMilliTransactions: adjusted.expectedMilliTransactions, requiredMinutes: adjusted.requiredMinutes, casualGapMinutes: adjusted.casualGapMinutes, blocks: adjusted.blocks } : null;
  };
  const localView: OutletLocalIntelligence = { ...local, days: local.days.map(day => ({ ...day, preview: localPreview(day) })) };
  if (!context) return { ...(local.accepted.size ? outletStaffing(organisationId, forecast, { ...inputs, localAccepted: local.accepted }, rates) : baseline), localIntelligence: localView };
  const final = context.accepted.size || local.accepted.size ? outletStaffing(organisationId, forecast, { ...inputs, accepted: context.accepted, localAccepted: local.accepted }, rates) : baseline;
  const previewOf = (day: ContextDay): ContextDay["preview"] => {
    if (!day.proposal || day.state === "NO_SIGNAL") return null;
    const adjusted = outletStaffing(organisationId, forecast, { ...inputs, accepted: new Map([[day.date, { scenario: day.proposal.scenario, adjustmentBps: SCENARIO_ADJUSTMENT_BPS[day.proposal.scenario], period: day.proposal.period, decisionId: "", proposalId: day.proposal.id, policyVersion: "", citedSignalIds: [] }]]) }, undefined, day.date).days.find(row => row.planningDate === day.date);
    return adjusted ? { expectedMilliTransactions: adjusted.expectedMilliTransactions, requiredMinutes: adjusted.requiredMinutes, casualGapMinutes: adjusted.casualGapMinutes, blocks: adjusted.blocks } : null;
  };
  return { ...final, demandContext: { ...context, days: context.days.map(day => ({ ...day, preview: previewOf(day) })) }, localIntelligence: localView };
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
