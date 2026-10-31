import { describe, expect, it } from "vitest";
import { backtestForecast, commercialContext, consolidateCommercial, estimateCasualCost } from "@/server/intelligence/commerce-labour";
import { shiftDate, type DailySales, type SalesForecast } from "@/server/intelligence/forecast";
import type { OutletStaffing, StaffingDay } from "@/server/intelligence/staffing";
import type { OutletWeeklyForecast } from "@/server/intelligence/weekly";

const THROUGH = "2026-10-25", FIRST = "2026-10-27";
const history = (value: (date: string) => number, count = 56): DailySales[] => Array.from({ length: count }, (_, i) => shiftDate(THROUGH, -(count - 1 - i))).map(date => ({ date, salesMinor: value(date), transactions: 10 }));
const prediction = (minor: number): SalesForecast => ({ forecastSalesMinor: minor, lowerSalesMinor: minor - 100, upperSalesMinor: minor + 100, support: "MODERATE", basis: "SAME_WEEKDAY", lookbackDays: 56, eligibleDays: 50, eligibleTransactions: 500, evidence: [{ date: THROUGH, salesMinor: minor, transactions: 1, usedSalesMinor: minor, weight: 1 }], drivers: ["d"] });
const week = (forecastMinor: number | null, evidence: DailySales[]): OutletWeeklyForecast => ({ outletId: "o", outletName: "A", timezone: "UTC", today: "2026-10-26",
  selection: { status: "SELECTED", source: "IMPORTED", currency: "GBP", kind: "HISTORICAL", dataThrough: THROUGH, firstTarget: FIRST, rejected: [] },
  days: Array.from({ length: 7 }, (_, i) => ({ targetDate: shiftDate(FIRST, i), forecast: forecastMinor === null ? null : prediction(forecastMinor) })), weeklyTotalMinor: forecastMinor === null ? null : forecastMinor * 7, evidenceDays: evidence });
const day = (over: Partial<StaffingDay> = {}): StaffingDay => ({ planningDate: FIRST, forecastSalesMinor: 100_000, support: "MODERATE", requiredMinutes: 600, regularMinutes: 480, allocatedCasualMinutes: 60, coverageMinutes: 540, casualGapMinutes: 60, indicativeShifts: 1, unavailable: null, ...over });
const days = (over: Partial<StaffingDay> = {}) => Array.from({ length: 7 }, () => day(over));
const hourly = { earningsModel: "HOURLY", rateMinor: 1500, currencyCode: "GBP" };
const flat = () => history(() => 100_000);

