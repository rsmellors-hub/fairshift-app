import { randomBytes, randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { entitled } from "../helpers/onboarding";
import type { Scope } from "@/server/auth/access";
import { requireScope } from "@/server/auth/request";
import { connectZettle, disconnectZettle, getCommerceConnections, syncZettle } from "@/server/commerce/connections";
import { ingestCommerceObservations } from "@/server/commerce/ingestion";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { auditEvents, commerceConnections, commerceSyncRuns, memberships, organisations, outlets, saleTransactions, subscriptions, users } from "@/server/db/schema";
import { prepareAssessmentInput } from "@/server/intelligence/ai-staffing-contract";
import { setLabourPolicy, setRegularCoverage } from "@/server/intelligence/business-policy";
import { shiftDate } from "@/server/intelligence/forecast";
import { getWeeklyStaffing } from "@/server/intelligence/staffing";
import { getWeeklyForecast } from "@/server/intelligence/weekly";
import { ZettleError, type ZettleClient, type ZettlePage } from "@/server/integrations/zettle/client";
import { OwnerWorkspace } from "@/app/owner/workspace";
import OwnerLocationPage from "@/app/owner/locations/[locationId]/page";

vi.mock("@/server/auth/request", () => ({ requireScope: vi.fn() }));
vi.mock("@/server/db/client", () => ({ getDatabase: vi.fn() }));
vi.mock("@/server/config/env", () => ({ getConfigurationStatus: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); }, notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const NOW = new Date("2026-10-25T10:00:00Z"), YESTERDAY = "2026-10-24", MONDAY = "2026-10-26";
const SECRET = "zettle-api-key-do-not-store-in-clear";
type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];
beforeEach(() => { vi.useFakeTimers({ now: NOW, toFake: ["Date"] }); vi.stubEnv("COMMERCE_CREDENTIAL_KEY", randomBytes(32).toString("base64")); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.resetAllMocks(); });

async function business(db: Db, names: string[] = ["Northgate"]) {
  const organisationId = randomUUID();
  await db.insert(organisations).values({ id: organisationId, name: "Unrelated business", country: "United Kingdom" });
  await db.insert(subscriptions).values({ id: randomUUID(), organisationId, requestId: randomUUID() });
  await entitled(db, organisationId);
  const rows = names.map(name => ({ id: randomUUID(), organisationId, name, timezone: "Europe/London" }));
  await db.insert(outlets).values(rows);
  const userId = randomUUID();
  await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: "Owner", passwordHash: "x", emailVerifiedAt: NOW });
  await db.insert(memberships).values({ id: randomUUID(), userId, organisationId, role: "OWNER" });
  const scope: Scope = { userId, organisationId, locationId: rows[0].id, role: "OWNER", organisationName: "Unrelated business", locationName: rows[0].name };
  return { organisationId, outletId: rows[0].id, rows, scope };
}
const purchase = (id: string, date: string, amount: number, over: Record<string, unknown> = {}) => ({ purchaseUUID1: id, amount, currency: "GBP", timestamp: `${date}T12:00:00.000+0000`, refund: false, userDisplayName: "Staff Name", ...over });
const dailyPurchases = (days: number, amount: (date: string) => number) => Array.from({ length: days }, (_, i) => { const date = shiftDate(YESTERDAY, -i); return purchase(`p-${date}`, date, amount(date)); });
function fakeClient(pages: unknown[][] = [], over: Partial<ZettleClient> = {}, merchant = "merchant-1") {
  const queue = [...pages, []];
  const client = {
    accessToken: vi.fn(async () => "access-token"),
    merchantId: vi.fn(async () => merchant),
    purchases: vi.fn(async (_token: string, query: { limit: number; lastPurchaseHash?: string }): Promise<ZettlePage> => {
      if (query.limit === 1) return { purchases: [], lastPurchaseHash: null };
      const next = queue.shift() ?? [];
      return { purchases: next, lastPurchaseHash: next.length ? `hash-${queue.length}` : null };
    }),
    ...over,
  };
  return client;
}
const connect = (db: Db, b: Awaited<ReturnType<typeof business>>, client: ZettleClient = fakeClient()) => connectZettle(db, b.scope, { outletId: b.outletId, clientId: "client", apiKey: SECRET }, client, NOW);
const zettleRows = (db: Db, outletId: string) => db.select().from(saleTransactions).where(eq(saleTransactions.outletId, outletId));
const withDb = async (run: (db: Db) => Promise<void>) => { const t = await createTestDatabase(); try { await run(t.db); } finally { await t.close(); } };

