import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { entitled } from "../helpers/onboarding";
import type { Scope } from "@/server/auth/access";
import { requireScope } from "@/server/auth/request";
import { savePayoutDestination } from "@/server/auth/operations";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { auditEvents, organisations, outlets, subscriptions, users, workPayables, workPayouts, workPolicies, workers } from "@/server/db/schema";
import { getPayPalPayoutClient } from "@/server/integrations/paypal/factory";
import { PayPalPayoutError, type PayPalPayoutAdapter, type PayoutResult } from "@/server/integrations/paypal/payout-client";
import { allocateAssignment, confirmWork, createDepartment, createRequirement, createTeamMember, createWorkPolicy, offerAssignment, respondToAssignment } from "@/server/scheduling/operations";
import { getWorkerWorkspace } from "@/server/product/workspace";
import { approveWorkPayable, PaymentDetailsRequiredError, payoutAmount, PayoutCurrencyUnsupportedError, payoutSenderIds, payoutStatusFromProvider, refreshWorkPayout, STALE_SUBMISSION_MS, submitWorkPayout } from "@/server/payments/work-payouts";
import { ManagerWorkspace } from "@/app/manager/workspace";
import { WorkerWorkspace } from "@/app/worker/workspace";
import { OwnerWorkspace } from "@/app/owner/workspace";
import { approvePayableAction, refreshPayoutAction, sendPayoutAction } from "@/app/operations-actions";

vi.mock("@/server/auth/request", () => ({ requireScope: vi.fn() }));
vi.mock("@/server/db/client", () => ({ getDatabase: vi.fn() }));
vi.mock("@/server/config/env", () => ({ getConfigurationStatus: vi.fn() }));
vi.mock("@/server/integrations/paypal/factory", () => ({ getPayPalPayoutClient: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); }, notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); vi.restoreAllMocks(); });

type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];
const START = Date.parse("2026-10-20T08:00:00Z");
const at = (hours: number) => new Date(START + hours * 3_600_000);

let n = 0;
async function user(db: Db) {
  const id = randomUUID();
  await db.insert(users).values({ id, email: `payout-user${++n}-${id.slice(0, 6)}@example.test`, name: "Test user", passwordHash: "test", emailVerifiedAt: new Date() });
  return id;
}
async function company(db: Db, locations = 1) {
  const organisationId = randomUUID();
  await db.insert(organisations).values({ id: organisationId, name: "UK company", country: "United Kingdom" });
  await db.insert(subscriptions).values({ id: randomUUID(), organisationId, requestId: randomUUID() });
  await entitled(db, organisationId);
  const rows = Array.from({ length: locations }, (_, i) => ({ id: randomUUID(), organisationId, name: `Store ${i + 1}`, timezone: "Europe/London" }));
  await db.insert(outlets).values(rows);
  const scopes: Scope[] = [];
  for (const row of rows) scopes.push({ userId: await user(db), organisationId, locationId: row.id, role: "MANAGER", organisationName: "UK company", locationName: row.name });
  return { organisationId, scopes };
}
// Shift → offer → acceptance → allocation → confirmation → payable, through the normal operations.
async function confirmedPayable(db: Db, manager: Scope, { paymentEmail = "casual.sandbox@example.test" as string | null } = {}) {
  const [department] = await createDepartment(db, `Sales floor ${randomUUID().slice(0, 6)}`, manager);
  const [policy] = await createWorkPolicy(db, { earningsModel: "HOURLY", rateMinor: 1_200 }, "Casual terms", manager);
  const shift = await createRequirement(db, { departmentId: department.id, policyId: policy.id, startsAt: at(0), endsAt: at(6), requiredHeadcount: 1 }, manager);
  const { worker } = await createTeamMember(db, { firstName: "Casual", surname: `Worker ${++n}`, telephone: "+441132000000", email: `casual${n}@example.test` }, manager);
  const workerScope: Scope = { ...manager, userId: await user(db), workerId: worker.id, role: "TEAM_MEMBER" };
  await db.update(workers).set({ userId: workerScope.userId }).where(eq(workers.id, worker.id));
  // Payment details arrive through the worker's own payment-settings path.
  if (paymentEmail) await savePayoutDestination(db, workerScope, paymentEmail);
  const offer = await offerAssignment(db, shift.id, worker.id, manager);
  await respondToAssignment(db, worker.id, offer.id, 1, "ACCEPTED", true, manager);
  await allocateAssignment(db, offer.id, manager);
  const { payable } = await confirmWork(db, offer.id, manager);
  return { payable: payable!, worker, workerScope, policy, shift };
}

