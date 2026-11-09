import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// This calculation suite supplies synthetic fixtures under an explicit mocked demo
// authority. Real configuration and ordinary-account rejection are tested separately.
vi.mock("@/server/intelligence/sales-history", async importOriginal => ({
  ...await importOriginal<typeof import("@/server/intelligence/sales-history")>(),
  syntheticHistoryAllowed: () => true,
}));
import { createTestDatabase } from "../helpers/database";
import { ALL_DAY, hours, ingestTimedBills, requiredFor } from "../helpers/workload";
import { entitled } from "../helpers/onboarding";
import type { Scope } from "@/server/auth/access";
import { requireScope } from "@/server/auth/request";
import { ingestCommerceObservations } from "@/server/commerce/ingestion";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { memberships, organisations, outlets, saleTransactions, subscriptions, users } from "@/server/db/schema";
import { AI_OUTPUT_SCHEMA_VERSION, ASSESSMENT_INSTRUCTIONS, prepareAssessmentInput, type AssessmentInput } from "@/server/intelligence/ai-staffing-contract";
import { generateStaffingAssessment, getStaffingAssessmentView, NoPlanningEvidenceError } from "@/server/intelligence/ai-staffing";
import { setRegularCoverage, setTradingHours, setWorkloadPolicy } from "@/server/intelligence/business-policy";
import { shiftDate } from "@/server/intelligence/forecast";
import { getWeeklyStaffing, type OutletStaffing } from "@/server/intelligence/staffing";
import { getWeeklyForecast } from "@/server/intelligence/weekly";
import type { StaffingAssessmentProvider } from "@/server/integrations/openai/staffing-assessment";
import { provisionReferenceHistory } from "@/server/reference/provision";
import { REFERENCE_STORE_CODES } from "@/server/reference/uk-hospitality";
import { OwnerWorkspace } from "@/app/owner/workspace";
import { ManagerWorkspace } from "@/app/manager/workspace";

