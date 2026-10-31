import { describe, expect, it } from "vitest";
import { shiftDate, startOfLocalDay } from "@/server/intelligence/forecast";
import { calculateStaffing, LABOUR_PLANNING, minutesWithin, outletStaffing, requiredLabourMinutes, resolveLabourPolicy, type LabourPolicy } from "@/server/intelligence/staffing";
import type { OutletWeeklyForecast } from "@/server/intelligence/weekly";
import type { SalesForecast } from "@/server/intelligence/forecast";
import { resolveLocationTimezone, timezoneForCountry } from "@/server/domain/timezone";

const policy: LabourPolicy = { version: "organisation-v1", level: "ORGANISATION", source: "CONFIGURED", currency: "GBP", salesMinorPerLabourHour: 10_000, ...LABOUR_PLANNING };
const organisationGbp = { outletId: null, version: 1, currencyCode: "GBP", salesMinorPerLabourHour: 10_000, source: "CONFIGURED" };
const h = (hours: number) => hours * 60;
const gap = (required: number, regular: number, casual: number) =>
  calculateStaffing({ forecastSalesMinor: required * 10_000, regularMinutes: h(regular), allocatedCasualMinutes: h(casual), policy });

describe("required labour from forecast demand", () => {
  it("applies the supplied policy rate", () => {
    expect(policy).toMatchObject({ currency: "GBP", salesMinorPerLabourHour: 10_000, planningIncrementMinutes: 15, indicativeShiftMinutes: 480 });
    expect(requiredLabourMinutes(10_000, policy)).toBe(h(1));
    expect(requiredLabourMinutes(100_000, policy)).toBe(h(10));
    expect(requiredLabourMinutes(102_500, policy)).toBe(615); // £1,025 → 10.25 h, already on 15 minutes
    expect(requiredLabourMinutes(0, policy)).toBe(0);
  });
  it("rounds up to the next 15 minutes and never down", () => {
    expect(requiredLabourMinutes(101_000, policy)).toBe(615); // £1,010 → 10.1 h → 606 min → 615
    expect(requiredLabourMinutes(100_001, policy)).toBe(615);
    expect(requiredLabourMinutes(1, policy)).toBe(15);
    for (const sales of [9_999, 12_345, 250_050, 1_999_999]) {
      const minutes = requiredLabourMinutes(sales, policy);
      expect(minutes % 15).toBe(0);
      expect(minutes * policy.salesMinorPerLabourHour).toBeGreaterThanOrEqual(sales * 60);
      expect((minutes - 15) * policy.salesMinorPerLabourHour).toBeLessThan(sales * 60);
    }
  });
  it("uses whatever rate the policy holds, in any currency, and refuses malformed sales", () => {
    expect(requiredLabourMinutes(75_000, { ...policy, salesMinorPerLabourHour: 7_500 })).toBe(h(10));
    expect(requiredLabourMinutes(180_000, { ...policy, salesMinorPerLabourHour: 18_000 })).toBe(h(10));
    expect(requiredLabourMinutes(150_000, { ...policy, currency: "ZAR", salesMinorPerLabourHour: 150_000 })).toBe(h(1));
    expect(() => requiredLabourMinutes(-1, policy)).toThrow();
    expect(() => requiredLabourMinutes(1.5, policy)).toThrow();
  });
});

