import { randomBytes, randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { entitled } from "../helpers/onboarding";
import { resolveScope, type Scope } from "@/server/auth/access";
import { workerRespond } from "@/server/auth/operations";
import { requireScope } from "@/server/auth/request";
import { inviteMember, redeemInvitation } from "@/server/auth/tenancy";
import { getCommerceConnections, disconnectZettle, syncZettle } from "@/server/commerce/connections";
import { ingestCommerceObservations } from "@/server/commerce/ingestion";
import { connectSquare, getSquareActivity, getSquareFreshness, refreshSquareSales, SQUARE_REFRESH_POLL_MS, SQUARE_VISIBLE_WITHIN_MS, syncSquare } from "@/server/commerce/square-connection";
import { prepareDemoShift, recordSquareSandboxSale } from "@/server/commerce/square-demo";
import { getSquareMappings, listSquareTeamMembers, mapSquareTeamMember, removeSquareMapping } from "@/server/commerce/square-mapping";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { attributedSales, auditEvents, commerceConnections, commercePaymentEvidence, commerceRefundEvidence, commerceSyncRuns, commerceWorkerIdentities, memberships, organisations, outlets, saleTransactions, shifts, subscriptions, users, workPerformanceResults, workPayables } from "@/server/db/schema";
import { SquareError, type SquareClient } from "@/server/integrations/square/client";
import { shiftDate } from "@/server/intelligence/forecast";
import { getWeeklyForecast } from "@/server/intelligence/weekly";
import { approveWorkPayable } from "@/server/payments/work-payouts";
import { confirmWorkPerformance, getLocationPerformance, getWorkerTargets, importAttributedSales } from "@/server/performance/attribution";
import { allocateAssignment, changeAssignment, confirmWork, createDepartment, createRequirement, createWorkPolicy, offerAssignment } from "@/server/scheduling/operations";
import { confirmPerformanceAction, importAttributedSalesAction } from "@/app/operations-actions";
import { recordSquareSandboxSaleAction } from "@/app/square-actions";
import { ManagerWorkspace } from "@/app/manager/workspace";
import { OwnerWorkspace } from "@/app/owner/workspace";
import { WorkerWorkspace } from "@/app/worker/workspace";

vi.mock("@/server/auth/request", () => ({ requireScope: vi.fn() }));
vi.mock("@/server/db/client", () => ({ getDatabase: vi.fn() }));
vi.mock("@/server/config/env", () => ({ getConfigurationStatus: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); }, notFound: () => { throw new Error("NOT_FOUND"); }, useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const BEFORE = new Date("2026-01-15T12:00:00Z"), DURING = new Date("2026-01-19T12:00:00Z"), AFTER = new Date("2026-01-20T12:00:00Z");
const SECRET = "fixture-square-token-do-not-store-in-clear";
const CREDENTIALS = { applicationId: "fixture-app", accessToken: SECRET };
beforeEach(() => { vi.useFakeTimers({ now: BEFORE, toFake: ["Date"] }); vi.stubEnv("COMMERCE_CREDENTIAL_KEY", randomBytes(32).toString("base64")); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.resetAllMocks(); });

type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];
const withDb = async (run: (db: Db) => Promise<void>) => { const t = await createTestDatabase(); try { await run(t.db); } finally { await t.close(); } };

const payment = (id: string, teamMemberId: string | undefined, at: string, amount: number, over: Record<string, unknown> = {}) => ({ id, status: "COMPLETED", location_id: "SQ-LOC", created_at: at, amount_money: { amount, currency: "GBP" }, ...(teamMemberId ? { team_member_id: teamMemberId } : {}), ...over });
const refund = (id: string, paymentId: string, amount: number, over: Record<string, unknown> = {}) => ({ id, status: "COMPLETED", location_id: "SQ-LOC", payment_id: paymentId, created_at: "2026-01-19T11:30:00.000Z", amount_money: { amount, currency: "GBP" }, team_member_id: "TM-OTHER", ...over });
// A stand-in for Square. Everything through this client in this file is a fixture, not provider evidence.
function fakeSquare(initial: { payments?: unknown[]; refunds?: unknown[]; members?: { id: string; name: string }[]; locations?: { id: string; merchant_id: string; status: string; currency: string }[] } = {}) {
  const state = { payments: initial.payments ?? [], refunds: initial.refunds ?? [], members: initial.members ?? [{ id: "TM-A", name: "Sandbox A" }, { id: "TM-B", name: "Sandbox B" }], locations: initial.locations ?? [{ id: "SQ-LOC", merchant_id: "SQ-MERCHANT", status: "ACTIVE", currency: "GBP" }] };
  const client = {
    locations: vi.fn<SquareClient["locations"]>(async () => state.locations),
    teamMembers: vi.fn<SquareClient["teamMembers"]>(async () => state.members),
    payments: vi.fn<SquareClient["payments"]>(async () => ({ items: state.payments, cursor: null })),
    refunds: vi.fn<SquareClient["refunds"]>(async () => ({ items: state.refunds, cursor: null })),
    createSandboxPayment: vi.fn<SquareClient["createSandboxPayment"]>(async () => ({ id: "NEW", status: "COMPLETED" })),
  };
  return { state, client };
}

let n = 0;
async function user(db: Db) {
  const id = randomUUID(), email = `u${++n}-${randomUUID().slice(0, 6)}@example.test`;
  await db.insert(users).values({ id, email, name: "Person", passwordHash: "x", emailVerifiedAt: new Date() });
  return { id, email };
}
async function business(db: Db, locations: string[] = ["Northgate"], country = "United Kingdom") {
  const organisationId = randomUUID();
  await db.insert(organisations).values({ id: organisationId, name: "Fictional Retail", country });
  await db.insert(subscriptions).values({ id: randomUUID(), organisationId, requestId: randomUUID() });
  await entitled(db, organisationId);
  const rows = locations.map(name => ({ id: randomUUID(), organisationId, name, timezone: "Europe/London", country }));
  await db.insert(outlets).values(rows);
  const owner = await user(db), ownerMembership = randomUUID();
  await db.insert(memberships).values({ id: ownerMembership, userId: owner.id, organisationId, role: "OWNER" });
  const ownerScope = await resolveScope(db, owner.id, ownerMembership, rows[0].id);
  const ownerAt = (i: number) => resolveScope(db, owner.id, ownerMembership, rows[i].id);
  const manager = async (i = 0) => {
    const person = await user(db), at = await ownerAt(i);
    const { token } = await inviteMember(db, at, { role: "MANAGER", email: person.email, firstName: "Morgan", surname: "Manager", telephone: "+441130000000" });
    return resolveScope(db, person.id, (await redeemInvitation(db, person.id, { token })).id);
  };
  const worker = async (by: Scope, firstName = "Casey") => {
    const person = await user(db);
    const { token } = await inviteMember(db, by, { role: "TEAM_MEMBER", email: person.email, firstName, surname: "Worker", telephone: "+441130000001" });
    return resolveScope(db, person.id, (await redeemInvitation(db, person.id, { token })).id);
  };
  return { organisationId, rows, ownerScope, ownerAt, manager, worker };
}
// £104 base from £13.00 for 8 hours (at or above the FairShift demo minimum, FS-WAGE-INTEL-DEC-002),
// £200 target, £25 bonus, in pence. Amendment F's £12.00 example is historical evidence, below that minimum.
async function setup(db: Db, square = fakeSquare()) {
  const c = await business(db), manager = await c.manager(), worker = await c.worker(manager);
  const [department] = await createDepartment(db, "Sales floor", c.ownerScope);
  const [policy] = await createWorkPolicy(db, { earningsModel: "HOURLY", rateMinor: 1_300, incentiveTargetMinor: 20_000, incentiveBonusMinor: 2_500 }, "Casual with bonus", c.ownerScope);
  await connectSquare(db, c.ownerScope, { outletId: c.rows[0].id }, square.client, CREDENTIALS);
  return { c, manager, worker, department, policy, square };
}
type Setup = Awaited<ReturnType<typeof setup>>;
const map = (db: Db, s: Setup, teamMemberId = "TM-A") => mapSquareTeamMember(db, s.manager, { workerId: s.worker.workerId!, teamMemberId }, s.square.client);
async function offered(db: Db, s: Setup, start = "2026-01-19T09:00:00Z", end = "2026-01-19T17:00:00Z") {
  const shift = await createRequirement(db, { departmentId: s.department.id, policyId: s.policy.id, startsAt: new Date(start), endsAt: new Date(end), requiredHeadcount: 1 }, s.manager);
  const offer = await offerAssignment(db, shift.id, s.worker.workerId!, s.manager);
  return { shift, offer };
}
async function booked(db: Db, s: Setup) {
  const { shift, offer } = await offered(db, s);
  await workerRespond(db, s.worker, offer.id, 1, "ACCEPTED", true);
  const allocation = await allocateAssignment(db, offer.id, s.manager);
  return { shift, offer, allocation };
}
const sync = (db: Db, s: Setup, now = new Date()) => syncSquare(db, s.c.ownerScope, s.c.rows[0].id, s.square.client, now);
const attributed = (db: Db) => db.select().from(attributedSales);
const squareSales = (db: Db) => db.select().from(saleTransactions).where(eq(saleTransactions.source, "SQUARE"));
const totals = async (db: Db, s: Setup) => (await getLocationPerformance(db, s.manager))[0];
const pages = (db: Db) => {
  vi.mocked(getDatabase).mockReturnValue(db);
  vi.mocked(getConfigurationStatus).mockReturnValue({ databaseConfigured: true, aiConfigured: false, paypalPayoutConfigured: true } as ReturnType<typeof getConfigurationStatus>);
};
const render = async (scope: Scope, element: () => Promise<React.ReactNode>) => { vi.mocked(requireScope).mockResolvedValue(scope); return renderToStaticMarkup(await element()); };
const STRONGER_CLAIMS = /till[- ]?(login|verified)|pos[- ]?(login|verified|sale)|cashier|verified employee|logged[- ]in worker|take payment/i;

describe("connecting Square Sandbox", () => {
  it("stores nothing unless Square accepts the credentials and allows a payment read", () => withDb(async db => {
    const c = await business(db), { client } = fakeSquare();
    const connect = (over: Partial<SquareClient>) => connectSquare(db, c.ownerScope, { outletId: c.rows[0].id }, { ...client, ...over }, CREDENTIALS);
    await expect(connect({ locations: vi.fn(async () => { throw new SquareError("AUTH_REJECTED"); }) })).rejects.toMatchObject({ feedback: "square-credentials-rejected" });
    await expect(connect({ payments: vi.fn(async () => { throw new SquareError("SCOPE_MISSING"); }) })).rejects.toMatchObject({ feedback: "square-credentials-rejected" });
    await expect(connect({ locations: vi.fn(async () => { throw new SquareError("PROVIDER_UNAVAILABLE"); }) })).rejects.toMatchObject({ feedback: "square-unavailable" });
    await expect(connectSquare(db, c.ownerScope, { outletId: c.rows[0].id }, client, null)).rejects.toMatchObject({ feedback: "square-not-configured" });
    expect(await db.select().from(commerceConnections)).toEqual([]);
  }));
  it("seals the token and never returns or logs it", () => withDb(async db => {
    const s = await setup(db);
    const [row] = await db.select().from(commerceConnections);
    expect(row).toMatchObject({ provider: "SQUARE", providerEnvironment: "SANDBOX", providerLocationId: "SQ-LOC", providerMerchantId: "SQ-MERCHANT" });
    expect(row.sealedCredentials).not.toContain(SECRET);
    expect(JSON.stringify(await getCommerceConnections(db, s.c.ownerScope))).not.toMatch(/fixture-square-token|SQ-MERCHANT|sealed/);
    expect(JSON.stringify(await db.select().from(auditEvents))).not.toContain(SECRET);
  }));
  it("binds one Square location to exactly one FairShift location, and other locations keep their sources", () => withDb(async db => {
    const c = await business(db, ["Northgate", "Southgate"]), other = await business(db), { client } = fakeSquare();
    await connectSquare(db, c.ownerScope, { outletId: c.rows[0].id }, client, CREDENTIALS);
    await expect(connectSquare(db, await c.ownerAt(1), { outletId: c.rows[1].id }, client, CREDENTIALS)).rejects.toMatchObject({ feedback: "square-already-connected" });
    await expect(connectSquare(db, other.ownerScope, { outletId: other.rows[0].id }, client, CREDENTIALS)).rejects.toMatchObject({ feedback: "square-already-connected" });
    await expect(connectSquare(db, c.ownerScope, { outletId: c.rows[0].id }, fakeSquare({ locations: [{ id: "X", merchant_id: "OTHER", status: "ACTIVE", currency: "GBP" }] }).client, CREDENTIALS)).rejects.toMatchObject({ feedback: "square-already-connected" });
    await ingestCommerceObservations(db, { organisationId: c.organisationId, source: "IMPORTED", sourceSystem: "file", now: BEFORE, observations: [{ outletId: c.rows[1].id, sourceTransactionId: "a", occurredAt: "2026-01-14T12:00:00Z", currencyCode: "GBP", grossAmountMinor: 5, status: "COMPLETED" }] });
    expect(await db.select().from(commerceConnections)).toHaveLength(1);
    expect((await db.select().from(saleTransactions)).map(row => row.source)).toEqual(["IMPORTED"]);
  }));
  it("refuses an ambiguous seller and a location in another currency", () => withDb(async db => {
    const c = await business(db), z = await business(db, ["Sandton"], "South Africa");
    const two = fakeSquare({ locations: [{ id: "A", merchant_id: "M", status: "ACTIVE", currency: "GBP" }, { id: "B", merchant_id: "M", status: "ACTIVE", currency: "GBP" }] });
    await expect(connectSquare(db, c.ownerScope, { outletId: c.rows[0].id }, two.client, CREDENTIALS)).rejects.toMatchObject({ feedback: "square-location-choice" });
    await expect(connectSquare(db, z.ownerScope, { outletId: z.rows[0].id }, fakeSquare().client, CREDENTIALS)).rejects.toMatchObject({ feedback: "square-location-currency" });
    expect(await db.select().from(commerceConnections)).toEqual([]);
  }));
  it("only the Owner of that organisation connects, syncs or disconnects", () => withDb(async db => {
    const s = await setup(db), rival = await business(db, ["Elsewhere"]);
    await expect(connectSquare(db, s.manager, { outletId: s.c.rows[0].id }, s.square.client, CREDENTIALS)).rejects.toThrow("Access denied");
    await expect(connectSquare(db, rival.ownerScope, { outletId: s.c.rows[0].id }, s.square.client, CREDENTIALS)).rejects.toMatchObject({ feedback: "commerce-location" });
    await expect(syncSquare(db, s.manager, s.c.rows[0].id, s.square.client)).rejects.toThrow("Access denied");
    await expect(syncSquare(db, s.worker, s.c.rows[0].id, s.square.client)).rejects.toThrow("Access denied");
    await expect(syncSquare(db, rival.ownerScope, s.c.rows[0].id, s.square.client)).rejects.toMatchObject({ feedback: "commerce-location" });
    await expect(disconnectZettle(db, rival.ownerScope, s.c.rows[0].id)).rejects.toMatchObject({ feedback: "commerce-location" });
  }));
  it("never hands a Square connection's credentials to the dormant Zettle sync", () => withDb(async db => {
    const s = await setup(db);
    const zettle = { accessToken: vi.fn(async () => "x"), merchantId: vi.fn(async () => "x"), purchases: vi.fn(async () => ({ purchases: [], lastPurchaseHash: null })) };
    await expect(syncZettle(db, s.c.ownerScope, s.c.rows[0].id, zettle)).rejects.toMatchObject({ feedback: "commerce-not-connected" });
    expect(zettle.accessToken).not.toHaveBeenCalled();
  }));
  it("disconnecting erases the token, keeps history and stops attribution reads", () => withDb(async db => {
    const s = await setup(db);
    s.square.state.payments = [payment("P1", "TM-A", "2026-01-14T12:00:00.000Z", 100)];
    await sync(db, s);
    await disconnectZettle(db, s.c.ownerScope, s.c.rows[0].id);
    expect((await db.select().from(commerceConnections))[0]).toMatchObject({ status: "DISCONNECTED", sealedCredentials: null });
    expect(await squareSales(db)).toHaveLength(1);
    await expect(sync(db, s)).rejects.toMatchObject({ feedback: "commerce-not-connected" });
  }));
});

describe("provider behaviour during sync", () => {
  it("stores a completed payment through the canonical boundary with Square provenance and its evidence", () => withDb(async db => {
    const s = await setup(db);
    s.square.state.payments = [payment("P1", "TM-A", "2026-01-14T12:00:00.000Z", 1234, { note: "ignored", card_details: { card: { last_4: "1111" } } })];
    expect(await sync(db, s)).toMatchObject({ status: "SUCCEEDED", retrieved: 1, inserted: 1, duplicates: 0, notCompleted: 0 });
    const [sale] = await squareSales(db);
    expect(sale).toMatchObject({ source: "SQUARE", sourceSystem: "SQUARE:SQ-MERCHANT", sourceTransactionId: "P1", providerStatus: "SQUARE", verificationState: "PENDING", reconciliationState: "NOT_RECONCILED", grossAmountMinor: 1234, currencyCode: "GBP", paypalCaptureId: null });
    expect(await db.select().from(commercePaymentEvidence)).toEqual([expect.objectContaining({ saleTransactionId: sale.id, providerPaymentId: "P1", providerLocationId: "SQ-LOC", providerStatus: "COMPLETED", providerTeamMemberId: "TM-A" })]);
    expect(JSON.stringify(sale)).not.toMatch(/ignored|1111/);
  }));
  it("a revoked token is a failure that needs attention, not zero sales, and stops background retries", () => withDb(async db => {
    const s = await setup(db);
    s.square.state.payments = [payment("P1", "TM-A", "2026-01-14T12:00:00.000Z", 100)];
    await sync(db, s);
    s.square.client.payments.mockRejectedValue(new SquareError("AUTH_REJECTED"));
    expect(await sync(db, s)).toEqual({ status: "FAILED", failureCode: "AUTH_REJECTED" });
    expect((await getCommerceConnections(db, s.c.ownerScope))[0].status).toBe("AUTH_FAILED");
    expect(await squareSales(db)).toHaveLength(1);
    s.square.client.payments.mockClear();
    expect(await refreshSquareSales(db, s.worker, s.square.client, new Date(Date.now() + 60_000))).toEqual({ status: "SKIPPED" });
    expect(s.square.client.payments).not.toHaveBeenCalled();
  }));
  it("stores nothing from a malformed response, and does not advance the window", () => withDb(async db => {
    const s = await setup(db);
    s.square.state.payments = [payment("OK", "TM-A", "2026-01-14T12:00:00.000Z", 100), { id: "BAD", amount_money: "12" }];
    expect(await sync(db, s)).toEqual({ status: "FAILED", failureCode: "MALFORMED_RESPONSE" });
    expect(await squareSales(db)).toEqual([]);
    expect((await getCommerceConnections(db, s.c.ownerScope))[0].lastSuccess).toBeNull();
  }));
  it("stores nothing when a later page fails, or when refunds can't be read", () => withDb(async db => {
    const s = await setup(db);
    s.square.client.payments.mockResolvedValueOnce({ items: [payment("A", "TM-A", "2026-01-14T12:00:00.000Z", 100)], cursor: "c1" }).mockRejectedValueOnce(new SquareError("PROVIDER_UNAVAILABLE"));
    expect(await sync(db, s)).toEqual({ status: "FAILED", failureCode: "PROVIDER_UNAVAILABLE" });
    expect(await squareSales(db)).toEqual([]);
    s.square.state.payments = [payment("A", "TM-A", "2026-01-14T12:00:00.000Z", 100)];
    s.square.client.payments.mockImplementation(async () => ({ items: s.square.state.payments, cursor: null }));
    s.square.client.refunds.mockRejectedValueOnce(new SquareError("RATE_LIMITED"));
    expect(await sync(db, s, new Date(Date.now() + 1))).toEqual({ status: "FAILED", failureCode: "RATE_LIMITED" });
    expect(await squareSales(db)).toEqual([]);
    expect((await getCommerceConnections(db, s.c.ownerScope))[0].lastSuccess).toBeNull();
  }));
  it("refuses a provider that repeats a page rather than looping or recording it as complete", () => withDb(async db => {
    const s = await setup(db);
    s.square.client.payments.mockResolvedValue({ items: [payment("A", "TM-A", "2026-01-14T12:00:00.000Z", 100)], cursor: "same" });
    expect(await sync(db, s)).toEqual({ status: "FAILED", failureCode: "MALFORMED_RESPONSE" });
    expect(s.square.client.payments).toHaveBeenCalledTimes(3); // Connect's read, then the page and its repeat.
    expect(await squareSales(db)).toEqual([]);
  }));
  it("finds a payment listed late on a later overlapping sync, exactly once, as the gate observed", () => withDb(async db => {
    const s = await setup(db);
    await map(db, s);
    await booked(db, s);
    vi.setSystemTime(DURING);
    const shown = payment("SHOWN", "TM-A", "2026-01-19T11:59:50.000Z", 5_000), late = payment("LATE", "TM-A", "2026-01-19T11:59:51.000Z", 7_000);
    s.square.state.payments = [shown];
    expect(await sync(db, s)).toMatchObject({ inserted: 1, attribution: { attributed: 1 } });
    const first = new Date(DURING.getTime() + 4_000);
    vi.setSystemTime(first);
    s.square.state.payments = [shown, late];
    expect(await sync(db, s)).toMatchObject({ retrieved: 2, inserted: 1, duplicates: 1, attribution: { attributed: 1 } });
    // The later sync reaches back before the first one started, so its window covers the gap.
    expect(new Date(s.square.client.payments.mock.calls.at(-1)![1].beginTime).getTime()).toBeLessThan(DURING.getTime());
    expect((await totals(db, s)).attributed).toEqual({ count: 2, minor: 12_000 });
    await sync(db, s, new Date(first.getTime() + 4_000));
    expect((await totals(db, s)).attributed).toEqual({ count: 2, minor: 12_000 });
    expect(await squareSales(db)).toHaveLength(2);
  }));
  it("a repeated sync, an overlapping sync and a duplicate in one page each count once", () => withDb(async db => {
    const s = await setup(db);
    const one = payment("P1", "TM-A", "2026-01-14T12:00:00.000Z", 100);
    s.square.state.payments = [one, one];
    expect(await sync(db, s)).toMatchObject({ status: "SUCCEEDED", retrieved: 2, inserted: 1 });
    expect(await sync(db, s)).toMatchObject({ status: "SUCCEEDED", inserted: 0 });
    expect(await squareSales(db)).toHaveLength(1);
    expect(await db.select().from(commercePaymentEvidence)).toHaveLength(1);
  }));
  it("concurrent syncs are safe: one runs, and the other declines without storing anything twice", () => withDb(async db => {
    const s = await setup(db);
    s.square.state.payments = [payment("P1", "TM-A", "2026-01-14T12:00:00.000Z", 100)];
    const results = await Promise.allSettled([sync(db, s), refreshSquareSales(db, s.worker, s.square.client), sync(db, s)]);
    expect(results.some(row => row.status === "fulfilled" && row.value.status === "SUCCEEDED")).toBe(true);
    expect(await squareSales(db)).toHaveLength(1);
    const { id } = (await db.select().from(commerceConnections))[0];
    await db.update(commerceSyncRuns).set({ status: "SUCCEEDED", finishedAt: new Date() }).where(eq(commerceSyncRuns.status, "RUNNING"));
    await db.insert(commerceSyncRuns).values({ id: randomUUID(), connectionId: id, status: "RUNNING", windowStart: BEFORE, startedAt: new Date() });
    await expect(sync(db, s)).rejects.toMatchObject({ feedback: "commerce-sync-running" });
    expect(await refreshSquareSales(db, s.worker, s.square.client, new Date(Date.now() + 60_000))).toEqual({ status: "SKIPPED" });
  }));
  it("refuses a payment whose amount or team member changed: identity must stay stable", () => withDb(async db => {
    const s = await setup(db);
    s.square.state.payments = [payment("P1", "TM-A", "2026-01-14T12:00:00.000Z", 100)];
    await sync(db, s);
    s.square.state.payments = [payment("P1", "TM-A", "2026-01-14T12:00:00.000Z", 999)];
    expect(await sync(db, s)).toMatchObject({ status: "FAILED", failureCode: "CONFLICTING_DUPLICATE" });
    s.square.state.payments = [payment("P1", "TM-B", "2026-01-14T12:00:00.000Z", 100)];
    expect(await sync(db, s)).toMatchObject({ status: "FAILED", failureCode: "CONFLICTING_DUPLICATE" });
    expect((await db.select().from(commercePaymentEvidence))[0].providerTeamMemberId).toBe("TM-A");
    expect((await squareSales(db))[0].grossAmountMinor).toBe(100);
  }));
  it("refuses an unsupported currency, and another location's record, storing nothing", () => withDb(async db => {
    const s = await setup(db);
    s.square.state.payments = [payment("J", "TM-A", "2026-01-14T12:00:00.000Z", 100, { amount_money: { amount: 100, currency: "JPY" } })];
    expect(await sync(db, s)).toMatchObject({ status: "FAILED", failureCode: "UNSUPPORTED_CURRENCY" });
    s.square.state.payments = [payment("X", "TM-A", "2026-01-14T12:00:00.000Z", 100, { location_id: "OTHER" })];
    expect(await sync(db, s)).toMatchObject({ status: "FAILED", failureCode: "MALFORMED_RESPONSE" });
    expect(await squareSales(db)).toEqual([]);
  }));
  it("a far-future payment is refused, and a provider clock slightly ahead is not", () => withDb(async db => {
    const s = await setup(db);
    s.square.state.payments = [payment("SOON", undefined, new Date(Date.now() + 60_000).toISOString(), 100)];
    expect(await sync(db, s)).toMatchObject({ status: "SUCCEEDED", inserted: 1 });
    s.square.state.payments = [payment("FAR", undefined, new Date(Date.now() + 3_600_000).toISOString(), 100)];
    expect(await sync(db, s)).toMatchObject({ status: "FAILED", failureCode: "FUTURE_DATED" });
  }));
  it("does not treat a non-completed payment as a sale, and takes it once it completes", () => withDb(async db => {
    const s = await setup(db);
    await map(db, s);
    await booked(db, s);
    vi.setSystemTime(DURING);
    const at = "2026-01-19T11:00:00.000Z";
    s.square.state.payments = [payment("A", "TM-A", at, 500, { status: "APPROVED" }), payment("C", "TM-A", at, 500, { status: "CANCELED" }), payment("F", "TM-A", at, 500, { status: "FAILED" }), payment("P", "TM-A", at, 500, { status: "PENDING" })];
    expect(await sync(db, s)).toMatchObject({ retrieved: 4, inserted: 0, notCompleted: 4 });
    expect(await squareSales(db)).toEqual([]);
    expect(await attributed(db)).toEqual([]);
    s.square.state.payments = [payment("A", "TM-A", at, 500)];
    expect(await sync(db, s)).toMatchObject({ inserted: 1, attribution: { attributed: 1 } });
    expect((await totals(db, s)).attributed).toEqual({ count: 1, minor: 500 });
  }));
});

describe("connected Square sales and the forecast", () => {
  const days = (count: number, from: string) => Array.from({ length: count }, (_, i) => { const date = shiftDate(from, -i); return payment(`D-${date}`, undefined, `${date}T12:00:00.000Z`, 200_000); });
  it("thin Square history shows as insufficient and reference history stays the labelled source", () => withDb(async db => {
    const s = await setup(db);
    await ingestCommerceObservations(db, { organisationId: s.c.organisationId, source: "REFERENCE", sourceSystem: "reference", now: BEFORE, observations: Array.from({ length: 56 }, (_, i) => { const date = shiftDate("2026-01-14", -i); return { outletId: s.c.rows[0].id, sourceTransactionId: date, occurredAt: `${date}T12:00:00Z`, currencyCode: "GBP", grossAmountMinor: 100_000, status: "COMPLETED" }; }) });
    s.square.state.payments = days(4, "2026-01-14");
    await sync(db, s);
    const selection = (await getWeeklyForecast(db, s.c.ownerScope, BEFORE)).outlets[0].selection;
    expect(selection).toMatchObject({ status: "SELECTED", source: "REFERENCE" });
    expect(selection.rejected).toEqual(expect.arrayContaining([expect.objectContaining({ source: "SQUARE", reason: "INSUFFICIENT_DAYS" })]));
  }));
  it("Square sales made only today say so: too few completed days, not that another source won", () => withDb(async db => {
    vi.stubEnv("SQUARE_ENVIRONMENT", "sandbox"); vi.stubEnv("SQUARE_ACCESS_TOKEN", SECRET); vi.stubEnv("SQUARE_APPLICATION_ID", "fixture-app");
    const s = await setup(db); pages(db);
    await ingestCommerceObservations(db, { organisationId: s.c.organisationId, source: "REFERENCE", sourceSystem: "reference", now: BEFORE, observations: Array.from({ length: 56 }, (_, i) => { const date = shiftDate("2026-01-14", -i); return { outletId: s.c.rows[0].id, sourceTransactionId: date, occurredAt: `${date}T12:00:00Z`, currencyCode: "GBP", grossAmountMinor: 100_000, status: "COMPLETED" }; }) });
    s.square.state.payments = [payment("TODAY", undefined, "2026-01-15T11:00:00.000Z", 500)];
    await sync(db, s);
    const html = await render(s.c.ownerScope, () => OwnerWorkspace({ area: "reporting" }));
    expect(html).toContain("0 of 28 required completed days. Today counts once it has finished.");
    expect(html).toContain("Drives this location’s forecast");
    const square = html.slice(html.indexOf("Square Sandbox sales · connected seller"), html.indexOf("Reference sales history · synthetic"));
    expect(square).not.toContain("another source takes precedence");
  }));
  it("the same threshold applies to Square: only genuine sufficiency selects it", () => withDb(async db => {
    const s = await setup(db);
    s.square.state.payments = days(56, "2026-01-14");
    await sync(db, s);
    expect((await getWeeklyForecast(db, s.c.ownerScope, BEFORE)).outlets[0].selection).toMatchObject({ status: "SELECTED", source: "SQUARE", kind: "PROVIDER" });
  }));
  it("Square provenance can't be claimed through the import, and the database enforces it", () => withDb(async db => {
    const c = await business(db);
    await expect(ingestCommerceObservations(db, { organisationId: c.organisationId, source: "SQUARE", sourceSystem: "x", now: BEFORE, observations: [{ outletId: c.rows[0].id, sourceTransactionId: "x", occurredAt: "2026-01-14T12:00:00Z", currencyCode: "GBP", grossAmountMinor: 1, status: "COMPLETED" }] })).rejects.toMatchObject({ code: "UNSUPPORTED_SOURCE" });
    const insert = (values: string) => db.execute(sql.raw(`insert into sale_transactions (id, internal_reference, outlet_id, currency_code, gross_amount_minor, source, provider_status, verification_state, reconciliation_state, source_system, source_transaction_id, occurred_at, paypal_capture_id) values ('${randomUUID()}', '${randomUUID()}', '${c.rows[0].id}', 'GBP', 100, 'SQUARE', ${values})`));
    await expect(insert(`'SQUARE','VERIFIED','NOT_RECONCILED','s','1',now(),null`)).rejects.toThrow();
    await expect(insert(`'COMPLETED','PENDING','NOT_RECONCILED','s','2',now(),null`)).rejects.toThrow();
    await expect(insert(`'SQUARE','PENDING','NOT_RECONCILED',null,'3',now(),null`)).rejects.toThrow();
    await expect(insert(`'SQUARE','PENDING','NOT_RECONCILED','s','4',now(),'CAP'`)).rejects.toThrow();
    await insert(`'SQUARE','PENDING','NOT_RECONCILED','s','5',now(),null`);
  }));
  it("the database refuses a Square connection that isn't bound to a Sandbox location", () => withDb(async db => {
    const c = await business(db);
    const row = { id: randomUUID(), organisationId: c.organisationId, outletId: c.rows[0].id, provider: "SQUARE", status: "CONNECTED", providerMerchantId: "M", sealedCredentials: "x", connectedAt: new Date() };
    await expect(db.insert(commerceConnections).values({ ...row, providerLocationId: "L", providerEnvironment: "PRODUCTION" })).rejects.toThrow();
    await expect(db.insert(commerceConnections).values({ ...row, providerEnvironment: "SANDBOX" })).rejects.toThrow();
  }));
});

describe("mapping a worker to a Square team member", () => {
  it("maps only a team member Square lists, and audits it", () => withDb(async db => {
    const s = await setup(db);
    await expect(mapSquareTeamMember(db, s.manager, { workerId: s.worker.workerId!, teamMemberId: "NOT-LISTED" }, s.square.client)).rejects.toMatchObject({ feedback: "square-mapping-identity" });
    await map(db, s);
    expect(await getSquareMappings(db, s.manager)).toEqual([expect.objectContaining({ workerId: s.worker.workerId, teamMemberId: "TM-A" })]);
    expect((await db.select().from(auditEvents)).map(row => row.action)).toContain("SQUARE_TEAM_MEMBER_MAPPED");
    expect((await db.select().from(commerceWorkerIdentities))[0]).toMatchObject({ organisationId: s.c.organisationId, outletId: s.c.rows[0].id, providerMerchantId: "SQ-MERCHANT", createdBy: s.manager.userId });
    expect(await listSquareTeamMembers(db, s.manager, s.square.client)).toHaveLength(2);
  }));
  it("refuses a worker mapping themselves, or reading the team list", () => withDb(async db => {
    const s = await setup(db);
    await expect(mapSquareTeamMember(db, s.worker, { workerId: s.worker.workerId!, teamMemberId: "TM-A" }, s.square.client)).rejects.toThrow("Access denied");
    await expect(listSquareTeamMembers(db, s.worker, s.square.client)).rejects.toThrow("Access denied");
    await expect(removeSquareMapping(db, s.worker, randomUUID())).rejects.toThrow("Access denied");
    await expect(getSquareMappings(db, s.worker)).rejects.toThrow("Access denied");
    expect(await db.select().from(commerceWorkerIdentities)).toEqual([]);
  }));
  it("keeps a Manager inside their location, and a tenant inside its own organisation", () => withDb(async db => {
    const c = await business(db, ["Northgate", "Southgate"]), { client } = fakeSquare();
    const north = await c.manager(0), south = await c.manager(1), northWorker = await c.worker(north), southWorker = await c.worker(south);
    await connectSquare(db, c.ownerScope, { outletId: c.rows[0].id }, client, CREDENTIALS);
    await expect(mapSquareTeamMember(db, north, { workerId: southWorker.workerId!, teamMemberId: "TM-A" }, client)).rejects.toMatchObject({ feedback: "square-mapping-worker" });
    // Southgate has no Square connection, so its manager cannot map anyone, even a Northgate worker.
    await expect(mapSquareTeamMember(db, south, { workerId: northWorker.workerId!, teamMemberId: "TM-A" }, client)).rejects.toMatchObject({ feedback: "commerce-not-connected" });
    const rival = await business(db, ["Rival"]), rivalManager = await rival.manager();
    await expect(mapSquareTeamMember(db, rivalManager, { workerId: northWorker.workerId!, teamMemberId: "TM-A" }, client)).rejects.toMatchObject({ feedback: "commerce-not-connected" });
    expect(await db.select().from(commerceWorkerIdentities)).toEqual([]);
    const forged = { id: randomUUID(), organisationId: rival.organisationId, outletId: rival.rows[0].id, workerId: northWorker.workerId!, provider: "SQUARE", providerMerchantId: "SQ-MERCHANT", providerTeamMemberId: "TM-A", status: "ACTIVE", createdAt: new Date() };
    await mapSquareTeamMember(db, north, { workerId: northWorker.workerId!, teamMemberId: "TM-A" }, client);
    // A second live mapping of one provider identity is refused even if written directly.
    await expect(db.insert(commerceWorkerIdentities).values(forged)).rejects.toThrow();
  }));
  it("the Owner can map at the location in their session", () => withDb(async db => {
    const s = await setup(db);
    await mapSquareTeamMember(db, s.c.ownerScope, { workerId: s.worker.workerId!, teamMemberId: "TM-B" }, s.square.client);
    expect((await db.select().from(commerceWorkerIdentities))[0].createdBy).toBe(s.c.ownerScope.userId);
  }));
  it("refuses a duplicate of a worker or of a team member", () => withDb(async db => {
    const s = await setup(db), second = await s.c.worker(s.manager, "Dee");
    await map(db, s);
    await expect(map(db, s, "TM-B")).rejects.toMatchObject({ feedback: "square-mapping-duplicate" });
    await expect(mapSquareTeamMember(db, s.manager, { workerId: second.workerId!, teamMemberId: "TM-A" }, s.square.client)).rejects.toMatchObject({ feedback: "square-mapping-duplicate" });
    expect(await db.select().from(commerceWorkerIdentities)).toHaveLength(1);
  }));
  it("a Manager at another location can't remove a mapping", () => withDb(async db => {
    const s = await setup(db), rival = await business(db, ["Rival"]), rivalManager = await rival.manager();
    const { id } = await map(db, s);
    await expect(removeSquareMapping(db, rivalManager, id)).rejects.toMatchObject({ feedback: "square-mapping-unavailable" });
    expect((await db.select().from(commerceWorkerIdentities))[0].status).toBe("ACTIVE");
  }));
});

describe("attributing a Square payment to a worker", () => {
  const AT = "2026-01-19T11:00:00.000Z";
  const bookedAndMapped = async (db: Db) => { const s = await setup(db); await map(db, s); const work = await booked(db, s); vi.setSystemTime(DURING); return { s, work }; };

  it("credits the provider's amount when every condition holds", () => withDb(async db => {
    const { s } = await bookedAndMapped(db);
    s.square.state.payments = [payment("P1", "TM-A", AT, 12_345)];
    expect(await sync(db, s)).toMatchObject({ attribution: { attributed: 1 } });
    expect(await attributed(db)).toEqual([expect.objectContaining({ provider: "SQUARE", providerTransactionId: "P1", workerId: s.worker.workerId, outletId: s.c.rows[0].id, amountMinor: 12_345, currencyCode: "GBP", source: "SQUARE_SYNC", verificationState: "UNVERIFIED" })]);
    const [view] = await getWorkerTargets(db, { organisationId: s.worker.organisationId, locationId: s.worker.locationId, workerId: s.worker.workerId! });
    expect(view).toMatchObject({ attributed: { count: 1, minor: 12_345 }, evidence: "SQUARE" });
  }));
  it.each([
    ["no team member", () => payment("X", undefined, AT, 500), "noTeamMember"],
    ["an unknown team member", () => payment("X", "TM-NOBODY", AT, 500), "unmapped"],
    ["a team member mapped to nobody here", () => payment("X", "TM-B", AT, 500), "unmapped"],
    ["a time before the shift", () => payment("X", "TM-A", "2026-01-19T08:59:59.000Z", 500), "noMatchingShift"],
    ["the shift's exact end", () => payment("X", "TM-A", "2026-01-19T17:00:00.000Z", 500), "noMatchingShift"],
    ["a time after the shift", () => payment("X", "TM-A", "2026-01-19T17:00:01.000Z", 500), "noMatchingShift"],
  ])("does not attribute a payment with %s", (_name, make, counter) => withDb(async db => {
    const { s } = await bookedAndMapped(db);
    vi.setSystemTime(AFTER);
    s.square.state.payments = [make()];
    expect(await sync(db, s)).toMatchObject({ status: "SUCCEEDED", inserted: 1, attribution: { attributed: 0, [counter]: 1 } });
    expect(await attributed(db)).toEqual([]);
    expect(await squareSales(db)).toHaveLength(1); // Still a genuine sale at this location.
  }));
  it("does not attribute the wrong currency", () => withDb(async db => {
    const { s } = await bookedAndMapped(db);
    s.square.state.payments = [payment("X", "TM-A", AT, 500, { amount_money: { amount: 500, currency: "USD" } })];
    expect(await sync(db, s)).toMatchObject({ attribution: { attributed: 0, wrongCurrency: 1 } });
    expect(await attributed(db)).toEqual([]);
  }));
  it("does not attribute to an unallocated worker, until the manager finalises the shift", () => withDb(async db => {
    const s = await setup(db);
    await map(db, s);
    const { offer } = await offered(db, s);
    await workerRespond(db, s.worker, offer.id, 1, "ACCEPTED", true);
    vi.setSystemTime(DURING);
    s.square.state.payments = [payment("P1", "TM-A", AT, 500)];
    expect(await sync(db, s)).toMatchObject({ attribution: { attributed: 0, noMatchingShift: 1 } });
    await allocateAssignment(db, offer.id, s.manager);
    expect(await sync(db, s, new Date(DURING.getTime() + 1))).toMatchObject({ attribution: { attributed: 1 } });
  }));
  it("does not attribute to a cancelled shift", () => withDb(async db => {
    const { s, work } = await bookedAndMapped(db);
    await changeAssignment(db, s.manager, work.shift.id, { cancel: true });
    s.square.state.payments = [payment("P1", "TM-A", AT, 500)];
    expect(await sync(db, s)).toMatchObject({ attribution: { attributed: 0, noMatchingShift: 1 } });
    expect(await attributed(db)).toEqual([]);
  }));
  it("does not attribute to a worker mapped at another location or tenant", () => withDb(async db => {
    const { s } = await bookedAndMapped(db);
    await db.update(commerceWorkerIdentities).set({ status: "REMOVED", removedAt: new Date() });
    const rival = await business(db, ["Rival"]), rivalManager = await rival.manager(), rivalWorker = await rival.worker(rivalManager);
    await db.insert(commerceWorkerIdentities).values({ id: randomUUID(), organisationId: rival.organisationId, outletId: rival.rows[0].id, workerId: rivalWorker.workerId!, provider: "SQUARE", providerMerchantId: "SQ-MERCHANT", providerTeamMemberId: "TM-A", status: "ACTIVE", createdAt: new Date() });
    s.square.state.payments = [payment("P1", "TM-A", AT, 500)];
    expect(await sync(db, s)).toMatchObject({ attribution: { attributed: 0, unmapped: 1 } });
    // Nor does a mapping row at this location help when it names a worker from elsewhere.
    await db.update(commerceWorkerIdentities).set({ status: "REMOVED", removedAt: new Date() });
    await db.insert(commerceWorkerIdentities).values({ id: randomUUID(), organisationId: s.c.organisationId, outletId: s.c.rows[0].id, workerId: rivalWorker.workerId!, provider: "SQUARE", providerMerchantId: "SQ-MERCHANT", providerTeamMemberId: "TM-A", status: "ACTIVE", createdAt: new Date() });
    expect(await sync(db, s, new Date(DURING.getTime() + 1))).toMatchObject({ attribution: { attributed: 0, unmapped: 1 } });
    expect(await attributed(db)).toEqual([]);
  }));
  it("a removed mapping stops attribution and withdraws unconfirmed sales, so a mistake can be corrected", () => withDb(async db => {
    const s = await setup(db), second = await s.c.worker(s.manager, "Dee");
    const { id } = await map(db, s);
    await booked(db, s);
    vi.setSystemTime(DURING);
    s.square.state.payments = [payment("P1", "TM-A", AT, 500)];
    await sync(db, s);
    expect(await attributed(db)).toHaveLength(1);
    expect(await removeSquareMapping(db, s.manager, id)).toEqual({ withdrawn: 1 });
    expect(await attributed(db)).toEqual([]);
    expect(await sync(db, s, new Date(DURING.getTime() + 1))).toMatchObject({ attribution: { attributed: 0, unmapped: 1 } });
    await expect(removeSquareMapping(db, s.manager, id)).rejects.toMatchObject({ feedback: "square-mapping-unavailable" });
    // The history of who mapped what stays.
    expect((await db.select().from(commerceWorkerIdentities))[0]).toMatchObject({ status: "REMOVED", removedBy: s.manager.userId });
    await mapSquareTeamMember(db, s.manager, { workerId: second.workerId!, teamMemberId: "TM-A" }, s.square.client);
  }));
  it("a mapping made after the payment still picks it up, once", () => withDb(async db => {
    const s = await setup(db);
    await booked(db, s);
    vi.setSystemTime(DURING);
    s.square.state.payments = [payment("P1", "TM-A", AT, 500)];
    expect(await sync(db, s)).toMatchObject({ attribution: { attributed: 0, unmapped: 1 } });
    await map(db, s);
    expect((await totals(db, s)).attributed).toEqual({ count: 1, minor: 500 });
    await sync(db, s, new Date(DURING.getTime() + 1));
    expect(await attributed(db)).toHaveLength(1);
  }));
  it("a transaction already attributed is not attributed again, and results that are final can't move", () => withDb(async db => {
    const { s, work } = await bookedAndMapped(db);
    s.square.state.payments = [payment("P1", "TM-A", AT, 500)];
    await sync(db, s);
    await sync(db, s, new Date(DURING.getTime() + 1));
    expect(await attributed(db)).toHaveLength(1);
    vi.setSystemTime(AFTER);
    await confirmWork(db, work.offer.id, s.manager);
    await sync(db, s);
    await confirmWorkPerformance(db, s.manager, work.allocation.id, { count: 1, minor: 500 });
    s.square.state.payments = [payment("P1", "TM-A", AT, 500), payment("LATE", "TM-A", "2026-01-19T12:00:00.000Z", 99_999)];
    expect(await sync(db, s, new Date(AFTER.getTime() + 1))).toMatchObject({ attribution: { attributed: 0, resultsFinal: 1 } });
    expect((await db.select().from(workPerformanceResults))[0]).toMatchObject({ salesCount: 1, salesMinor: 500 });
  }));
  it("ignores forged client totals: the amount is Square's and the posted figures only guard against late sales", () => withDb(async db => {
    const { s, work } = await bookedAndMapped(db);
    pages(db);
    s.square.state.payments = [payment("P1", "TM-A", AT, 5_000)];
    await sync(db, s);
    vi.setSystemTime(AFTER);
    await confirmWork(db, work.offer.id, s.manager);
    await sync(db, s);
    const form = (values: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(values)) f.set(k, v); return f; };
    vi.mocked(requireScope).mockResolvedValue(s.manager);
    const forged = await confirmPerformanceAction(form({ allocationId: work.allocation.id, complete: "yes", seenCount: "9", seenMinor: "999999" })).catch((error: Error) => error.message);
    expect(String(forged)).toContain("status=sales-changed");
    expect(await db.select().from(workPerformanceResults)).toEqual([]);
    await confirmPerformanceAction(form({ allocationId: work.allocation.id, complete: "yes", seenCount: "1", seenMinor: "5000", earnedMinor: "999999", salesMinor: "999999", evidenceProvenance: "SQUARE_TEAM_MEMBER" })).catch(() => undefined);
    expect((await db.select().from(workPerformanceResults))[0]).toMatchObject({ salesMinor: 5_000, earnedMinor: 0 });
  }));
  it("closes the pasted import at a connected location, so a sale can't be counted twice or forged", () => withDb(async db => {
    const { s } = await bookedAndMapped(db);
    await expect(importAttributedSales(db, s.manager, "transaction_id,attribution_code,occurred_at,amount,currency\nT1,FS-X,2026-01-19T10:00:00Z,999.00,GBP")).rejects.toMatchObject({ feedback: "import-closed-connected" });
    pages(db);
    vi.mocked(requireScope).mockResolvedValue(s.manager);
    const f = new FormData(); f.set("rows", "transaction_id,attribution_code,occurred_at,amount,currency\nT1,FS-X,2026-01-19T10:00:00Z,999.00,GBP");
    expect(String(await importAttributedSalesAction(f).catch((error: Error) => error.message))).toContain("status=import-closed-connected");
  }));
});

