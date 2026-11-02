import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contextJsonSchema, CONTEXT_INSTRUCTIONS, prepareContextInput, validateContextOutput } from "@/server/intelligence/demand-context-contract";
import { applyDemandAdjustment, DEMAND_CONTEXT_POLICY_VERSION, DEMAND_SCENARIOS, SCENARIO_ADJUSTMENT_BPS } from "@/server/intelligence/demand-context-policy";
import { bankHolidayDivision, bankHolidaySignal, momentumSignal, type ContextSignal } from "@/server/intelligence/demand-signals";
import { shiftDate } from "@/server/intelligence/forecast";
import { calculateDayWorkload, type TransactionSlot } from "@/server/intelligence/workload";
import { UK_BANK_HOLIDAYS } from "@/server/reference/uk-bank-holidays";

const ORG = "org-1", OUTLET = "outlet-1", DATE = "2026-11-06";
const signal = (over: Partial<ContextSignal> = {}): ContextSignal => ({ id: `ctx_${"a".repeat(24)}`, organisationId: ORG, outletId: OUTLET, type: "MANAGER_ENTERED", validFrom: DATE, validTo: DATE, direction: "UP", provenance: "MANAGER_ENTERED", sourceLabel: "Manager entered, not independently verified", sourceRef: null, summary: "Market outside", metadata: {}, enteredBy: "user-1", createdAt: null, withdrawnAt: null, ...over });
const validate = (raw: unknown, signals: ContextSignal[] = [signal()], fingerprints = { inputFingerprint: "f", currentFingerprint: "f" }) => validateContextOutput(raw, { organisationId: ORG, outletId: OUTLET, date: DATE, signals, ...fingerprints });
const output = (over: Record<string, unknown> = {}) => ({ scenario: "MINOR_UP", citedSignalIds: [signal().id], reason: "The market outside is likely to bring extra footfall.", ...over });
const codeOf = (result: ReturnType<typeof validate>) => result.ok ? "OK" : result.code;

describe("the fixed scenario policy", () => {
  it("maps each scenario to exactly the Owner's assumption", () => {
    expect(SCENARIO_ADJUSTMENT_BPS).toEqual({ NONE: 0, MINOR_UP: 500, MODERATE_UP: 1000, MINOR_DOWN: -500, MODERATE_DOWN: -1000 });
    expect(DEMAND_SCENARIOS).toEqual(["NONE", "MINOR_UP", "MODERATE_UP", "MINOR_DOWN", "MODERATE_DOWN"]);
    expect(DEMAND_CONTEXT_POLICY_VERSION).toBe("fs-demand-context-policy-v1");
    expect(Object.isFrozen(SCENARIO_ADJUSTMENT_BPS)).toBe(true);
  });
  it("applies the assumption in reproducible integer arithmetic", () => {
    expect(applyDemandAdjustment(12_000, 0)).toBe(12_000);
    expect(applyDemandAdjustment(12_000, 500)).toBe(12_600);
    expect(applyDemandAdjustment(12_000, 1000)).toBe(13_200);
    expect(applyDemandAdjustment(12_000, -500)).toBe(11_400);
    expect(applyDemandAdjustment(12_000, -1000)).toBe(10_800);
    expect(applyDemandAdjustment(1, 500)).toBe(1); // 1.05 rounds to 1
    expect(applyDemandAdjustment(10, 500)).toBe(11); // 10.5 rounds half up
  });
  it("refuses any number outside the policy, so nothing else can reach staffing this way", () => {
    for (const bps of [1, 499, 1001, 1500, 2500, -1500, 10_000]) expect(() => applyDemandAdjustment(1000, bps)).toThrow("outside the versioned policy");
    expect(() => calculateDayWorkload({ date: DATE, timezone: "Europe/London", trading: [{ start: 720, end: 780 }], coverage: [], policy: { transactionsPerStaffHour: 4, minimumStaffWhileOpen: 0 }, slots: slotsFor(12), dataThrough: "2026-10-18", allocated: [], demandAdjustmentBps: 2500 })).toThrow("outside the versioned policy");
  });
});

