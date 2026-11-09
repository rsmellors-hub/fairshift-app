import { sandboxFixture } from "../helpers/sandbox";
import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { entitled } from "../helpers/onboarding";
import { requireEntitlement } from "@/server/billing/entitlement";
import type { Scope } from "@/server/auth/access";
import { requireFinancialScope, requireScope } from "@/server/auth/request";
import { savePayoutDestination } from "@/server/auth/operations";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { auditEvents, departments, organisations, outlets, paypalConnections, subscriptions, users, workAcceptances, workPayables, workPayouts, workPolicies, workers } from "@/server/db/schema";
import { getPayPalPayoutClient } from "@/server/integrations/paypal/factory";
import { PayPalPayoutError, type PayPalPayoutAdapter, type PayoutResult } from "@/server/integrations/paypal/payout-client";
import { allocateAssignment, confirmWork, createDepartment, createRequirement, createWorkPolicy, offerAssignment, respondToAssignment } from "@/server/scheduling/operations";
import { getWorkerWorkspace } from "@/server/product/workspace";
import { approveWorkPayable, isVerifiedPayoutCurrency, PaymentDetailsRequiredError, payoutAmount, PayoutCurrencyUnsupportedError, payoutSenderIds, payoutStatusFromProvider, refreshWorkPayout, STALE_SUBMISSION_MS, submitWorkPayout } from "@/server/payments/work-payouts";
import { ProviderCurrencyRateUnavailableError } from "@/server/domain/provider-currency";
import { seedTestFxRate, TEST_QUOTE_1850 } from "../helpers/fx";
import { ManagerWorkspace } from "@/app/manager/workspace";
import { WorkerWorkspace } from "@/app/worker/workspace";
import { OwnerWorkspace } from "@/app/owner/workspace";
import { approvePayableAction, confirmWorkAction, refreshPayoutAction, sendPayoutAction } from "@/app/operations-actions";
import { DEMO_ORGANISATION_ID, DEMO_OUTLET_ID } from "@/server/constants";
import { createActivatedTeamMember } from "../helpers/workers";
import { fixtureHourlyRate } from "../helpers/pay-agent";
import { ownerAcknowledgesWageNotChecked } from "../helpers/legacy-commission";
import { wageJurisdiction } from "@/server/domain/statutory-wage";

vi.mock("@/server/auth/request", () => ({ requireScope: vi.fn(), requireFinancialScope: vi.fn() }));
vi.mock("@/server/db/client", () => ({ getDatabase: vi.fn() }));
vi.mock("@/server/config/env", () => ({ getConfigurationStatus: vi.fn() }));
vi.mock("@/server/integrations/paypal/factory", () => ({ getPayPalPayoutClient: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); }, notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); vi.resetAllMocks(); vi.restoreAllMocks(); });

type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];
const START = Date.parse("2026-10-20T08:00:00Z");
const at = (hours: number) => new Date(START + hours * 3_600_000);

let n = 0;
async function user(db: Db) {
  const id = randomUUID();
  await db.insert(users).values({ id, email: `payout-user${++n}-${id.slice(0, 6)}@example.test`, name: "Test user", passwordHash: "test", emailVerifiedAt: new Date() });
  return id;
}
async function company(db: Db, locations = 1, country = "United Kingdom") {
  const organisationId = randomUUID();
  if (!process.env.FAIRSHIFT_SANDBOX_ORGANISATION_ID) sandboxFixture(organisationId);
  await db.insert(organisations).values({ id: organisationId, name: "Independent company", country });
  await db.insert(subscriptions).values({ id: randomUUID(), organisationId, requestId: randomUUID() });
  await entitled(db, organisationId);
  const timezone = country === "South Africa" ? "Africa/Johannesburg" : "Europe/London";
  const rows = Array.from({ length: locations }, (_, i) => ({ id: randomUUID(), organisationId, name: `Store ${i + 1}`, timezone }));
  await db.insert(outlets).values(rows);
  const scopes: Scope[] = [];
  for (const row of rows) scopes.push({ userId: await user(db), organisationId, locationId: row.id, role: "MANAGER", organisationName: "Independent company", locationName: row.name });
  // Where FairShift holds no wage rule for the country, the Owner has acknowledged that (Day 6, Step 3a).
  if (wageJurisdiction({ organisationCountry: country }).jurisdiction === null) for (const scope of scopes) await ownerAcknowledgesWageNotChecked(db, scope);
  return { organisationId, scopes };
}
// Shift → offer → acceptance → allocation, through the normal operations.
async function allocatedWork(db: Db, manager: Scope, { paymentEmail = "casual.sandbox@example.test" as string | null } = {}) {
  const [department] = await createDepartment(db, `Sales floor ${randomUUID().slice(0, 6)}`, manager);
  // £13.00 an hour, or R39.00 in South Africa: at or above the floor in force for these dates
  // (FS-WAGE-INTEL-DEC-002; the South African National Minimum Wage since Day 6).
  const [policy] = await createWorkPolicy(db, { earningsModel: "HOURLY", rateMinor: await fixtureHourlyRate(db, manager) }, "Casual terms", manager);
  const shift = await createRequirement(db, { departmentId: department.id, policyId: policy.id, startsAt: at(0), endsAt: at(6), requiredHeadcount: 1 }, manager);
  const { worker } = await createActivatedTeamMember(db, { firstName: "Casual", surname: `Worker ${++n}`, telephone: "+441132000000", email: `casual${n}@example.test` }, manager);
  const workerScope: Scope = { ...manager, userId: await user(db), workerId: worker.id, role: "TEAM_MEMBER" };
  await db.update(workers).set({ userId: workerScope.userId }).where(eq(workers.id, worker.id));
  // Payment details arrive through the worker's own payment-settings path.
  if (paymentEmail) await savePayoutDestination(db, workerScope, paymentEmail);
  const offer = await offerAssignment(db, shift.id, worker.id, manager);
  await respondToAssignment(db, worker.id, offer.id, 1, "ACCEPTED", true, manager);
  await allocateAssignment(db, offer.id, manager);
  return { offer, worker, workerScope, policy, shift };
}
// Allocation → explicit confirmation → payable, through the ordinary deterministic path.
async function confirmedPayable(db: Db, manager: Scope, options: { paymentEmail?: string | null } = {}) {
  const allocated = await allocatedWork(db, manager, options);
  const { payable } = await confirmWork(db, allocated.offer.id, manager);
  return { ...allocated, payable: payable! };
}

const pending = (input: { senderBatchId: string }): PayoutResult => ({ batchId: `PPB${input.senderBatchId.slice(-8)}`, itemId: null, status: "PENDING", batchStatus: "PENDING", itemStatus: null, transactionId: null });
function fakePayPal(overrides: Partial<Record<keyof PayPalPayoutAdapter, unknown>> = {}) {
  return {
    createPayout: vi.fn(async (input: { senderBatchId: string }) => pending(input)),
    getPayout: vi.fn(async (batchId: string): Promise<PayoutResult> => ({ batchId, itemId: "PPI-1", status: "SUCCESS", batchStatus: "SUCCESS", itemStatus: "SUCCESS", transactionId: "PPT-1", itemAmount: { value: "78.00", currency: "GBP" } })),
    ...overrides,
  } as unknown as PayPalPayoutAdapter & { createPayout: ReturnType<typeof vi.fn>; getPayout: ReturnType<typeof vi.fn> };
}
const payoutsOf = async (db: Db) => db.select().from(workPayouts);
const form = (values: Record<string, string>) => { const result = new FormData(); for (const [k, v] of Object.entries(values)) result.set(k, v); return result; };
const subscriptionStatus = (db: Db, organisationId: string, status: "ACTIVE" | "SUSPENDED" | "CANCELLED" | "EXPIRED") =>
  db.update(subscriptions).set({ status }).where(eq(subscriptions.organisationId, organisationId));