vi.mock("@/server/auth/request", () => ({ requireScope: vi.fn() }));
vi.mock("@/server/db/client", () => ({ getDatabase: vi.fn() }));
vi.mock("@/server/config/env", () => ({ getConfigurationStatus: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); }, notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// Sunday 25 Oct 2026; the next seven days are Mon 26 Oct – Sun 1 Nov 2026.
const NOW = new Date("2026-10-25T10:00:00Z");
beforeEach(() => { vi.useFakeTimers({ now: NOW, toFake: ["Date"] }); });
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];
type Pattern = (isoWeekday: number) => number;
const isoWeekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay() || 7;
async function business(db: Db, input: { names: string[]; timezone: string; country?: string }) {
  const organisationId = randomUUID();
  await db.insert(organisations).values({ id: organisationId, name: "Unrelated business", country: input.country ?? "Ireland" });
  await db.insert(subscriptions).values({ id: randomUUID(), organisationId, requestId: randomUUID() });
  await entitled(db, organisationId);
  const rows = input.names.map(name => ({ id: randomUUID(), organisationId, name, timezone: input.timezone }));
  await db.insert(outlets).values(rows);
  const userId = randomUUID();
  await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: "Owner", passwordHash: "x", emailVerifiedAt: NOW });
  await db.insert(memberships).values({ id: randomUUID(), userId, organisationId, role: "OWNER" });
  const owner = (locationId = rows[0].id): Scope => ({ userId, organisationId, locationId, role: "OWNER", organisationName: "Unrelated business", locationName: rows.find(row => row.id === locationId)!.name });
  return { organisationId, rows, owner };
}
// Timed bills for 56 days through the canonical boundary: a count per weekday at £50 a bill.
const BILL = 5_000;
function ingest(db: Db, organisationId: string, outletId: string, currencyCode: string, through: string, pattern: Pattern, sourceSystem = "dataset") {
  return ingestTimedBills(db, { organisationId, outletId, currencyCode, through, bills: pattern, billMinor: BILL, now: NOW, sourceSystem });
}
// Fixture configuration: open all day, with regular cover in the hour the bills fall in.
async function configure(db: Db, scope: Scope, regularHeadcount: number) {
  await setTradingHours(db, scope, Array(7).fill(ALL_DAY));
  await setRegularCoverage(db, scope, Array(7).fill(regularHeadcount ? [hours(0, 24, regularHeadcount)] : []));
}
// Each weekday's count repeats, so the weighted forecast equals it exactly. All bills share one hour.
function expectDay(outlet: OutletStaffing, date: string, bills: number, capacity: number, regularHeadcount: number) {
  const need = requiredFor(bills, capacity), gap = Math.max(0, need - regularHeadcount * 60);
  const day = outlet.days.find(row => row.planningDate === date)!;
  expect(day).toMatchObject({ forecastSalesMinor: bills * BILL, expectedMilliTransactions: bills * 1000, requiredMinutes: need, regularMinutes: regularHeadcount * 1440, casualGapMinutes: gap, unavailable: null });
}
const MONDAY = "2026-10-26", SATURDAY = "2026-10-31";
function fakeProvider() {
  const assess = vi.fn(async (request: { input: string; instructions: string }) => {
    const input = JSON.parse(request.input) as AssessmentInput;
    const first = input.rankedGapDays[0];
    const location = input.locations.find(row => row.key === first.locationKey)!;
    return { responseId: "resp", responseModel: "test-model", text: JSON.stringify({ schemaVersion: AI_OUTPUT_SCHEMA_VERSION, summary: `Pressure is highest at [[${first.locationKey}]].`,
      priorities: [{ rank: 1, locationKey: first.locationKey, date: first.date, severity: "HIGH", category: "CASUAL_GAP", reason: "This day has the largest gap.", evidence: [{ metric: "casualGapMinutes", value: first.casualGapMinutes }], action: "FILL_SHIFTS", actionNote: "Plan this day first.", window: null, signalRefs: [] }],
      constraints: [], signalCommentary: `Evidence is ${location.evidence?.synthetic ? "synthetic" : "imported"}.`, commercialImplication: "Demand and cost are in proportion.", suggestionOrder: [] }) };
  });
  return { provider: "OPENAI" as const, model: "test-model", assess } as StaffingAssessmentProvider & { assess: typeof assess };
}
const render = async (scope: Scope, element: () => Promise<React.ReactNode>) => { vi.mocked(requireScope).mockResolvedValue(scope); return renderToStaticMarkup(await element()); };
function pages(db: Db, aiConfigured = true) {
  vi.mocked(getDatabase).mockReturnValue(db);
  vi.mocked(getConfigurationStatus).mockReturnValue({ databaseConfigured: true, aiConfigured } as ReturnType<typeof getConfigurationStatus>);
}