describe("the economics stay FairShift's", () => {
  const AT = "2026-01-19T11:00:00.000Z";
  async function finished(db: Db, amounts: number[]) {
    const s = await setup(db);
    await map(db, s);
    const work = await booked(db, s);
    vi.setSystemTime(DURING);
    s.square.state.payments = amounts.map((amount, i) => payment(`P${i}`, "TM-A", AT, amount));
    await sync(db, s);
    vi.setSystemTime(AFTER);
    const { payable } = await confirmWork(db, work.offer.id, s.manager);
    await sync(db, s);
    return { s, work, payable: payable! };
  }
  it("one penny below the target earns no bonus: £104 base only", () => withDb(async db => {
    const { s, work, payable } = await finished(db, [12_000, 7_999]);
    expect(await confirmWorkPerformance(db, s.manager, work.allocation.id, { count: 2, minor: 19_999 })).toMatchObject({ salesMinor: 19_999, earnedMinor: 0, evidenceProvenance: "SQUARE_TEAM_MEMBER" });
    expect(await approveWorkPayable(db, s.manager, payable.id)).toMatchObject({ baseAmountMinor: 10_400, incentiveAmountMinor: 0, approvedAmountMinor: 10_400, currencyCode: "GBP" });
  }));
  it("reaching the target earns the locked £25: £104 + £25 = £129", () => withDb(async db => {
    const { s, work, payable } = await finished(db, [12_000, 8_000]);
    expect(await confirmWorkPerformance(db, s.manager, work.allocation.id, { count: 2, minor: 20_000 })).toMatchObject({ salesMinor: 20_000, targetMinor: 20_000, bonusMinor: 2_500, earnedMinor: 2_500, evidenceProvenance: "SQUARE_TEAM_MEMBER" });
    expect(await approveWorkPayable(db, s.manager, payable.id)).toMatchObject({ baseAmountMinor: 10_400, incentiveAmountMinor: 2_500, approvedAmountMinor: 12_900, currencyCode: "GBP" });
  }));
  it("a duplicate sync doesn't move the result", () => withDb(async db => {
    const { s } = await finished(db, [12_000, 8_000]);
    await sync(db, s, new Date(AFTER.getTime() + 1));
    await sync(db, s, new Date(AFTER.getTime() + 2));
    expect((await totals(db, s)).attributed).toEqual({ count: 2, minor: 20_000 });
  }));
  it("a refund is recorded and linked, and does not silently penalise the worker", () => withDb(async db => {
    const { s, work } = await finished(db, [12_000, 8_000]);
    s.square.state.refunds = [refund("R1", "P0", 12_000)];
    const later = new Date(AFTER.getTime() + 1);
    expect(await sync(db, s, later)).toMatchObject({ status: "SUCCEEDED" });
    expect((await db.select().from(commerceRefundEvidence))[0]).toMatchObject({ providerRefundId: "R1", providerPaymentId: "P0", amountMinor: 12_000, providerStatus: "COMPLETED" });
    expect(JSON.stringify(await db.select().from(commerceRefundEvidence))).not.toContain("TM-OTHER");
    expect((await totals(db, s)).attributed).toEqual({ count: 2, minor: 20_000 });
    expect((await squareSales(db)).map(row => row.grossAmountMinor).sort((a, b) => a - b)).toEqual([8_000, 12_000]);
    expect(await confirmWorkPerformance(db, s.manager, work.allocation.id, { count: 2, minor: 20_000 })).toMatchObject({ earnedMinor: 2_500 });
    expect((await getSquareActivity(db, s.c.ownerScope, s.c.rows[0].id)).find(row => row.refundedMinor)).toMatchObject({ refundedMinor: 12_000, amountMinor: 12_000 });
    // A refund's status can move on, and its link can't.
    s.square.state.refunds = [refund("R1", "P0", 12_000, { status: "PENDING" })];
    expect(await sync(db, s, new Date(AFTER.getTime() + 2))).toMatchObject({ status: "SUCCEEDED" });
    s.square.state.refunds = [refund("R1", "P1", 12_000)];
    expect(await sync(db, s, new Date(AFTER.getTime() + 3))).toMatchObject({ status: "FAILED", failureCode: "CONFLICTING_DUPLICATE" });
  }));
  it("missing provider evidence does not become zero performance: results can't be confirmed", () => withDb(async db => {
    const s = await setup(db);
    await map(db, s);
    const work = await booked(db, s);
    vi.setSystemTime(AFTER);
    const { payable } = await confirmWork(db, work.offer.id, s.manager);
    // Never synced.
    await expect(confirmWorkPerformance(db, s.manager, work.allocation.id, { count: 0, minor: 0 })).rejects.toMatchObject({ feedback: "sales-evidence-incomplete" });
    // Synced, but before the shift had settled.
    await sync(db, s, new Date("2026-01-19T17:00:10Z"));
    await expect(confirmWorkPerformance(db, s.manager, work.allocation.id, { count: 0, minor: 0 })).rejects.toMatchObject({ feedback: "sales-evidence-incomplete" });
    // A failed sync since then does not count.
    s.square.client.payments.mockRejectedValueOnce(new SquareError("PROVIDER_UNAVAILABLE"));
    expect(await sync(db, s)).toMatchObject({ status: "FAILED" });
    await expect(confirmWorkPerformance(db, s.manager, work.allocation.id, { count: 0, minor: 0 })).rejects.toMatchObject({ feedback: "sales-evidence-incomplete" });
    await expect(approveWorkPayable(db, s.manager, payable!.id)).rejects.toMatchObject({ feedback: "performance-required" });
    expect(await db.select().from(workPerformanceResults)).toEqual([]);
    // A completed check after the shift can then confirm a genuine zero.
    await sync(db, s, new Date(AFTER.getTime() + 1));
    expect(await confirmWorkPerformance(db, s.manager, work.allocation.id, { count: 0, minor: 0 })).toMatchObject({ salesCount: 0, earnedMinor: 0, evidenceProvenance: "SQUARE_TEAM_MEMBER" });
  }));
  it("evidence from before a connection is not upgraded: mixed results stay imported", () => withDb(async db => {
    const s = await setup(db);
    await disconnectZettle(db, s.c.ownerScope, s.c.rows[0].id);
    const work = await booked(db, s);
    vi.setSystemTime(DURING);
    const [{ code }] = await db.execute<{ code: string }>(sql`select attribution_code as code from workers where id = ${s.worker.workerId}`).then(result => (result as unknown as { rows: { code: string }[] }).rows);
    await importAttributedSales(db, s.manager, `transaction_id,attribution_code,occurred_at,amount,currency\nT1,${code},${AT},10.00,GBP`, DURING);
    await connectSquare(db, s.c.ownerScope, { outletId: s.c.rows[0].id }, s.square.client, CREDENTIALS);
    await map(db, s);
    s.square.state.payments = [payment("P1", "TM-A", AT, 500)];
    await sync(db, s);
    expect((await totals(db, s)).evidence).toBe("MIXED");
    vi.setSystemTime(AFTER);
    await confirmWork(db, work.offer.id, s.manager);
    await sync(db, s);
    expect(await confirmWorkPerformance(db, s.manager, work.allocation.id, { count: 2, minor: 1_500 })).toMatchObject({ evidenceProvenance: "IMPORTED_NOT_PROVIDER_VERIFIED" });
  }));
  it("the database accepts only the two provenance values", () => withDb(async db => {
    const { s, work } = await finished(db, [20_000]);
    const [result] = await db.execute(sql`select conname from pg_constraint where conname = 'work_performance_results_provenance_check'`).then(value => (value as unknown as { rows: unknown[] }).rows);
    expect(result).toBeTruthy();
    await confirmWorkPerformance(db, s.manager, work.allocation.id, { count: 1, minor: 20_000 });
    await expect(db.update(workPerformanceResults).set({ evidenceProvenance: "POS_VERIFIED_WORKER" })).rejects.toThrow();
    expect(work).toBeTruthy();
  }));
});

