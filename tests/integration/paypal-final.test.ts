import { sandboxFixture } from "../helpers/sandbox";
import { randomBytes, randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { entitled } from "../helpers/onboarding";
import { resolveScope, type Scope } from "@/server/auth/access";
import { savePayoutDestination, workerRespond } from "@/server/auth/operations";
import { requireFinancialScope, requireScope } from "@/server/auth/request";
import { inviteMember, redeemInvitation } from "@/server/auth/tenancy";
import { connectSquare, syncSquare } from "@/server/commerce/square-connection";
import { mapSquareTeamMember } from "@/server/commerce/square-mapping";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { auditEvents, memberships, organisations, outlets, subscriptions, users, workPayables, workPayouts, workPerformanceResults } from "@/server/db/schema";
import { getPayPalPayoutClient } from "@/server/integrations/paypal/factory";
import { PayPalPayoutError, type PayPalPayoutAdapter, type PayoutResult } from "@/server/integrations/paypal/payout-client";
import type { SquareClient } from "@/server/integrations/square/client";
import { approveWorkPayable, refreshWorkPayout, submitWorkPayout } from "@/server/payments/work-payouts";
import { confirmWorkPerformance, getLocationPerformance } from "@/server/performance/attribution";
import { allocateAssignment, confirmWork, createDepartment, createRequirement, createWorkPolicy, offerAssignment } from "@/server/scheduling/operations";
import { approvePayableAction, refreshPayoutAction, sendPayoutAction } from "@/app/operations-actions";
import { ManagerWorkspace } from "@/app/manager/workspace";
import { WorkerWorkspace } from "@/app/worker/workspace";

// Every Square and PayPal response in this file is a fixture, not provider evidence.
vi.mock("@/server/auth/request", () => ({ requireScope: vi.fn(), requireFinancialScope: vi.fn() }));
vi.mock("@/server/db/client", () => ({ getDatabase: vi.fn() }));
vi.mock("@/server/config/env", () => ({ getConfigurationStatus: vi.fn() }));
vi.mock("@/server/integrations/paypal/factory", () => ({ getPayPalPayoutClient: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); }, notFound: () => { throw new Error("NOT_FOUND"); }, useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const BEFORE = new Date("2026-01-15T12:00:00Z"), DURING = new Date("2026-01-19T15:00:00Z"), AFTER = new Date("2026-01-20T12:00:00Z");
beforeEach(() => { vi.useFakeTimers({ now: BEFORE, toFake: ["Date"] }); vi.stubEnv("COMMERCE_CREDENTIAL_KEY", randomBytes(32).toString("base64")); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.resetAllMocks(); });

type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];
const withDb = async (run: (db: Db) => Promise<void>) => { const t = await createTestDatabase(); try { await run(t.db); } finally { await t.close(); } };

let n = 0;
async function person(db: Db) {
  const id = randomUUID(), email = `u${++n}-${randomUUID().slice(0, 6)}@example.test`;
  await db.insert(users).values({ id, email, name: "Person", passwordHash: "x", emailVerifiedAt: new Date() });
  return { id, email };
}
async function business(db: Db, locations = ["Northgate"]) {
  const organisationId = randomUUID();
  if (!process.env.FAIRSHIFT_SANDBOX_ORGANISATION_ID) sandboxFixture(organisationId);
  await db.insert(organisations).values({ id: organisationId, name: "Fictional Retail", country: "United Kingdom" });
  await db.insert(subscriptions).values({ id: randomUUID(), organisationId, requestId: randomUUID() });
  await entitled(db, organisationId);
  const rows = locations.map(name => ({ id: randomUUID(), organisationId, name, timezone: "Europe/London", country: "United Kingdom" }));
  await db.insert(outlets).values(rows);
  const owner = await person(db), ownerMembership = randomUUID();
  await db.insert(memberships).values({ id: ownerMembership, userId: owner.id, organisationId, role: "OWNER" });
  const ownerAt = (i: number) => resolveScope(db, owner.id, ownerMembership, rows[i].id);
  const invite = async (role: "MANAGER" | "TEAM_MEMBER", by: Scope) => {
    const member = await person(db);
    const { token } = await inviteMember(db, by, { role, email: member.email, firstName: role === "MANAGER" ? "Morgan" : "Casey", surname: "Person", telephone: "+441130000000" });
    return resolveScope(db, member.id, (await redeemInvitation(db, member.id, { token })).id);
  };
  return { rows, ownerAt, invite };
}

// The locked example: a fixed £96 shift base, a £200 target and a £25 bonus, through the normal
// operations, on Square-attributed sales read through the normal sync.
async function journey(db: Db, sales: number[] = [12_000, 8_000]) {
  const c = await business(db, ["Northgate", "Southgate"]);
  const owner = await c.ownerAt(0), manager = await c.invite("MANAGER", owner), worker = await c.invite("TEAM_MEMBER", manager);
  const [department] = await createDepartment(db, "Sales floor", owner);
  const [policy] = await createWorkPolicy(db, { earningsModel: "DAILY", rateMinor: 9_600, incentiveTargetMinor: 20_000, incentiveBonusMinor: 2_500 }, "Golden Path terms", owner);
  const payments = sales.map((amount, i) => ({ id: `P${i}`, status: "COMPLETED", location_id: "SQ-LOC", created_at: "2026-01-19T15:00:00.000Z", amount_money: { amount, currency: "GBP" }, team_member_id: "TM-A" }));
  const refunds: unknown[] = [];
  const square = {
    locations: vi.fn(async () => [{ id: "SQ-LOC", merchant_id: "SQ-MERCHANT", status: "ACTIVE", currency: "GBP" }]),
    teamMembers: vi.fn(async () => [{ id: "TM-A", name: "Sandbox A" }]),
    payments: vi.fn(async () => ({ items: payments, cursor: null })),
    refunds: vi.fn(async () => ({ items: refunds, cursor: null })),
    createSandboxPayment: vi.fn(),
  } as unknown as SquareClient;
  await connectSquare(db, owner, { outletId: c.rows[0].id }, square, { applicationId: "fixture-app", accessToken: "fixture-token" });
  await mapSquareTeamMember(db, manager, { workerId: worker.workerId!, teamMemberId: "TM-A" }, square);
  await savePayoutDestination(db, worker, "casey.sandbox@example.test");
  const shift = await createRequirement(db, { departmentId: department.id, policyId: policy.id, startsAt: new Date("2026-01-19T14:00:00Z"), endsAt: new Date("2026-01-19T20:00:00Z"), requiredHeadcount: 1 }, manager);
  const offer = await offerAssignment(db, shift.id, worker.workerId!, manager);
  await workerRespond(db, worker, offer.id, 1, "ACCEPTED", true);
  const allocation = await allocateAssignment(db, offer.id, manager);
  const sync = (now = new Date()) => syncSquare(db, owner, c.rows[0].id, square, now);
  const confirmedWork = async () => { vi.setSystemTime(AFTER); await sync(); return (await confirmWork(db, offer.id, manager)).payable!; };
  const confirmedSales = async () => { const payable = await confirmedWork(); const row = (await getLocationPerformance(db, manager))[0]; await confirmWorkPerformance(db, manager, allocation.id, row.attributed); return payable; };
  return { c, owner, manager, worker, offer, allocation, sync, refunds, confirmedWork, confirmedSales };
}

const GBP121 = { value: "121.00", currency: "GBP" };
const paypalResult = (batchId: string, itemStatus: string, itemAmount: PayoutResult["itemAmount"] = GBP121): PayoutResult => ({ batchId, itemId: "PPI-1", status: itemStatus, batchStatus: "SUCCESS", itemStatus, transactionId: "PPT-1", itemAmount });
function fakePayPal(getPayout: PayPalPayoutAdapter["getPayout"] = async batchId => paypalResult(batchId, "SUCCESS")) {
  return {
    createPayout: vi.fn<PayPalPayoutAdapter["createPayout"]>(async () => ({ batchId: "PPB-1", itemId: null, status: "PENDING", batchStatus: "PENDING", itemStatus: null, transactionId: null })),
    getPayout: vi.fn(getPayout),
  };
}
const form = (values: Record<string, string>) => { const result = new FormData(); for (const [k, v] of Object.entries(values)) result.set(k, v); return result; };
const payouts = (db: Db) => db.select().from(workPayouts);
const pages = (db: Db) => {
  vi.mocked(getDatabase).mockReturnValue(db);
  vi.mocked(getConfigurationStatus).mockReturnValue({ databaseConfigured: true, aiConfigured: false, paypalPayoutConfigured: true } as ReturnType<typeof getConfigurationStatus>);
};
const render = async (scope: Scope, element: () => Promise<React.ReactNode>) => { vi.mocked(requireScope).mockResolvedValue(scope); return renderToStaticMarkup(await element()); };
const asAction = async (scope: Scope, action: () => Promise<unknown>) => { vi.mocked(requireScope).mockResolvedValue(scope); vi.mocked(requireFinancialScope).mockResolvedValue(scope); await action().catch((error: Error) => { if (!error.message.startsWith("REDIRECT:")) throw error; }); };

describe("Square-attributed earnings to a PayPal payout", () => {
  it("derives £121 from the accepted terms and confirmed Square performance, and sends exactly that from the persisted payable", () => withDb(async db => {
    const j = await journey(db), payable = await j.confirmedSales();
    const [result] = await db.select().from(workPerformanceResults);
    expect(result).toMatchObject({ evidenceProvenance: "SQUARE_TEAM_MEMBER", salesCount: 2, salesMinor: 20_000, targetMinor: 20_000, bonusMinor: 2_500, earnedMinor: 2_500 });
    const approved = await approveWorkPayable(db, j.manager, payable.id);
    expect(approved).toMatchObject({ earningsModel: "DAILY", baseAmountMinor: 9_600, incentiveAmountMinor: 2_500, approvedAmountMinor: 12_100, approvedCurrencyCode: "GBP", performanceResultId: result.id, approvedBy: j.manager.userId });
    expect(approved.acceptanceId).toBe(j.allocation.acceptanceId);
    const paypal = fakePayPal();
    const { payout } = await submitWorkPayout(db, paypal, j.manager, payable.id);
    expect(paypal.createPayout).toHaveBeenCalledTimes(1);
    expect(paypal.createPayout.mock.calls[0][0]).toMatchObject({ amount: "121.00", currency: "GBP", recipient: "casey.sandbox@example.test" });
    expect(payout.status).toBe("PROCESSING");
    expect(await refreshWorkPayout(db, paypal, j.manager, payable.id)).toMatchObject({ status: "PAID", amountMinor: 12_100, currencyCode: "GBP", payableId: payable.id, paypalBatchId: "PPB-1", paypalItemId: "PPI-1", paypalTransactionId: "PPT-1", paypalStatus: "SUCCESS" });
    const actions = (await db.select().from(auditEvents)).map(row => row.action);
    for (const action of ["WORK_CONFIRMED", "WORK_PERFORMANCE_CONFIRMED", "PAYABLE_APPROVED", "PAYOUT_RESERVED", "PAYOUT_PROVIDER_RESPONSE", "PAYOUT_STATUS_UPDATED"]) expect(actions).toContain(action);
  }));

  it("£199.99 of attributed sales pays the base only, with no bonus", () => withDb(async db => {
    const j = await journey(db, [19_999]), payable = await j.confirmedSales();
    expect(await approveWorkPayable(db, j.manager, payable.id)).toMatchObject({ incentiveAmountMinor: 0, approvedAmountMinor: 9_600 });
  }));

  it("refuses to confirm work before the shift ends, sales before the work, approval before the sales, and payout before approval", () => withDb(async db => {
    const j = await journey(db);
    vi.setSystemTime(DURING);
    await expect(confirmWork(db, j.offer.id, j.manager)).rejects.toThrow(/has not ended/);
    await expect(confirmWorkPerformance(db, j.manager, j.allocation.id, { count: 0, minor: 0 })).rejects.toMatchObject({ feedback: "work-not-confirmed" });
    expect(await db.select().from(workPayables)).toEqual([]);
    const payable = await j.confirmedWork(), paypal = fakePayPal();
    await expect(approveWorkPayable(db, j.manager, payable.id)).rejects.toMatchObject({ feedback: "performance-required" });
    await expect(submitWorkPayout(db, paypal, j.manager, payable.id)).rejects.toThrow(/Approve the payable/);
    expect(paypal.createPayout).not.toHaveBeenCalled();
    expect(await payouts(db)).toEqual([]);
  }));

  it("requires a Square check after the shift ended before results can be confirmed", () => withDb(async db => {
    const j = await journey(db);
    vi.setSystemTime(new Date("2026-01-19T19:59:00Z"));
    await j.sync();
    vi.setSystemTime(AFTER);
    await confirmWork(db, j.offer.id, j.manager);
    const row = (await getLocationPerformance(db, j.manager))[0];
    await expect(confirmWorkPerformance(db, j.manager, j.allocation.id, row.attributed)).rejects.toMatchObject({ feedback: "sales-evidence-incomplete" });
  }));

  it("allows only this location's manager or owner to approve or pay", () => withDb(async db => {
    const j = await journey(db), payable = await j.confirmedSales(), paypal = fakePayPal();
    const elsewhere = await j.c.invite("MANAGER", await j.c.ownerAt(1));
    const stranger = await business(db), strangerOwner = await stranger.ownerAt(0), strangerManager = await stranger.invite("MANAGER", strangerOwner);
    await expect(approveWorkPayable(db, j.worker, payable.id)).rejects.toThrow();
    for (const scope of [elsewhere, strangerManager]) await expect(approveWorkPayable(db, scope, payable.id)).rejects.toThrow(/unavailable/i);
    expect((await db.select().from(workPayables))[0].status).toBe("PENDING_REVIEW");
    await approveWorkPayable(db, j.manager, payable.id);
    await expect(submitWorkPayout(db, paypal, j.worker, payable.id)).rejects.toThrow();
    for (const scope of [elsewhere, strangerManager]) {
      await expect(submitWorkPayout(db, paypal, scope, payable.id)).rejects.toThrow(/unavailable/i);
      await expect(refreshWorkPayout(db, paypal, scope, payable.id)).rejects.toThrow(/unavailable/i);
    }
    expect(paypal.createPayout).not.toHaveBeenCalled();
  }));

  it("ignores a forged amount, currency or recipient on the server actions", () => withDb(async db => {
    pages(db);
    const j = await journey(db), payable = await j.confirmedSales(), paypal = fakePayPal();
    vi.mocked(getPayPalPayoutClient).mockReturnValue(paypal as unknown as ReturnType<typeof getPayPalPayoutClient>);
    const forged = form({ payableId: payable.id, amount: "1.00", amountMinor: "100", approvedAmountMinor: "100", baseAmountMinor: "1", incentiveAmountMinor: "1", currency: "USD", currencyCode: "USD", recipient: "attacker@example.test" });
    await asAction(j.manager, () => approvePayableAction(forged));
    expect((await db.select().from(workPayables))[0]).toMatchObject({ approvedAmountMinor: 12_100, approvedCurrencyCode: "GBP" });
    await asAction(j.manager, () => sendPayoutAction(forged));
    expect(paypal.createPayout.mock.calls[0][0]).toMatchObject({ amount: "121.00", currency: "GBP", recipient: "casey.sandbox@example.test" });
  }));

  it("makes the approved amount and performance immutable, and a repeat approval changes nothing", () => withDb(async db => {
    const j = await journey(db), payable = await j.confirmedSales();
    const first = await approveWorkPayable(db, j.manager, payable.id);
    const again = await approveWorkPayable(db, j.manager, payable.id);
    expect(again).toMatchObject({ approvedAt: first.approvedAt, approvedAmountMinor: 12_100 });
    expect(await db.select().from(workPayables)).toHaveLength(1);
    const events = await db.select().from(auditEvents).where(eq(auditEvents.action, "PAYABLE_APPROVED"));
    expect(events).toHaveLength(1);
    await expect(db.update(workPayables).set({ approvedAmountMinor: 1 }).where(eq(workPayables.id, payable.id))).rejects.toThrow();
    await expect(db.update(workPayables).set({ baseAmountMinor: 1 }).where(eq(workPayables.id, payable.id))).rejects.toThrow();
    await expect(db.update(workPayables).set({ approvedCurrencyCode: "USD" }).where(eq(workPayables.id, payable.id))).rejects.toThrow();
    await expect(db.update(workPayables).set({ incentiveAmountMinor: 0 }).where(eq(workPayables.id, payable.id))).rejects.toThrow();
    await expect(db.update(workPerformanceResults).set({ salesMinor: 1 })).rejects.toThrow();
  }));

  it("a refund after approval rewrites neither the approved amount nor the payout", () => withDb(async db => {
    const j = await journey(db), payable = await j.confirmedSales();
    await approveWorkPayable(db, j.manager, payable.id);
    j.refunds.push({ id: "R1", status: "COMPLETED", location_id: "SQ-LOC", payment_id: "P0", created_at: "2026-01-20T11:00:00.000Z", amount_money: { amount: 12_000, currency: "GBP" } });
    await j.sync();
    const paypal = fakePayPal();
    await submitWorkPayout(db, paypal, j.manager, payable.id);
    expect(paypal.createPayout.mock.calls[0][0]).toMatchObject({ amount: "121.00", currency: "GBP" });
  }));

  it("the repeated and concurrent user action reaches PayPal once", () => withDb(async db => {
    pages(db);
    const j = await journey(db), payable = await j.confirmedSales(), paypal = fakePayPal();
    vi.mocked(getPayPalPayoutClient).mockReturnValue(paypal as unknown as ReturnType<typeof getPayPalPayoutClient>);
    vi.mocked(requireScope).mockResolvedValue(j.manager);
    vi.mocked(requireFinancialScope).mockResolvedValue(j.manager);
    await approveWorkPayable(db, j.manager, payable.id);
    const results = await Promise.all([submitWorkPayout(db, paypal, j.manager, payable.id), submitWorkPayout(db, paypal, j.manager, payable.id), submitWorkPayout(db, paypal, j.manager, payable.id)]);
    expect(results.filter(result => result.submitted)).toHaveLength(1);
    await expect(sendPayoutAction(form({ payableId: payable.id }))).rejects.toThrow("REDIRECT:/settlements?status=payout-already-sent");
    expect(paypal.createPayout).toHaveBeenCalledTimes(1);
    expect(await payouts(db)).toHaveLength(1);
    expect(await render(j.manager, () => ManagerWorkspace({ area: "review", status: "payout-already-sent" }))).toContain("no second payment was made");
    // And again once PayPal has confirmed it.
    await refreshWorkPayout(db, paypal, j.manager, payable.id);
    await asAction(j.manager, () => sendPayoutAction(form({ payableId: payable.id })));
    await asAction(j.manager, () => refreshPayoutAction(form({ payableId: payable.id })));
    expect(paypal.createPayout).toHaveBeenCalledTimes(1);
    expect((await payouts(db))[0].status).toBe("PAID");
    expect(await db.execute(sql`select count(*)::int as c from audit_events where action = 'PAYOUT_RESERVED'`).then(r => (r as unknown as { rows: { c: number }[] }).rows[0].c)).toBe(1);
  }));

  it("a timeout is neither failure nor payment, and nothing is resent automatically", () => withDb(async db => {
    const j = await journey(db), payable = await j.confirmedSales();
    await approveWorkPayable(db, j.manager, payable.id);
    const paypal = fakePayPal();
    paypal.createPayout.mockRejectedValueOnce(new PayPalPayoutError("x", "TIMEOUT", undefined, undefined, undefined, "UNKNOWN"));
    const { payout } = await submitWorkPayout(db, paypal, j.manager, payable.id);
    expect(payout).toMatchObject({ status: "RECONCILIATION_REQUIRED", paidAt: null });
    expect((await submitWorkPayout(db, paypal, j.manager, payable.id)).submitted).toBe(false);
    expect(paypal.createPayout).toHaveBeenCalledTimes(1);
  }));

  it.each([
    ["ONHOLD", "PROCESSING"], ["PENDING", "PROCESSING"], ["UNCLAIMED", "PROCESSING"], ["SOMETHING_NEW", "PROCESSING"],
    ["FAILED", "FAILED"], ["BLOCKED", "FAILED"], ["RETURNED", "FAILED"], ["REFUNDED", "FAILED"],
  ])("PayPal %s is recorded as %s, never paid", (provider, expected) => withDb(async db => {
    const j = await journey(db), payable = await j.confirmedSales();
    await approveWorkPayable(db, j.manager, payable.id);
    const paypal = fakePayPal(async batchId => paypalResult(batchId, provider));
    await submitWorkPayout(db, paypal, j.manager, payable.id);
    expect(await refreshWorkPayout(db, paypal, j.manager, payable.id)).toMatchObject({ status: expected, paypalStatus: provider, paidAt: null });
  }));

  it.each([
    ["a different amount", { value: "12.10", currency: "GBP" }, "PROVIDER_AMOUNT_MISMATCH"],
    ["a different currency", { value: "121.00", currency: "USD" }, "PROVIDER_AMOUNT_MISMATCH"],
    ["no amount", null, "PROVIDER_AMOUNT_UNAVAILABLE"],
  ])("PayPal SUCCESS with %s is not paid, and is not resent", (_label, itemAmount, code) => withDb(async db => {
    pages(db);
    const j = await journey(db), payable = await j.confirmedSales();
    await approveWorkPayable(db, j.manager, payable.id);
    const paypal = fakePayPal(async batchId => paypalResult(batchId, "SUCCESS", itemAmount));
    await submitWorkPayout(db, paypal, j.manager, payable.id);
    expect(await refreshWorkPayout(db, paypal, j.manager, payable.id)).toMatchObject({ status: "PROCESSING", paypalStatus: "SUCCESS", paidAt: null, lastError: { code } });
    expect(paypal.createPayout).toHaveBeenCalledTimes(1);
    expect(await db.select().from(auditEvents).where(eq(auditEvents.action, "PAYOUT_STATUS_UPDATED"))).toHaveLength(1);
    expect(await render(j.manager, () => ManagerWorkspace({ area: "review" }))).toContain("could not match PayPal");
    expect(await render(j.worker, () => WorkerWorkspace({ area: "pay" }))).not.toContain("PayPal confirmed");
  }));

  it("a later mismatch takes back a paid state rather than leaving it standing", () => withDb(async db => {
    const j = await journey(db), payable = await j.confirmedSales();
    await approveWorkPayable(db, j.manager, payable.id);
    const paypal = fakePayPal();
    await submitWorkPayout(db, paypal, j.manager, payable.id);
    expect((await refreshWorkPayout(db, paypal, j.manager, payable.id)).status).toBe("PAID");
    paypal.getPayout.mockImplementation(async batchId => paypalResult(batchId, "SUCCESS", { value: "1.00", currency: "GBP" }));
    expect(await refreshWorkPayout(db, paypal, j.manager, payable.id)).toMatchObject({ status: "PROCESSING", paidAt: null });
  }));

  it("a payout created with an immediate SUCCESS is held to the same amount rule", () => withDb(async db => {
    const j = await journey(db), payable = await j.confirmedSales();
    await approveWorkPayable(db, j.manager, payable.id);
    const paypal = fakePayPal();
    paypal.createPayout.mockResolvedValueOnce(paypalResult("PPB-2", "SUCCESS", { value: "99.00", currency: "GBP" }));
    expect((await submitWorkPayout(db, paypal, j.manager, payable.id)).payout).toMatchObject({ status: "PROCESSING", paidAt: null, lastError: { code: "PROVIDER_AMOUNT_MISMATCH" } });
  }));

  it("shows the worker their own base, bonus, total and paid state, and no one else's payout", () => withDb(async db => {
    pages(db);
    const j = await journey(db), payable = await j.confirmedSales(), paypal = fakePayPal();
    await approveWorkPayable(db, j.manager, payable.id);
    await submitWorkPayout(db, paypal, j.manager, payable.id);
    const processing = await render(j.worker, () => WorkerWorkspace({ area: "pay" }));
    expect(processing).toContain("Processing");
    expect(processing).not.toContain("PayPal confirmed");
    await refreshWorkPayout(db, paypal, j.manager, payable.id);
    const page = await render(j.worker, () => WorkerWorkspace({ area: "pay" }));
    for (const text of ["£96.00", "£25.00", "£121.00", "Paid", "PayPal confirmed"]) expect(page).toContain(text);
    for (const text of ["PPB-1", "PPI-1", "PPT-1", "casey.sandbox@example.test"]) expect(page).not.toContain(text);
    const colleague = await j.c.invite("TEAM_MEMBER", j.manager);
    const theirs = await render(colleague, () => WorkerWorkspace({ area: "pay" }));
    expect(theirs).not.toContain("£121.00");
    const stranger = await business(db), strangerOwner = await stranger.ownerAt(0), strangerWorker = await stranger.invite("TEAM_MEMBER", strangerOwner);
    expect(await render(strangerWorker, () => WorkerWorkspace({ area: "pay" }))).not.toContain("£121.00");
    const review = await render(j.manager, () => ManagerWorkspace({ area: "review" }));
    expect(review).toMatch(/Square Sandbox attributed sales/);
    // Every provider reference stays on the page, in the stacked reference panel.
    expect(review).toContain("shift-terms payout-reference");
    for (const text of ["PPB-1", "PPI-1", "PPT-1"]) expect(review).toContain(text);
  }));
});