describe("dataset substitution", () => {
  it("derives forecast, staffing and AI input from whichever evidence and policy are supplied", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db, { names: ["Harbour Road", "Mill Lane"], timezone: "Europe/London" });
      const [x, y] = c.rows.map(row => row.id);

      // Dataset A: Monday-heavy, at a fixture capacity of 6 per staff hour.
      const a: Pattern = day => day === 1 ? 24 : 6, a2: Pattern = day => day === 1 ? 12 : 3;
      await ingest(t.db, c.organisationId, x, "GBP", "2026-09-20", a);
      await ingest(t.db, c.organisationId, y, "GBP", "2026-09-20", a2);
      await setWorkloadPolicy(t.db, c.owner(), "ORGANISATION", { transactionsPerStaffHour: 6, minimumStaffWhileOpen: 0 });
      for (const id of [x, y]) await configure(t.db, c.owner(id), 1);
      let staffing = await getWeeklyStaffing(t.db, c.owner(), NOW);
      let at = (id: string) => staffing.outlets.find(row => row.outletId === id)!;
      expect(at(x)).toMatchObject({ currency: "GBP", regularCoverage: "CONFIGURED", evidence: { source: "IMPORTED", dataThrough: "2026-09-20" }, policy: { transactionsPerStaffHour: 6, source: "CONFIGURED" } });
      expectDay(at(x), MONDAY, 24, 6, 1);
      expectDay(at(x), SATURDAY, 6, 6, 1);
      expectDay(at(y), MONDAY, 12, 6, 1);
      let prepared = prepareAssessmentInput(staffing, "ORGANISATION");
      const keyX = Object.entries(prepared.locationKeys).find(([, id]) => id === x)![0];
      expect(prepared.input.rankedGapDays[0]).toEqual({ locationKey: keyX, date: MONDAY, casualGapMinutes: requiredFor(24, 6) - 60 });
      const provider = fakeProvider();
      await generateStaffingAssessment(t.db, c.owner(), "ORGANISATION", provider, NOW);
      expect((await getStaffingAssessmentView(t.db, c.owner(), "ORGANISATION", staffing)).state).toBe("CURRENT");
      const fingerprintA = prepared.fingerprint;

      // Dataset B replaces it: weekend-heavy, different values, a different fixture capacity.
      await t.db.delete(saleTransactions).where(inArray(saleTransactions.outletId, [x, y]));
      const b: Pattern = day => day === 6 ? 45 : 4, b2: Pattern = day => day === 6 ? 90 : 2;
      await ingest(t.db, c.organisationId, x, "GBP", "2026-07-05", b, "other-system");
      await ingest(t.db, c.organisationId, y, "GBP", "2026-07-05", b2, "other-system");
      await setWorkloadPolicy(t.db, c.owner(), "ORGANISATION", { transactionsPerStaffHour: 9, minimumStaffWhileOpen: 0 });
      staffing = await getWeeklyStaffing(t.db, c.owner(), NOW);
      at = (id: string) => staffing.outlets.find(row => row.outletId === id)!;
      expect(at(x)).toMatchObject({ evidence: { dataThrough: "2026-07-05" }, policy: { transactionsPerStaffHour: 9, version: "organisation-v2" } });
      expectDay(at(x), SATURDAY, 45, 9, 1);
      expectDay(at(y), SATURDAY, 90, 9, 1);
      expectDay(at(x), MONDAY, 4, 9, 1);
      prepared = prepareAssessmentInput(staffing, "ORGANISATION");
      const keyY = Object.entries(prepared.locationKeys).find(([, id]) => id === y)![0];
      expect(prepared.input.rankedGapDays[0]).toEqual({ locationKey: keyY, date: SATURDAY, casualGapMinutes: requiredFor(90, 9) - 60 });
      // Dataset A's conclusions do not survive: Saturdays lead and Monday falls behind them.
      expect(prepared.input.rankedGapDays.slice(0, 2).map(day => day.date)).toEqual([SATURDAY, SATURDAY]);
      expect(prepared.input.rankedGapDays.find(day => day.date === MONDAY)?.casualGapMinutes ?? 0).toBeLessThan(requiredFor(24, 6) - 60);
      expect(prepared.fingerprint).not.toBe(fingerprintA);
      expect((await getStaffingAssessmentView(t.db, c.owner(), "ORGANISATION", staffing))).toMatchObject({ state: "STALE", assessment: null });
      const second = await generateStaffingAssessment(t.db, c.owner(), "ORGANISATION", provider, NOW);
      expect(second.generated).toBe(true);
      expect(provider.assess).toHaveBeenCalledTimes(2);
      expect(provider.assess.mock.calls[0][0].instructions).toBe(provider.assess.mock.calls[1][0].instructions);
      expect(JSON.parse(provider.assess.mock.calls[1][0].input)).toEqual(prepared.input);
      expect(second.record.assessment).toMatchObject({ priorities: [{ date: SATURDAY, locationKey: keyY }] });

      // Dataset C: invalid evidence is refused whole; the valid history stands.
      const before = await t.db.select().from(saleTransactions).where(inArray(saleTransactions.outletId, [x, y]));
      await expect(ingestCommerceObservations(t.db, { organisationId: c.organisationId, source: "IMPORTED", sourceSystem: "bad", now: NOW, observations: [
        { outletId: x, sourceTransactionId: "ok", occurredAt: "2026-07-06T12:00:00Z", currencyCode: "GBP", grossAmountMinor: 100, status: "COMPLETED" },
        { outletId: x, sourceTransactionId: "bad", occurredAt: "2026-07-06T12:00:00Z", currencyCode: "GBP", grossAmountMinor: -100, status: "COMPLETED" },
      ] })).rejects.toMatchObject({ code: "INVALID_OBSERVATION" });
      expect(await t.db.select().from(saleTransactions).where(inArray(saleTransactions.outletId, [x, y]))).toHaveLength(before.length);
    } finally { await t.close(); }
  });

  it("does not manufacture a result from insufficient evidence", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db, { names: ["New Shop"], timezone: "Europe/Dublin" });
      const id = c.rows[0].id;
      await setWorkloadPolicy(t.db, c.owner(), "ORGANISATION", { transactionsPerStaffHour: 10, minimumStaffWhileOpen: 0 });
      await configure(t.db, c.owner(), 1);
      await ingestCommerceObservations(t.db, { organisationId: c.organisationId, source: "IMPORTED", sourceSystem: "till", now: NOW, observations: Array.from({ length: 10 }, (_, i) => ({
        outletId: id, sourceTransactionId: `T${i}`, occurredAt: `${shiftDate("2026-10-20", -i)}T12:00:00Z`, currencyCode: "EUR", grossAmountMinor: 500_000, status: "COMPLETED" })) });
      const weekly = await getWeeklyForecast(t.db, c.owner(), NOW);
      expect(weekly.outlets[0]).toMatchObject({ days: [], weeklyTotalMinor: null, selection: { status: "NONE", rejected: [{ source: "IMPORTED", reason: "INSUFFICIENT_DAYS" }] } });
      const staffing = await getWeeklyStaffing(t.db, c.owner(), NOW);
      expect(staffing.outlets[0].days.every(day => day.forecastSalesMinor === null && day.requiredMinutes === null && day.casualGapMinutes === null && day.unavailable === "NO_FORECAST")).toBe(true);
      expect(staffing.consolidated).toBeNull();
      const provider = fakeProvider();
      await expect(generateStaffingAssessment(t.db, c.owner(), "ORGANISATION", provider, NOW)).rejects.toThrow(NoPlanningEvidenceError);
      expect(provider.assess).not.toHaveBeenCalled();
      pages(t.db);
      const html = await render(c.owner(), () => OwnerWorkspace({ area: "forecast" }));
      expect(html).toContain("too few days");
      expect(html).not.toContain("High priority");
    } finally { await t.close(); }
  });

  it("lets a South African business plan in ZAR with its own policy, with no conversion", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db, { names: ["Sandton", "Durban", "Gqeberha"], timezone: "Africa/Johannesburg", country: "South Africa" });
      const pattern: Pattern = day => day === 5 ? 30 : 10;
      for (const row of c.rows) await ingest(t.db, c.organisationId, row.id, "ZAR", "2026-10-18", pattern);
      for (const row of c.rows) expect((await getWeeklyStaffing(t.db, c.owner(row.id), NOW)).outlets.find(o => o.outletId === row.id)!.days[0]).toMatchObject({ requiredMinutes: null, unavailable: "TRADING_HOURS_NOT_SET" });
      await setWorkloadPolicy(t.db, c.owner(), "ORGANISATION", { transactionsPerStaffHour: 5, minimumStaffWhileOpen: 0 });
      for (const row of c.rows) await configure(t.db, c.owner(row.id), 1);
      const staffing = await getWeeklyStaffing(t.db, c.owner(), NOW);
      expect(staffing.outlets).toHaveLength(3);
      for (const outlet of staffing.outlets) {
        expect(outlet).toMatchObject({ currency: "ZAR", policy: { transactionsPerStaffHour: 5 }, timezone: "Africa/Johannesburg", evidence: { source: "IMPORTED" } });
        expectDay(outlet, "2026-10-30", 30, 5, 1); // Friday in Johannesburg
        expectDay(outlet, MONDAY, 10, 5, 1);
      }
      expect(staffing.consolidated).toMatchObject({ currency: "ZAR" });
      const prepared = prepareAssessmentInput(staffing, "ORGANISATION");
      expect(prepared.input.locations).toHaveLength(3);
      expect(prepared.input.locations[0]).toMatchObject({ currency: "ZAR", evidence: { source: "IMPORTED", synthetic: false } });
      expect(prepared.input.rankedGapDays[0]).toMatchObject({ date: "2026-10-30" });
      expect((await generateStaffingAssessment(t.db, c.owner(), "ORGANISATION", fakeProvider(), NOW)).record.status).toBe("AVAILABLE");
      pages(t.db);
      const html = await render(c.owner(), () => OwnerWorkspace({ area: "forecast" }));
      expect(html).toContain("ZAR");
      for (const leaked of ["£", "reference company", "synthetic reference", "Europe/London"]) expect(html).not.toContain(leaked);
      expect(html).toContain("Africa/Johannesburg");
    } finally { await t.close(); }
  });

  // Fails if someone reintroduces a fixed store count, currency, rate, history end date,
  // reference-only staffing or a company's identity in the intelligence path.
  it.each([
    { names: ["Solo"], currency: "USD", rate: 7, through: "2026-02-15", timezone: "America/New_York" },
    { names: ["One", "Two", "Three"], currency: "ZAR", rate: 18, through: "2026-10-11", timezone: "Africa/Johannesburg" },
    { names: Array.from({ length: 7 }, (_, i) => `Branch ${i}`), currency: "EUR", rate: 33, through: "2024-06-30", timezone: "Europe/Dublin" },
  ])("has no hidden assumption for $names.length location(s) in $currency at $rate", async ({ names, currency, rate, through, timezone }) => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db, { names, timezone });
      for (const [i, row] of c.rows.entries()) await ingest(t.db, c.organisationId, row.id, currency, through, day => 3 * (i + 1) + day);
      await setWorkloadPolicy(t.db, c.owner(), "ORGANISATION", { transactionsPerStaffHour: rate, minimumStaffWhileOpen: 0 });
      for (const row of c.rows) await configure(t.db, c.owner(row.id), 0);
      const staffing = await getWeeklyStaffing(t.db, c.owner(), NOW);
      expect(staffing.outlets).toHaveLength(names.length);
      for (const outlet of staffing.outlets) {
        const i = c.rows.findIndex(row => row.id === outlet.outletId);
        expect(outlet).toMatchObject({ currency, evidence: { source: "IMPORTED", dataThrough: through }, policy: { transactionsPerStaffHour: rate }, regularCoverage: "CONFIGURED" });
        for (const day of outlet.days) {
          const bills = 3 * (i + 1) + isoWeekday(day.planningDate);
          expect(day).toMatchObject({ forecastSalesMinor: bills * BILL, requiredMinutes: requiredFor(bills, rate), casualGapMinutes: requiredFor(bills, rate) });
        }
      }
      const { input } = prepareAssessmentInput(staffing, "ORGANISATION");
      expect(input.locations).toHaveLength(names.length);
      expect(input.locations[0].evidence).toMatchObject({ source: "IMPORTED", synthetic: false, dataThrough: through });
      const serialised = JSON.stringify(input);
      for (const name of names) expect(serialised).not.toContain(name);
    } finally { await t.close(); }
  });

  it("keeps company identity, rates and dates out of production intelligence source and the AI task", async () => {
    const files = ["src/server/intelligence/ai-staffing-contract.ts", "src/server/intelligence/ai-staffing.ts", "src/server/intelligence/business-policy.ts", "src/server/intelligence/sales-history.ts", "src/server/intelligence/staffing.ts", "src/server/intelligence/workload.ts", "src/server/intelligence/opportunity.ts", "src/server/intelligence/opportunity-shifts.ts", "src/server/intelligence/weekly.ts", "src/server/commerce/ingestion.ts",
      "src/app/components/staffing.tsx", "src/app/components/ai-staffing-assessment.tsx", "src/app/owner/weekly-forecast.tsx", "src/app/owner/staffing-configuration.tsx"];
    // Fallbacks and fixed rates, not display locales or unrelated limits.
    const forbidden = /Leeds|Manchester|Birmingham|Brighton|Stratford|UK0[1-5]|uk-retail|uk-hospitality|reference\/|reference retailer|(\?\?|\?|:|[^=!]=) "GBP"|Europe\/London|[Tt]ransactionsPerStaffHour: *\d|minimumStaffWhileOpen: *\d|[Pp]erLabourHour/;
    for (const file of files) expect({ file, match: forbidden.exec(await readFile(file, "utf8"))?.[0] ?? null }).toEqual({ file, match: null });
    expect(ASSESSMENT_INSTRUCTIONS).not.toMatch(/Leeds|Manchester|Birmingham|Brighton|Stratford|GBP|£|\b(five|5) (stores?|locations?)\b/i);
    // Hospitality wording is display only: names of parts of the day never reach the calculation.
    expect(await readFile("src/server/intelligence/workload.ts", "utf8")).not.toMatch(/breakfast|lunch|dinner|[^a-z]evening/i);
    // The reference company's policy enters only as its own configuration, never as a production default.
    expect(await readFile("src/server/reference/provision.ts", "utf8")).toContain("REFERENCE_WORKLOAD_POLICY");
  });
});