describe("casual labour gap and indicative shifts", () => {
  it("subtracts regular and allocated casual coverage from required labour", () => {
    expect(gap(20, 12, 0)).toMatchObject({ requiredMinutes: h(20), coverageMinutes: h(12), casualGapMinutes: h(8), indicativeShifts: 1 });
    expect(gap(20, 12, 4)).toMatchObject({ coverageMinutes: h(16), casualGapMinutes: h(4), indicativeShifts: 1 });
  });
  it("never produces a negative gap and keeps the underlying values", () => {
    expect(gap(20, 20, 4)).toEqual({ requiredMinutes: h(20), regularMinutes: h(20), allocatedCasualMinutes: h(4), coverageMinutes: h(24), casualGapMinutes: 0, indicativeShifts: 0 });
    expect(gap(5, 40, 0).casualGapMinutes).toBe(0);
  });
  it("sums daily gaps: surplus coverage on one day never offsets another day's shortage", () => {
    // Weekly totals are sums of daily values, and each daily gap is floored at zero.
    // So weekly gap = required − coverage + surplus on covered days, not required − coverage.
    const week = [gap(20, 12, 0), gap(10, 16, 0), gap(14, 10, 2)];
    const sum = (key: "requiredMinutes" | "coverageMinutes" | "casualGapMinutes") => week.reduce((total, day) => total + day[key], 0);
    expect([sum("requiredMinutes"), sum("coverageMinutes"), sum("casualGapMinutes")]).toEqual([h(44), h(40), h(10)]);
    expect(sum("requiredMinutes") - sum("coverageMinutes")).toBe(h(4));
    const surplus = week.reduce((total, day) => total + Math.max(0, day.coverageMinutes - day.requiredMinutes), 0);
    expect(sum("casualGapMinutes")).toBe(sum("requiredMinutes") - sum("coverageMinutes") + surplus);
  });
  it("converts the gap to indicative 8-hour shifts by rounding up", () => {
    // Demand worth exactly gapMinutes of labour, with no coverage.
    const shifts = (gapMinutes: number) => calculateStaffing({ forecastSalesMinor: gapMinutes * 10_000 / 60, regularMinutes: 0, allocatedCasualMinutes: 0, policy }).indicativeShifts;
    expect(shifts(0)).toBe(0);
    expect(shifts(h(8))).toBe(1);
    expect(shifts(h(8.25))).toBe(2);
    expect(shifts(h(15))).toBe(2);
    expect(shifts(h(16))).toBe(2);
  });
});

describe("local planning days", () => {
  it("clips a shift to each local day, including across midnight", () => {
    const shift = { startsAt: new Date("2026-10-27T22:00:00Z"), endsAt: new Date("2026-10-28T02:00:00Z") }; // GMT
    expect(minutesWithin(shift, startOfLocalDay("2026-10-27", "Europe/London"), startOfLocalDay("2026-10-28", "Europe/London"))).toBe(120);
    expect(minutesWithin(shift, startOfLocalDay("2026-10-28", "Europe/London"), startOfLocalDay("2026-10-29", "Europe/London"))).toBe(120);
    expect(minutesWithin(shift, startOfLocalDay("2026-10-29", "Europe/London"), startOfLocalDay("2026-10-30", "Europe/London"))).toBe(0);
  });
  it("uses the 25-hour London day when British Summer Time ends", () => {
    const start = startOfLocalDay("2026-10-25", "Europe/London"), end = startOfLocalDay("2026-10-26", "Europe/London");
    expect(start.toISOString()).toBe("2026-10-24T23:00:00.000Z");
    expect(end.getTime() - start.getTime()).toBe(25 * 3_600_000);
    // 00:00 BST to 02:00 GMT is three elapsed hours, all on 25 October.
    expect(minutesWithin({ startsAt: new Date("2026-10-24T23:00:00Z"), endsAt: new Date("2026-10-25T02:00:00Z") }, start, end)).toBe(180);
    // 23:30–00:30 BST: only the half hour after local midnight belongs to 25 October.
    expect(minutesWithin({ startsAt: new Date("2026-10-24T22:30:00Z"), endsAt: new Date("2026-10-24T23:30:00Z") }, start, end)).toBe(30);
  });
});

const forecast = (minor: number): SalesForecast => ({ forecastSalesMinor: minor, lowerSalesMinor: minor, upperSalesMinor: minor, support: "MODERATE",
  basis: "SAME_WEEKDAY", lookbackDays: 56, eligibleDays: 50, eligibleTransactions: 500, evidence: [{ date: "2025-12-28", salesMinor: minor, transactions: 10, usedSalesMinor: minor, weight: 1 }], drivers: ["test"] });
const week = (overrides: Partial<OutletWeeklyForecast> = {}, currency = "GBP"): OutletWeeklyForecast => ({
  outletId: "o1", outletName: "Leeds", timezone: "Europe/London", today: "2026-10-26",
  selection: { status: "SELECTED", source: "REFERENCE", currency, kind: "HISTORICAL", dataThrough: "2025-12-28", firstTarget: "2026-10-27", rejected: [] },
  days: Array.from({ length: 7 }, (_, i) => ({ targetDate: shiftDate("2026-10-27", i), forecast: forecast(200_000) })),
  weeklyTotalMinor: 1_400_000, evidenceDays: [], ...overrides,
});
const rota = new Map(Array.from({ length: 7 }, (_, i) => [i + 1, { plannedMinutes: h(12), source: "REFERENCE" }]));