describe("commerce to labour economics", () => {
  it("derives every figure from its inputs", () => {
    const c = commercialContext(week(120_000, flat()), days(), [hourly, { earningsModel: "DAILY", rateMinor: 10_000, currencyCode: "GBP" }], "GBP");
    expect(c.recent).toEqual({ start: "2026-10-19", end: THROUGH, salesMinor: 700_000, transactions: 70, observedDays: 7, averageTransactionMinor: 10_000 });
    expect(c.forecast).toEqual({ totalMinor: 840_000, lowerMinor: 839_300, upperMinor: 840_700 });
    expect(c.comparable).toEqual({ salesMinor: 700_000, deltaMinor: 140_000, deltaBps: 2000 });
    expect(c.casual).toEqual({ needMinutes: 840, allocatedMinutes: 420, allocatedBps: 5000 });
    // 420 gap minutes at 15.00/hour = 105.00; 7 indicative shifts at 100.00/day = 700.00.
    expect(c.cost).toEqual({ lowMinor: 10_500, highMinor: 70_000, policies: 2, lowBpsOfForecast: 125, highBpsOfForecast: 833 });
    expect(c.plannedSalesPerHourMinor).toBe(Math.round(840_000 * 60 / (540 * 7)));
  });
  it("a calculated zero gap is a zero cost; a missing gap is no cost at all", () => {
    expect(commercialContext(week(100_000, flat()), days({ casualGapMinutes: 0, indicativeShifts: 0 }), [hourly], "GBP").cost).toMatchObject({ lowMinor: 0, highMinor: 0 });
    const missing = commercialContext(week(100_000, flat()), days({ unavailable: "REGULAR_COVERAGE_NOT_SET", regularMinutes: null, coverageMinutes: null, casualGapMinutes: null, indicativeShifts: null }), [hourly], "GBP");
    expect(missing).toMatchObject({ cost: null, costUnavailable: "GAP_UNAVAILABLE", casual: null, plannedSalesPerHourMinor: null });
  });
  it("never invents a rate: no policy, a commission policy or another currency gives no cost", () => {
    for (const rates of [[], [{ earningsModel: "COMMISSION", rateMinor: null, currencyCode: "GBP" }], [{ ...hourly, currencyCode: "USD" }]]) {
      expect(commercialContext(week(100_000, flat()), days(), rates, "GBP")).toMatchObject({ cost: null, costUnavailable: "NO_WORK_POLICY" });
    }
  });
  it("gives no percentage of forecast sales when the forecast is zero", () => {
    expect(commercialContext(week(0, flat()), days(), [hourly], "GBP").cost).toMatchObject({ lowBpsOfForecast: null, highBpsOfForecast: null });
  });
  it("has no forecast figures without a forecast, rather than zeros", () => {
    expect(commercialContext(week(null, flat()), days(), [hourly], "GBP")).toMatchObject({ forecast: null, comparable: null });
  });
  it("leaves comparable unavailable when a weekday has no recent observation, and falls back one week for one closure", () => {
    const noMondays = flat().filter(row => new Date(`${row.date}T12:00:00Z`).getUTCDay() !== 1);
    expect(commercialContext(week(100_000, noMondays), days(), [hourly], "GBP").comparable).toBeNull();
    const closed = flat().filter(row => row.date !== shiftDate(THROUGH, -1));
    expect(commercialContext(week(100_000, closed), days(), [hourly], "GBP").comparable?.salesMinor).toBe(700_000);
  });
  it("does not count a cost share or sales figure as zero for a location with no evidence", () => {
    const none: OutletWeeklyForecast = { ...week(null, []), selection: { status: "NONE", rejected: [] }, days: [] };
    const c = commercialContext(none, days({ unavailable: "NO_FORECAST", requiredMinutes: null, regularMinutes: null, coverageMinutes: null, casualGapMinutes: null, indicativeShifts: null }), [hourly], null);
    expect(c).toMatchObject({ recent: null, forecast: null, comparable: null, cost: null, backtest: null, plannedSalesPerHourMinor: null });
  });
  it("prices daily terms by indicative shift and hourly by minute, rounding cost up", () => {
    expect(estimateCasualCost(61, 1, [hourly], "GBP")).toEqual({ lowMinor: 1525, highMinor: 1525, policies: 1 });
    expect(estimateCasualCost(61, 1, [{ earningsModel: "DAILY", rateMinor: 8000, currencyCode: "GBP" }], "GBP")).toEqual({ lowMinor: 8000, highMinor: 8000, policies: 1 });
  });
});

describe("forecast backtest", () => {
  it("reports no error on a perfectly steady history and uses only earlier days", () => {
    expect(backtestForecast(flat(), THROUGH)).toMatchObject({ errorBps: 0, biasBps: 0 });
  });
  it("detects a step change as error and bias", () => {
    const stepped = history(date => date >= shiftDate(THROUGH, -6) ? 200_000 : 100_000);
    const result = backtestForecast(stepped, THROUGH)!;
    expect(result.errorBps).toBeGreaterThan(0);
    expect(result.biasBps).toBeLessThan(0);
  });
  it("refuses to claim anything from too little comparable history", () => {
    expect(backtestForecast(history(() => 100_000, 20), THROUGH)).toBeNull();
    expect(backtestForecast([], THROUGH)).toBeNull();
    expect(backtestForecast(history(() => 0), THROUGH)).toBeNull();
  });
});

describe("company consolidation", () => {
  const outlet = (currency: string | null, source: "IMPORTED" | "REFERENCE", gap = 60): OutletStaffing => ({ outletId: currency ?? "x", outletName: "A", timezone: "UTC", currency, policy: null, evidence: { source, kind: "HISTORICAL", dataThrough: THROUGH, ageDays: 2 }, regularCoverage: "CONFIGURED", days: days({ casualGapMinutes: gap }), totals: null,
    commercial: commercialContext(week(100_000, flat()), days({ casualGapMinutes: gap }), [hourly], currency) });
  it("sums only when every location shares a currency, and says if evidence is mixed", () => {
    expect(consolidateCommercial([outlet("GBP", "IMPORTED"), outlet("GBP", "IMPORTED")])).toMatchObject({ currency: "GBP", singleSource: true, forecast: { totalMinor: 1_400_000 } });
    expect(consolidateCommercial([outlet("GBP", "IMPORTED"), outlet("GBP", "REFERENCE")])).toMatchObject({ singleSource: false });
    expect(consolidateCommercial([outlet("GBP", "IMPORTED"), outlet("USD", "IMPORTED")])).toBeNull();
  });
  it("gives no partial company cost when one location cannot be priced", () => {
    const priced = outlet("GBP", "IMPORTED");
    const unpriced: OutletStaffing = { ...outlet("GBP", "IMPORTED"), commercial: { ...priced.commercial!, cost: null, costUnavailable: "NO_WORK_POLICY" } };
    expect(consolidateCommercial([priced, unpriced])?.cost).toBeNull();
  });
});