const pending = (input: { senderBatchId: string }): PayoutResult => ({ batchId: `PPB${input.senderBatchId.slice(-8)}`, itemId: null, status: "PENDING", batchStatus: "PENDING", itemStatus: null, transactionId: null });
function fakePayPal(overrides: Partial<Record<keyof PayPalPayoutAdapter, unknown>> = {}) {
  return {
    createPayout: vi.fn(async (input: { senderBatchId: string }) => pending(input)),
    getPayout: vi.fn(async (batchId: string): Promise<PayoutResult> => ({ batchId, itemId: "PPI-1", status: "SUCCESS", batchStatus: "SUCCESS", itemStatus: "SUCCESS", transactionId: "PPT-1" })),
    ...overrides,
  } as unknown as PayPalPayoutAdapter & { createPayout: ReturnType<typeof vi.fn>; getPayout: ReturnType<typeof vi.fn> };
}
const payoutsOf = async (db: Db) => db.select().from(workPayouts);
const form = (values: Record<string, string>) => { const result = new FormData(); for (const [k, v] of Object.entries(values)) result.set(k, v); return result; };

describe("payout status mapping and amounts", () => {
  it("is paid only on an item-level SUCCESS and never guesses other currencies' minor units", () => {
    expect(payoutStatusFromProvider({ itemStatus: "SUCCESS", batchStatus: "SUCCESS" })).toBe("PAID");
    for (const item of ["PENDING", "UNCLAIMED", "ONHOLD", "SOMETHING_NEW"]) expect(payoutStatusFromProvider({ itemStatus: item, batchStatus: "SUCCESS" })).toBe("PROCESSING");
    for (const item of ["FAILED", "RETURNED", "BLOCKED", "REFUNDED", "REVERSED"]) expect(payoutStatusFromProvider({ itemStatus: item, batchStatus: "SUCCESS" })).toBe("FAILED");
    // A successful batch says nothing certain about the worker's item.
    for (const batch of ["SUCCESS", "PENDING", "PROCESSING", undefined]) expect(payoutStatusFromProvider({ itemStatus: null, batchStatus: batch })).toBe("PROCESSING");
    for (const batch of ["DENIED", "CANCELED"]) expect(payoutStatusFromProvider({ itemStatus: null, batchStatus: batch })).toBe("FAILED");
    expect(payoutAmount(7_200, "GBP")).toBe("72.00");
    expect(payoutAmount(5, "GBP")).toBe("0.05");
    expect(payoutAmount(9_007_199_254_740_991, "USD")).toBe("90071992547409.91");
    expect(() => payoutAmount(7_200, "JPY")).toThrow(PayoutCurrencyUnsupportedError);
    expect(() => payoutAmount(0, "GBP")).toThrow();
    expect(() => payoutAmount(1.5, "GBP")).toThrow();
  });
});

