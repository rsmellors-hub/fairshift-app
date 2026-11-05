import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import type { Scope } from "@/server/auth/access";
import { CommerceIngestionError, ingestCommerceObservations, ingestConnectedObservations } from "@/server/commerce/ingestion";
import { organisations, outlets, regularCoverageWindows, saleTransactions } from "@/server/db/schema";
import { prepareAssessmentInput } from "@/server/intelligence/ai-staffing-contract";
import { getWeeklyStaffing } from "@/server/intelligence/staffing";
import { getWeeklyForecast } from "@/server/intelligence/weekly";
import { provisionReferenceHistory, referencePrefix } from "@/server/reference/provision";
import { REFERENCE_DATASET, REFERENCE_STORE_CODES, referenceDates, referenceTransactions } from "@/server/reference/uk-hospitality";
vi.mock("@/server/demo/config", () => ({ demoConfig: () => ({ organisationId: process.env.FAIRSHIFT_TEST_DEMO_ORG }) }));

type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];
// Sunday 1 Nov 2026, 21:00 in London: today hasn't finished, so Saturday is the latest complete day.
const NOW = new Date("2026-11-01T21:00:00Z");
const TOMORROW = new Date("2026-11-02T08:00:00Z");
const RECENT = { from: "2026-10-03" };

async function company(db: Db, timezone = "Europe/London") {
  const organisationId = randomUUID();
  process.env.FAIRSHIFT_TEST_DEMO_ORG = organisationId;
  await db.insert(organisations).values({ id: organisationId, name: "Refresh company", country: "United Kingdom" });
  const rows = REFERENCE_STORE_CODES.map((code, i) => ({ id: randomUUID(), organisationId, name: `${i + 1} ${code}`, timezone }));
  await db.insert(outlets).values(rows);
  const mapping = Object.fromEntries(REFERENCE_STORE_CODES.map((code, i) => [code, rows[i].id])) as Record<typeof REFERENCE_STORE_CODES[number], string>;
  const owner: Scope = { userId: randomUUID(), organisationId, locationId: rows[0].id, role: "OWNER", organisationName: "Refresh company", locationName: rows[0].name, demo: { persona: "OWNER", group: "isolated-test" } };
  return { organisationId, rows, mapping, owner };
}
const count = async (db: Db) => (await db.select({ n: sql<number>`count(*)::int` }).from(saleTransactions))[0].n;