describe("the Sandbox demo-sale utility", () => {
  const sale = (over: Partial<{ workerId: string; amountMinor: number; requestId: string }>, s: Setup & { db: Db }, scope: Scope = s.manager) => recordSquareSandboxSale(s.db, scope, { workerId: s.worker.workerId!, amountMinor: 1_000, requestId: randomUUID(), ...over }, s.square.client);
  const demoSetup = async (db: Db) => { vi.stubEnv("FAIRSHIFT_DEMO_TOOLS", "enabled"); const s = await setup(db); await map(db, s); return Object.assign(s, { db }); };

  it("refuses without the explicit flag, in any build mode, and for a production connection", () => withDb(async db => {
    const s = await demoSetup(db);
    vi.stubEnv("FAIRSHIFT_DEMO_TOOLS", "");
    await expect(sale({}, s)).rejects.toMatchObject({ feedback: "square-demo-disabled" });
    await expect(prepareDemoShift(db, s.manager, { workerId: s.worker.workerId!, minutesUntilEnd: 15 })).rejects.toMatchObject({ feedback: "square-demo-disabled" });
    vi.stubEnv("NODE_ENV", "production");
    await expect(sale({}, s)).rejects.toMatchObject({ feedback: "square-demo-disabled" });
    expect(s.square.client.createSandboxPayment).not.toHaveBeenCalled();
    vi.stubEnv("FAIRSHIFT_DEMO_TOOLS", "enabled");
    // A hosted demo is a production build, so the mode itself is not the guard.
    expect(await sale({}, s)).toEqual({ status: "COMPLETED" });
  }));
  it("needs a Manager or Owner at the location, and a mapped worker", () => withDb(async db => {
    const s = await demoSetup(db), rival = await business(db, ["Rival"]), rivalManager = await rival.manager(), unmapped = await s.c.worker(s.manager, "Dee");
    await expect(sale({}, s, s.worker)).rejects.toThrow("Access denied");
    await expect(sale({}, s, rivalManager)).rejects.toMatchObject({ feedback: "square-demo-disabled" });
    await expect(sale({ workerId: unmapped.workerId! }, s)).rejects.toMatchObject({ feedback: "square-demo-unmapped" });
    await expect(prepareDemoShift(db, s.worker, { workerId: s.worker.workerId!, minutesUntilEnd: 15 })).rejects.toThrow("Access denied");
    expect(s.square.client.createSandboxPayment).not.toHaveBeenCalled();
    expect(await sale({}, s, s.c.ownerScope)).toEqual({ status: "COMPLETED" });
  }));
  it("keeps amounts small and whole", () => withDb(async db => {
    const s = await demoSetup(db);
    for (const amountMinor of [0, -1, 25_001, 1.5]) await expect(sale({ amountMinor }, s)).rejects.toMatchObject({ feedback: "square-demo-amount" });
    await expect(sale({ requestId: "not-a-uuid" }, s)).rejects.toMatchObject({ feedback: "square-demo-amount" });
    expect(s.square.client.createSandboxPayment).not.toHaveBeenCalled();
  }));
  it("uses the connection's location and the mapped identity, and a server-checked key", () => withDb(async db => {
    const s = await demoSetup(db), requestId = randomUUID();
    await sale({ amountMinor: 1_250, requestId }, s);
    const [, request] = s.square.client.createSandboxPayment.mock.calls[0];
    expect(request).toEqual({ idempotencyKey: `fsd-${requestId}`, locationId: "SQ-LOC", teamMemberId: "TM-A", amountMinor: 1_250, currencyCode: "GBP" });
    expect(request.idempotencyKey.length).toBeLessThanOrEqual(45);
  }));
  it("reports a refused payment and records nothing", () => withDb(async db => {
    const s = await demoSetup(db);
    s.square.client.createSandboxPayment.mockRejectedValueOnce(new SquareError("PAYMENT_REJECTED"));
    await expect(sale({}, s)).rejects.toMatchObject({ feedback: "square-demo-refused" });
    expect((await db.select().from(auditEvents)).map(row => row.action)).not.toContain("SQUARE_SANDBOX_SALE_REQUESTED");
  }));
  it("writes no sale or attributed sale: only a later read from Square does", () => withDb(async db => {
    const s = await demoSetup(db);
    await booked(db, s);
    vi.setSystemTime(DURING);
    await sale({ amountMinor: 1_000 }, s);
    expect(await squareSales(db)).toEqual([]);
    expect(await attributed(db)).toEqual([]);
    expect((await totals(db, s)).attributed).toEqual({ count: 0, minor: 0 });
    s.square.state.payments = [payment("FROM-SQUARE", "TM-A", DURING.toISOString(), 1_000)];
    await sync(db, s);
    expect((await totals(db, s)).attributed).toEqual({ count: 1, minor: 1_000 });
  }));
  it("the action reads no worker or location from anywhere but the form's checked fields and the session", () => withDb(async db => {
    const s = await demoSetup(db);
    pages(db);
    vi.mocked(requireScope).mockResolvedValue(s.manager);
    const f = new FormData(); f.set("workerId", s.worker.workerId!); f.set("amount", "not money"); f.set("requestId", randomUUID());
    expect(String(await recordSquareSandboxSaleAction(f).catch((error: Error) => error.message))).toContain("status=square-demo-amount");
  }));
  it("offers a shift spanning now with the demo terms, and leaves the attribution rule as it was", () => withDb(async db => {
    const s = await demoSetup(db);
    vi.setSystemTime(DURING);
    const { shiftId, offerId, endsAt } = await prepareDemoShift(db, s.manager, { workerId: s.worker.workerId!, minutesUntilEnd: 15 }, DURING);
    const [shift] = await db.select().from(shifts).where(eq(shifts.id, shiftId));
    expect(shift).toMatchObject({ currencyCode: "GBP", earningsModel: "DAILY", expectedEarningsMinor: 9_600, incentiveTargetMinor: 20_000, incentiveAmountMinor: 2_500, incentiveBasis: "INDIVIDUAL_ATTRIBUTED_SALES" });
    expect(shift.startsAt.getTime()).toBeLessThanOrEqual(DURING.getTime());
    expect(shift.endsAt).toEqual(endsAt);
    // It reaches back only a moment, so it can't claim earlier Sandbox payments.
    expect(DURING.getTime() - shift.startsAt.getTime()).toBeLessThanOrEqual(120_000);
    // Nothing counts until the worker accepts and the manager finalises, as for any shift.
    const earlier = payment("OLD", "TM-A", new Date(DURING.getTime() - 3 * 3_600_000).toISOString(), 202);
    s.square.state.payments = [earlier, payment("P1", "TM-A", DURING.toISOString(), 1_000)];
    expect(await sync(db, s)).toMatchObject({ attribution: { attributed: 0, noMatchingShift: 2 } });
    await workerRespond(db, s.worker, offerId, 1, "ACCEPTED", true);
    await allocateAssignment(db, offerId, s.manager);
    expect(await sync(db, s, new Date(DURING.getTime() + 1))).toMatchObject({ attribution: { attributed: 1, noMatchingShift: 1 } });
    expect((await totals(db, s)).attributed).toEqual({ count: 1, minor: 1_000 });
    // A sale before or after that window still doesn't count.
    s.square.state.payments.push(payment("EARLY", "TM-A", new Date(shift.startsAt.getTime() - 1).toISOString(), 1_000));
    expect(await sync(db, s, new Date(DURING.getTime() + 2))).toMatchObject({ attribution: { attributed: 0, noMatchingShift: 2 } });
    // Reusing the terms and department on a second shift creates no duplicates.
    expect((await prepareDemoShift(db, s.manager, { workerId: s.worker.workerId!, minutesUntilEnd: 120 }, new Date(endsAt.getTime() + 9 * 3_600_000))).shiftId).toBeTruthy();
    await expect(prepareDemoShift(db, s.manager, { workerId: s.worker.workerId!, minutesUntilEnd: 1 }, DURING)).rejects.toMatchObject({ feedback: "square-demo-shift" });
  }));
});