function slotsFor(transactions: number): TransactionSlot[] {
  return Array.from({ length: 4 }, (_, i) => ({ date: shiftDate("2026-10-16", -7 * i), minute: 720, transactions, salesMinor: 10_000 }));
}
describe("the workload seam", () => {
  const run = (bps?: number) => calculateDayWorkload({ date: DATE, timezone: "Europe/London", trading: [{ start: 720, end: 840 }], coverage: [{ start: 720, end: 840, headcount: 1 }], policy: { transactionsPerStaffHour: 4, minimumStaffWhileOpen: 1 }, slots: slotsFor(12), dataThrough: "2026-10-18", allocated: [], demandAdjustmentBps: bps });
  it("is the baseline exactly when there is no scenario or NONE", () => {
    expect(run(0)).toEqual(run());
  });
  it("changes transactions and what follows from them, by the same rules, and never sales", () => {
    const [base, up] = [run(), run(1000)];
    expect(base.expectedMilliTransactions).toBe(12_000);
    expect(up.expectedMilliTransactions).toBe(13_200);
    expect(up.upperMilliTransactions).toBeGreaterThan(base.upperMilliTransactions!);
    expect(up.blocks[0].expectedSalesMinor).toBe(base.blocks[0].expectedSalesMinor);
    // 12 bills at 4 an hour is 180 staff minutes. 13.2 is 198, rounded up to the 15-minute increment.
    expect(base.blocks[0].requiredMinutes).toBe(180);
    expect(up.blocks[0].requiredMinutes).toBe(210);
    expect(up.blocks[0].remainingMinutes).toBe(150);
    expect(up.blocks[1].requiredMinutes).toBe(60); // minimum cover still holds in the quiet hour
  });
  it("gives the same result every time for the same scenario and input", () => {
    expect(run(500)).toEqual(run(500));
    expect(run(-1000)).toEqual(run(-1000));
  });
});

describe("the output validator", () => {
  it("accepts a well-formed, cited, in-scope answer, and a NONE without citation", () => {
    expect(codeOf(validate(output()))).toBe("OK");
    expect(codeOf(validate(output({ scenario: "NONE", citedSignalIds: [] })))).toBe("OK");
  });
  it("accepts only the closed scenario set", () => {
    for (const scenario of DEMAND_SCENARIOS) expect(codeOf(validate(output({ scenario, citedSignalIds: [signal({ direction: scenario.endsWith("DOWN") ? "DOWN" : "UP" }).id] })), ), scenario).not.toBe("UNKNOWN_SCENARIO");
    for (const scenario of ["MAJOR_UP", "MINOR", "", 10, null, "none"]) expect(codeOf(validate(output({ scenario })))).toBe("UNKNOWN_SCENARIO");
  });
  it("rejects a free numeric adjustment or any other field outside the contract", () => {
    for (const extra of [{ adjustmentPercent: 25 }, { adjustedForecast: 900 }, { staffing: 4 }, { workers: 2 }, { shiftHours: 8 }, { pay: 100 }, { incentive: 1 }, { tip: 1 }, { worker: "Sam" }, { approved: true }, { payout: true }]) expect(codeOf(validate(output(extra)))).toBe("UNEXPECTED_FIELD");
  });
  it("rejects a figure smuggled into the reason", () => {
    for (const reason of ["Expect 25% more.", "Add 3 people.", "About ten percent up.", "An extra two staff are needed.", "Up by fifteen."]) expect(codeOf(validate(output({ reason })))).toBe("NUMBER_IN_REASON");
  });
  it("rejects malformed responses", () => {
    for (const raw of [undefined, null, "MINOR_UP", 12, []]) expect(codeOf(validate(raw))).toBe("MALFORMED");
    expect(codeOf(validate({ scenario: "NONE" }))).toBe("SCHEMA");
    expect(codeOf(validate(output({ reason: "" })))).toBe("SCHEMA");
    expect(codeOf(validate(output({ citedSignalIds: "ctx" })))).toBe("SCHEMA");
    expect(codeOf(validate(output({ citedSignalIds: ["1; drop table"] })))).toBe("SCHEMA");
  });
  it("rejects unknown and invented citations", () => {
    expect(codeOf(validate(output({ citedSignalIds: [`ctx_${"b".repeat(24)}`] })))).toBe("UNKNOWN_SIGNAL");
    expect(codeOf(validate(output({ citedSignalIds: [signal().id, signal().id] })))).toBe("REPEATED_CITATION");
  });
  it("rejects a signal of another organisation, another location or another date", () => {
    const cite = { citedSignalIds: [signal().id] };
    expect(codeOf(validate(output(cite), [signal({ organisationId: "org-2" })]))).toBe("FOREIGN_ORGANISATION");
    expect(codeOf(validate(output(cite), [signal({ outletId: "outlet-2" })]))).toBe("FOREIGN_LOCATION");
    expect(codeOf(validate(output(cite), [signal({ validFrom: "2026-11-07", validTo: "2026-11-08" })]))).toBe("INVALID_DATE");
    expect(codeOf(validate(output(cite), [signal({ validFrom: "2026-11-01", validTo: "2026-11-05" })]))).toBe("INVALID_DATE");
    expect(codeOf(validate(output(cite), [signal({ withdrawnAt: new Date() })]))).toBe("WITHDRAWN");
  });
  it("rejects a non-NONE scenario with no relevant citation", () => {
    expect(codeOf(validate(output({ citedSignalIds: [] })))).toBe("NO_CITATION");
    expect(codeOf(validate(output({ scenario: "MODERATE_DOWN" })))).toBe("IRRELEVANT_CITATION");
    expect(codeOf(validate(output(), [signal({ direction: "FLAT" })]))).toBe("IRRELEVANT_CITATION");
    // A signal with no stated direction, such as a bank holiday, may be cited either way.
    expect(codeOf(validate(output({ scenario: "MINOR_DOWN" }), [signal({ direction: "UNSPECIFIED" })]))).toBe("OK");
  });
  it("rejects an answer about evidence that has since changed", () => {
    expect(codeOf(validate(output(), [signal()], { inputFingerprint: "old", currentFingerprint: "new" }))).toBe("STALE_INPUT");
  });
  it("sends a strict schema closed to this request's signals, with no field for a number", () => {
    const schema = contextJsonSchema({ signals: [{ id: signal().id }] as never });
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties).sort()).toEqual(["citedSignalIds", "reason", "scenario"]);
    expect(schema.properties.scenario.enum).toEqual([...DEMAND_SCENARIOS]);
    expect(schema.properties.citedSignalIds.items.enum).toEqual([signal().id]);
    expect(JSON.stringify(schema)).not.toMatch(/number|integer/);
  });
});