describe("payout status mapping and amounts", () => {
  it("is paid only on an item-level SUCCESS and never guesses other currencies' minor units", () => {
    expect(payoutStatusFromProvider({ itemStatus: "SUCCESS", batchStatus: "SUCCESS" })).toBe("PAID");
    for (const item of ["PENDING", "UNCLAIMED", "ONHOLD", "SOMETHING_NEW"]) expect(payoutStatusFromProvider({ itemStatus: item, batchStatus: "SUCCESS" })).toBe("PROCESSING");
    for (const item of ["FAILED", "RETURNED", "BLOCKED", "REFUNDED", "REVERSED", "DENIED"]) expect(payoutStatusFromProvider({ itemStatus: item, batchStatus: "SUCCESS" })).toBe("FAILED");
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
  it.each(["CANCELLED", "SUSPENDED", "EXPIRED"] as const)("confirms ended allocated work and completes payment after subscription becomes %s", async subscription => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      const manager = c.scopes[0];
      const { offer, worker } = await allocatedWork(t.db, manager);
      await subscriptionStatus(t.db, c.organisationId, subscription);
      vi.mocked(getDatabase).mockReturnValue(t.db);
      vi.mocked(getConfigurationStatus).mockReturnValue({ databaseConfigured: true, paypalPayoutConfigured: true } as ReturnType<typeof getConfigurationStatus>);
      vi.mocked(requireFinancialScope).mockResolvedValue(manager);
      const paypal = fakePayPal();
      vi.mocked(getPayPalPayoutClient).mockReturnValue(paypal as unknown as ReturnType<typeof getPayPalPayoutClient>);

      const before = renderToStaticMarkup(await ManagerWorkspace({ area: "review", financialScope: manager, financialOnly: true }));
      expect(before).toContain("Confirm completed work");
      expect(before).toContain(worker.displayName);
      expect(before).toContain("I confirm the scheduled work was performed.");
      for (const operational of ["Create a shift", "Send offer", "Finalise allocation", "Confirm sales results", "Forecast &amp; staffing"]) expect(before).not.toContain(operational);

      await expect(confirmWorkAction(form({ offerId: offer.id, confirmed: "yes", amount: "1", currency: "USD" }))).rejects.toThrow("REDIRECT:/settlements?status=saved");
      await expect(confirmWorkAction(form({ offerId: offer.id, confirmed: "yes" }))).rejects.toThrow("REDIRECT:/settlements?status=saved");
      const [payable] = await t.db.select().from(workPayables);
      expect(payable).toMatchObject({ workerId: worker.id, status: "PENDING_REVIEW", baseAmountMinor: 7_800, currencyCode: "GBP" });
      expect(await t.db.select().from(workPayables)).toHaveLength(1);

      await approveWorkPayable(t.db, manager, payable.id);
      expect((await submitWorkPayout(t.db, paypal, manager, payable.id)).submitted).toBe(true);
      expect((await submitWorkPayout(t.db, paypal, manager, payable.id)).submitted).toBe(false);
      expect(paypal.createPayout).toHaveBeenCalledTimes(1);
      expect(await refreshWorkPayout(t.db, paypal, manager, payable.id)).toMatchObject({ status: "PAID", paypalStatus: "SUCCESS", amountMinor: 7_800, currencyCode: "GBP" });
    } finally { await t.close(); }
  });

  it("settles confirmed work after cancellation without weakening operational entitlement", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      const manager = c.scopes[0];
      const { payable } = await confirmedPayable(t.db, manager);
      await subscriptionStatus(t.db, c.organisationId, "CANCELLED");

      const approved = await approveWorkPayable(t.db, manager, payable.id);
      expect(approved).toMatchObject({ status: "APPROVED", approvedAmountMinor: 7_800, approvedCurrencyCode: "GBP" });
      await expect(requireEntitlement(t.db, c.organisationId)).rejects.toThrow(/active organisation subscription/);
    } finally { await t.close(); }
  });

  it("submits an active-earned approved payable once after suspension", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      const manager = c.scopes[0];
      const { payable } = await confirmedPayable(t.db, manager);
      await approveWorkPayable(t.db, manager, payable.id);
      await subscriptionStatus(t.db, c.organisationId, "SUSPENDED");
      const paypal = fakePayPal();

      expect((await submitWorkPayout(t.db, paypal, manager, payable.id)).submitted).toBe(true);
      expect((await submitWorkPayout(t.db, paypal, manager, payable.id)).submitted).toBe(false);
      expect(paypal.createPayout).toHaveBeenCalledTimes(1);
      expect(paypal.createPayout.mock.calls[0][0]).toMatchObject({ amount: "78.00", currency: "GBP" });
    } finally { await t.close(); }
  });

  it("reconciles existing provider identifiers after expiry without false payment", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      const manager = c.scopes[0];
      const { payable } = await confirmedPayable(t.db, manager);
      await approveWorkPayable(t.db, manager, payable.id);
      const paypal = fakePayPal({ getPayout: vi.fn(async (batchId: string) => ({ batchId, itemId: "PPI-INACTIVE", status: "PENDING", batchStatus: "SUCCESS", itemStatus: "PENDING", transactionId: null })) });
      const submitted = await submitWorkPayout(t.db, paypal, manager, payable.id);
      await subscriptionStatus(t.db, c.organisationId, "EXPIRED");

      const reconciled = await refreshWorkPayout(t.db, paypal, manager, payable.id);
      expect(reconciled).toMatchObject({ status: "PROCESSING", paypalBatchId: submitted.payout.paypalBatchId, paypalItemId: "PPI-INACTIVE", paypalStatus: "PENDING", paidAt: null });
      expect(paypal.createPayout).toHaveBeenCalledTimes(1);
    } finally { await t.close(); }
  });

  it("keeps uncertain inactive-subscription outcomes idempotent and reconcilable", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      const manager = c.scopes[0];
      const { payable } = await confirmedPayable(t.db, manager);
      await approveWorkPayable(t.db, manager, payable.id);
      const timeout = new PayPalPayoutError("PayPal request could not be completed.", "TIMEOUT", undefined, undefined, undefined, "UNKNOWN");
      const paypal = fakePayPal({ createPayout: vi.fn().mockRejectedValue(timeout) });
      expect((await submitWorkPayout(t.db, paypal, manager, payable.id)).payout.status).toBe("RECONCILIATION_REQUIRED");
      await subscriptionStatus(t.db, c.organisationId, "CANCELLED");

      expect((await submitWorkPayout(t.db, paypal, manager, payable.id)).submitted).toBe(false);
      expect((await refreshWorkPayout(t.db, paypal, manager, payable.id)).status).toBe("RECONCILIATION_REQUIRED");
      expect(paypal.createPayout).toHaveBeenCalledTimes(2);
      expect(paypal.createPayout.mock.calls[1][0]).toEqual(paypal.createPayout.mock.calls[0][0]);
      expect(await payoutsOf(t.db)).toHaveLength(1);
    } finally { await t.close(); }
  });

  it("approves the calculated GBP payable, sends exactly that amount once, and reconciles to paid", async () => {
    const t = await createTestDatabase();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const c = await company(t.db);
      const manager = c.scopes[0];
      const { payable, worker, policy } = await confirmedPayable(t.db, manager);
      expect(payable).toMatchObject({ status: "PENDING_REVIEW", baseAmountMinor: 7_800, currencyCode: "GBP", approvedAt: null, approvedBy: null });
      const paypal = fakePayPal();

      // Payout is impossible before approval.
      await expect(submitWorkPayout(t.db, paypal, manager, payable.id)).rejects.toThrow(/Approve/);
      expect(paypal.createPayout).not.toHaveBeenCalled();

      // A: explicit approval records who, when, how much and in which currency.
      const approved = await approveWorkPayable(t.db, manager, payable.id);
      expect(approved).toMatchObject({ status: "APPROVED", approvedBy: manager.userId, approvedAmountMinor: 7_800, approvedCurrencyCode: "GBP", baseAmountMinor: 7_800 });
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
        ...ids, recipient: "casual.sandbox@example.test", amount: "78.00", currency: "GBP", purpose: "SERVICES",
        emailSubject: "FairShift work earnings", emailMessage: expect.any(String), note: "Manager-approved FairShift work earnings",
      });
      // L: PayPal accepted the batch; that is processing, not paid.
      expect(first.payout).toMatchObject({ status: "PROCESSING", paypalBatchId: `PPB${ids.senderBatchId.slice(-8)}`, paypalBatchStatus: "PENDING", paypalStatus: null, paidAt: null,
        amountMinor: 7_800, currencyCode: "GBP", recipient: "casual.sandbox@example.test", workerId: worker.id, attempts: 1, requestedBy: manager.userId });

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
      expect(createPayout.mock.calls[2][0]).toMatchObject({ recipient: "casual.sandbox@example.test", amount: "78.00", currency: "GBP" });
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
      const paypal = fakePayPal({ getPayout: vi.fn(async (batchId: string) => { const item = statuses.shift()!; return { batchId, itemId: "PPI-2", status: item, batchStatus: "SUCCESS", itemStatus: item, transactionId: "PPT-2", itemAmount: { value: "78.00", currency: "GBP" } }; }) });
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
        amountMinor: 7_800, currencyCode: "GBP", providerCurrency: "GBP", providerAmountMinor: 7_800, recipient: "casual.sandbox@example.test", ...payoutSenderIds(payable.id), status: "SUBMITTING", reservedAt: new Date() };
      // No payout for an unapproved payable.
      await expect(t.db.insert(workPayouts).values(reservation)).rejects.toThrow();
      // Approval must copy the base amount and currency exactly, and a payable cannot be created approved.
      for (const change of [{ approvedAmountMinor: 9_999 }, { approvedCurrencyCode: "USD" }, { approvedBy: null }]) {
        await expect(t.db.update(workPayables).set({ status: "APPROVED", approvedAt: new Date(), approvedBy: manager.userId, approvedAmountMinor: 7_800, approvedCurrencyCode: "GBP", ...change }).where(eq(workPayables.id, payable.id))).rejects.toThrow();
      }
      await approveWorkPayable(t.db, manager, payable.id);
      await expect(t.db.update(workPayables).set({ status: "PENDING_REVIEW", approvedAt: null, approvedBy: null, approvedAmountMinor: null, approvedCurrencyCode: null }).where(eq(workPayables.id, payable.id))).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringMatching(/final/) }) });
      await expect(t.db.update(workPayables).set({ approvedAt: new Date(0) }).where(eq(workPayables.id, payable.id))).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringMatching(/final/) }) });
      for (const invalid of [{ amountMinor: 7_201 }, { currencyCode: "USD" }, { workerId: randomUUID() }, { status: "PAID" }, { outletId: randomUUID() }]) {
        await expect(t.db.insert(workPayouts).values({ ...reservation, ...invalid })).rejects.toThrow();
      }
      await t.db.insert(workPayouts).values(reservation);
      for (const change of [{ amountMinor: 1 }, { currencyCode: "USD" }, { senderBatchId: "OTHER" }, { senderItemId: "OTHER" }, { reservedAt: new Date(0) }, { recipient: "other@example.test" }, { status: "NOT_SENT", paypalBatchId: "B" },
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
        .mockImplementation(async (batchId: string) => ({ batchId, itemId: "PPI-7", status: "SUCCESS", batchStatus: "SUCCESS", itemStatus: "SUCCESS", transactionId: "PPT-7", itemAmount: { value: "78.00", currency: "GBP" } })) });
      vi.mocked(getDatabase).mockReturnValue(t.db);
      vi.mocked(getConfigurationStatus).mockReturnValue({ databaseConfigured: true, paypalPayoutConfigured: true } as ReturnType<typeof getConfigurationStatus>);
      vi.mocked(getPayPalPayoutClient).mockReturnValue(paypal as unknown as ReturnType<typeof getPayPalPayoutClient>);
      const render = async (scope: Scope, element: () => Promise<React.ReactNode>) => { vi.mocked(requireScope).mockResolvedValue(scope); return renderToStaticMarkup(await element()); };
      const act = async (scope: Scope, action: (f: FormData) => Promise<unknown>, values: Record<string, string>) => { vi.mocked(requireScope).mockResolvedValue(scope); vi.mocked(requireFinancialScope).mockResolvedValue(scope); await expect(action(form(values))).rejects.toThrow(/REDIRECT/); };
      const status = async () => (await t.db.select().from(workPayables).where(eq(workPayables.id, payable.id)))[0];

      let review = await render(manager, () => ManagerWorkspace({ area: "review" }));
      expect(review).toContain("Approve £78.00");
      expect(review).not.toContain("payout with PayPal");

      // A worker cannot reach the approval or payment actions.
      vi.mocked(requireFinancialScope).mockRejectedValueOnce(new Error("Access denied."));
      await expect(confirmWorkAction(form({ payableId: payable.id, confirmed: "yes" }))).rejects.toThrow("Access denied.");
      await act(workerScope, approvePayableAction, { payableId: payable.id });
      vi.mocked(requireFinancialScope).mockRejectedValueOnce(new Error("Access denied."));
      await expect(approvePayableAction(form({ payableId: payable.id }))).rejects.toThrow();
      expect((await status()).status).toBe("PENDING_REVIEW");

      await act(manager, approvePayableAction, { payableId: payable.id, amount: "1.00", approvedAmountMinor: "1", currency: "USD" });
      expect(await status()).toMatchObject({ status: "APPROVED", approvedAmountMinor: 7_800, approvedCurrencyCode: "GBP" });
      review = await render(manager, () => ManagerWorkspace({ area: "review" }));
      expect(review).toContain("Send £78.00 payout with PayPal");
      expect(review).not.toMatch(/>\s*Paid\s*</);

      // Approved, not sent: the worker sees approval, not payment.
      let earnings = await render(workerScope, () => WorkerWorkspace({ area: "earnings" }));
      expect(earnings).toContain("Approved");
      expect(earnings).not.toMatch(/>\s*Paid\s*</);

      await act(manager, sendPayoutAction, { payableId: payable.id, amount: "999.00", currency: "USD", recipient: "attacker@example.test" });
      expect(paypal.createPayout).toHaveBeenCalledTimes(1);
      expect(paypal.createPayout.mock.calls[0][0]).toMatchObject({ amount: "78.00", currency: "GBP", recipient: "casual.sandbox@example.test" });
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
      for (const text of [">Paid<", "PPI-7", "PPT-7", "PayPal Sandbox reference", "£78.00"]) expect(review).toContain(text);
      expect(review).not.toContain("casual.sandbox@example.test");

      // N: the worker sees their own paid status, without provider internals or other workers.
      earnings = await render(workerScope, () => WorkerWorkspace({ area: "earnings" }));
      for (const text of [">Paid<", "£78.00", "paid to your PayPal account", "Europe/London"]) expect(earnings).toContain(text);
      for (const hidden of ["PPI-7", "PPT-7", "PPB", "casual.sandbox@example.test", otherWorker.worker.displayName]) expect(earnings).not.toContain(hidden);
      expect(await render(workerScope, () => WorkerWorkspace({ area: "home" }))).toContain("£78.00 paid");
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

  it("explains a payout PayPal holds for the recipient, without calling it paid or exposing codes to the worker", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      const manager = c.scopes[0];
      const { payable, workerScope } = await confirmedPayable(t.db, manager);
      await approveWorkPayable(t.db, manager, payable.id);
      // As observed in Sandbox for a GBP payout to an account that does not hold GBP.
      const paypal = fakePayPal({ getPayout: vi.fn(async (batchId: string) => ({ batchId, itemId: "PPI-H", status: "ONHOLD", batchStatus: "PROCESSING", itemStatus: "ONHOLD", transactionId: "PPT-H", itemErrorCode: "PENDING_RECIPIENT_NON_HOLDING_CURRENCY_PAYMENT_PREFERENCE" })) });
      await submitWorkPayout(t.db, paypal, manager, payable.id);
      expect(await refreshWorkPayout(t.db, paypal, manager, payable.id)).toMatchObject({ status: "PROCESSING", paypalStatus: "ONHOLD", paidAt: null, lastError: { code: "PENDING_RECIPIENT_NON_HOLDING_CURRENCY_PAYMENT_PREFERENCE" } });
      vi.mocked(getDatabase).mockReturnValue(t.db);
      vi.mocked(getConfigurationStatus).mockReturnValue({ databaseConfigured: true, paypalPayoutConfigured: true } as ReturnType<typeof getConfigurationStatus>);
      vi.mocked(requireScope).mockResolvedValue(manager);
      const review = renderToStaticMarkup(await ManagerWorkspace({ area: "review" }));
      for (const text of ["Processing · on hold at PayPal", "accept the payment in their PayPal account", "PENDING_RECIPIENT_NON_HOLDING_CURRENCY_PAYMENT_PREFERENCE"]) expect(review).toContain(text);
      expect(review).not.toMatch(/>\s*Paid\s*</);
      vi.mocked(requireScope).mockResolvedValue(workerScope);
      const earnings = renderToStaticMarkup(await WorkerWorkspace({ area: "earnings" }));
      expect(earnings).toContain("check your PayPal account to accept it");
      expect(earnings).not.toContain("PENDING_RECIPIENT");
      expect(earnings).not.toMatch(/>\s*Paid\s*</);
      const home = renderToStaticMarkup(await WorkerWorkspace({ area: "home" }));
      expect(home).toContain("£78.00 sent to PayPal · processing");
      expect(home).not.toContain("£78.00 paid");
    } finally { await t.close(); }
  });

  it("shows a payout PayPal refused outright as refused and not paid, with PayPal's reason, never as sent", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      const manager = c.scopes[0];
      const { payable, workerScope } = await confirmedPayable(t.db, manager);
      await approveWorkPayable(t.db, manager, payable.id);
      // As observed in PayPal Sandbox for a ZAR payout (docs/evidence/paypal-currency-tests.md): HTTP 400, no batch.
      const refusal = new PayPalPayoutError("PayPal rejected the payout request.", "VALIDATION_ERROR", 400, "dbg-refused",
        [{ field: "items[0].amount.currency", issue: "Currency is not supported" }], "REJECTED");
      const paypal = fakePayPal({ createPayout: vi.fn(async () => { throw refusal; }) });
      const { payout } = await submitWorkPayout(t.db, paypal, manager, payable.id);
      expect(payout).toMatchObject({ status: "FAILED", paypalBatchId: null, paidAt: null,
        lastError: { code: "VALIDATION_ERROR", httpStatus: 400, outcome: "REJECTED", reason: "Currency is not supported" } });
      expect((await submitWorkPayout(t.db, paypal, manager, payable.id)).submitted).toBe(false);
      expect(paypal.createPayout).toHaveBeenCalledTimes(1);

      vi.mocked(getDatabase).mockReturnValue(t.db);
      vi.mocked(getConfigurationStatus).mockReturnValue({ databaseConfigured: true, paypalPayoutConfigured: true } as ReturnType<typeof getConfigurationStatus>);
      vi.mocked(requireScope).mockResolvedValue(manager);
      const review = renderToStaticMarkup(await ManagerWorkspace({ area: "review" }));
      for (const text of ["Refused by PayPal: Currency is not supported", "Refused by PayPal: Currency is not supported. Nothing has been paid.", "PayPal refused this payout request, so no payment was created.", "None created"]) expect(review).toContain(text);
      expect(review).not.toContain("<dt>PayPal status</dt><dd>Unknown</dd>");
      // "Sent to PayPal" is not ticked: the refusal is the problem step and nothing later is reached.
      expect(review).not.toContain(">Sent to PayPal<");
      expect(review).toContain('data-state="problem" aria-current="step">Refused by PayPal<');
      expect(review).not.toMatch(/>\s*Paid\s*</);

      vi.mocked(requireScope).mockResolvedValue(workerScope);
      const earnings = renderToStaticMarkup(await WorkerWorkspace({ area: "earnings" }));
      for (const text of [">Not paid<", "Refused by PayPal: Currency is not supported. Nothing has been paid.", "nothing has reached your PayPal account"]) expect(earnings).toContain(text);
      for (const hidden of ["VALIDATION_ERROR", "dbg-refused", "items[0]", ">Sent to PayPal<"]) expect(earnings).not.toContain(hidden);
      expect(earnings).not.toMatch(/>\s*Paid\s*</);
      // The worker's data carries only the derived refusal reason, no error internals.
      const view = JSON.stringify((await getWorkerWorkspace(t.db, workerScope)).assignments);
      expect(view).toContain('"refusal":{"reason":"Currency is not supported"}');
      expect(view).not.toMatch(/lastError|VALIDATION_ERROR|dbg-refused|httpStatus|refusalSource/);

      // The manager's card badge and the Owner's payments view agree with the worker: not paid, PayPal's reason.
      expect(review).toContain(">Not paid<");
      const owner: Scope = { ...manager, userId: await user(t.db), role: "OWNER" };
      await t.db.insert((await import("@/server/db/schema")).memberships).values({ id: randomUUID(), userId: owner.userId, organisationId: c.organisationId, role: "OWNER" });
      vi.mocked(requireScope).mockResolvedValue(owner);
      const payments = renderToStaticMarkup(await OwnerWorkspace({ area: "payments" }));
      for (const text of [">Not paid<", "Refused by PayPal: Currency is not supported"]) expect(payments).toContain(text);
      for (const hidden of ["Needs attention", "VALIDATION_ERROR", "dbg-refused"]) expect(payments).not.toContain(hidden);
      expect(payments).not.toMatch(/>\s*Paid\s*</);
    } finally { await t.close(); }
  });

  it("keeps a payout PayPal accepted and later failed as sent, without a refusal", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      const manager = c.scopes[0];
      const { payable, workerScope } = await confirmedPayable(t.db, manager);
      await approveWorkPayable(t.db, manager, payable.id);
      const paypal = fakePayPal({ getPayout: vi.fn(async (batchId: string) => ({ batchId, itemId: "PPI-F", status: "FAILED", batchStatus: "SUCCESS", itemStatus: "FAILED", transactionId: null })) });
      await submitWorkPayout(t.db, paypal, manager, payable.id);
      expect(await refreshWorkPayout(t.db, paypal, manager, payable.id)).toMatchObject({ status: "FAILED", paidAt: null });
      vi.mocked(getDatabase).mockReturnValue(t.db);
      vi.mocked(getConfigurationStatus).mockReturnValue({ databaseConfigured: true, paypalPayoutConfigured: true } as ReturnType<typeof getConfigurationStatus>);
      vi.mocked(requireScope).mockResolvedValue(manager);
      const review = renderToStaticMarkup(await ManagerWorkspace({ area: "review" }));
      expect(review).toContain('data-state="done">Sent to PayPal<');
      expect(review).toContain("PayPal did not complete this payment. Nothing has been paid.");
      expect(review).not.toContain("Refused by PayPal");
      vi.mocked(requireScope).mockResolvedValue(workerScope);
      const earnings = renderToStaticMarkup(await WorkerWorkspace({ area: "earnings" }));
      expect(earnings).toContain("Your payment needs attention: ask your manager to review it.");
      expect(earnings).not.toContain("Refused by PayPal");
      expect(JSON.stringify((await getWorkerWorkspace(t.db, workerScope)).assignments)).toContain('"refusal":null');
      const owner: Scope = { ...manager, userId: await user(t.db), role: "OWNER" };
      await t.db.insert((await import("@/server/db/schema")).memberships).values({ id: randomUUID(), userId: owner.userId, organisationId: c.organisationId, role: "OWNER" });
      vi.mocked(requireScope).mockResolvedValue(owner);
      const payments = renderToStaticMarkup(await OwnerWorkspace({ area: "payments" }));
      expect(payments).toContain("Needs attention");
      expect(payments).not.toContain("Refused by PayPal");
    } finally { await t.close(); }
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