describe("freshness without a manual sync", () => {
  it("every open page can notice a sale another viewer's sync found, without learning any figures", () => withDb(async db => {
    const s = await setup(db);
    await map(db, s);
    await booked(db, s);
    vi.setSystemTime(DURING);
    await sync(db, s);
    const before = (await getSquareFreshness(db, s.worker))!;
    s.square.state.payments = [payment("P1", "TM-A", "2026-01-19T11:00:00.000Z", 12_345)];
    await refreshSquareSales(db, s.manager, s.square.client, new Date(DURING.getTime() + 60_000));
    const after = (await getSquareFreshness(db, s.worker))!;
    expect(after.revision).not.toBe(before.revision);
    expect(after.revision).toMatch(/^[0-9a-f]{16}$/);
    await refreshSquareSales(db, s.manager, s.square.client, new Date(DURING.getTime() + 120_000));
    expect((await getSquareFreshness(db, s.worker))!.revision).toBe(after.revision);
  }));
  it("anyone at the location may cause a refresh, throttled, and it says nothing about sales", () => withDb(async db => {
    const s = await setup(db), rival = await business(db, ["Rival"]);
    const start = Date.now();
    expect(await refreshSquareSales(db, s.worker, s.square.client, new Date(start))).toMatchObject({ status: "SUCCEEDED" });
    expect(await refreshSquareSales(db, s.worker, s.square.client, new Date(start + 8_999))).toEqual({ status: "SKIPPED" });
    expect(await refreshSquareSales(db, s.manager, s.square.client, new Date(start + 9_000))).toMatchObject({ status: "SUCCEEDED" });
    expect(await refreshSquareSales(db, rival.ownerScope, s.square.client, new Date(start + 60_000))).toEqual({ status: "SKIPPED" });
  }));
  it(`a sale listed about 4 seconds late is visible within ${SQUARE_VISIBLE_WITHIN_MS / 1000} seconds of being recorded, polling normally`, () => withDb(async db => {
    const s = await setup(db);
    await map(db, s);
    await booked(db, s);
    vi.setSystemTime(DURING);
    const recordedAt = DURING.getTime();
    // A sync starting just before the payment becomes listable is the worst case for a poller.
    const LIST_LAG_MS = 4_000, SYNC_TAKES_MS = 1_500, WORST_FIRST_POLL = recordedAt + LIST_LAG_MS - 1;
    s.square.client.payments.mockImplementation(async () => ({ items: Date.now() >= recordedAt + LIST_LAG_MS ? [payment("LAGGED", "TM-A", new Date(recordedAt).toISOString(), 1_000)] : [], cursor: null }));
    // Another viewer's refresh started just after, so this viewer's next poll can be throttled too.
    let seenAt: number | null = null;
    const viewers = [s.worker, s.manager];
    await refreshSquareSales(db, viewers[0], s.square.client, new Date(WORST_FIRST_POLL));
    for (let tick = WORST_FIRST_POLL + SQUARE_REFRESH_POLL_MS - 1, i = 0; tick < recordedAt + 120_000 && seenAt === null; tick += SQUARE_REFRESH_POLL_MS, i++) {
      vi.setSystemTime(tick);
      const result = await refreshSquareSales(db, viewers[i % 2], s.square.client, new Date(tick));
      if (result.status === "SUCCEEDED" && (await totals(db, s)).attributed.count === 1) seenAt = tick + SYNC_TAKES_MS;
    }
    expect(seenAt).not.toBeNull();
    expect(seenAt! - recordedAt).toBeLessThanOrEqual(SQUARE_VISIBLE_WITHIN_MS);
    expect((await totals(db, s)).attributed).toEqual({ count: 1, minor: 1_000 });
  }));
});

