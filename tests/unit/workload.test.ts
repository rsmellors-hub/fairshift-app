import { describe, expect, it } from "vitest";
import { calculateDayWorkload, calculateWindowCapacity, casualMinutesWithin, coverageWindowsSchema, forecastTransactionWindows, formatCoverageText, formatTradingText, localInstant, parseCoverageText, parseTradingText, planningBlocks, regularMinutesWithin, resolveWorkloadPolicy, tradingWindowsSchema, transactionWorkloadMinutes, workloadPolicyInputSchema, type TransactionSlot } from "@/server/intelligence/workload";
import { outletOpportunities, selectOpportunity, windowParam } from "@/server/intelligence/opportunity";
import { outletStaffing } from "@/server/intelligence/staffing";
import { hours, TEST_FIXTURE_POLICY } from "../helpers/workload";

const TARGET = "2026-11-09", THROUGH = "2026-11-01"; // A Monday, after a run of Mondays.
const MONDAYS = ["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"];
const POLICY = { transactionsPerStaffHour: 10, minimumStaffWhileOpen: 1 }; // Test fixture.
const slot = (date: string, hour: number, transactions: number, salesMinor: number): TransactionSlot => ({ date, minute: hour * 60, transactions, salesMinor });
const everyMonday = (shape: Record<number, [number, number]>) => MONDAYS.flatMap(date => Object.entries(shape).map(([hour, [count, sales]]) => slot(date, Number(hour), count, sales)));
const day = (over: Partial<Parameters<typeof calculateDayWorkload>[0]>) => calculateDayWorkload({ date: TARGET, timezone: "Europe/London", trading: [{ start: 9 * 60, end: 11 * 60 }], coverage: [], policy: POLICY, slots: everyMonday({ 9: [20, 20_000], 10: [20, 20_000] }), dataThrough: THROUGH, allocated: [], ...over });

describe("staffing follows transactions, never sales value", () => {
  it("same sales, different transaction counts: staffing differs", () => {
    const few = day({ slots: everyMonday({ 9: [10, 100_000] }) }), many = day({ slots: everyMonday({ 9: [40, 100_000] }) });
    expect(few.blocks[0].expectedSalesMinor).toBe(many.blocks[0].expectedSalesMinor);
    expect(few.requiredMinutes).toBeLessThan(many.requiredMinutes!);
  });
  it("same transaction count, different sales: staffing is unchanged", () => {
    const low = day({ slots: everyMonday({ 9: [30, 10_000] }) }), high = day({ slots: everyMonday({ 9: [30, 900_000] }) });
    expect(low.requiredMinutes).toBe(high.requiredMinutes);
    expect(low.remainingMinutes).toBe(high.remainingMinutes);
    expect(low.periods.map(row => row.expectedSalesMinor)).not.toEqual(high.periods.map(row => row.expectedSalesMinor));
  });
  it("a pure average-bill rise changes the commercial figure and not the workload", () => {
    const base = forecastTransactionWindows({ slots: everyMonday({ 9: [30, 60_000] }), dataThrough: THROUGH, targetDate: TARGET, windows: [{ start: 540, end: 600 }] })!;
    const richer = forecastTransactionWindows({ slots: everyMonday({ 9: [30, 120_000] }), dataThrough: THROUGH, targetDate: TARGET, windows: [{ start: 540, end: 600 }] })!;
    expect(richer.windows[0].expectedSalesMinor).toBe(base.windows[0].expectedSalesMinor * 2);
    expect(richer.windows[0].expectedMilliTransactions).toBe(base.windows[0].expectedMilliTransactions);
  });
  it("more transactions raise the workload unless minimum cover is what binds", () => {
    expect(day({ slots: everyMonday({ 9: [40, 1] }) }).blocks[0].requiredMinutes).toBeGreaterThan(day({ slots: everyMonday({ 9: [20, 1] }) }).blocks[0].requiredMinutes!);
    // Floor-bound: 2 and 5 transactions both sit under one staff member's 60 minutes.
    expect(day({ slots: everyMonday({ 9: [2, 1] }) }).blocks[0].requiredMinutes).toBe(60);
    expect(day({ slots: everyMonday({ 9: [5, 1] }) }).blocks[0].requiredMinutes).toBe(60);
  });
  it("uses the required formula with explicit units, rounding demand up", () => {
    expect(transactionWorkloadMinutes(10_000, 10)).toBe(60);
    expect(transactionWorkloadMinutes(10_001, 10)).toBe(75); // Never rounded down into understaffing.
    expect(transactionWorkloadMinutes(0, 10)).toBe(0);
    expect(calculateWindowCapacity({ expectedMilliTransactions: 15_000, openMinutes: 60, regularMinutes: 30, allocatedCasualMinutes: 15, policy: POLICY })).toEqual({ workloadMinutes: 90, minimumCoverMinutes: 60, requiredMinutes: 90, regularMinutes: 30, allocatedCasualMinutes: 15, casualNeedMinutes: 60, remainingMinutes: 45 });
    expect(calculateWindowCapacity({ expectedMilliTransactions: 1_000, openMinutes: 60, regularMinutes: 500, allocatedCasualMinutes: 0, policy: POLICY }).remainingMinutes).toBe(0);
  });
});