describe("provenance and truthful product states", () => {
  it("keeps reference provisioning reproducible as explicit configuration", async () => {
    const t = await createTestDatabase();
    try {
      const organisationId = randomUUID();
      await t.db.insert(organisations).values({ id: organisationId, name: "Reference", country: "United Kingdom" });
      await t.db.insert(subscriptions).values({ id: randomUUID(), organisationId, requestId: randomUUID() });
      await entitled(t.db, organisationId);
      const rows = REFERENCE_STORE_CODES.map(code => ({ id: randomUUID(), organisationId, name: `Store ${code}`, timezone: "Europe/London" }));
      await t.db.insert(outlets).values(rows);
      const mapping = Object.fromEntries(REFERENCE_STORE_CODES.map((code, i) => [code, rows[i].id])) as never;
      const load = () => provisionReferenceHistory(t.db, { organisationId, outlets: mapping, from: "2026-10-05", through: "2026-10-18" });
      const first = await load();
      expect(first.inserted).toBe(first.expected);
      const owner: Scope = { userId: randomUUID(), organisationId, locationId: rows[0].id, role: "OWNER", organisationName: "Reference", locationName: "Store" };
      const staffing = await getWeeklyStaffing(t.db, owner, NOW);
      expect(staffing.outlets[0]).toMatchObject({ regularCoverage: "REFERENCE", tradingHours: "REFERENCE", policy: { source: "REFERENCE", transactionsPerStaffHour: 7, minimumStaffWhileOpen: 2, version: "organisation-v1" }, evidence: { source: "REFERENCE", dataset: "uk-hospitality-v1" } });
      expect(staffing.outlets[0].days[0]).toMatchObject({ unavailable: null });
      expect(staffing.outlets[0].days[0].expectedMilliTransactions).toBeGreaterThan(0);
      expect(prepareAssessmentInput(staffing, "ORGANISATION").input.locations[0]).toMatchObject({ evidence: { synthetic: true, stale: true }, flags: expect.arrayContaining(["SYNTHETIC_REFERENCE_DATA", "HISTORICAL_EVIDENCE_STALE"]) });
      // A rerun changes nothing, through the same duplicate-safe boundary.
      expect(await load()).toMatchObject({ inserted: 0 });
      const [row] = await t.db.select().from(saleTransactions).where(eq(saleTransactions.outletId, rows[0].id)).limit(1);
      expect(row).toMatchObject({ source: "REFERENCE", providerStatus: "REFERENCE", sourceSystem: "uk-hospitality-v1", verificationState: "PENDING" });
    } finally { await t.close(); }
  });

  it("tells the truth for each planning state on Owner and Manager surfaces", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db, { names: ["Quay Street"], timezone: "Europe/Dublin" });
      const id = c.rows[0].id;
      const manager: Scope = { ...c.owner(), role: "MANAGER" };
      pages(t.db, false);
      await ingest(t.db, c.organisationId, id, "EUR", "2026-10-18", day => day === 6 ? 18 : 6);
      await setTradingHours(t.db, c.owner(), Array(7).fill(ALL_DAY));

      // Valid forecast, no policy: unavailable, and never presented as no staff needed.
      let owner = await render(c.owner(), () => OwnerWorkspace({ area: "forecast" }));
      for (const text of ["Imported sales history", "not verified by a payment provider", "Service capacity not set", "This does not mean no staff are needed", "Configuration required", "Set up staffing inputs"]) expect(owner).toContain(text);
      expect(owner).toContain("Required staff capacity is unavailable because service capacity and minimum cover aren’t configured");
      for (const leaked of ["£", "Verified PayPal", "synthetic", "reference company"]) expect(owner).not.toContain(leaked);
      let plan = await render(manager, () => ManagerWorkspace({ area: "plan" }));
      expect(plan).toContain("Imported sales history · not provider-verified");
      expect(plan).toContain("Service capacity not set");
      expect(plan).toContain("Ask the business owner");
      expect(plan).not.toContain("Set up staffing inputs");
      expect(plan).not.toContain("Single-day demand forecast");

      // Policy, no cover: required known, gap unavailable, not zero.
      await setWorkloadPolicy(t.db, c.owner(), "ORGANISATION", { transactionsPerStaffHour: 8, minimumStaffWhileOpen: 0 });
      owner = await render(c.owner(), () => OwnerWorkspace({ area: "forecast" }));
      for (const text of ["Regular coverage not set", "No regular-staff coverage has been set", "this business’s configured policy"]) expect(owner).toContain(text);
      // Explicit zero cover: an hours figure, labelled configured.
      await setRegularCoverage(t.db, c.owner(), Array(7).fill([]));
      owner = await render(c.owner(), () => OwnerWorkspace({ area: "forecast" }));
      expect(owner).toContain("as configured for this location");
      expect(owner).not.toContain("Regular coverage not set");
      expect(owner).toContain("AI assessment is not configured");
      plan = await render(manager, () => ManagerWorkspace({ area: "plan" }));
      expect(plan).toContain("€");
      expect(plan).toContain("this business’s configured policy");
      expect(plan).not.toContain("Reference sales history");

      // The Owner configures it in business language; a Manager page offers no such form.
      const policies = await render(c.owner(), () => OwnerWorkspace({ area: "policies" }));
      for (const text of ["Service capacity and minimum cover", "How many completed transactions can one staff member sustainably support in a normally busy hour, counting everyone working in the venue?", "Minimum staff working while this location is open to customers.", "FairShift doesn’t know the right values and sets none for you", "Organisation default", "Quay Street override", "Trading hours · Quay Street", "Regular coverage · Quay Street", "<code>none</code> for a day with no regular staff"]) expect(policies).toContain(text);
      expect(plan).not.toContain("Save organisation default");
      expect(await render(manager, () => ManagerWorkspace({ area: "review" }))).not.toContain("Service capacity and minimum cover");
    } finally { await t.close(); }
  });
});
