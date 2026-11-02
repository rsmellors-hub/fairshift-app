import { and, eq, inArray } from "drizzle-orm";
import { assertRole, type Scope } from "@/server/auth/access";
import type { DatabaseSession } from "@/server/db/client";
import { outlets, workPayables, workPayouts, workPerformanceResults } from "@/server/db/schema";
import { forecastFromHistory, shiftDate, type DailySales } from "@/server/intelligence/forecast";
import type { OutletStaffing, StaffingDay } from "@/server/intelligence/staffing";
import type { OutletWeeklyForecast } from "@/server/intelligence/weekly";

// What one location's commerce implies for labour and money. Deterministic, derived on
// read, and only from recorded or configured inputs. A value that cannot be supported is
// null with its reason, never zero; a calculated zero is a real zero. Nothing here is a
// saving, a return on investment or a causal claim.

const BACKTEST_DAYS = 28;
const BACKTEST_MINIMUM = 14;
const bps = (part: number, whole: number) => whole > 0 ? Math.round(part * 10_000 / whole) : null;
const sum = <T,>(rows: readonly T[], value: (row: T) => number) => rows.reduce((total, row) => total + value(row), 0);
const weekdayOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

export type WorkRate = { earningsModel: string; rateMinor: number | null; currencyCode: string };
export type CostUnavailable = "GAP_UNAVAILABLE" | "NO_WORK_POLICY";
export type CommercialContext = {
  // Latest seven days of the chosen evidence: factual for that source.
  recent: { start: string; end: string; salesMinor: number; transactions: number; observedDays: number; averageTransactionMinor: number | null } | null;
  forecast: { totalMinor: number; lowerMinor: number; upperMinor: number } | null;
  // The latest observed matching weekday in the evidence for each planning day.
  comparable: { salesMinor: number; deltaMinor: number; deltaBps: number | null } | null;
  // Casual need before allocations, and how much of it is already allocated.
  casual: { needMinutes: number; allocatedMinutes: number; allocatedBps: number | null } | null;
  // The remaining gap priced across the location's own work policies. Regular staff
  // wages are not known to FairShift, so this is never total labour cost.
  cost: { lowMinor: number; highMinor: number; policies: number; lowBpsOfForecast: number | null; highBpsOfForecast: number | null } | null;
  costUnavailable: CostUnavailable | null;
  // Planned, not measured: forecast sales over planned coverage hours. Actual hours are not recorded.
  plannedSalesPerHourMinor: number | null;
  // Each recent day forecast from only the days before it. A backtest on this evidence, not live accuracy.
  backtest: { days: number; errorBps: number; biasBps: number; from: string; to: string } | null;
};

export function backtestForecast(history: readonly DailySales[], dataThrough: string) {
  const start = shiftDate(dataThrough, -(BACKTEST_DAYS - 1));
  const rows = history.filter(day => day.date >= start && day.date <= dataThrough && day.transactions > 0)
    .flatMap(day => {
      const forecast = forecastFromHistory({ days: history, dataThrough: shiftDate(day.date, -1), targetDate: day.date });
      // Only days with real comparable weekdays behind them are a fair test.
      return forecast?.basis === "SAME_WEEKDAY" ? [{ date: day.date, actual: day.salesMinor, predicted: forecast.forecastSalesMinor }] : [];
    });
  const actual = sum(rows, row => row.actual);
  if (rows.length < BACKTEST_MINIMUM || actual <= 0) return null;
  return { days: rows.length, errorBps: bps(sum(rows, row => Math.abs(row.predicted - row.actual)), actual)!, biasBps: bps(sum(rows, row => row.predicted - row.actual), actual)!, from: rows[0].date, to: rows.at(-1)!.date };
}

export function estimateCasualCost(gapMinutes: number, indicativeShifts: number, rates: readonly WorkRate[], currency: string) {
  const costs = rates.filter(rate => rate.currencyCode === currency && rate.rateMinor !== null).flatMap(rate =>
    rate.earningsModel === "HOURLY" ? [Math.ceil(gapMinutes * rate.rateMinor! / 60)] : rate.earningsModel === "DAILY" ? [indicativeShifts * rate.rateMinor!] : []);
  return costs.length ? { lowMinor: Math.min(...costs), highMinor: Math.max(...costs), policies: costs.length } : null;
}