describe("what isn't configured stays unavailable, never zero", () => {
  it("missing service policy is unavailable, with demand still shown", () => {
    const result = day({ policy: null });
    expect(result).toMatchObject({ unavailable: "NO_WORKLOAD_POLICY", requiredMinutes: null, remainingMinutes: null, indicativeShifts: null, periods: [] });
    expect(result.expectedMilliTransactions).toBe(40_000);
    expect(result.blocks[0]).toMatchObject({ requiredMinutes: null, remainingMinutes: null });
  });
  it("a policy can't exist without minimum cover or service capacity, and there is no default", () => {
    expect(workloadPolicyInputSchema.safeParse({ transactionsPerStaffHour: 10 }).success).toBe(false);
    expect(workloadPolicyInputSchema.safeParse({ minimumStaffWhileOpen: 1 }).success).toBe(false);
    expect(workloadPolicyInputSchema.safeParse({ transactionsPerStaffHour: 0, minimumStaffWhileOpen: 1 }).success).toBe(false);
    expect(workloadPolicyInputSchema.safeParse({ transactionsPerStaffHour: 2.5, minimumStaffWhileOpen: 1 }).success).toBe(false);
    expect(workloadPolicyInputSchema.safeParse({ transactionsPerStaffHour: 10, minimumStaffWhileOpen: -1 }).success).toBe(false);
    expect(workloadPolicyInputSchema.safeParse({ transactionsPerStaffHour: 10, minimumStaffWhileOpen: 0, source: "REFERENCE" }).success).toBe(false);
    expect(resolveWorkloadPolicy([], "any")).toBeNull();
    expect(() => resolveWorkloadPolicy([{ outletId: null, version: 1, transactionsPerStaffHour: 0, minimumStaffWhileOpen: 1, source: "CONFIGURED" }], "any")).toThrow();
  });
  it("a location override wins; another location's override does not apply", () => {
    const records = [{ outletId: null, version: 2, transactionsPerStaffHour: 10, minimumStaffWhileOpen: 1, source: "CONFIGURED" }, { outletId: "a", version: 1, transactionsPerStaffHour: 20, minimumStaffWhileOpen: 2, source: "CONFIGURED" }];
    expect(resolveWorkloadPolicy(records, "a")).toMatchObject({ version: "location-v1", level: "LOCATION", transactionsPerStaffHour: 20 });
    expect(resolveWorkloadPolicy(records, "b")).toMatchObject({ version: "organisation-v2", transactionsPerStaffHour: 10 });
  });
  it("missing trading hours is unavailable, and differs from a day stated as closed", () => {
    expect(day({ trading: null })).toMatchObject({ closed: null, unavailable: "TRADING_HOURS_NOT_SET", requiredMinutes: null, expectedMilliTransactions: null, blocks: [] });
    expect(day({ trading: [] })).toMatchObject({ closed: true, unavailable: null, requiredMinutes: 0, remainingMinutes: 0, expectedMilliTransactions: 0 });
  });
  it("configured zero and missing stay distinguishable", () => {
    expect(day({ coverage: null })).toMatchObject({ unavailable: "REGULAR_COVERAGE_NOT_SET", remainingMinutes: null, regularMinutes: null });
    expect(day({ coverage: null }).requiredMinutes).toBe(240); // Required is still known.
    expect(day({ coverage: [] })).toMatchObject({ unavailable: null, regularMinutes: 0, remainingMinutes: 240 });
    const zeroFloor = day({ policy: { transactionsPerStaffHour: 10, minimumStaffWhileOpen: 0 }, slots: [...everyMonday({ 12: [5, 1] })] });
    expect(zeroFloor).toMatchObject({ unavailable: null, requiredMinutes: 0 }); // Observed days, nothing in these hours.
  });
  it("no history and history with no times are unavailable, not zero demand", () => {
    expect(day({ dataThrough: null })).toMatchObject({ unavailable: "NO_FORECAST", expectedMilliTransactions: null });
    expect(day({ slots: [] })).toMatchObject({ unavailable: "NO_TIMED_HISTORY", expectedMilliTransactions: null, requiredMinutes: null });
  });
});