describe("staffing boundaries", () => {
  it("rounds at exact and near 15-minute boundaries and handles zero and very large forecasts", () => {
    expect(requiredLabourMinutes(0, policy)).toBe(0);
    expect(requiredLabourMinutes(2_500, policy)).toBe(15); // exactly 15 minutes
    expect(requiredLabourMinutes(2_501, policy)).toBe(30);
    expect(requiredLabourMinutes(2_499, policy)).toBe(15);
    expect(requiredLabourMinutes(1, policy)).toBe(15);
    const large = requiredLabourMinutes(100_000_000_000, policy);
    expect(Number.isSafeInteger(large)).toBe(true);
    expect(large).toBe(600_000_000);
    expect(() => requiredLabourMinutes(Number.MAX_SAFE_INTEGER, policy)).toThrow(/safe/);
  });
  it("never produces a negative or non-finite gap, whichever coverage exceeds demand", () => {
    for (const [regularMinutes, allocatedCasualMinutes] of [[h(100), 0], [0, h(100)], [h(100), h(100)], [0, 0]]) for (const forecastSalesMinor of [0, 1, 50_000]) {
      const result = calculateStaffing({ forecastSalesMinor, regularMinutes, allocatedCasualMinutes, policy });
      for (const value of Object.values(result)) expect(Number.isFinite(value) && value >= 0).toBe(true);
      expect(result.casualGapMinutes).toBe(Math.max(0, result.requiredMinutes - regularMinutes - allocatedCasualMinutes));
    }
    expect(calculateStaffing({ forecastSalesMinor: 0, regularMinutes: 0, allocatedCasualMinutes: 0, policy })).toMatchObject({ requiredMinutes: 0, casualGapMinutes: 0, indicativeShifts: 0 });
  });
});

describe("labour policy resolution", () => {
  const override = { outletId: "o1", version: 3, currencyCode: "GBP", salesMinorPerLabourHour: 18_000, source: "CONFIGURED" };
  it("prefers a location override, otherwise the organisation default, and names the version", () => {
    expect(resolveLabourPolicy([organisationGbp, override], "o1", "GBP").policy).toMatchObject({ version: "location-v3", level: "LOCATION", salesMinorPerLabourHour: 18_000 });
    expect(resolveLabourPolicy([organisationGbp, override], "o2", "GBP").policy).toMatchObject({ version: "organisation-v1", level: "ORGANISATION", salesMinorPerLabourHour: 10_000 });
  });
  it("is unavailable without a policy or in another currency, with no fallback or conversion", () => {
    expect(resolveLabourPolicy([], "o1", "GBP")).toEqual({ policy: null, reason: "NO_LABOUR_POLICY" });
    expect(resolveLabourPolicy([organisationGbp], "o1", "ZAR")).toEqual({ policy: null, reason: "LABOUR_POLICY_CURRENCY_MISMATCH" });
    // A mismatched override does not fall back to a compatible organisation default.
    expect(resolveLabourPolicy([organisationGbp, { ...override, currencyCode: "ZAR" }], "o1", "GBP")).toEqual({ policy: null, reason: "LABOUR_POLICY_CURRENCY_MISMATCH" });
  });
  it("rejects a stored policy with an impossible rate rather than calculating from it", () => {
    expect(() => resolveLabourPolicy([{ ...organisationGbp, salesMinorPerLabourHour: 0 }], "o1", "GBP")).toThrow();
    expect(() => resolveLabourPolicy([{ ...organisationGbp, salesMinorPerLabourHour: -5 }], "o1", "GBP")).toThrow();
  });
});