describe("uncertain no-batch recovery safety window", () => {
  const DAY = 24 * 60 * 60_000;
  const FIRST = new Date("2026-11-05T12:00:00Z");
  const timeout = () => new PayPalPayoutError("Response lost", "TIMEOUT", undefined, undefined, undefined, "UNKNOWN");
  beforeEach(() => { vi.useFakeTimers({ now: FIRST, toFake: ["Date"] }); });

  const boundaries = [
    { label: "one hour", age: 3_600_000, retry: true },
    { label: "27 days", age: 27 * DAY, retry: true },
    { label: "one millisecond below 28 days", age: 28 * DAY - 1, retry: true },
    { label: "exactly 28 days", age: 28 * DAY, retry: false },
    { label: "29 days", age: 29 * DAY, retry: false },
    { label: "30 days", age: 30 * DAY, retry: false },
    { label: "90 days", age: 90 * DAY, retry: false },
  ];
  for (const state of ["RECONCILIATION_REQUIRED", "SUBMITTING"]) {
    it.each(boundaries)(`${state}: enforces the recovery cutoff at $label after subscription cancellation`, async ({ age, retry }) => {
      const t = await createTestDatabase();
      try {
        const c = await company(t.db), manager = c.scopes[0];
        const { payable, workerScope } = await confirmedPayable(t.db, manager);
        await approveWorkPayable(t.db, manager, payable.id);
        const paypal = fakePayPal({ createPayout: vi.fn().mockRejectedValue(timeout()) });
        const first = await submitWorkPayout(t.db, paypal, manager, payable.id);
        expect(first.payout).toMatchObject({ reservedAt: FIRST, submittedAt: null, paypalBatchId: null, paidAt: null });
        // Emulate an interrupted recovery after the original response was lost.
        if (state === "SUBMITTING") await t.db.update(workPayouts).set({ status: state }).where(eq(workPayouts.id, first.payout.id));
        await savePayoutDestination(t.db, workerScope, "changed@example.test");
        await subscriptionStatus(t.db, c.organisationId, "CANCELLED");
        vi.setSystemTime(new Date(FIRST.getTime() + age));
        const [before] = await payoutsOf(t.db);
        const auditBefore = await t.db.select().from(auditEvents);
        if (retry) {
          const recovered = await refreshWorkPayout(t.db, paypal, manager, payable.id);
          expect(recovered).toMatchObject({ status: "RECONCILIATION_REQUIRED", reservedAt: FIRST, submittedAt: null, attempts: 2, paidAt: null });
          expect(paypal.createPayout.mock.calls[1][0]).toEqual(paypal.createPayout.mock.calls[0][0]);
          expect(paypal.createPayout.mock.calls[1][0]).toMatchObject({ ...payoutSenderIds(payable.id), amount: "78.00", currency: "GBP", recipient: "casual.sandbox@example.test" });
          // Repeated uncertainty must never restart the original safety window.
          vi.setSystemTime(new Date(FIRST.getTime() + 28 * DAY));
          await expect(refreshWorkPayout(t.db, paypal, manager, payable.id)).rejects.toMatchObject({ feedback: "payout-investigation-required" });
        } else {
          for (let check = 0; check < 2; check++) await expect(refreshWorkPayout(t.db, paypal, manager, payable.id)).rejects.toMatchObject({ feedback: "payout-investigation-required" });
          expect((await payoutsOf(t.db))[0]).toEqual(before);
          // Each refused check is recorded as the Manager's request, and nothing else is written.
          const added = (await t.db.select().from(auditEvents).orderBy(asc(auditEvents.createdAt))).filter(row => !auditBefore.some(old => old.id === row.id));
          expect(added.map(row => [row.action, (row.metadata as { outcome?: string }).outcome])).toEqual([
            ["PAYOUT_STATUS_CHECK_REQUESTED", "REFUSED:payout-investigation-required"], ["PAYOUT_STATUS_CHECK_REQUESTED", "REFUSED:payout-investigation-required"],
          ]);
        }
        expect((await submitWorkPayout(t.db, paypal, manager, payable.id)).submitted).toBe(false);
        expect(paypal.createPayout).toHaveBeenCalledTimes(retry ? 2 : 1);
        expect(paypal.getPayout).not.toHaveBeenCalled();
        expect(await payoutsOf(t.db)).toHaveLength(1);
        expect((await t.db.select().from(workPayables))[0]).toMatchObject({ status: "APPROVED", approvedAmountMinor: 7_800, approvedCurrencyCode: "GBP" });
      } finally { await t.close(); }
    });
  }

  it("does not extend the original reservation time after a delayed NOT_SENT retry", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db), manager = c.scopes[0];
      const { payable } = await confirmedPayable(t.db, manager);
      await approveWorkPayable(t.db, manager, payable.id);
      const paypal = fakePayPal({ createPayout: vi.fn()
        .mockRejectedValueOnce(new PayPalPayoutError("No request", "AUTHENTICATION_FAILURE", 401, undefined, undefined, "NOT_SENT"))
        .mockRejectedValue(timeout()) });
      await submitWorkPayout(t.db, paypal, manager, payable.id);
      vi.setSystemTime(new Date(FIRST.getTime() + 27 * DAY));
      expect((await submitWorkPayout(t.db, paypal, manager, payable.id)).payout).toMatchObject({ status: "RECONCILIATION_REQUIRED", reservedAt: FIRST, submittedAt: null, attempts: 2 });
      vi.setSystemTime(new Date(FIRST.getTime() + 28 * DAY));
      await expect(refreshWorkPayout(t.db, paypal, manager, payable.id)).rejects.toMatchObject({ feedback: "payout-investigation-required" });
      expect(paypal.createPayout).toHaveBeenCalledTimes(2);
      expect(paypal.createPayout.mock.calls[1][0]).toEqual(paypal.createPayout.mock.calls[0][0]);
    } finally { await t.close(); }
  });

  it("preserves GET reconciliation of a 90-day-old known batch", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db), manager = c.scopes[0];
      const { payable } = await confirmedPayable(t.db, manager);
      await approveWorkPayable(t.db, manager, payable.id);
      const paypal = fakePayPal();
      const first = await submitWorkPayout(t.db, paypal, manager, payable.id);
      vi.setSystemTime(new Date(FIRST.getTime() + 90 * DAY));
      await subscriptionStatus(t.db, c.organisationId, "EXPIRED");
      expect(await refreshWorkPayout(t.db, paypal, manager, payable.id)).toMatchObject({ status: "PAID", paypalStatus: "SUCCESS", amountMinor: 7_800, currencyCode: "GBP", reservedAt: FIRST });
      expect(paypal.getPayout).toHaveBeenCalledWith(first.payout.paypalBatchId, first.payout.senderItemId);
      expect(paypal.createPayout).toHaveBeenCalledTimes(1);
    } finally { await t.close(); }
  });

  it("claims only one concurrent no-batch recovery and keeps one immutable reservation", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db), manager = c.scopes[0];
      const { payable } = await confirmedPayable(t.db, manager);
      await approveWorkPayable(t.db, manager, payable.id);
      const paypal = fakePayPal({ createPayout: vi.fn().mockRejectedValueOnce(timeout()) });
      const first = await submitWorkPayout(t.db, paypal, manager, payable.id);
      vi.setSystemTime(new Date(FIRST.getTime() + 27 * DAY));
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      paypal.createPayout.mockImplementation(async () => { await gate; throw timeout(); });
      let completed = 0;
      let competitorsDone!: () => void;
      const competitors = new Promise<void>(resolve => { competitorsDone = resolve; });
      const recoveries = [1, 2, 3, 4].map(async () => {
        const result = await refreshWorkPayout(t.db, paypal, manager, payable.id);
        if (++completed === 3) competitorsDone();
        return result;
      });
      // Three losing callers finish while the claimed provider request is in flight.
      await competitors;
      expect(paypal.createPayout).toHaveBeenCalledTimes(2); // one initial create, one recovery
      release();
      await Promise.all(recoveries);
      expect(paypal.createPayout).toHaveBeenCalledTimes(2);
      expect(paypal.createPayout.mock.calls[1][0]).toEqual(paypal.createPayout.mock.calls[0][0]);
      expect(await payoutsOf(t.db)).toHaveLength(1);
      expect((await payoutsOf(t.db))[0]).toMatchObject({ id: first.payout.id, status: "RECONCILIATION_REQUIRED", attempts: 2, reservedAt: FIRST });
    } finally { await t.close(); }
  });

  it("returns investigation feedback through the existing settlement action", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db), manager = c.scopes[0];
      const { payable } = await confirmedPayable(t.db, manager);
      await approveWorkPayable(t.db, manager, payable.id);
      const paypal = fakePayPal({ createPayout: vi.fn().mockRejectedValue(timeout()) });
      await submitWorkPayout(t.db, paypal, manager, payable.id);
      vi.setSystemTime(new Date(FIRST.getTime() + 28 * DAY));
      vi.mocked(getDatabase).mockReturnValue(t.db);
      vi.mocked(requireFinancialScope).mockResolvedValue(manager);
      vi.mocked(getConfigurationStatus).mockReturnValue({ databaseConfigured: true, paypalPayoutConfigured: true } as ReturnType<typeof getConfigurationStatus>);
      vi.mocked(getPayPalPayoutClient).mockReturnValue(paypal as unknown as ReturnType<typeof getPayPalPayoutClient>);
      await expect(refreshPayoutAction(form({ payableId: payable.id }))).rejects.toThrow("REDIRECT:/settlements?status=payout-investigation-required");
      const html = renderToStaticMarkup(await ManagerWorkspace({ area: "review", status: "payout-investigation-required", financialScope: manager, financialOnly: true }));
      expect(html).toContain("Investigate the original payout with PayPal");
      expect(html).not.toContain("which PayPal pays at most once");
      expect(paypal.createPayout).toHaveBeenCalledTimes(1);
    } finally { await t.close(); }
  });
});