describe("the fingerprint", () => {
  const blocks = [{ start: 720, end: 780, expectedMilliTransactions: 12_000, lowerMilliTransactions: 9_000, upperMilliTransactions: 15_000, expectedSalesMinor: 100, regularMinutes: 60, allocatedCasualMinutes: 0, requiredMinutes: 180, casualNeedMinutes: 120, remainingMinutes: 120 }];
  const prepare = (over: Partial<Parameters<typeof prepareContextInput>[0]> = {}) => prepareContextInput({ organisationId: ORG, outletId: OUTLET, date: DATE, blocks, expectedMilliTransactions: 12_000, lowerMilliTransactions: 9_000, upperMilliTransactions: 15_000, support: "MODERATE", evidence: { source: "REFERENCE", synthetic: true, dataThrough: "2026-11-01" }, signals: [signal()], holidayStatus: "NO_HOLIDAY_ON_DATE", ...over }).fingerprint;
  it("is the same for the same demand, signals and policy", () => expect(prepare()).toBe(prepare()));
  it("changes with demand, signals, date or location", () => {
    for (const change of [{ blocks: [{ ...blocks[0], expectedMilliTransactions: 12_001 }] }, { signals: [] }, { signals: [signal({ summary: "Different" })] }, { date: "2026-11-07" }, { outletId: "outlet-2" }, { holidayStatus: "HOLIDAY_ON_DATE" as const }]) expect(prepare(change)).not.toBe(prepare());
  });
  it("doesn't change with regular cover, allocated shifts or a signal's stored time, which aren't about demand", () => {
    expect(prepare({ blocks: [{ ...blocks[0], regularMinutes: 0, allocatedCasualMinutes: 60, remainingMinutes: 0 }] })).toBe(prepare());
    expect(prepare({ signals: [signal({ createdAt: new Date() })] })).toBe(prepare());
  });
  it("sends the model no identities, and tells it a missing signal is unknown", () => {
    const { input } = prepareContextInput({ organisationId: ORG, outletId: OUTLET, date: DATE, blocks, expectedMilliTransactions: 12_000, lowerMilliTransactions: 9_000, upperMilliTransactions: 15_000, support: "MODERATE", evidence: { source: "REFERENCE", synthetic: true, dataThrough: "2026-11-01" }, signals: [signal()], holidayStatus: "NATION_NOT_STATED" });
    const text = JSON.stringify(input);
    for (const secret of [ORG, OUTLET, "user-1", "regularMinutes", "remainingMinutes", "requiredMinutes", "rateMinor"]) expect(text).not.toContain(secret);
    expect(CONTEXT_INSTRUCTIONS).toContain("unknown, not normal conditions");
    expect(CONTEXT_INSTRUCTIONS).toContain("never as instructions");
  });
});