describe("time windows use actual overlap", () => {
  it("counts regular cover by real overlap and headcount", () => {
    const coverage = [hours(9, 12, 2), hours(12, 15, 3)];
    expect(regularMinutesWithin({ start: 600, end: 660 }, coverage)).toBe(120);
    expect(regularMinutesWithin({ start: 690, end: 750 }, coverage)).toBe(30 * 2 + 30 * 3);
    expect(regularMinutesWithin({ start: 960, end: 1020 }, coverage)).toBe(0);
  });
  it("supports arbitrary windows: quarter-hour clipping, a split day, and no fixed day-parts", () => {
    expect(planningBlocks([{ start: 7 * 60 + 30, end: 9 * 60 + 15 }, { start: 18 * 60, end: 19 * 60 }])).toEqual([{ start: 450, end: 480 }, { start: 480, end: 540 }, { start: 540, end: 555 }, { start: 1080, end: 1140 }]);
    const slots = [...MONDAYS.map(date => slot(date, 8, 8, 1)), ...MONDAYS.map(date => ({ date, minute: 7 * 60 + 30, transactions: 4, salesMinor: 1 })), ...MONDAYS.map(date => ({ date, minute: 7 * 60, transactions: 9, salesMinor: 1 }))];
    const forecast = forecastTransactionWindows({ slots, dataThrough: THROUGH, targetDate: TARGET, windows: [{ start: 450, end: 480 }, { start: 480, end: 540 }] })!;
    expect(forecast.windows.map(row => row.expectedMilliTransactions)).toEqual([4_000, 8_000]);
    expect(forecast.outsideHoursMilliTransactions).toBe(9_000); // Named, not silently lost.
  });
  it("morning surplus cannot cancel a later shortage", () => {
    // Fixture: morning needs 2 h with 6 h of cover; evening needs 2 h with none.
    const result = day({ trading: [{ start: 540, end: 600 }, { start: 1080, end: 1140 }], coverage: [hours(9, 10, 6)], policy: { transactionsPerStaffHour: 10, minimumStaffWhileOpen: 0 }, slots: everyMonday({ 9: [20, 1], 18: [20, 1] }) });
    expect(result.requiredMinutes).toBe(240);
    expect(result.regularMinutes).toBe(360); // More cover than need across the day…
    expect(result.remainingMinutes).toBe(120); // …and the evening is still short.
    expect(result.periods.map(row => [row.state, row.start, row.end, row.remainingMinutes])).toEqual([["COVERED", 540, 600, 0], ["OPEN", 1080, 1140, 120]]);
  });
  it("shows one period covered while another on the same day needs casual work", () => {
    const result = day({ trading: [{ start: 9 * 60, end: 14 * 60 }], coverage: [hours(9, 12, 2)], slots: everyMonday({ 9: [10, 1], 10: [10, 1], 11: [10, 1], 12: [30, 1], 13: [30, 1] }) });
    expect(result.periods.map(row => [row.state, row.start, row.end])).toEqual([["COVERED", 540, 720], ["OPEN", 720, 840]]);
    expect(result.periods[1]).toMatchObject({ requiredMinutes: 360, remainingMinutes: 360, peakCasualStaff: 3, expectedMilliTransactions: 60_000 });
    expect(result.indicativeShifts).toBe(3);
  });
  it("a casual shift covers only the part overlapping the window", () => {
    const window = { startsAt: new Date("2026-11-09T12:00:00Z"), endsAt: new Date("2026-11-09T13:00:00Z") };
    expect(casualMinutesWithin(window, [{ startsAt: new Date("2026-11-09T12:30:00Z"), endsAt: new Date("2026-11-09T18:00:00Z") }])).toBe(30);
    expect(casualMinutesWithin(window, [{ startsAt: new Date("2026-11-09T06:00:00Z"), endsAt: new Date("2026-11-09T12:00:00Z") }])).toBe(0);
    expect(casualMinutesWithin(window, [{ startsAt: new Date("2026-11-09T06:00:00Z"), endsAt: new Date("2026-11-09T23:00:00Z") }, { startsAt: new Date("2026-11-09T12:45:00Z"), endsAt: new Date("2026-11-09T13:30:00Z") }])).toBe(75);
    // Across blocks: a 12:30–14:00 shift gives 30 and 60 minutes, and is filled only where needed.
    const result = day({ trading: [{ start: 720, end: 900 }], slots: everyMonday({ 12: [10, 1], 13: [10, 1], 14: [10, 1] }), allocated: [{ startsAt: new Date("2026-11-09T12:30:00Z"), endsAt: new Date("2026-11-09T14:00:00Z") }] });
    expect(result.blocks.map(row => [row.allocatedCasualMinutes, row.remainingMinutes])).toEqual([[30, 30], [60, 0], [0, 60]]);
    expect(result.periods.map(row => [row.state, row.start, row.end])).toEqual([["OPEN", 720, 780], ["FILLED", 780, 840], ["OPEN", 840, 900]]);
    // Casual hours outside trading hours aren't counted.
    expect(day({ trading: [{ start: 540, end: 600 }], allocated: [{ startsAt: new Date("2026-11-09T16:00:00Z"), endsAt: new Date("2026-11-09T18:00:00Z") }] }).allocatedCasualMinutes).toBe(0);
  });
  it("keeps wall-clock hours across the clock changes", () => {
    expect(localInstant("2026-07-14", 600, "Europe/London").toISOString()).toBe("2026-07-14T09:00:00.000Z");
    expect(localInstant("2026-01-14", 600, "Europe/London").toISOString()).toBe("2026-01-14T10:00:00.000Z");
    expect(localInstant("2026-01-14", 1440, "Europe/London").toISOString()).toBe("2026-01-15T00:00:00.000Z");
    expect(localInstant("2026-10-25", 600, "Europe/London").toISOString()).toBe("2026-10-25T10:00:00.000Z"); // The day clocks go back.
    expect(() => localInstant("2026-03-29", 90, "Europe/London")).not.toThrow(); // 01:30 doesn't exist that day.
  });
});