describe("connecting a Zettle account", () => {
  it("stores nothing unless Zettle accepts the credentials and allows a purchase read", () => withDb(async db => {
    const b = await business(db);
    const rejected = fakeClient([], { accessToken: vi.fn(async () => { throw new ZettleError("AUTH_REJECTED"); }) });
    await expect(connect(db, b, rejected)).rejects.toMatchObject({ feedback: "zettle-credentials-rejected" });
    const noScope = fakeClient([], { purchases: vi.fn(async () => { throw new ZettleError("SCOPE_MISSING"); }) });
    await expect(connect(db, b, noScope)).rejects.toMatchObject({ feedback: "zettle-scope-missing" });
    const down = fakeClient([], { merchantId: vi.fn(async () => { throw new ZettleError("PROVIDER_UNAVAILABLE"); }) });
    await expect(connect(db, b, down)).rejects.toMatchObject({ feedback: "zettle-unavailable" });
    expect(await db.select().from(commerceConnections)).toEqual([]);
  }));
  it("seals the key at rest and never returns it or the merchant identifier", () => withDb(async db => {
    const b = await business(db);
    await connect(db, b);
    const [row] = await db.select().from(commerceConnections);
    expect(row.sealedCredentials).not.toContain(SECRET);
    const views = await getCommerceConnections(db, b.scope);
    expect(JSON.stringify(views)).not.toMatch(/zettle-api-key|merchant-1|sealed/i);
    expect(JSON.stringify(await db.select().from(auditEvents))).not.toContain(SECRET);
  }));
  it("refuses without a server key, for managers and workers, for another tenant's location, and without entitlement", () => withDb(async db => {
    const b = await business(db), other = await business(db);
    for (const role of ["MANAGER", "TEAM_MEMBER"] as const) await expect(connectZettle(db, { ...b.scope, role }, { outletId: b.outletId, clientId: "c", apiKey: "k" }, fakeClient(), NOW)).rejects.toThrow("Access denied");
    await expect(connectZettle(db, b.scope, { outletId: other.outletId, clientId: "c", apiKey: "k" }, fakeClient(), NOW)).rejects.toMatchObject({ feedback: "commerce-location" });
    await db.update(subscriptions).set({ status: "SUSPENDED" }).where(eq(subscriptions.organisationId, b.organisationId));
    await expect(connect(db, b)).rejects.toThrow();
    await db.update(subscriptions).set({ status: "ACTIVE" }).where(eq(subscriptions.organisationId, b.organisationId));
    vi.stubEnv("COMMERCE_CREDENTIAL_KEY", "");
    await expect(connect(db, b)).rejects.toMatchObject({ feedback: "commerce-not-configured" });
    expect(await db.select().from(commerceConnections)).toEqual([]);
  }));
  it("allows one live connection per location and one location per merchant account, across tenants", () => withDb(async db => {
    const b = await business(db, ["A", "B"]), other = await business(db);
    await connect(db, b);
    await expect(connect(db, b, fakeClient([], {}, "merchant-2"))).rejects.toMatchObject({ feedback: "zettle-already-connected" });
    await expect(connectZettle(db, b.scope, { outletId: b.rows[1].id, clientId: "c", apiKey: "k" }, fakeClient(), NOW)).rejects.toMatchObject({ feedback: "zettle-already-connected" });
    await expect(connect(db, other)).rejects.toMatchObject({ feedback: "zettle-already-connected" });
  }));
});