describe("what the pages say", () => {
  const AT = "2026-01-19T11:00:00.000Z";
  it("Owner Sales shows the connection, the source, gross of refunds, and thin history truthfully, with no Zettle and no secrets", () => withDb(async db => {
    vi.stubEnv("SQUARE_ENVIRONMENT", "sandbox"); vi.stubEnv("SQUARE_ACCESS_TOKEN", SECRET); vi.stubEnv("SQUARE_APPLICATION_ID", "fixture-app");
    const c = await business(db); pages(db);
    let html = await render(c.ownerScope, () => OwnerWorkspace({ area: "reporting" }));
    expect(html).toContain("Not connected. This location has no Square Sandbox sales.");
    expect(html).toContain("Connect Square Sandbox to Northgate");
    expect(html).not.toMatch(/Zettle|apiKey|fixture-square-token/i);
    const { client, state } = fakeSquare();
    await connectSquare(db, c.ownerScope, { outletId: c.rows[0].id }, client, CREDENTIALS);
    state.payments = [payment("PAYMENT-ONE-AAAAAA", "TM-A", "2026-01-14T12:00:00.000Z", 1_000), payment("PAYMENT-TWO-BBBBBB", undefined, "2026-01-14T13:00:00.000Z", 500)];
    state.refunds = [refund("R1", "PAYMENT-ONE-AAAAAA", 1_000)];
    await syncSquare(db, c.ownerScope, c.rows[0].id, client);
    html = await render(c.ownerScope, () => OwnerWorkspace({ area: "reporting" }));
    for (const text of ["Connected · Square Sandbox", "Square Sandbox sales · connected seller", "gross of refunds", "recorded and linked, not netted off", "Not used for forecast", "1 of 28 required days", "£15.00", "1 refunds recorded, not deducted", "Latest Square Sandbox payments", "Not attributed · no team member on the payment", "Not attributed · team member not mapped", "…AAAAAA"]) expect(html).toContain(text);
    expect(html).not.toMatch(/Zettle|name="apiKey"|fixture-square-token|SQ-MERCHANT|PAYMENT-ONE/);
    expect(html).not.toMatch(STRONGER_CLAIMS);
    client.payments.mockRejectedValueOnce(new SquareError("PROVIDER_UNAVAILABLE"));
    await syncSquare(db, c.ownerScope, c.rows[0].id, client, new Date(Date.now() + 60_000));
    html = await render(c.ownerScope, () => OwnerWorkspace({ area: "reporting" }));
    expect(html).toContain("Connected · last sync failed");
    expect(html).toContain("does not mean no sales happened");
  }));
  it("Worker and Manager pages use the precise wording and show only the worker's own aggregates", () => withDb(async db => {
    const s = await setup(db); pages(db);
    const other = await s.c.worker(s.manager, "Dee");
    await map(db, s);
    await mapSquareTeamMember(db, s.manager, { workerId: other.workerId!, teamMemberId: "TM-B" }, s.square.client);
    const work = await booked(db, s);
    let home = await render(s.worker, () => WorkerWorkspace({ area: "home" }));
    expect(home).toContain("Your sales aren’t known yet");
    expect(home).not.toContain("None yet");
    vi.setSystemTime(DURING);
    s.square.state.payments = [payment("PAY-A", "TM-A", AT, 12_000), payment("PAY-B", "TM-B", AT, 77_700)];
    await sync(db, s);
    home = await render(s.worker, () => WorkerWorkspace({ area: "home" }));
    for (const text of ["Square Sandbox · team-member attributed", "£120.00", "£80.00 to go · target £200.00", "Checking Square Sandbox for new sales automatically"]) expect(home).toContain(text);
    expect(home).not.toMatch(/Imported · not provider-verified|PAY-A|PAY-B|TM-A|£777/);
    expect(home).not.toMatch(STRONGER_CLAIMS);
    let review = await render(s.manager, () => ManagerWorkspace({ area: "review" }));
    for (const text of ["Square Sandbox attributed sales", "£120.00", "£200.00", "£25.00", "doesn’t show who was logged in to a till"]) expect(review).toContain(text);
    expect(review).not.toContain("Import attributed sales");
    expect(review).not.toMatch(/Imported · not provider-verified/);
    vi.setSystemTime(AFTER);
    s.square.state.payments.push(payment("PAY-C", "TM-A", AT, 8_000));
    await confirmWork(db, work.offer.id, s.manager);
    await sync(db, s);
    await confirmWorkPerformance(db, s.manager, work.allocation.id, { count: 2, minor: 20_000 });
    review = await render(s.manager, () => ManagerWorkspace({ area: "review" }));
    for (const text of ["Square Sandbox attributed sales", "Confirmed for payment", "£104.00", "£25.00 · target reached", "£129.00"]) expect(review).toContain(text);
    expect((await db.select().from(workPayables))[0]).toMatchObject({ baseAmountMinor: 10_400, incentiveAmountMinor: 2_500 });
    const earnings = await render(s.worker, () => WorkerWorkspace({ area: "earnings" }));
    for (const text of ["Square Sandbox payments carrying your team-member identity", "£129.00"]) expect(earnings).toContain(text);
    expect(earnings).not.toMatch(/haven’t been checked by a sales provider|£777/);
    expect(earnings).not.toMatch(STRONGER_CLAIMS);
  }));
  it("a location with no Square connection keeps the imported wording and shows no Square panels", () => withDb(async db => {
    const c = await business(db), manager = await c.manager(); pages(db);
    const team = await render(manager, () => ManagerWorkspace({ area: "team" }));
    expect(team).not.toContain("Square team members");
    const review = await render(manager, () => ManagerWorkspace({ area: "review" }));
    expect(review).toContain("Import attributed sales");
  }));
  it("Team shows the mapping and says what it is, and the demo tools only behind their guard", () => withDb(async db => {
    const s = await setup(db); pages(db);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ team_members: [{ id: "TM-A", status: "ACTIVE", given_name: "Sandbox", family_name: "A" }] })));
    let team = await render(s.manager, () => ManagerWorkspace({ area: "team" }));
    for (const text of ["Map a FairShift worker to a Square team-member identity", "doesn’t show who was logged in to a till", "Map to Square team member", "Sandbox A"]) expect(team).toContain(text);
    expect(team).not.toContain("Record Square Sandbox sale");
    expect(team).not.toMatch(STRONGER_CLAIMS);
    vi.stubEnv("FAIRSHIFT_DEMO_TOOLS", "enabled");
    await map(db, s);
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(JSON.stringify({ team_members: [{ id: "TM-A", status: "ACTIVE", given_name: "Sandbox", family_name: "A" }] })));
    team = await render(s.manager, () => ManagerWorkspace({ area: "team" }));
    for (const text of ["Sandbox demo tools", "Record Square Sandbox sale", "It is not a till", "Offer demo shift"]) expect(team).toContain(text);
    expect(team).not.toMatch(STRONGER_CLAIMS);
    vi.mocked(globalThis.fetch).mockRestore();
  }));
});