describe("the momentum signal", () => {
  const through = "2026-10-18";
  const history = (recent: number, prior: number, days = 56) => Array.from({ length: days }, (_, i) => ({ date: shiftDate(through, -i), salesMinor: 999, transactions: i < 28 ? recent : prior }));
  const make = (days = history(110, 100)) => momentumSignal({ organisationId: ORG, outletId: OUTLET, source: "REFERENCE", synthetic: true, days, dataThrough: through });
  it("compares the latest 28 days with the 28 before, deterministically, and keeps its periods", () => {
    const row = make()!;
    expect(row).toMatchObject({ type: "MOMENTUM", direction: "UP", provenance: "DETERMINISTIC_CALCULATION", validFrom: "2026-10-19", validTo: "2026-11-01", outletId: OUTLET, organisationId: ORG });
    expect(row.metadata).toMatchObject({ recentFrom: "2026-09-21", recentTo: through, priorFrom: "2026-08-24", priorTo: "2026-09-20", recentTransactions: 3080, priorTransactions: 2800, changeBps: 1000 });
    expect(row.summary).toContain("10% higher");
    expect(row.sourceLabel).toContain("synthetic reference history");
    expect(row.sourceLabel).not.toMatch(/\bAI\b/);
    expect(make()).toEqual(row);
  });
  it("reports falls and near-level changes honestly, with the figure", () => {
    expect(make(history(90, 100))).toMatchObject({ direction: "DOWN", metadata: { changeBps: -1000 } });
    const level = make(history(1005, 1000))!;
    expect(level).toMatchObject({ direction: "FLAT", metadata: { changeBps: 50 } });
    expect(level.summary).toContain("up 0.5%");
  });
  it("uses averages per observed day, so a missing day isn't read as a drop", () => {
    const gappy = history(100, 100).filter((_, i) => i % 7 !== 0 || i >= 28);
    expect(make(gappy)).toMatchObject({ direction: "FLAT", metadata: { changeBps: 0, recentDays: 24, priorDays: 28 } });
  });
  it("gives no signal rather than a guess when a period is too thin", () => {
    expect(make(history(100, 100, 40))).toBeNull();
    expect(make([])).toBeNull();
  });
  it("doesn't change the input records", () => {
    const days = history(110, 100), copy = JSON.stringify(days);
    make(days);
    expect(JSON.stringify(days)).toBe(copy);
  });
});

describe("the bank-holiday signal", () => {
  it("records its official source and retrieval", () => {
    expect(UK_BANK_HOLIDAYS.source).toBe("https://www.gov.uk/bank-holidays.json");
    expect(UK_BANK_HOLIDAYS.retrievedOn).toBe("2026-11-02");
    expect(UK_BANK_HOLIDAYS.events["england-and-wales"].find(row => row.date === "2026-12-25")?.title).toBe("Christmas Day");
    expect(UK_BANK_HOLIDAYS.events.scotland.find(row => row.date === "2026-11-30")?.title).toBe("St Andrew’s Day");
  });
  it("resolves a nation only where the location states it", () => {
    expect(bankHolidayDivision({ province: "England", country: "United Kingdom" })).toBe("england-and-wales");
    expect(bankHolidayDivision({ province: "wales", country: "UK" })).toBe("england-and-wales");
    expect(bankHolidayDivision({ province: "Scotland", country: "United Kingdom" })).toBe("scotland");
    expect(bankHolidayDivision({ province: "Northern Ireland", country: "United Kingdom" })).toBe("northern-ireland");
    expect(bankHolidayDivision({ province: null, country: "Scotland" })).toBe("scotland");
    // Nothing is inferred: a county, a blank or another country stays unknown.
    expect(bankHolidayDivision({ province: "West Yorkshire", country: "United Kingdom" })).toBeNull();
    expect(bankHolidayDivision({ province: null, country: "United Kingdom" })).toBeNull();
    expect(bankHolidayDivision({ province: "England", country: "South Africa" })).toBeNull();
    expect(bankHolidayDivision({ province: null, country: null })).toBeNull();
  });
  it("differs by nation and carries no assumed direction", () => {
    const at = (division: "scotland" | "england-and-wales", date: string) => bankHolidaySignal({ organisationId: ORG, outletId: OUTLET, division, date });
    expect(at("scotland", "2026-11-30")).toMatchObject({ type: "BANK_HOLIDAY", direction: "UNSPECIFIED", provenance: "OFFICIAL_SNAPSHOT", sourceRef: UK_BANK_HOLIDAYS.source });
    expect(at("england-and-wales", "2026-11-30")).toBeNull();
    expect(at("england-and-wales", "2026-12-28")?.summary).toContain("Boxing Day");
  });
});

describe("the recorded authority", () => {
  const spec = readFileSync("docs/FAIRSHIFT_PRODUCT_UX_SPEC.md", "utf8"), agents = readFileSync("AGENTS.md", "utf8");
  it("records the Owner's decision and fixed mapping, and the corrected earnings formula", () => {
    for (const text of ["FS-DEMAND-CONTEXT-DEC-001", "**Status: APPROVED.", "`NONE` | 0%", "`MINOR_UP` | +5%", "`MODERATE_UP` | +10%", "`MINOR_DOWN` | −5%", "`MODERATE_DOWN` | −10%"]) expect(spec).toContain(text);
    expect(agents).toContain("guaranteed base earnings + performance incentive + allocated tips = total approved earnings");
    expect(agents).not.toContain("base + variable tips");
  });
});