// DEC-SA-001 / DEC-SA-010: South African work is denominated in ZAR, and ZAR is not a verified
// PayPal payout currency for FairShift. Earnings are kept, never converted, relabelled or sent.
describe("South African operating currency and the provider payout-currency gate", () => {
  it("keeps preauthorised ZAR terms through acceptance, confirmation and approval, then refuses to send them", async () => {
    const t = await createTestDatabase();
    try {
      // Migrations seed a legacy demo; remove its empty rows from this test DB to
      // verify that the ordinary-tenant flow has no runtime dependency on them.
      await t.db.delete(paypalConnections).where(eq(paypalConnections.outletId, DEMO_OUTLET_ID));
      await t.db.delete(departments).where(eq(departments.outletId, DEMO_OUTLET_ID));
      await t.db.delete(outlets).where(eq(outlets.id, DEMO_OUTLET_ID));
      await t.db.delete(organisations).where(eq(organisations.id, DEMO_ORGANISATION_ID));
      const c = await company(t.db, 1, "South Africa");
      const manager = c.scopes[0];
      const { policy, shift, offer, worker } = await allocatedWork(t.db, manager);
      expect(policy).toMatchObject({ currencyCode: "ZAR", rateMinor: 3_900 });
      expect(shift).toMatchObject({ currencyCode: "ZAR", expectedEarningsMinor: 23_400 });
      expect((await t.db.select().from(workAcceptances))[0].snapshot).toMatchObject({ currencyCode: "ZAR", rateMinor: 3_900, expectedEarningsMinor: 23_400, acknowledged: true });
      // Only this independently created tenant exists: no seeded demo company is needed.
      expect(await t.db.select().from(organisations)).toHaveLength(1);
      const { payable } = await confirmWork(t.db, offer.id, manager);
      expect(payable).toMatchObject({ workerId: worker.id, currencyCode: "ZAR", baseAmountMinor: 23_400, status: "PENDING_REVIEW" });
      const approved = await approveWorkPayable(t.db, manager, payable!.id);
      expect(approved).toMatchObject({ status: "APPROVED", approvedAmountMinor: 23_400, approvedCurrencyCode: "ZAR" });

      const paypal = fakePayPal();
      // No approved ZAR→USD demo rate is configured (DEC-SA-012 leaves it unrecorded), so the
      // payout fails closed before any provider currency is chosen or any request is prepared.
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(submitWorkPayout(t.db, paypal, manager, payable!.id)).rejects.toMatchObject({ feedback: "provider-fx-rate-unavailable" });
      }
      expect(paypal.createPayout).not.toHaveBeenCalled();
      expect(await payoutsOf(t.db)).toHaveLength(0);
      expect(await t.db.select().from(auditEvents).where(eq(auditEvents.action, "PAYOUT_RESERVED"))).toHaveLength(0);
      // The obligation is preserved exactly as approved.
      expect((await t.db.select().from(workPayables))[0]).toMatchObject({ status: "APPROVED", approvedAmountMinor: 23_400, approvedCurrencyCode: "ZAR" });
      await expect(refreshWorkPayout(t.db, paypal, manager, payable!.id)).rejects.toThrow("No payout has been sent");

      // The Manager action reports the refusal truthfully rather than as an error or a payment.
      vi.mocked(getDatabase).mockReturnValue(t.db);
      vi.mocked(getConfigurationStatus).mockReturnValue({ databaseConfigured: true, paypalPayoutConfigured: true } as ReturnType<typeof getConfigurationStatus>);
      vi.mocked(requireFinancialScope).mockResolvedValue(manager);
      vi.mocked(getPayPalPayoutClient).mockReturnValue(paypal as unknown as ReturnType<typeof getPayPalPayoutClient>);
      await expect(sendPayoutAction(form({ payableId: payable!.id, amount: "1", currency: "USD" }))).rejects.toThrow("REDIRECT:/settlements?status=provider-fx-rate-unavailable");
      expect(getPayPalPayoutClient).not.toHaveBeenCalled();
      expect(paypal.createPayout).not.toHaveBeenCalled();
      expect(await payoutsOf(t.db)).toHaveLength(0);
    } finally { await t.close(); }
  });

  it("refuses a UK policy's currency at a South African location rather than relabelling it", async () => {
    const t = await createTestDatabase();
    try {
      const manager = (await company(t.db, 1, "South Africa")).scopes[0];
      const [department] = await createDepartment(t.db, "Floor", manager);
      const [policy] = await createWorkPolicy(t.db, { earningsModel: "HOURLY", rateMinor: 3_900 }, "Casual terms", manager);
      await t.db.update(workPolicies).set({ currencyCode: "GBP" }).where(eq(workPolicies.id, policy.id));
      await expect(createRequirement(t.db, { departmentId: department.id, policyId: policy.id, startsAt: at(0), endsAt: at(6), requiredHeadcount: 1 }, manager)).rejects.toMatchObject({ feedback: "policy-currency" });
    } finally { await t.close(); }
  });

  it.each([
    { currency: "GBP", countryOn: "organisation" },
    { currency: "USD", countryOn: "organisation" },
    { currency: "GBP", countryOn: "location" },
    { currency: "USD", countryOn: "location" },
  ])("refuses legacy $currency for an SA $countryOn before client creation or reservation", async ({ currency, countryOn }) => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db, 1, currency === "GBP" ? "United Kingdom" : "United States"), manager = c.scopes[0];
      const { payable } = await confirmedPayable(t.db, manager);
      await approveWorkPayable(t.db, manager, payable.id);
      // Persisted historical denomination is retained; it supplies no SA permission.
      expect(payable.currencyCode).toBe(currency);
      if (countryOn === "organisation") {
        await t.db.update(organisations).set({ country: " za " }).where(eq(organisations.id, c.organisationId));
        // An explicit UK work location must not authorise an unverified SA employer.
        await t.db.update(outlets).set({ country: "United Kingdom" }).where(eq(outlets.id, manager.locationId));
      } else {
        await t.db.update(outlets).set({ country: "South Africa" }).where(eq(outlets.id, manager.locationId));
      }
      const paypal = fakePayPal(), factory = vi.fn(() => paypal);
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(submitWorkPayout(t.db, factory, manager, payable.id)).rejects.toMatchObject({ feedback: "payout-route-unverified" });
      }
      expect(factory).not.toHaveBeenCalled();
      vi.mocked(getDatabase).mockReturnValue(t.db);
      vi.mocked(getConfigurationStatus).mockReturnValue({ databaseConfigured: true } as ReturnType<typeof getConfigurationStatus>);
      vi.mocked(requireFinancialScope).mockResolvedValue(manager);
      await expect(sendPayoutAction(form({ payableId: payable.id, currency: "ZAR" }))).rejects.toThrow("REDIRECT:/settlements?status=payout-route-unverified");
      expect(getPayPalPayoutClient).not.toHaveBeenCalled();
      expect(paypal.createPayout).not.toHaveBeenCalled();
      expect(await payoutsOf(t.db)).toHaveLength(0);
      expect(await t.db.select().from(auditEvents).where(eq(auditEvents.action, "PAYOUT_RESERVED"))).toHaveLength(0);
      expect((await t.db.select().from(workPayables))[0]).toMatchObject({ status: "APPROVED", approvedAmountMinor: 7_800, approvedCurrencyCode: currency });
    } finally { await t.close(); }
  });

  it.each(["ZAR", "USD"])("blocks no-batch recovery in %s for SA before client creation or changing the reservation", async currency => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db, 1, currency === "ZAR" ? "South Africa" : "United States"), manager = c.scopes[0];
      const { payable } = await confirmedPayable(t.db, manager);
      await approveWorkPayable(t.db, manager, payable.id);
      const [reservation] = await t.db.insert(workPayouts).values({
        id: randomUUID(), payableId: payable.id, organisationId: payable.organisationId, outletId: payable.outletId, workerId: payable.workerId,
        amountMinor: payable.baseAmountMinor, currencyCode: currency, providerCurrency: currency, providerAmountMinor: payable.baseAmountMinor, recipient: "casual.sandbox@example.test", ...payoutSenderIds(payable.id),
        status: "SUBMITTING", requestedBy: manager.userId, reservedAt: new Date(), updatedAt: new Date(),
      }).returning();
      const [held] = await t.db.update(workPayouts).set({ status: "RECONCILIATION_REQUIRED" }).where(eq(workPayouts.id, reservation.id)).returning();
      await t.db.update(organisations).set({ country: "South Africa" }).where(eq(organisations.id, c.organisationId));
      vi.mocked(getDatabase).mockReturnValue(t.db);
      vi.mocked(getConfigurationStatus).mockReturnValue({ databaseConfigured: true } as ReturnType<typeof getConfigurationStatus>);
      vi.mocked(requireFinancialScope).mockResolvedValue(manager);
      const feedback = currency === "ZAR" ? "payout-currency-unverified" : "payout-route-unverified";
      await expect(refreshPayoutAction(form({ payableId: payable.id }))).rejects.toThrow(`REDIRECT:/settlements?status=${feedback}`);
      expect(getPayPalPayoutClient).not.toHaveBeenCalled();
      expect((await payoutsOf(t.db))[0]).toEqual(held);
      expect(await t.db.select().from(auditEvents).where(eq(auditEvents.action, "PAYOUT_RECONCILIATION_REQUESTED"))).toHaveLength(0);
    } finally { await t.close(); }
  });

  it("retains known-batch GET reconciliation after an SA route becomes blocked", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db), manager = c.scopes[0];
      const { payable } = await confirmedPayable(t.db, manager);
      await approveWorkPayable(t.db, manager, payable.id);
      const paypal = fakePayPal(), factory = vi.fn(() => paypal);
      const first = await submitWorkPayout(t.db, factory, manager, payable.id);
      await t.db.update(organisations).set({ country: "South Africa" }).where(eq(organisations.id, c.organisationId));
      expect(await refreshWorkPayout(t.db, factory, manager, payable.id)).toMatchObject({ status: "PAID", currencyCode: "GBP", paypalStatus: "SUCCESS" });
      expect(paypal.getPayout).toHaveBeenCalledWith(first.payout.paypalBatchId, first.payout.senderItemId);
      expect(paypal.createPayout).toHaveBeenCalledTimes(1);
      expect(await submitWorkPayout(t.db, factory, manager, payable.id)).toMatchObject({ submitted: false });
      expect(factory).toHaveBeenCalledTimes(2); // First submission and known-batch read only.
    } finally { await t.close(); }
  });

  it("allows payouts only in currencies with recorded Sandbox payout evidence", () => {
    for (const code of ["GBP", "USD"]) expect(isVerifiedPayoutCurrency(code)).toBe(true);
    for (const code of ["ZAR", "EUR", "gbp", ""]) expect(isVerifiedPayoutCurrency(code)).toBe(false);
  });
});