describe("synchronising sales", () => {
  it("stores completed sales through the canonical boundary with Zettle provenance only", () => withDb(async db => {
    const b = await business(db);
    await connect(db, b);
    const result = await syncZettle(db, b.scope, b.outletId, fakeClient([[purchase("a", YESTERDAY, 1234), purchase("r", YESTERDAY, -1234, { refund: true })]]), NOW);
    expect(result).toEqual({ status: "SUCCEEDED", retrieved: 2, inserted: 1, duplicates: 0, refundsExcluded: 1 });
    const [row, ...rest] = await zettleRows(db, b.outletId);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ source: "ZETTLE", sourceSystem: "ZETTLE:merchant-1", sourceTransactionId: "a", providerStatus: "ZETTLE", verificationState: "PENDING", reconciliationState: "NOT_RECONCILED", grossAmountMinor: 1234, currencyCode: "GBP", paypalCaptureId: null });
    expect(JSON.stringify(row)).not.toContain("Staff Name");
  }));
  it("is idempotent: repeating a sync changes nothing", () => withDb(async db => {
    const b = await business(db);
    await connect(db, b);
    const page = [purchase("a", YESTERDAY, 1234), purchase("b", YESTERDAY, 500)];
    await syncZettle(db, b.scope, b.outletId, fakeClient([page]), NOW);
    expect(await syncZettle(db, b.scope, b.outletId, fakeClient([page]), NOW)).toMatchObject({ status: "SUCCEEDED", inserted: 0, duplicates: 2 });
    expect(await zettleRows(db, b.outletId)).toHaveLength(2);
  }));
  it("follows pagination, widening nothing and fetching since the last completed sync", () => withDb(async db => {
    const b = await business(db);
    await connect(db, b);
    const client = fakeClient([[purchase("a", YESTERDAY, 100)], [purchase("b", YESTERDAY, 200)]]);
    expect(await syncZettle(db, b.scope, b.outletId, client, NOW)).toMatchObject({ retrieved: 2, inserted: 2 });
    expect(vi.mocked(client.purchases).mock.calls.map(call => call[1].lastPurchaseHash)).toEqual([undefined, "hash-2", "hash-1"]);
    expect(vi.mocked(client.purchases).mock.calls[0][1]).toMatchObject({ startDate: shiftDate("2026-10-25", -120), limit: 1000 });
    const later = fakeClient([]);
    await syncZettle(db, b.scope, b.outletId, later, new Date("2026-10-30T10:00:00Z"));
    expect(vi.mocked(later.purchases).mock.calls[0][1]).toMatchObject({ startDate: "2026-10-24" });
  }));
  it("records a provider failure as a failure, keeps prior history, and does not advance the window", () => withDb(async db => {
    const b = await business(db);
    await connect(db, b);
    await syncZettle(db, b.scope, b.outletId, fakeClient([[purchase("a", YESTERDAY, 100)]]), NOW);
    const down = fakeClient([], { purchases: vi.fn(async () => { throw new ZettleError("PROVIDER_UNAVAILABLE"); }) });
    expect(await syncZettle(db, b.scope, b.outletId, down, new Date("2026-10-28T10:00:00Z"))).toEqual({ status: "FAILED", failureCode: "PROVIDER_UNAVAILABLE" });
    expect(await zettleRows(db, b.outletId)).toHaveLength(1);
    const [view] = await getCommerceConnections(db, b.scope);
    expect(view.latestRun).toMatchObject({ status: "FAILED", failureCode: "PROVIDER_UNAVAILABLE" });
    expect(view.lastSuccess).toMatchObject({ status: "SUCCEEDED", retrieved: 1 });
    const later = fakeClient([]);
    await syncZettle(db, b.scope, b.outletId, later, new Date("2026-10-29T10:00:00Z"));
    expect(vi.mocked(later.purchases).mock.calls[0][1]).toMatchObject({ startDate: "2026-10-24" });
  }));
  it("stores nothing when any purchase in the retrieval is malformed", () => withDb(async db => {
    const b = await business(db);
    await connect(db, b);
    expect(await syncZettle(db, b.scope, b.outletId, fakeClient([[purchase("a", YESTERDAY, 100), { purchaseUUID1: "bad", amount: "12" }]]), NOW)).toMatchObject({ status: "FAILED", failureCode: "MALFORMED_RESPONSE" });
    expect(await zettleRows(db, b.outletId)).toEqual([]);
  }));
  it("stores nothing when a later page of the retrieval fails, and does not advance the window", () => withDb(async db => {
    const b = await business(db);
    await connect(db, b);
    const purchases = vi.fn<ZettleClient["purchases"]>()
      .mockResolvedValueOnce({ purchases: [purchase("a", YESTERDAY, 100)], lastPurchaseHash: "hash-1" })
      .mockRejectedValueOnce(new ZettleError("PROVIDER_UNAVAILABLE"));
    expect(await syncZettle(db, b.scope, b.outletId, fakeClient([], { purchases }), NOW)).toEqual({ status: "FAILED", failureCode: "PROVIDER_UNAVAILABLE" });
    expect(await zettleRows(db, b.outletId)).toEqual([]);
    expect((await getCommerceConnections(db, b.scope))[0].lastSuccess).toBeNull();
  }));
  it("refuses a provider that repeats a page rather than looping or recording it as complete", () => withDb(async db => {
    const b = await business(db);
    await connect(db, b);
    const purchases = vi.fn<ZettleClient["purchases"]>(async () => ({ purchases: [purchase("a", YESTERDAY, 100)], lastPurchaseHash: "same-hash" }));
    expect(await syncZettle(db, b.scope, b.outletId, fakeClient([], { purchases }), NOW)).toEqual({ status: "FAILED", failureCode: "MALFORMED_RESPONSE" });
    expect(purchases).toHaveBeenCalledTimes(2);
    expect(await zettleRows(db, b.outletId)).toEqual([]);
  }));
  it("a retrieval spanning several ingestion batches is stored whole or not at all", () => withDb(async db => {
    const b = await business(db);
    await connect(db, b);
    const good = Array.from({ length: 10_000 }, (_, i) => purchase(`p-${i}`, YESTERDAY, 100));
    expect(await syncZettle(db, b.scope, b.outletId, fakeClient([[...good, purchase("future", "2027-01-01", 100)]]), NOW)).toMatchObject({ status: "FAILED", failureCode: "FUTURE_DATED" });
    expect(await zettleRows(db, b.outletId)).toEqual([]);
  }), 120_000);
  it("rejects changed facts for a sale already held, a future-dated sale and an unsupported currency", () => withDb(async db => {
    const b = await business(db);
    await connect(db, b);
    await syncZettle(db, b.scope, b.outletId, fakeClient([[purchase("a", YESTERDAY, 100)]]), NOW);
    expect(await syncZettle(db, b.scope, b.outletId, fakeClient([[purchase("a", YESTERDAY, 999)]]), NOW)).toMatchObject({ status: "FAILED", failureCode: "CONFLICTING_DUPLICATE" });
    expect(await syncZettle(db, b.scope, b.outletId, fakeClient([[purchase("f", "2027-01-01", 100)]]), NOW)).toMatchObject({ status: "FAILED", failureCode: "FUTURE_DATED" });
    expect(await syncZettle(db, b.scope, b.outletId, fakeClient([[purchase("j", YESTERDAY, 100, { currency: "JPY" })]]), NOW)).toMatchObject({ status: "FAILED", failureCode: "UNSUPPORTED_CURRENCY" });
    expect((await zettleRows(db, b.outletId)).map(row => row.grossAmountMinor)).toEqual([100]);
  }));
  it("a revoked key marks the connection for attention without touching history", () => withDb(async db => {
    const b = await business(db);
    await connect(db, b);
    await syncZettle(db, b.scope, b.outletId, fakeClient([[purchase("a", YESTERDAY, 100)]]), NOW);
    const revoked = fakeClient([], { accessToken: vi.fn(async () => { throw new ZettleError("AUTH_REJECTED"); }) });
    expect(await syncZettle(db, b.scope, b.outletId, revoked, NOW)).toMatchObject({ status: "FAILED", failureCode: "AUTH_REJECTED" });
    expect((await getCommerceConnections(db, b.scope))[0].status).toBe("AUTH_FAILED");
    expect(await zettleRows(db, b.outletId)).toHaveLength(1);
  }));
  it("treats an empty retrieval as no records, with no sales created", () => withDb(async db => {
    const b = await business(db);
    await connect(db, b);
    expect(await syncZettle(db, b.scope, b.outletId, fakeClient([]), NOW)).toMatchObject({ status: "SUCCEEDED", retrieved: 0, inserted: 0 });
    expect(await zettleRows(db, b.outletId)).toEqual([]);
    expect((await getWeeklyForecast(db, b.scope, NOW)).outlets[0].selection.status).toBe("NONE");
  }));
  it("refuses overlapping runs and recovers from an abandoned one", () => withDb(async db => {
    const b = await business(db);
    const { id } = await connect(db, b);
    await db.insert(commerceSyncRuns).values({ id: randomUUID(), connectionId: id, status: "RUNNING", windowStart: NOW, startedAt: NOW });
    await expect(syncZettle(db, b.scope, b.outletId, fakeClient([]), NOW)).rejects.toMatchObject({ feedback: "commerce-sync-running" });
    expect(await syncZettle(db, b.scope, b.outletId, fakeClient([]), new Date(NOW.getTime() + 16 * 60_000))).toMatchObject({ status: "SUCCEEDED" });
  }));
  it("only the owning organisation's Owner can sync or disconnect, and a location without a connection cannot", () => withDb(async db => {
    const b = await business(db), other = await business(db, ["Elsewhere"]);
    await connect(db, b);
    await expect(syncZettle(db, other.scope, b.outletId, fakeClient([]), NOW)).rejects.toMatchObject({ feedback: "commerce-location" });
    await expect(disconnectZettle(db, other.scope, b.outletId, NOW)).rejects.toMatchObject({ feedback: "commerce-location" });
    await expect(syncZettle(db, { ...b.scope, role: "MANAGER" }, b.outletId, fakeClient([]), NOW)).rejects.toThrow("Access denied");
    await expect(syncZettle(db, other.scope, other.outletId, fakeClient([]), NOW)).rejects.toMatchObject({ feedback: "commerce-not-connected" });
    expect(await getCommerceConnections(db, other.scope)).toEqual([]);
  }));
  it("disconnecting erases the credentials and keeps retrieved history, and the account can reconnect without duplicates", () => withDb(async db => {
    const b = await business(db);
    await connect(db, b);
    await syncZettle(db, b.scope, b.outletId, fakeClient([[purchase("a", YESTERDAY, 100)]]), NOW);
    await disconnectZettle(db, b.scope, b.outletId, NOW);
    const [row] = await db.select().from(commerceConnections);
    expect(row).toMatchObject({ status: "DISCONNECTED", sealedCredentials: null });
    await expect(syncZettle(db, b.scope, b.outletId, fakeClient([]), NOW)).rejects.toMatchObject({ feedback: "commerce-not-connected" });
    expect(await zettleRows(db, b.outletId)).toHaveLength(1);
    await connect(db, b);
    expect(await syncZettle(db, b.scope, b.outletId, fakeClient([[purchase("a", YESTERDAY, 100)]]), NOW)).toMatchObject({ inserted: 0, duplicates: 1 });
  }));
});