describe("malformed configuration is refused", () => {
  it.each([
    [[{ start: 600, end: 600 }]], [[{ start: 700, end: 600 }]], [[{ start: 540, end: 720 }, { start: 660, end: 900 }]],
    [[{ start: -15, end: 60 }]], [[{ start: 0, end: 1455 }]], [[{ start: 545, end: 600 }]], [[{ start: 540.5, end: 600 }]], [[{ start: "09:00", end: 600 }]], [[{ start: 540 }]], [[{ start: 540, end: 600, extra: 1 }]],
  ])("trading windows %j", windows => { expect(tradingWindowsSchema.safeParse(windows).success).toBe(false); });
  it.each([
    [[{ start: 540, end: 600, headcount: 0 }]], [[{ start: 540, end: 600, headcount: -1 }]], [[{ start: 540, end: 600, headcount: 1.5 }]], [[{ start: 540, end: 600 }]],
    [[{ start: 540, end: 720, headcount: 1 }, { start: 600, end: 660, headcount: 1 }]], [[{ start: 600, end: 540, headcount: 1 }]],
  ])("coverage windows %j", windows => { expect(coverageWindowsSchema.safeParse(windows).success).toBe(false); });
  it("reads and refuses Owner text", () => {
    expect(parseTradingText("09:00-17:00, 18:00 – 22:00")).toEqual([{ start: 540, end: 1020 }, { start: 1080, end: 1320 }]);
    expect(parseTradingText("Closed")).toEqual([]);
    expect(parseCoverageText("07:00-12:00 x3, 12:00-15:00 ×4")).toEqual([hours(7, 12, 3), hours(12, 15, 4)]);
    expect(parseCoverageText("none")).toEqual([]);
    for (const bad of ["9am-5pm", "25:00-26:00", "17:00-09:00", "09:00-12:00, 11:00-13:00", "09:07-17:00", "0"]) expect(() => parseTradingText(bad)).toThrow();
    for (const bad of ["07:00-12:00", "07:00-12:00 x0", "07:00-12:00 x3, 11:00-13:00 x1", "lots"]) expect(() => parseCoverageText(bad)).toThrow();
    expect(formatTradingText(null)).toBe("");
    expect(formatTradingText([])).toBe("closed");
    expect(formatTradingText([{ start: 540, end: 1440 }])).toBe("09:00-24:00");
    expect(formatCoverageText(null)).toBe("");
    expect(formatCoverageText([])).toBe("none");
    expect(formatCoverageText([hours(7, 12, 3)])).toBe("07:00-12:00 x3");
  });
});