describe("current reference history", () => {
  it("plans the coming week from history that ends just before it, under the reference policy", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      const load = await provisionReferenceHistory(t.db, { organisationId: c.organisationId, outlets: c.mapping, ...RECENT }, NOW);
      expect(load).toMatchObject({ dataset: "uk-hospitality-v1", provenance: "REFERENCE", requested: { through: "2026-10-31" } });
      expect(load.stores.every(store => store.dataThrough === "2026-10-31")).toBe(true);
      const staffing = await getWeeklyStaffing(t.db, c.owner, NOW);
      const at = (code: typeof REFERENCE_STORE_CODES[number]) => staffing.outlets.find(row => row.outletId === c.mapping[code])!;
      for (const code of REFERENCE_STORE_CODES) {
        expect(at(code)).toMatchObject({ currency: "GBP", regularCoverage: "REFERENCE", tradingHours: "REFERENCE", policy: { transactionsPerStaffHour: 7, minimumStaffWhileOpen: 2, source: "REFERENCE" },
          evidence: { source: "REFERENCE", kind: "HISTORICAL", dataThrough: "2026-10-31", ageDays: 2, dataset: "uk-hospitality-v1" } });
        expect(at(code).days[0].planningDate).toBe("2026-11-02");
        expect(at(code).days[6].planningDate).toBe("2026-11-08");
        expect(at(code).days.every(day => day.unavailable === null && day.support === "MODERATE" && day.expectedMilliTransactions! > 0 && day.regularMinutes! > 0 && day.forecastSalesMinor! > 0)).toBe(true);
      }
      expect(staffing.consolidated).toMatchObject({ currency: "GBP", firstDate: "2026-11-02", lastDate: "2026-11-08" });
      // Venues have different busy times, not one clone scaled.
      const busiestHour = (code: typeof REFERENCE_STORE_CODES[number]) => at(code).days[1].blocks.reduce((best, block) => block.expectedMilliTransactions! > best.expectedMilliTransactions! ? block : best).start;
      expect(new Set(REFERENCE_STORE_CODES.map(busiestHour)).size).toBeGreaterThanOrEqual(3);

      // What AI would be given: calculated figures, labelled synthetic, and not stale at two days. No provider is called.
      const { input } = prepareAssessmentInput(staffing, "ORGANISATION");
      expect(input.locations).toHaveLength(5);
      for (const location of input.locations) {
        expect(location.evidence).toMatchObject({ source: "REFERENCE", synthetic: true, stale: false, dataThrough: "2026-10-31", ageDays: 2 });
        expect(location.flags).toContain("SYNTHETIC_REFERENCE_DATA");
        expect(location.flags).not.toContain("HISTORICAL_EVIDENCE_STALE");
      }
      // Three days old, the same input is flagged, not hidden.
      const later = prepareAssessmentInput(await getWeeklyStaffing(t.db, c.owner, new Date("2026-11-02T12:00:00Z")), "ORGANISATION").input;
      expect(later.locations[0].flags).toContain("HISTORICAL_EVIDENCE_STALE");
    } finally { await t.close(); }
  }, 180_000);

  it("refuses future and unfinished days, and tomorrow's rerun adds only the day that has since finished", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      const run = (through: string | undefined, now: Date, from = "2026-10-25") => provisionReferenceHistory(t.db, { organisationId: c.organisationId, outlets: c.mapping, from, ...(through ? { through } : {}) }, now);
      await expect(run("2026-11-01", NOW)).rejects.toThrow("latest completed trading day is 2026-10-31");
      await expect(run("2026-12-01", NOW)).rejects.toThrow("latest completed trading day");
      // A clock earlier than the dataset's end must not load sales dated after that clock.
      await expect(run("2026-10-20", new Date("2026-10-20T12:00:00Z"), "2026-10-19")).rejects.toThrow("latest completed trading day is 2026-10-19");
      expect(await count(t.db)).toBe(0);
      await run(undefined, NOW);
      const [latest] = (await t.db.execute(sql`select max(occurred_at) as at from sale_transactions`)).rows as { at: string }[];
      expect(new Date(latest.at) <= NOW).toBe(true);
      const again = await run(undefined, TOMORROW);
      const newDay = REFERENCE_STORE_CODES.reduce((sum, code) => sum + referenceTransactions(code, "2026-11-01").length, 0);
      expect(again.inserted).toBe(newDay);
      expect(again.requested.through).toBe("2026-11-01");
      // Past the dataset's end, the load stops at its last day rather than inventing more.
      const pastEnd = new Date("2027-03-15T12:00:00Z");
      const later = await run(undefined, pastEnd, "2027-01-30");
      expect(later).toMatchObject({ requested: { through: REFERENCE_DATASET.lastDate } });
      await expect(run("2027-02-01", pastEnd, "2027-01-30")).rejects.toThrow("Reference history covers");
    } finally { await t.close(); }
  }, 180_000);

  it("rejects malformed, negative, wrong-currency, wrong-location and wrong-organisation sales at the commerce boundary", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      const other = await company(t.db);
      const good = { outletId: c.mapping.UK01, sourceTransactionId: "r1", occurredAt: "2026-10-30T12:00:00Z", currencyCode: "GBP", grossAmountMinor: 100, status: "COMPLETED" };
      const send = (observation: object, organisationId = c.organisationId) => ingestCommerceObservations(t.db, { organisationId, source: "REFERENCE", sourceSystem: "test", observations: [observation], now: NOW });
      const failure = async (work: Promise<unknown>) => { try { await work; return "accepted"; } catch (error) { return error instanceof CommerceIngestionError ? error.code : `other: ${error}`; } };
      expect(await failure(send({ ...good, grossAmountMinor: -1 }))).toBe("INVALID_OBSERVATION");
      expect(await failure(send({ ...good, grossAmountMinor: 1.5 }))).toBe("INVALID_OBSERVATION");
      expect(await failure(send({ ...good, occurredAt: "yesterday" }))).toBe("INVALID_OBSERVATION");
      expect(await failure(send({ ...good, teamMemberId: "invented" }))).toBe("INVALID_OBSERVATION");
      expect(await failure(send({ ...good, currencyCode: "XXQ" }))).toBe("UNSUPPORTED_CURRENCY");
      expect(await failure(send({ ...good, occurredAt: "2026-11-01T21:00:01Z" }))).toBe("FUTURE_DATED");
      expect(await failure(send({ ...good, outletId: other.mapping.UK01 }))).toBe("UNKNOWN_LOCATION");
      expect(await failure(send(good, other.organisationId))).toBe("UNKNOWN_LOCATION");
      expect(await count(t.db)).toBe(0);
      await send(good);
      expect(await failure(send({ ...good, sourceTransactionId: "r2", currencyCode: "USD" }))).toBe("CURRENCY_MISMATCH");
      expect(await failure(send({ ...good, grossAmountMinor: 200 }))).toBe("CONFLICTING_DUPLICATE");
      // The database also refuses a negative reference sale written around the boundary.
      await expect(t.db.insert(saleTransactions).values({ id: randomUUID(), internalReference: "REF:negative", outletId: c.mapping.UK01, source: "REFERENCE", currencyCode: "GBP",
        grossAmountMinor: -5, providerStatus: "REFERENCE", occurredAt: new Date("2026-10-30T12:00:00Z") })).rejects.toThrow();
    } finally { await t.close(); }
  }, 120_000);

  it("rolls the whole load back when a transaction identity already holds different facts", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      const window = { organisationId: c.organisationId, outlets: c.mapping, from: "2026-10-26", through: "2026-10-27" };
      await provisionReferenceHistory(t.db, window, NOW);
      const before = await count(t.db);
      const reference = `${referencePrefix("UK01", c.mapping.UK01)}2026-10-26:0001`;
      const [{ amount }] = await t.db.select({ amount: saleTransactions.grossAmountMinor }).from(saleTransactions).where(eq(saleTransactions.internalReference, reference));
      await t.db.update(saleTransactions).set({ grossAmountMinor: amount + 1 }).where(eq(saleTransactions.internalReference, reference));
      await expect(provisionReferenceHistory(t.db, { ...window, through: "2026-10-28" }, NOW)).rejects.toThrow("CONFLICTING_DUPLICATE");
      expect(await count(t.db)).toBe(before);
    } finally { await t.close(); }
  }, 120_000);

  it("refuses to mix an earlier dataset version, including the retail one, into an outlet", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      await t.db.insert(saleTransactions).values({ id: randomUUID(), internalReference: `REF:uk-specialty-retail-v2:UK01:${c.mapping.UK01}:2025-12-28:0001`, outletId: c.mapping.UK01,
        source: "REFERENCE", currencyCode: "GBP", grossAmountMinor: 100, providerStatus: "REFERENCE", occurredAt: new Date("2025-12-28T12:00:00Z") });
      await expect(provisionReferenceHistory(t.db, { organisationId: c.organisationId, outlets: c.mapping, ...RECENT }, NOW)).rejects.toThrow("already holds a different reference history");
      expect(await count(t.db)).toBe(1);
    } finally { await t.close(); }
  }, 120_000);

  it("marks thin history as low support and absent history as no forecast, never as zero demand", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      await provisionReferenceHistory(t.db, { organisationId: c.organisationId, outlets: c.mapping, from: "2026-10-26", through: "2026-10-31" }, NOW);
      const empty = randomUUID();
      await t.db.insert(outlets).values({ id: empty, organisationId: c.organisationId, name: "0 Empty", timezone: "Europe/London" });
      const weekly = await getWeeklyForecast(t.db, c.owner, NOW);
      const thin = weekly.outlets.find(row => row.outletId === c.mapping.UK01)!;
      expect(thin.days.every(day => day.forecast?.support === "LOW" && day.forecast.basis === "RECENT_OBSERVED_DAYS")).toBe(true);
      expect(weekly.outlets.find(row => row.outletId === empty)).toMatchObject({ selection: { status: "NONE" }, days: [], weeklyTotalMinor: null });
      const staffing = await getWeeklyStaffing(t.db, c.owner, NOW);
      const none = staffing.outlets.find(row => row.outletId === empty)!;
      expect(none.days.every(day => day.unavailable === "NO_FORECAST" && day.casualGapMinutes === null)).toBe(true);
      expect(none.totals).toBeNull();
      expect(staffing.consolidated).toBeNull();
    } finally { await t.close(); }
  }, 120_000);

  it("separates absent coverage from configured zero, and a missing policy from a real requirement", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      await provisionReferenceHistory(t.db, { organisationId: c.organisationId, outlets: c.mapping, from: "2026-10-05", through: "2026-10-31" }, NOW);
      const uk01 = c.mapping.UK01, uk02 = c.mapping.UK02;
      const at = async (id: string) => (await getWeeklyStaffing(t.db, c.owner, NOW)).outlets.find(row => row.outletId === id)!;
      await t.db.delete(regularCoverageWindows).where(eq(regularCoverageWindows.outletId, uk01));
      const absent = await at(uk01);
      expect(absent.regularCoverage).toBeNull();
      expect(absent.days.every(day => day.unavailable === "REGULAR_COVERAGE_NOT_SET" && day.casualGapMinutes === null && day.requiredMinutes! > 0)).toBe(true);
      expect(absent.totals).toBeNull();
      await t.db.update(regularCoverageWindows).set({ windows: [] }).where(and(eq(regularCoverageWindows.outletId, uk02), eq(regularCoverageWindows.isoWeekday, 1)));
      const zero = (await at(uk02)).days[0];
      expect(zero).toMatchObject({ unavailable: null, regularMinutes: 0 });
      expect(zero.casualGapMinutes).toBe(zero.requiredMinutes);

      // Sales with no provisioned policy: no assumed capacity, so no requirement.
      const bare = await company(t.db);
      await ingestCommerceObservations(t.db, { organisationId: bare.organisationId, source: "REFERENCE", sourceSystem: "test", now: NOW, observations: ["2026-10-29", "2026-10-30", "2026-10-31"].map(date => (
        { outletId: bare.mapping.UK01, sourceTransactionId: date, occurredAt: `${date}T12:00:00Z`, currencyCode: "GBP", grossAmountMinor: 100_000, status: "COMPLETED" })) });
      const noPolicy = (await getWeeklyStaffing(t.db, bare.owner, NOW)).outlets.find(row => row.outletId === bare.mapping.UK01)!;
      expect(noPolicy.policy).toBeNull();
      expect(noPolicy.days.every(day => day.forecastSalesMinor !== null && day.unavailable === "TRADING_HOURS_NOT_SET" && day.casualGapMinutes === null && day.requiredMinutes === null)).toBe(true);
    } finally { await t.close(); }
  }, 120_000);

  it("keeps Square evidence and reference history apart: separate rows, no sums, reference still plans", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      const window = { organisationId: c.organisationId, outlets: c.mapping, from: "2026-10-05", through: "2026-10-31" };
      await provisionReferenceHistory(t.db, window, NOW);
      const baseline = (await getWeeklyForecast(t.db, c.owner, NOW)).outlets.find(row => row.outletId === c.mapping.UK01)!;
      await expect(ingestCommerceObservations(t.db, { organisationId: c.organisationId, source: "SQUARE", sourceSystem: "x", now: NOW,
        observations: [{ outletId: c.mapping.UK01, sourceTransactionId: "s", occurredAt: "2026-10-30T12:00:00Z", currencyCode: "GBP", grossAmountMinor: 100, status: "COMPLETED" }] })).rejects.toThrow("UNSUPPORTED_SOURCE");
      await ingestConnectedObservations(t.db, { provider: "SQUARE", organisationId: c.organisationId, sourceSystem: "square-sandbox", now: NOW,
        observations: [{ outletId: c.mapping.UK01, sourceTransactionId: "PAY-1", occurredAt: "2026-10-30T15:00:00Z", currencyCode: "GBP", grossAmountMinor: 25_000, status: "COMPLETED" }] });
      const weekly = await getWeeklyForecast(t.db, c.owner, NOW);
      const uk01 = weekly.outlets.find(row => row.outletId === c.mapping.UK01)!;
      expect(uk01.selection).toMatchObject({ source: "REFERENCE", rejected: [{ source: "SQUARE", reason: "INSUFFICIENT_DAYS" }] });
      expect(uk01.days).toEqual(baseline.days);
      // A reference rerun neither alters nor adopts the Square payment.
      expect(await provisionReferenceHistory(t.db, window, NOW)).toMatchObject({ inserted: 0 });
      const bySource = await t.db.select({ source: saleTransactions.source, prefix: sql<string>`left(${saleTransactions.internalReference}, 3)`, status: saleTransactions.providerStatus, n: sql<number>`count(*)::int` })
        .from(saleTransactions).where(eq(saleTransactions.outletId, c.mapping.UK01)).groupBy(saleTransactions.source, sql`left(${saleTransactions.internalReference}, 3)`, saleTransactions.providerStatus);
      const expected = referenceDates("2026-10-05", "2026-10-31").reduce((sum, date) => sum + referenceTransactions("UK01", date).length, 0);
      expect(bySource.sort((a, b) => a.source.localeCompare(b.source))).toEqual([
        { source: "REFERENCE", prefix: "REF", status: "REFERENCE", n: expected },
        { source: "SQUARE", prefix: "SQU", status: "SQUARE", n: 1 },
      ]);
    } finally { await t.close(); }
  }, 120_000);
});