describe("provenance", () => {
  it("cannot be claimed through the generic import, and the database enforces it", () => withDb(async db => {
    const b = await business(db);
    await expect(ingestCommerceObservations(db, { organisationId: b.organisationId, source: "ZETTLE", sourceSystem: "x", now: NOW, observations: [{ outletId: b.outletId, sourceTransactionId: "x", occurredAt: `${YESTERDAY}T12:00:00Z`, currencyCode: "GBP", grossAmountMinor: 1, status: "COMPLETED" }] })).rejects.toMatchObject({ code: "UNSUPPORTED_SOURCE" });
    const insert = (values: string) => db.execute(sql.raw(`insert into sale_transactions (id, internal_reference, outlet_id, currency_code, gross_amount_minor, source, provider_status, verification_state, reconciliation_state, source_system, source_transaction_id, occurred_at, paypal_capture_id) values ('${randomUUID()}', '${randomUUID()}', '${b.outletId}', 'GBP', 100, 'ZETTLE', ${values})`));
    await expect(insert(`'ZETTLE','VERIFIED','NOT_RECONCILED','z','1',now(),null`)).rejects.toThrow();
    await expect(insert(`'ZETTLE','PENDING','RECONCILED','z','2',now(),null`)).rejects.toThrow();
    await expect(insert(`'COMPLETED','PENDING','NOT_RECONCILED','z','3',now(),null`)).rejects.toThrow();
    await expect(insert(`'ZETTLE','PENDING','NOT_RECONCILED',null,'4',now(),null`)).rejects.toThrow();
    await expect(insert(`'ZETTLE','PENDING','NOT_RECONCILED','z','5',null,null`)).rejects.toThrow();
    await expect(insert(`'ZETTLE','PENDING','NOT_RECONCILED','z','6',now(),'CAP'`)).rejects.toThrow();
    await insert(`'ZETTLE','PENDING','NOT_RECONCILED','z','7',now(),null`);
  }));
  it("each source stays separate: imported history and reference labels are unchanged by a connection", () => withDb(async db => {
    const b = await business(db);
    await ingestCommerceObservations(db, { organisationId: b.organisationId, source: "IMPORTED", sourceSystem: "file", now: NOW, observations: [{ outletId: b.outletId, sourceTransactionId: "a", occurredAt: `${YESTERDAY}T12:00:00Z`, currencyCode: "GBP", grossAmountMinor: 5, status: "COMPLETED" }] });
    await connect(db, b);
    await syncZettle(db, b.scope, b.outletId, fakeClient([[purchase("a", YESTERDAY, 9)]]), NOW);
    const rows = await zettleRows(db, b.outletId);
    expect(rows.map(row => [row.source, row.grossAmountMinor]).sort()).toEqual([["IMPORTED", 5], ["ZETTLE", 9]]);
  }));
});