export function commercialContext(forecast: OutletWeeklyForecast, days: readonly StaffingDay[], rates: readonly WorkRate[], currency: string | null): CommercialContext {
  const selected = forecast.selection.status === "SELECTED" ? forecast.selection : null;
  const history = selected ? forecast.evidenceDays.filter(day => day.date <= selected.dataThrough) : [];
  const dataThrough = selected?.dataThrough ?? null;

  const recentRows = dataThrough ? history.filter(day => day.date >= shiftDate(dataThrough, -6)) : [];
  const recentSales = sum(recentRows, row => row.salesMinor), recentTransactions = sum(recentRows, row => row.transactions);
  const recent = dataThrough && recentRows.length ? { start: shiftDate(dataThrough, -6), end: dataThrough, salesMinor: recentSales, transactions: recentTransactions, observedDays: recentRows.length, averageTransactionMinor: recentTransactions ? Math.round(recentSales / recentTransactions) : null } : null;

  const predictions = forecast.days.flatMap(day => day.forecast ? [day] : []);
  const complete = predictions.length === 7;
  const total = complete ? sum(predictions, day => day.forecast!.forecastSalesMinor) : null;
  const weekly = complete ? { totalMinor: total!, lowerMinor: sum(predictions, day => day.forecast!.lowerSalesMinor), upperMinor: sum(predictions, day => day.forecast!.upperSalesMinor) } : null;

  const matched = complete && dataThrough ? predictions.map(day => {
    // Latest observed matching weekday; a closure a week ago falls back one more week.
    const lowest = shiftDate(dataThrough, -13);
    return history.findLast(row => row.date >= lowest && weekdayOf(row.date) === weekdayOf(day.targetDate))?.salesMinor ?? null;
  }) : [];
  const comparableSales = matched.length === 7 && matched.every(value => value !== null) ? sum(matched, value => value!) : null;
  const comparable = comparableSales !== null ? { salesMinor: comparableSales, deltaMinor: total! - comparableSales, deltaBps: bps(total! - comparableSales, comparableSales) } : null;

  const known = days.every(day => !day.unavailable);
  const needMinutes = known ? sum(days, day => day.casualNeedMinutes!) : null;
  const allocatedMinutes = sum(days, day => day.allocatedCasualMinutes);
  const casual = needMinutes !== null ? { needMinutes, allocatedMinutes, allocatedBps: bps(Math.min(allocatedMinutes, needMinutes), needMinutes) } : null;

  const gap = known ? sum(days, day => day.casualGapMinutes!) : null, shifts = known ? sum(days, day => day.indicativeShifts!) : null;
  const priced = gap !== null && currency ? estimateCasualCost(gap, shifts!, rates, currency) : null;
  const cost = priced && total !== null ? { ...priced, lowBpsOfForecast: bps(priced.lowMinor, total), highBpsOfForecast: bps(priced.highMinor, total) } : null;

  const coverage = known ? sum(days, day => day.coverageMinutes!) : 0;
  return {
    recent, forecast: weekly, comparable, casual, cost,
    costUnavailable: cost ? null : gap === null ? "GAP_UNAVAILABLE" : "NO_WORK_POLICY",
    plannedSalesPerHourMinor: known && total !== null && coverage > 0 ? Math.round(total * 60 / coverage) : null,
    backtest: dataThrough ? backtestForecast(history, dataThrough) : null,
  };
}