it.each(["LIVE_CUSTOMER", "wrong tenant", "public demo"])("preserves an existing approved payable and payout on isolation refusal: %s", async boundary => {
  const t = await createTestDatabase();
  try {
    const c = await company(t.db), manager = c.scopes[0];
    const { payable } = await confirmedPayable(t.db, manager);
    await approveWorkPayable(t.db, manager, payable.id);
    const paypal = fakePayPal();
    await submitWorkPayout(t.db, paypal, manager, payable.id);
    paypal.createPayout.mockClear(); paypal.getPayout.mockClear();
    const snapshot = async () => Promise.all([t.db.select().from(workPayables), t.db.select().from(workPayouts)]);
    const before = await snapshot(), auditBefore = await t.db.select().from(auditEvents);
    let refused = manager;
    if (boundary === "LIVE_CUSTOMER") vi.stubEnv("FAIRSHIFT_DEPLOYMENT_MODE", "LIVE_CUSTOMER");
    if (boundary === "wrong tenant") refused = { ...manager, organisationId: randomUUID() };
    if (boundary === "public demo") refused = { ...manager, demo: { persona: "MANAGER", group: "public" } };
    await expect(submitWorkPayout(t.db, paypal, refused, payable.id)).rejects.toMatchObject({ code: "SANDBOX_ISOLATION_REQUIRED" });
    await expect(refreshWorkPayout(t.db, paypal, refused, payable.id)).rejects.toMatchObject({ code: "SANDBOX_ISOLATION_REQUIRED" });
    expect(paypal.createPayout).not.toHaveBeenCalled(); expect(paypal.getPayout).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
    // Each refused request is recorded, and nothing else is written. A scope naming an organisation that
    // isn't stored can't be recorded against it; the refusal stands all the same.
    const added = (await t.db.select().from(auditEvents).orderBy(asc(auditEvents.createdAt))).filter(row => !auditBefore.some(old => old.id === row.id));
    const session = boundary === "public demo" ? "PUBLIC_DEMO" : "SIGNED_IN";
    expect(added.map(row => [row.action, (row.metadata as { outcome?: string }).outcome, (row.metadata as { sessionType?: string }).sessionType])).toEqual(boundary === "wrong tenant" ? [] : [
      ["PAYOUT_SEND_REQUESTED", "REFUSED:sandbox-isolation-required", session], ["PAYOUT_STATUS_CHECK_REQUESTED", "REFUSED:sandbox-isolation-required", session],
    ]);
  } finally { await t.close(); }
});