describe("outlet planning week", () => {
  it("plans seven consecutive local dates from tomorrow and reports evidence age", () => {
    const result = outletStaffing(week(), rota, [], [organisationGbp]);
    expect(result.days.map(day => day.planningDate)).toEqual(["2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
    expect(result.evidence).toEqual({ source: "REFERENCE", kind: "HISTORICAL", dataThrough: "2025-12-28", ageDays: 303 });
    expect(result.days.every(day => day.requiredMinutes === h(20) && day.casualGapMinutes === h(8) && day.indicativeShifts === 1)).toBe(true);
    expect(result.totals).toMatchObject({ requiredMinutes: h(140), casualGapMinutes: h(56), indicativeShifts: 7, forecastSalesMinor: 1_400_000 });
  });
  it("shows a missing forecast as unavailable staffing, never as zero demand or zero gap", () => {
    const result = outletStaffing(week({ selection: { status: "NONE", rejected: [] }, days: [], weeklyTotalMinor: null }), rota, [], [organisationGbp]);
    expect(result.days).toHaveLength(7);
    for (const day of result.days) expect(day).toMatchObject({ forecastSalesMinor: null, requiredMinutes: null, casualGapMinutes: null, indicativeShifts: null, unavailable: "NO_FORECAST" });
    expect(result.totals).toBeNull();
    const oneMissing = week();
    oneMissing.days[2] = { ...oneMissing.days[2], forecast: null };
    const partial = outletStaffing(oneMissing, rota, [], [organisationGbp]);
    expect(partial.days[2]).toMatchObject({ unavailable: "NO_FORECAST", casualGapMinutes: null });
    expect(partial.days[3].casualGapMinutes).toBe(h(8));
    expect(partial.totals).toBeNull();
  });
  it("does not calculate a gap without regular coverage or a labour assumption for the currency", () => {
    const noRota = outletStaffing(week(), new Map(), [], [organisationGbp]);
    expect(noRota.days[0]).toMatchObject({ requiredMinutes: h(20), regularMinutes: null, casualGapMinutes: null, unavailable: "REGULAR_COVERAGE_NOT_SET" });
    expect(noRota.regularCoverage).toBeNull();
    const explicitZero = outletStaffing(week(), new Map(Array.from({ length: 7 }, (_, i) => [i + 1, { plannedMinutes: 0, source: "CONFIGURED" }])), [], [organisationGbp]);
    expect(explicitZero.regularCoverage).toBe("CONFIGURED");
    expect(explicitZero.days[0]).toMatchObject({ regularMinutes: 0, casualGapMinutes: h(20), unavailable: null });
    const usd = outletStaffing(week({}, "USD"), rota, [], [organisationGbp]);
    expect(usd.policy).toBeNull();
    expect(usd.days[0]).toMatchObject({ forecastSalesMinor: 200_000, requiredMinutes: null, casualGapMinutes: null, unavailable: "LABOUR_POLICY_CURRENCY_MISMATCH" });
    const none = outletStaffing(week(), rota, [], []);
    expect(none.days[0]).toMatchObject({ forecastSalesMinor: 200_000, requiredMinutes: null, coverageMinutes: null, casualGapMinutes: null, indicativeShifts: null, unavailable: "NO_LABOUR_POLICY" });
    expect(none.totals).toBeNull();
  });
  it("counts allocated casual minutes on the local day they fall in", () => {
    const result = outletStaffing(week(), rota, [
      { startsAt: new Date("2026-10-27T09:00:00Z"), endsAt: new Date("2026-10-27T13:00:00Z") },
      { startsAt: new Date("2026-10-28T22:00:00Z"), endsAt: new Date("2026-10-29T02:00:00Z") },
      { startsAt: new Date("2026-11-10T09:00:00Z"), endsAt: new Date("2026-11-10T17:00:00Z") },
    ], [organisationGbp]);
    expect(result.days.map(day => day.allocatedCasualMinutes)).toEqual([240, 120, 120, 0, 0, 0, 0]);
    expect(result.days[0]).toMatchObject({ coverageMinutes: h(16), casualGapMinutes: h(4) });
  });
});

describe("location time zones", () => {
  it("resolves from location country, then organisation country, then existing locations, and never guesses", () => {
    expect(timezoneForCountry(" United Kingdom ")).toBe("Europe/London");
    expect(timezoneForCountry("South Africa")).toBe("Africa/Johannesburg");
    expect(timezoneForCountry("United States")).toBeNull();
    expect(resolveLocationTimezone({ locationCountry: "United Kingdom", organisationCountry: "South Africa" })).toBe("Europe/London");
    expect(resolveLocationTimezone({ organisationCountry: "GB" })).toBe("Europe/London");
    expect(resolveLocationTimezone({ existingTimezones: ["Europe/London", "Europe/London"] })).toBe("Europe/London");
    expect(resolveLocationTimezone({ locationCountry: "South Africa" })).toBe("Africa/Johannesburg");
    // No zone is ever guessed: the location is refused instead.
    for (const unknown of [{}, { locationCountry: "Germany" }, { organisationCountry: "Germany" }, { existingTimezones: ["Europe/London", "Africa/Johannesburg"] }]) {
      expect(() => resolveLocationTimezone(unknown)).toThrow(expect.objectContaining({ feedback: "location-timezone-unknown" }));
    }
  });
});