describe("connected commerce drives the established pipeline", () => {
  const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
  const seedImported = (db: Db, b: Awaited<ReturnType<typeof business>>) => ingestCommerceObservations(db, { organisationId: b.organisationId, source: "IMPORTED", sourceSystem: "file", now: NOW, observations: Array.from({ length: 56 }, (_, i) => { const date = shiftDate(YESTERDAY, -i); return { outletId: b.outletId, sourceTransactionId: date, occurredAt: `${date}T12:00:00Z`, currencyCode: "GBP", grossAmountMinor: 100_000, status: "COMPLETED" }; }) });
  const configure = async (db: Db, b: Awaited<ReturnType<typeof business>>) => {
    await setLabourPolicy(db, b.scope, "ORGANISATION", { currencyCode: "GBP", salesMinorPerLabourHour: 10_000 });
    await setRegularCoverage(db, b.scope, Array(7).fill(60));
  };
  it("thin connected sales change nothing; sufficient ones replace the forecast, labour and AI input with no other change", () => withDb(async db => {
    const b = await business(db);
    await seedImported(db, b);
    await configure(db, b);
    const before = await getWeeklyStaffing(db, b.scope, NOW);
    expect(before.outlets[0].evidence?.source).toBe("IMPORTED");
    expect(before.outlets[0].days[0]).toMatchObject({ forecastSalesMinor: 100_000, requiredMinutes: 600, casualGapMinutes: 540 });
    const fingerprint = prepareAssessmentInput(before, "ORGANISATION").fingerprint;
    const sales = (date: string) => weekday(date) === 1 ? 400_000 : 200_000;

    await connect(db, b);
    await syncZettle(db, b.scope, b.outletId, fakeClient([dailyPurchases(5, sales)]), NOW);
    const thin = await getWeeklyStaffing(db, b.scope, NOW);
    expect((await getWeeklyForecast(db, b.scope, NOW)).outlets[0].selection).toMatchObject({ source: "IMPORTED", rejected: [{ source: "ZETTLE", reason: "INSUFFICIENT_DAYS" }] });
    expect(prepareAssessmentInput(thin, "ORGANISATION").fingerprint).toBe(fingerprint);

    await syncZettle(db, b.scope, b.outletId, fakeClient([dailyPurchases(56, sales)]), NOW);
    const after = await getWeeklyStaffing(db, b.scope, NOW);
    expect(after.outlets[0].evidence).toMatchObject({ source: "ZETTLE", kind: "PROVIDER", dataThrough: YESTERDAY });
    expect(after.outlets[0].days[0]).toMatchObject({ planningDate: MONDAY, forecastSalesMinor: 400_000, requiredMinutes: 2400, casualGapMinutes: 2340 });
    expect(prepareAssessmentInput(after, "ORGANISATION").fingerprint).not.toBe(fingerprint);
  }));
  it("a fresh business forecasts from connected sales alone, in the provider's values", () => withDb(async db => {
    const b = await business(db);
    await connect(db, b);
    expect(await syncZettle(db, b.scope, b.outletId, fakeClient([dailyPurchases(56, date => weekday(date) === 1 ? 400_000 : 200_000)]), NOW)).toMatchObject({ status: "SUCCEEDED", inserted: 56 });
    const weekly = await getWeeklyForecast(db, b.scope, NOW);
    expect(weekly.outlets[0].selection).toMatchObject({ status: "SELECTED", source: "ZETTLE", kind: "PROVIDER", currency: "GBP", dataThrough: YESTERDAY });
    expect(weekly.outlets[0].days.find(day => day.targetDate === MONDAY)?.forecast?.forecastSalesMinor).toBe(400_000);
    const staffing = await getWeeklyStaffing(db, b.scope, NOW);
    const input = prepareAssessmentInput(staffing, "ORGANISATION").input;
    expect(input.locations[0].evidence).toMatchObject({ source: "ZETTLE", kind: "PROVIDER", synthetic: false });
    expect(input.locations[0].flags).not.toContain("SYNTHETIC_REFERENCE_DATA");
    expect(staffing.outlets[0].commercial?.recent).toMatchObject({ transactions: 7 });
    // Missing inputs stay missing even with genuine sales: no policy means no labour figures.
    expect(staffing.outlets[0].days[0]).toMatchObject({ requiredMinutes: null, unavailable: "NO_LABOUR_POLICY" });
    expect(staffing.outlets[0].commercial).toMatchObject({ cost: null, costUnavailable: "GAP_UNAVAILABLE" });
  }));
  it("another tenant's connected sales never appear", () => withDb(async db => {
    const b = await business(db), other = await business(db, ["Elsewhere"]);
    await connect(db, b);
    await syncZettle(db, b.scope, b.outletId, fakeClient([dailyPurchases(56, () => 200_000)]), NOW);
    const weekly = await getWeeklyForecast(db, other.scope, NOW);
    expect(weekly.outlets.map(row => row.outletId)).toEqual([other.outletId]);
    expect(weekly.outlets[0].selection.status).toBe("NONE");
  }));
});