describe("South African ZAR→USD Sandbox provider currency (DEC-SA-012)", () => {
  // Rates come from recorded ECB-shaped test quotes (tests/helpers/fx.ts): R18.54 = 1 USD unless
  // stated. Never a published ECB rate; they only exercise the conversion.
  async function saApproved(db: Db) {
    const c = await company(db, 1, "South Africa");
    const manager = c.scopes[0];
    const { payable, workerScope } = await confirmedPayable(db, manager);
    await approveWorkPayable(db, manager, payable.id);
    return { manager, payable, workerScope };
  }

  it("fails closed and sends nothing when no fresh ECB reference rate is recorded", async () => {
    const t = await createTestDatabase();
    try {
      const { manager, payable } = await saApproved(t.db);
      const paypal = fakePayPal();
      // The ZAR entitlement cannot be prepared for a provider payout without a fresh reference rate.
      await expect(submitWorkPayout(t.db, paypal, manager, payable.id)).rejects.toBeInstanceOf(ProviderCurrencyRateUnavailableError);
      expect(paypal.createPayout).not.toHaveBeenCalled();
      expect(await payoutsOf(t.db)).toHaveLength(0);
      // The approved ZAR payable is untouched and simply stays recorded and unpaid.
      expect((await t.db.select().from(workPayables))[0]).toMatchObject({ status: "APPROVED", approvedAmountMinor: 23_400, approvedCurrencyCode: "ZAR" });
    } finally { await t.close(); }
  });

  it("freezes the converted USD provider leg on the reservation and sends USD to PayPal", async () => {
    const t = await createTestDatabase();
    try {
      const { manager, payable, workerScope } = await saApproved(t.db);
      const rate = await seedTestFxRate(t.db);
      const paypal = fakePayPal();
      const { payout, submitted } = await submitWorkPayout(t.db, paypal, manager, payable.id);
      expect(submitted).toBe(true);
      // Entitlement stays ZAR; the provider leg is R234.00 floored to $12.62, frozen with its rate.
      expect(payout).toMatchObject({ currencyCode: "ZAR", amountMinor: 23_400, providerCurrency: "USD", providerAmountMinor: 1_262, fxRateMicros: 18_540_000, fxRateSource: `ECB_EUROFXREF_DAILY:${rate.rateDate}`, status: "PROCESSING", paidAt: null });
      expect(paypal.createPayout).toHaveBeenCalledTimes(1);
      expect(paypal.createPayout).toHaveBeenCalledWith(expect.objectContaining({ amount: "12.62", currency: "USD" }));
      // The worker sees the deterministic breakdown: ZAR earned, USD sent, the rate and its source.
      const workspace = await getWorkerWorkspace(t.db, workerScope);
      const seen = workspace.assignments.find(row => row.payout?.id === payout.id)?.payout;
      expect(seen).toMatchObject({ amountMinor: 23_400, currencyCode: "ZAR", providerCurrency: "USD", providerAmountMinor: 1_262, fxRateMicros: 18_540_000, fxRateSource: `ECB_EUROFXREF_DAILY:${rate.rateDate}` });
      expect(seen?.status).not.toBe("PAID"); // no fabricated success before a genuine provider SUCCESS
    } finally { await t.close(); }
  });

  it("never re-converts: a later rate change cannot alter the reservation or a resend", async () => {
    const t = await createTestDatabase();
    try {
      const { manager, payable } = await saApproved(t.db);
      await seedTestFxRate(t.db, undefined, 1);
      const notSent = new PayPalPayoutError("No request reached PayPal.", "NETWORK_ERROR", undefined, undefined, undefined, "NOT_SENT");
      const createPayout = vi.fn().mockRejectedValueOnce(notSent).mockImplementation(async (input: { senderBatchId: string }) => pending(input));
      const paypal = fakePayPal({ createPayout });
      const first = await submitWorkPayout(t.db, paypal, manager, payable.id);
      expect(first.payout.status).toBe("NOT_SENT");
      // A newer reference rate is recorded before the resend; the frozen reservation must ignore it.
      await seedTestFxRate(t.db, TEST_QUOTE_1850); // a re-conversion would give a different amount
      const second = await submitWorkPayout(t.db, paypal, manager, payable.id);
      expect(second.submitted).toBe(true);
      expect(second.payout).toMatchObject({ providerAmountMinor: 1_262, providerCurrency: "USD", fxRateMicros: 18_540_000 });
      expect(createPayout).toHaveBeenLastCalledWith(expect.objectContaining({ amount: "12.62", currency: "USD" }));
      // The frozen provider facts cannot be mutated directly either.
      await expect(t.db.update(workPayouts).set({ providerAmountMinor: 780, fxRateMicros: 10_000_000 }).where(eq(workPayouts.id, second.payout.id)))
        .rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringMatching(/immutable/) }) });
    } finally { await t.close(); }
  });

  it("reserves at most one payout per payable and refuses a different tenant without side effects", async () => {
    const t = await createTestDatabase();
    try {
      const { manager, payable } = await saApproved(t.db);
      await seedTestFxRate(t.db);
      const paypal = fakePayPal();
      await submitWorkPayout(t.db, paypal, manager, payable.id);
      // A repeat does not create a second payout or call PayPal again.
      expect((await submitWorkPayout(t.db, paypal, manager, payable.id)).submitted).toBe(false);
      expect(await payoutsOf(t.db)).toHaveLength(1);
      expect(paypal.createPayout).toHaveBeenCalledTimes(1);
      // A different organisation cannot reach the isolated demo route, and changes nothing.
      const before = await payoutsOf(t.db);
      await expect(submitWorkPayout(t.db, paypal, { ...manager, organisationId: randomUUID() }, payable.id)).rejects.toMatchObject({ code: "SANDBOX_ISOLATION_REQUIRED" });
      expect(await payoutsOf(t.db)).toEqual(before);
    } finally { await t.close(); }
  });

  it("leaves GBP payouts unconverted (identity provider leg) even with a rate configured", async () => {
    const t = await createTestDatabase();
    try {
      await seedTestFxRate(t.db); // recorded, but a GBP entitlement is not converted
      const c = await company(t.db); // United Kingdom / GBP
      const manager = c.scopes[0];
      const { payable } = await confirmedPayable(t.db, manager);
      await approveWorkPayable(t.db, manager, payable.id);
      const paypal = fakePayPal();
      const { payout } = await submitWorkPayout(t.db, paypal, manager, payable.id);
      expect(payout).toMatchObject({ currencyCode: "GBP", amountMinor: 7_800, providerCurrency: "GBP", providerAmountMinor: 7_800, fxRateMicros: null, fxRateSource: null });
      expect(paypal.createPayout).toHaveBeenCalledWith(expect.objectContaining({ amount: "78.00", currency: "GBP" }));
    } finally { await t.close(); }
  });
});