describe("the forecast method", () => {
  it("is deterministic, recency-weighted, and treats a quiet window on a trading day as zero", () => {
    const slots = [slot(MONDAYS[0], 9, 10, 1), slot(MONDAYS[1], 9, 10, 1), slot(MONDAYS[2], 9, 20, 1), slot(MONDAYS[3], 12, 1, 1)];
    const input = { slots, dataThrough: THROUGH, targetDate: TARGET, windows: [{ start: 540, end: 600 }] };
    const forecast = forecastTransactionWindows(input)!;
    expect(forecastTransactionWindows(input)).toEqual(forecast);
    expect(forecast).toMatchObject({ support: "MODERATE", basis: "SAME_WEEKDAY", comparableDays: 4 });
    // (10×1 + 10×2 + 20×3 + 0×4) / 10
    expect(forecast.windows[0].expectedMilliTransactions).toBe(9_000);
    expect(forecast.windows[0].lowerMilliTransactions).toBeLessThan(9_000);
    expect(forecast.windows[0].upperMilliTransactions).toBeGreaterThan(9_000);
  });
  it("falls back with low support on thin history, ignores data past the cutoff, and rejects a past target", () => {
    const thin = forecastTransactionWindows({ slots: [slot("2026-10-30", 9, 10, 1)], dataThrough: THROUGH, targetDate: TARGET, windows: [{ start: 540, end: 600 }] })!;
    expect(thin).toMatchObject({ support: "LOW", basis: "RECENT_OBSERVED_DAYS", comparableDays: 1 });
    expect(forecastTransactionWindows({ slots: [slot("2026-11-05", 9, 10, 1)], dataThrough: THROUGH, targetDate: TARGET, windows: [] })).toBeNull();
    expect(forecastTransactionWindows({ slots: [slot("2026-08-01", 9, 10, 1)], dataThrough: THROUGH, targetDate: TARGET, windows: [] })).toBeNull();
    expect(() => forecastTransactionWindows({ slots: [], dataThrough: TARGET, targetDate: TARGET, windows: [] })).toThrow("must follow");
  });
});