describe("Owner pages", () => {
  const prepare = (db: Db, scope: Scope, configured = true) => {
    vi.mocked(requireScope).mockResolvedValue(scope);
    vi.mocked(getDatabase).mockReturnValue(db);
    vi.mocked(getConfigurationStatus).mockReturnValue({ databaseConfigured: true, aiConfigured: configured, paypalPayoutConfigured: true } as ReturnType<typeof getConfigurationStatus>);
  };
  const sales = async () => renderToStaticMarkup(await OwnerWorkspace({ area: "reporting" }));
  const location = async (locationId: string) => renderToStaticMarkup(await OwnerLocationPage({ params: Promise.resolve({ locationId }) }));

  it("Sales offers no Zettle controls and claims no Zettle data, configured or not", () => withDb(async db => {
    const b = await business(db);
    prepare(db, b.scope);
    let html = await sales();
    expect(html).not.toMatch(/Zettle|name="apiKey"/);
    vi.stubEnv("COMMERCE_CREDENTIAL_KEY", "");
    html = await sales();
    expect(html).toContain("not configured in this environment");
    expect(html).not.toMatch(/Zettle|name="apiKey"/);
  }));
  // Retrieved rows stay truthful history if any exist, without naming an inactive provider.
  it("Sales keeps earlier retrieved sales separate, and shows whether they drive the forecast", () => withDb(async db => {
    const b = await business(db);
    prepare(db, b.scope);
    await connect(db, b);
    await syncZettle(db, b.scope, b.outletId, fakeClient([dailyPurchases(5, () => 100_000)]), NOW);
    const html = await sales();
    expect(html).toContain("Earlier connected-account sales");
    expect(html).toContain("Not used for forecast");
    expect(html).toContain("5 of 28 required days");
    expect(html).not.toMatch(/Zettle|zettle-api-key|name="apiKey"/);
  }));
  it("location drill-down is scoped to the organisation and keeps missing figures unavailable", () => withDb(async db => {
    const b = await business(db), other = await business(db, ["Elsewhere"]);
    prepare(db, b.scope);
    const html = await location(b.outletId);
    expect(html).toContain("Northgate");
    expect(html).toContain("No eligible sales history");
    expect(html).toContain("Not available");
    // Allocated casual hours are a recorded zero; nothing unknown may read as zero.
    expect(html).not.toContain("£0");
    expect(html).toContain("Needs a complete casual labour gap");
    await expect(location(other.outletId)).rejects.toThrow("NOT_FOUND");
    await expect(location(randomUUID())).rejects.toThrow("NOT_FOUND");
    await expect(location("not-a-uuid")).rejects.toThrow("NOT_FOUND");
  }));
});