// Company totals only when every location has the figure in one currency; a partial
// sum would read as the whole business.
export function consolidateCommercial(rows: readonly OutletStaffing[]) {
  const [first] = rows;
  if (!first?.currency || !rows.every(row => row.currency === first.currency && row.commercial)) return null;
  const contexts = rows.map(row => row.commercial!);
  const all = <T,>(pick: (row: CommercialContext) => T | null) => { const values = contexts.map(pick); return values.every(value => value !== null) ? values as T[] : null; };
  const recent = all(row => row.recent), forecast = all(row => row.forecast), comparable = all(row => row.comparable), casual = all(row => row.casual), cost = all(row => row.cost);
  const total = forecast ? sum(forecast, row => row.totalMinor) : null;
  const comparableTotal = comparable ? sum(comparable, row => row.salesMinor) : null;
  const low = cost ? sum(cost, row => row.lowMinor) : null, high = cost ? sum(cost, row => row.highMinor) : null;
  const sources = [...new Set(rows.map(row => row.evidence?.source ?? null))];
  return {
    currency: first.currency, singleSource: sources.length === 1 && sources[0] !== null,
    recent: recent && { salesMinor: sum(recent, row => row.salesMinor), transactions: sum(recent, row => row.transactions) },
    forecast: forecast && { totalMinor: total!, lowerMinor: sum(forecast, row => row.lowerMinor), upperMinor: sum(forecast, row => row.upperMinor) },
    comparable: comparable && total !== null ? { salesMinor: comparableTotal!, deltaMinor: total - comparableTotal!, deltaBps: bps(total - comparableTotal!, comparableTotal!) } : null,
    casual: casual && { needMinutes: sum(casual, row => row.needMinutes), allocatedMinutes: sum(casual, row => row.allocatedMinutes) },
    cost: cost && { lowMinor: low!, highMinor: high!, lowBpsOfForecast: total === null ? null : bps(low!, total), highBpsOfForecast: total === null ? null : bps(high!, total) },
  };
}
export type CommercialSummary = NonNullable<ReturnType<typeof consolidateCommercial>>;

// What actually happened to confirmed casual work, per location and currency. Attributed
// sales come from imported evidence and stay labelled as not provider-verified.
export async function getWorkOutcomes(db: DatabaseSession, scope: Pick<Scope, "organisationId" | "locationId" | "role">) {
  assertRole(scope as Scope, ["OWNER", "MANAGER"]);
  const locations = await db.select({ id: outlets.id }).from(outlets)
    .where(and(eq(outlets.organisationId, scope.organisationId), scope.role === "OWNER" ? undefined : eq(outlets.id, scope.locationId)));
  if (!locations.length) return [];
  const ids = locations.map(row => row.id);
  const rows = await db.select({ outletId: workPayables.outletId, currency: workPayables.currencyCode, base: workPayables.baseAmountMinor, incentive: workPayables.incentiveAmountMinor,
    payoutStatus: workPayouts.status, payoutMinor: workPayouts.amountMinor, attributedMinor: workPerformanceResults.salesMinor, attributedCount: workPerformanceResults.salesCount })
    .from(workPayables).leftJoin(workPayouts, eq(workPayouts.payableId, workPayables.id))
    .leftJoin(workPerformanceResults, eq(workPerformanceResults.allocationId, workPayables.allocationId))
    .where(and(eq(workPayables.organisationId, scope.organisationId), inArray(workPayables.outletId, ids)));
  const groups = new Map<string, { outletId: string; currency: string; confirmedShifts: number; confirmedPayMinor: number; paidMinor: number; attributedSalesMinor: number; attributedSalesCount: number; payWithAttributionMinor: number; shiftsWithAttribution: number }>();
  for (const row of rows) {
    const key = `${row.outletId}:${row.currency}`;
    const group = groups.get(key) ?? { outletId: row.outletId, currency: row.currency, confirmedShifts: 0, confirmedPayMinor: 0, paidMinor: 0, attributedSalesMinor: 0, attributedSalesCount: 0, payWithAttributionMinor: 0, shiftsWithAttribution: 0 };
    const pay = row.base + (row.incentive ?? 0);
    group.confirmedShifts++; group.confirmedPayMinor += pay;
    if (row.payoutStatus === "PAID") group.paidMinor += row.payoutMinor ?? 0;
    if (row.attributedMinor !== null) { group.attributedSalesMinor += row.attributedMinor; group.attributedSalesCount += row.attributedCount ?? 0; group.payWithAttributionMinor += pay; group.shiftsWithAttribution++; }
    groups.set(key, group);
  }
  return [...groups.values()];
}
export type WorkOutcome = Awaited<ReturnType<typeof getWorkOutcomes>>[number];