describe("opportunity demand", () => {
  const OUTLET = "11111111-1111-4111-8111-111111111111", ORG = "22222222-2222-4222-8222-222222222222";
  const forecast = { outletId: OUTLET, outletName: "A", timezone: "Europe/London", today: "2026-11-08", selection: { status: "SELECTED" as const, source: "REFERENCE" as const, currency: "GBP", kind: "HISTORICAL" as const, dataThrough: THROUGH, firstTarget: TARGET, rejected: [] }, days: [], weeklyTotalMinor: null, evidenceDays: [] };
  const weekMap = <T,>(value: T) => new Map(Array.from({ length: 7 }, (_, i) => [i + 1, { windows: value, source: "CONFIGURED" }]));
  const inputs = { trading: weekMap([{ start: 720, end: 840 }]), coverage: weekMap([hours(12, 14, 1)]), policies: [{ outletId: null, version: 3, ...TEST_FIXTURE_POLICY, source: "CONFIGURED" }], slots: everyMonday({ 12: [12, 60_000], 13: [4, 20_000] }), allocated: [], dataset: "dataset-x" };

  it("is typed with every traceable field, from the calculated figures", () => {
    const outlet = outletStaffing(ORG, forecast, inputs);
    const [row] = outletOpportunities(outlet);
    expect(row).toEqual({ organisationId: ORG, outletId: OUTLET, localDate: TARGET, windowStart: "12:00", windowEnd: "13:00", startsAt: "2026-11-09T12:00:00.000Z", endsAt: "2026-11-09T13:00:00.000Z", state: "OPEN",
      expectedTransactions: 12, lowerTransactions: 9, upperTransactions: 15, support: "MODERATE", commercial: { expectedSalesMinor: 60_000, currency: "GBP" },
      requiredMinutes: 180, regularMinutes: 60, allocatedCasualMinutes: 0, remainingCasualMinutes: 120, peakCasualStaff: 2,
      workloadMethodVersion: "transaction-windows-recency-v1", staffingMethodVersion: "transaction-capacity-windows-v1", workloadPolicyVersion: "organisation-v3",
      provenance: { source: "REFERENCE", synthetic: true, dataset: "dataset-x", dataThrough: THROUGH } });
    expect(windowParam(row)).toBe("12:00-13:00");
  });
  it("has none without a policy, and picks the window named or the largest open one", () => {
    expect(outletOpportunities(outletStaffing(ORG, forecast, { ...inputs, policies: [] }))).toEqual([]);
    const opportunities = outletOpportunities(outletStaffing(ORG, forecast, { ...inputs, trading: weekMap([{ start: 720, end: 780 }, { start: 840, end: 900 }]), coverage: weekMap([]), slots: everyMonday({ 12: [4, 1], 14: [12, 1] }) })).filter(row => row.localDate === TARGET);
    expect(opportunities.map(windowParam)).toEqual(["12:00-13:00", "14:00-15:00"]);
    expect(selectOpportunity(opportunities, undefined)?.windowStart).toBe("14:00");
    expect(selectOpportunity(opportunities, "12:00-13:00")?.windowStart).toBe("12:00");
    for (const bad of ["12:00-14:00", "<script>", "12:00", ""]) expect(selectOpportunity(opportunities, bad)?.windowStart ?? null).toBe(bad === "" ? "14:00" : null);
  });
});