describe("manager approval and PayPal payout of confirmed work", () => {
  it("approves the calculated GBP payable, sends exactly that amount once, and reconciles to paid", async () => {
    const t = await createTestDatabase();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const c = await company(t.db);
      const manager = c.scopes[0];
      const { payable, worker, policy } = await confirmedPayable(t.db, manager);
      expect(payable).toMatchObject({ status: "PENDING_REVIEW", baseAmountMinor: 7_200, currencyCode: "GBP", approvedAt: null, approvedBy: null });
      const paypal = fakePayPal();

      // Payout is impossible before approval.
      await expect(submitWorkPayout(t.db, paypal, manager, payable.id)).rejects.toThrow(/Approve/);
      expect(paypal.createPayout).not.toHaveBeenCalled();

      // A: explicit approval records who, when, how much and in which currency.
      const approved = await approveWorkPayable(t.db, manager, payable.id);
      expect(approved).toMatchObject({ status: "APPROVED", approvedBy: manager.userId, approvedAmountMinor: 7_200, approvedCurrencyCode: "GBP", baseAmountMinor: 7_200 });
      expect(approved.approvedAt).toBeInstanceOf(Date);
      // Approving again changes nothing.
      expect(await approveWorkPayable(t.db, manager, payable.id)).toEqual(approved);

      // C: later policy changes do not affect what is paid.
      await t.db.update(workPolicies).set({ rateMinor: 9_900 }).where(eq(workPolicies.id, policy.id));

      // D, F, K: the request carries exactly the approved GBP amount, the saved recipient and the payable's IDs.
      const first = await submitWorkPayout(t.db, paypal, manager, payable.id);
      expect(first.submitted).toBe(true);
      expect(paypal.createPayout).toHaveBeenCalledTimes(1);
      const ids = payoutSenderIds(payable.id);
      expect(paypal.createPayout.mock.calls[0][0]).toEqual({
        ...ids, recipient: "casual.sandbox@example.test", amount: "72.00", currency: "GBP", purpose: "SERVICES",
        emailSubject: "FairShift work earnings", emailMessage: expect.any(String), note: "Manager-approved FairShift work earnings",
      });
      // L: PayPal accepted the batch; that is processing, not paid.
      expect(first.payout).toMatchObject({ status: "PROCESSING", paypalBatchId: `PPB${ids.senderBatchId.slice(-8)}`, paypalBatchStatus: "PENDING", paypalStatus: null, paidAt: null,
        amountMinor: 7_200, currencyCode: "GBP", recipient: "casual.sandbox@example.test", workerId: worker.id, attempts: 1, requestedBy: manager.userId });

      // G: repeats never reach PayPal again.
      expect((await submitWorkPayout(t.db, paypal, manager, payable.id)).submitted).toBe(false);
      expect(paypal.createPayout).toHaveBeenCalledTimes(1);

      // M: provider success reconciles to paid with PayPal's identifiers.
      const paid = await refreshWorkPayout(t.db, paypal, manager, payable.id);
      expect(paypal.getPayout).toHaveBeenCalledWith(first.payout.paypalBatchId, ids.senderItemId);
      expect(paid).toMatchObject({ status: "PAID", paypalStatus: "SUCCESS", paypalBatchStatus: "SUCCESS", paypalItemId: "PPI-1", paypalTransactionId: "PPT-1" });
      expect(paid.paidAt).toBeInstanceOf(Date);
      expect(paid.statusCheckedAt).toBeInstanceOf(Date);
      // Paid is final for sending: no further request.
      expect((await submitWorkPayout(t.db, paypal, manager, payable.id)).submitted).toBe(false);
      expect(paypal.createPayout).toHaveBeenCalledTimes(1);

      // The financial audit trail in order.
      const actions = (await t.db.select().from(auditEvents).where(eq(auditEvents.organisationId, c.organisationId))).map(event => event.action);
      for (const action of ["SHIFT_ACCEPTED", "WORK_CONFIRMED", "BASE_PAYABLE_CALCULATED", "PAYABLE_APPROVED", "PAYOUT_RESERVED", "PAYOUT_PROVIDER_RESPONSE", "PAYOUT_STATUS_UPDATED"]) expect(actions).toContain(action);
      const audit = JSON.stringify(await t.db.select().from(auditEvents));
      expect(audit).not.toContain("casual.sandbox@example.test");
      // O: no network was used.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); await t.close(); }
  });

  it("B: allows only the payable's own location managers and owner to approve, send or refresh", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db, 2), other = await company(t.db);
      const [manager, otherLocation] = c.scopes;
      const { payable, workerScope } = await confirmedPayable(t.db, manager);
      const paypal = fakePayPal();
      const forged: Scope = { ...other.scopes[0], organisationId: c.organisationId };
      const crossTenant: Scope = { ...other.scopes[0], locationId: manager.locationId };
      for (const scope of [otherLocation, other.scopes[0], forged, crossTenant, { ...otherLocation, role: "OWNER" as const }]) {
        await expect(approveWorkPayable(t.db, scope, payable.id)).rejects.toThrow();
      }
      await expect(approveWorkPayable(t.db, workerScope, payable.id)).rejects.toThrow("Access denied.");
      // A worker holding a manager role still cannot approve their own pay.
      await expect(approveWorkPayable(t.db, { ...manager, workerId: workerScope.workerId }, payable.id)).rejects.toThrow(/own worker/);
      expect((await t.db.select().from(workPayables).where(eq(workPayables.id, payable.id)))[0].status).toBe("PENDING_REVIEW");

      await approveWorkPayable(t.db, { ...manager, userId: await user(t.db), role: "OWNER" }, payable.id);
      for (const scope of [otherLocation, other.scopes[0], forged, crossTenant, workerScope]) {
        await expect(submitWorkPayout(t.db, paypal, scope, payable.id)).rejects.toThrow();
        await expect(refreshWorkPayout(t.db, paypal, scope, payable.id)).rejects.toThrow();
      }
      expect(paypal.createPayout).not.toHaveBeenCalled();
      expect(await payoutsOf(t.db)).toHaveLength(0);
    } finally { await t.close(); }
  });

  it("E: requires the worker's saved payment details before any payout request", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      const manager = c.scopes[0];
      const { payable, workerScope } = await confirmedPayable(t.db, manager, { paymentEmail: null });
      await approveWorkPayable(t.db, manager, payable.id);
      const paypal = fakePayPal();
      await expect(submitWorkPayout(t.db, paypal, manager, payable.id)).rejects.toThrow(PaymentDetailsRequiredError);
      expect(paypal.createPayout).not.toHaveBeenCalled();
      expect(await payoutsOf(t.db)).toHaveLength(0);
      await savePayoutDestination(t.db, workerScope, "later.sandbox@example.test");
      expect((await submitWorkPayout(t.db, paypal, manager, payable.id)).payout.recipient).toBe("later.sandbox@example.test");
    } finally { await t.close(); }
  });

  it("G: concurrent sends create one payout and one PayPal request", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      const manager = c.scopes[0];
      const { payable } = await confirmedPayable(t.db, manager);
      await approveWorkPayable(t.db, manager, payable.id);
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const paypal = fakePayPal({ createPayout: vi.fn(async (input: { senderBatchId: string }) => { await gate; return pending(input); }) });
      const attempts = Promise.all([1, 2, 3, 4].map(() => submitWorkPayout(t.db, paypal, manager, payable.id)));
      await new Promise(resolve => setTimeout(resolve, 50));
      release();
      const results = await attempts;
      expect(results.filter(result => result.submitted)).toHaveLength(1);
      expect(paypal.createPayout).toHaveBeenCalledTimes(1);
      expect(await payoutsOf(t.db)).toHaveLength(1);
      // The database refuses a second payout for the same payable.
      const [row] = await payoutsOf(t.db);
      await expect(t.db.insert(workPayouts).values({ ...row, id: randomUUID(), senderBatchId: "X-1", senderItemId: "X-2", paypalBatchId: null, status: "SUBMITTING", paidAt: null })).rejects.toThrow();
    } finally { await t.close(); }
  });

  it("H: a request that never reached PayPal is not a payout, and can be sent again with the same IDs", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      const manager = c.scopes[0];
      const { payable } = await confirmedPayable(t.db, manager);
      await approveWorkPayable(t.db, manager, payable.id);
      const notSent = new PayPalPayoutError("PayPal request could not be completed.", "NETWORK_ERROR", undefined, undefined, undefined, "NOT_SENT");
      const paypal = fakePayPal({ createPayout: vi.fn().mockRejectedValueOnce(notSent).mockImplementation(async (input: { senderBatchId: string }) => pending(input)) });
      const first = await submitWorkPayout(t.db, paypal, manager, payable.id);
      expect(first.payout).toMatchObject({ status: "NOT_SENT", paypalBatchId: null, paidAt: null, lastError: { code: "NETWORK_ERROR", outcome: "NOT_SENT" } });
      // Nothing is pending at PayPal, so a status check does not call it.
      await refreshWorkPayout(t.db, paypal, manager, payable.id);
      expect(paypal.getPayout).not.toHaveBeenCalled();
      const second = await submitWorkPayout(t.db, paypal, manager, payable.id);
      expect(second.payout).toMatchObject({ status: "PROCESSING", attempts: 2 });
      expect(paypal.createPayout.mock.calls[1][0]).toEqual(paypal.createPayout.mock.calls[0][0]);
      expect(await payoutsOf(t.db)).toHaveLength(1);
    } finally { await t.close(); }
  });

  it("I: a PayPal refusal is recorded as failed, never paid, and is not resent", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      const manager = c.scopes[0];
      const { payable } = await confirmedPayable(t.db, manager);
      await approveWorkPayable(t.db, manager, payable.id);
      const rejected = new PayPalPayoutError("PayPal rejected the payout request.", "VALIDATION_ERROR", 400, "dbg-123", [{ field: "items[0].amount.currency", issue: "CURRENCY_NOT_SUPPORTED" }], "REJECTED");
      const paypal = fakePayPal({ createPayout: vi.fn().mockRejectedValue(rejected) });
      const { payout } = await submitWorkPayout(t.db, paypal, manager, payable.id);
      expect(payout).toMatchObject({ status: "FAILED", paidAt: null, paypalBatchId: null, currencyCode: "GBP", lastError: { code: "VALIDATION_ERROR", httpStatus: 400, debugId: "dbg-123", outcome: "REJECTED" } });
      expect(await submitWorkPayout(t.db, paypal, manager, payable.id)).toMatchObject({ submitted: false });
      await refreshWorkPayout(t.db, paypal, manager, payable.id);
      expect(paypal.createPayout).toHaveBeenCalledTimes(1);
      expect(paypal.getPayout).not.toHaveBeenCalled();
    } finally { await t.close(); }
  });

  it("J: an unknown outcome is never resent automatically; reconciliation repeats the identical request", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      const manager = c.scopes[0];
      const { payable, workerScope } = await confirmedPayable(t.db, manager);
      await approveWorkPayable(t.db, manager, payable.id);
      const timeout = new PayPalPayoutError("PayPal request could not be completed.", "TIMEOUT", undefined, undefined, undefined, "UNKNOWN");
      const notSent = new PayPalPayoutError("PayPal request could not be completed.", "NETWORK_ERROR", undefined, undefined, undefined, "NOT_SENT");
      const createPayout = vi.fn().mockRejectedValueOnce(timeout).mockRejectedValueOnce(notSent).mockImplementation(async (input: { senderBatchId: string }) => pending(input));
      const paypal = fakePayPal({ createPayout, getPayout: vi.fn(async (batchId: string) => ({ batchId, itemId: "PPI-9", status: "UNCLAIMED", batchStatus: "SUCCESS", itemStatus: "UNCLAIMED", transactionId: null })) });
      const { payout } = await submitWorkPayout(t.db, paypal, manager, payable.id);
      expect(payout).toMatchObject({ status: "RECONCILIATION_REQUIRED", paidAt: null, lastError: { code: "TIMEOUT", outcome: "UNKNOWN" } });
      // A repeated send does not resend money.
      expect(await submitWorkPayout(t.db, paypal, manager, payable.id)).toMatchObject({ submitted: false });
      expect(createPayout).toHaveBeenCalledTimes(1);
      // The worker changes their PayPal email meanwhile; the reconciliation still uses the original request.
      await savePayoutDestination(t.db, workerScope, "changed@example.test");
      // A reconciliation attempt that does not leave cannot prove the first did not pay.
      expect(await refreshWorkPayout(t.db, paypal, manager, payable.id)).toMatchObject({ status: "RECONCILIATION_REQUIRED", attempts: 2 });
      const reconciled = await refreshWorkPayout(t.db, paypal, manager, payable.id);
      expect(createPayout).toHaveBeenCalledTimes(3);
      for (const call of createPayout.mock.calls) expect(call[0]).toEqual(createPayout.mock.calls[0][0]);
      expect(createPayout.mock.calls[2][0]).toMatchObject({ recipient: "casual.sandbox@example.test", amount: "72.00", currency: "GBP" });
      // L: unclaimed at PayPal is still processing, not paid.
      expect(reconciled).toMatchObject({ status: "PROCESSING", paypalStatus: "UNCLAIMED", paypalItemId: "PPI-9", attempts: 3, paidAt: null });
      expect(await payoutsOf(t.db)).toHaveLength(1);
    } finally { await t.close(); }
  });

  it("J: PayPal's duplicate response and an interrupted submission both recover the original payout without a second payment", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      const manager = c.scopes[0];
      const first = await confirmedPayable(t.db, manager);
      await approveWorkPayable(t.db, manager, first.payable.id);
      const duplicate = new PayPalPayoutError("PayPal rejected the payout request.", "USER_BUSINESS_ERROR", 400, undefined, undefined, "DUPLICATE", "ORIGINAL1");
      const paypal = fakePayPal({ createPayout: vi.fn().mockRejectedValueOnce(new PayPalPayoutError("x", "INTERNAL_SERVER_ERROR", 500, undefined, undefined, "UNKNOWN")).mockRejectedValueOnce(duplicate) });
      expect((await submitWorkPayout(t.db, paypal, manager, first.payable.id)).payout.status).toBe("RECONCILIATION_REQUIRED");
      const adopted = await refreshWorkPayout(t.db, paypal, manager, first.payable.id);
      expect(paypal.getPayout).toHaveBeenCalledWith("ORIGINAL1", payoutSenderIds(first.payable.id).senderItemId);
      expect(adopted).toMatchObject({ status: "PAID", paypalBatchId: "ORIGINAL1", paypalStatus: "SUCCESS" });

      // PayPal accepted the payout but FairShift stopped before recording it: the reservation remains.
      const second = await confirmedPayable(t.db, manager);
      await approveWorkPayable(t.db, manager, second.payable.id);
      const hang = fakePayPal({ createPayout: vi.fn(() => new Promise(() => undefined)) });
      void submitWorkPayout(t.db, hang, manager, second.payable.id);
      await new Promise(resolve => setTimeout(resolve, 50));
      const [reserved] = await t.db.select().from(workPayouts).where(eq(workPayouts.payableId, second.payable.id));
      expect(reserved.status).toBe("SUBMITTING");
      const recover = fakePayPal();
      // A recent reservation may still be in flight and is left alone.
      expect(await refreshWorkPayout(t.db, recover, manager, second.payable.id)).toMatchObject({ status: "SUBMITTING" });
      expect(recover.createPayout).not.toHaveBeenCalled();
      await t.db.update(workPayouts).set({ updatedAt: new Date(Date.now() - STALE_SUBMISSION_MS - 1_000) }).where(eq(workPayouts.id, reserved.id));
      const recovered = await refreshWorkPayout(t.db, recover, manager, second.payable.id);
      expect(recover.createPayout).toHaveBeenCalledTimes(1);
      expect(recover.createPayout.mock.calls[0][0]).toMatchObject(payoutSenderIds(second.payable.id));
      expect(recovered.status).toBe("PAID");
    } finally { await t.close(); }
  });

  it("L: intermediate and failed provider states are shown truthfully", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      const manager = c.scopes[0];
      const { payable } = await confirmedPayable(t.db, manager);
      await approveWorkPayable(t.db, manager, payable.id);
      const statuses = ["PENDING", "ONHOLD", "SUCCESS", "REVERSED"];
      const paypal = fakePayPal({ getPayout: vi.fn(async (batchId: string) => { const item = statuses.shift()!; return { batchId, itemId: "PPI-2", status: item, batchStatus: "SUCCESS", itemStatus: item, transactionId: "PPT-2" }; }) });
      await submitWorkPayout(t.db, paypal, manager, payable.id);
      expect(await refreshWorkPayout(t.db, paypal, manager, payable.id)).toMatchObject({ status: "PROCESSING", paypalStatus: "PENDING", paidAt: null });
      expect(await refreshWorkPayout(t.db, paypal, manager, payable.id)).toMatchObject({ status: "PROCESSING", paypalStatus: "ONHOLD", paidAt: null });
      const paid = await refreshWorkPayout(t.db, paypal, manager, payable.id);
      expect(paid.status).toBe("PAID");
      // A reversal after payment is not shown as paid.
      expect(await refreshWorkPayout(t.db, paypal, manager, payable.id)).toMatchObject({ status: "FAILED", paypalStatus: "REVERSED" });
      // A status read failure leaves the recorded status unchanged.
      const down = fakePayPal({ getPayout: vi.fn().mockRejectedValue(new PayPalPayoutError("x", "TIMEOUT")) });
      await expect(refreshWorkPayout(t.db, down, manager, payable.id)).rejects.toThrow(/unchanged/);
      expect((await payoutsOf(t.db))[0]).toMatchObject({ status: "FAILED", paypalStatus: "REVERSED" });
    } finally { await t.close(); }
  });

  it("enforces approval, amount, currency and lifecycle rules in the database", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      const manager = c.scopes[0];
      const { payable } = await confirmedPayable(t.db, manager);
      const reservation = { id: randomUUID(), payableId: payable.id, organisationId: payable.organisationId, outletId: payable.outletId, workerId: payable.workerId,
        amountMinor: 7_200, currencyCode: "GBP", recipient: "casual.sandbox@example.test", ...payoutSenderIds(payable.id), status: "SUBMITTING", reservedAt: new Date() };
      // No payout for an unapproved payable.
      await expect(t.db.insert(workPayouts).values(reservation)).rejects.toThrow();
      // Approval must copy the base amount and currency exactly, and a payable cannot be created approved.
      for (const change of [{ approvedAmountMinor: 9_999 }, { approvedCurrencyCode: "USD" }, { approvedBy: null }]) {
        await expect(t.db.update(workPayables).set({ status: "APPROVED", approvedAt: new Date(), approvedBy: manager.userId, approvedAmountMinor: 7_200, approvedCurrencyCode: "GBP", ...change }).where(eq(workPayables.id, payable.id))).rejects.toThrow();
      }
      await approveWorkPayable(t.db, manager, payable.id);
      await expect(t.db.update(workPayables).set({ status: "PENDING_REVIEW", approvedAt: null, approvedBy: null, approvedAmountMinor: null, approvedCurrencyCode: null }).where(eq(workPayables.id, payable.id))).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringMatching(/final/) }) });
      await expect(t.db.update(workPayables).set({ approvedAt: new Date(0) }).where(eq(workPayables.id, payable.id))).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringMatching(/final/) }) });
      for (const invalid of [{ amountMinor: 7_201 }, { currencyCode: "USD" }, { workerId: randomUUID() }, { status: "PAID" }, { outletId: randomUUID() }]) {
        await expect(t.db.insert(workPayouts).values({ ...reservation, ...invalid })).rejects.toThrow();
      }
      await t.db.insert(workPayouts).values(reservation);
      for (const change of [{ amountMinor: 1 }, { currencyCode: "USD" }, { senderBatchId: "OTHER" }, { recipient: "other@example.test" }, { status: "NOT_SENT", paypalBatchId: "B" },
        { status: "PAID", paypalBatchId: "B", paypalStatus: "PENDING", paidAt: new Date() }, { status: "PAID", paypalBatchId: "B", paypalStatus: "SUCCESS" }, { status: "PROCESSING" }]) {
        await expect(t.db.update(workPayouts).set(change).where(eq(workPayouts.id, reservation.id))).rejects.toThrow();
      }
      await t.db.update(workPayouts).set({ status: "PROCESSING", paypalBatchId: "B1" }).where(eq(workPayouts.id, reservation.id));
      for (const change of [{ paypalBatchId: "B2" }, { status: "SUBMITTING" }, { status: "NOT_SENT" }, { status: "RECONCILIATION_REQUIRED" }]) {
        await expect(t.db.update(workPayouts).set(change).where(eq(workPayouts.id, reservation.id))).rejects.toThrow();
      }
      await expect(t.db.delete(workPayouts).where(eq(workPayouts.id, reservation.id))).rejects.toThrow();
    } finally { await t.close(); }
  });

  it("drives the manager, worker and owner surfaces through the server actions, ignoring client-supplied money", async () => {
    const t = await createTestDatabase();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const c = await company(t.db);
      const manager = c.scopes[0];
      const { payable, workerScope, worker } = await confirmedPayable(t.db, manager);
      const otherWorker = await confirmedPayable(t.db, manager);
      const owner: Scope = { ...manager, userId: await user(t.db), role: "OWNER" };
      const paypal = fakePayPal({ getPayout: vi.fn()
        .mockImplementationOnce(async (batchId: string) => ({ batchId, itemId: null, status: "PENDING", batchStatus: "PROCESSING", itemStatus: "PENDING", transactionId: null }))
        .mockImplementation(async (batchId: string) => ({ batchId, itemId: "PPI-7", status: "SUCCESS", batchStatus: "SUCCESS", itemStatus: "SUCCESS", transactionId: "PPT-7" })) });
      vi.mocked(getDatabase).mockReturnValue(t.db);
      vi.mocked(getConfigurationStatus).mockReturnValue({ databaseConfigured: true, paypalPayoutConfigured: true } as ReturnType<typeof getConfigurationStatus>);
      vi.mocked(getPayPalPayoutClient).mockReturnValue(paypal as unknown as ReturnType<typeof getPayPalPayoutClient>);
      const render = async (scope: Scope, element: () => Promise<React.ReactNode>) => { vi.mocked(requireScope).mockResolvedValue(scope); return renderToStaticMarkup(await element()); };
      const act = async (scope: Scope, action: (f: FormData) => Promise<unknown>, values: Record<string, string>) => { vi.mocked(requireScope).mockResolvedValue(scope); await expect(action(form(values))).rejects.toThrow(/REDIRECT/); };
      const status = async () => (await t.db.select().from(workPayables).where(eq(workPayables.id, payable.id)))[0];

      let review = await render(manager, () => ManagerWorkspace({ area: "review" }));
      expect(review).toContain("Approve £72.00");
      expect(review).not.toContain("payout with PayPal");

      // A worker cannot reach the approval or payment actions.
      await act(workerScope, approvePayableAction, { payableId: payable.id });
      vi.mocked(requireScope).mockRejectedValueOnce(new Error("Access denied."));
      await expect(approvePayableAction(form({ payableId: payable.id }))).rejects.toThrow();
      expect((await status()).status).toBe("PENDING_REVIEW");

      await act(manager, approvePayableAction, { payableId: payable.id, amount: "1.00", approvedAmountMinor: "1", currency: "USD" });
      expect(await status()).toMatchObject({ status: "APPROVED", approvedAmountMinor: 7_200, approvedCurrencyCode: "GBP" });
      review = await render(manager, () => ManagerWorkspace({ area: "review" }));
      expect(review).toContain("Send £72.00 payout with PayPal");
      expect(review).not.toMatch(/>\s*Paid\s*</);

      // Approved, not sent: the worker sees approval, not payment.
      let earnings = await render(workerScope, () => WorkerWorkspace({ area: "earnings" }));
      expect(earnings).toContain("Approved");
      expect(earnings).not.toMatch(/>\s*Paid\s*</);

      await act(manager, sendPayoutAction, { payableId: payable.id, amount: "999.00", currency: "USD", recipient: "attacker@example.test" });
      expect(paypal.createPayout).toHaveBeenCalledTimes(1);
      expect(paypal.createPayout.mock.calls[0][0]).toMatchObject({ amount: "72.00", currency: "GBP", recipient: "casual.sandbox@example.test" });
      await act(manager, sendPayoutAction, { payableId: payable.id });
      expect(paypal.createPayout).toHaveBeenCalledTimes(1);

      await act(manager, refreshPayoutAction, { payableId: payable.id });
      review = await render(manager, () => ManagerWorkspace({ area: "review" }));
      expect(review).toContain("Processing");
      expect(review).toContain("Check payment status");
      expect(review).not.toMatch(/>\s*Paid\s*</);
      earnings = await render(workerScope, () => WorkerWorkspace({ area: "earnings" }));
      expect(earnings).toContain("Processing");
      expect(earnings).not.toMatch(/>\s*Paid\s*</);

      await act(manager, refreshPayoutAction, { payableId: payable.id });
      review = await render(manager, () => ManagerWorkspace({ area: "review" }));
      for (const text of [">Paid<", "PPI-7", "PPT-7", "PayPal Sandbox reference", "£72.00"]) expect(review).toContain(text);
      expect(review).not.toContain("casual.sandbox@example.test");

      // N: the worker sees their own paid status, without provider internals or other workers.
      earnings = await render(workerScope, () => WorkerWorkspace({ area: "earnings" }));
      for (const text of [">Paid<", "£72.00", "paid to your PayPal account", "Europe/London"]) expect(earnings).toContain(text);
      for (const hidden of ["PPI-7", "PPT-7", "PPB", "casual.sandbox@example.test", otherWorker.worker.displayName]) expect(earnings).not.toContain(hidden);
      expect(await render(workerScope, () => WorkerWorkspace({ area: "home" }))).toContain("£72.00 paid");
      const otherView = await getWorkerWorkspace(t.db, otherWorker.workerScope);
      expect(otherView.assignments.map(row => row.payout?.id ?? null)).toEqual([null]);
      // The worker's own profile holds their own PayPal email; the payout carries no provider internals.
      expect(JSON.stringify((await getWorkerWorkspace(t.db, workerScope)).assignments)).not.toMatch(/PPI-7|PPT-7|PPB|sandbox@example|senderBatch|recipient|lastError/);

      // Owner sees the organisation's work payment states.
      await t.db.insert((await import("@/server/db/schema")).memberships).values({ id: randomUUID(), userId: owner.userId, organisationId: c.organisationId, role: "OWNER" });
      const payments = await render(owner, () => OwnerWorkspace({ area: "payments" }));
      expect(payments).toContain("Work earnings payments");
      expect(payments).toContain(worker.displayName);
      expect(payments).toContain(">Paid<");
      expect(payments).toContain("Awaiting approval");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); await t.close(); }
  });

  it("shows payment details required to the manager and worker without offering a payout", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      const manager = c.scopes[0];
      const { payable, workerScope } = await confirmedPayable(t.db, manager, { paymentEmail: null });
      await approveWorkPayable(t.db, manager, payable.id);
      vi.mocked(getDatabase).mockReturnValue(t.db);
      vi.mocked(getConfigurationStatus).mockReturnValue({ databaseConfigured: true, paypalPayoutConfigured: true } as ReturnType<typeof getConfigurationStatus>);
      vi.mocked(requireScope).mockResolvedValue(manager);
      const review = renderToStaticMarkup(await ManagerWorkspace({ area: "review" }));
      expect(review).toContain("Payment details required.");
      expect(review).not.toContain("payout with PayPal");
      vi.mocked(requireScope).mockResolvedValue(workerScope);
      const earnings = renderToStaticMarkup(await WorkerWorkspace({ area: "earnings" }));
      expect(earnings).toContain("Payment details required");
      expect(earnings).toContain("/worker/profile");
    } finally { await t.close(); }
  });
});
