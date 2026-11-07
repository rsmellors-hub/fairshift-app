import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { workPayouts } from "@/server/db/schema";
import { PayPalPayoutClient, payoutNegativeTestNote } from "@/server/integrations/paypal/payout-client";
import { payoutPlainReason } from "@/server/payments/payout-reasons";
import { approveWorkPayable, RATE_LIMIT_BACKOFF_MS, refreshWorkPayout, submitWorkPayout } from "@/server/payments/work-payouts";
import { createTestDatabase } from "../helpers/database";
import { confirmedWork, payAgentCompany } from "../helpers/pay-agent";
import { sandboxFixture } from "../helpers/sandbox";

// PayPal Payouts Sandbox negative-test values (developer.paypal.com/api/payouts/v5/standard/test-go-live/)
// replayed through FairShift's real payout engine and PayPal client over a fake transport: no network.
// PayPal documents each code's error name, not its HTTP status, so business failures are checked at
// more than one 4xx status. None may end PAID, and none may create a second payout.
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

const CONFIG = { PAYPAL_CLIENT_ID: "test-client", PAYPAL_CLIENT_SECRET: "test-secret", apiBaseUrl: "https://api-m.sandbox.paypal.com" as const };
type Reply = { status: number; body: unknown };
const error = (status: number, name: string, extra: Record<string, unknown> = {}): Reply => ({ status, body: { name, message: "Sandbox negative test", debug_id: "dbg-test", ...extra } });

// A fake PayPal: OAuth always succeeds; create and GET answer from queues of replies.
function fakePayPal(creates: Reply[], gets: Reply[] = []) {
  const sent: Array<{ senderBatchId: string; note: string | undefined }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith("/v1/oauth2/token")) return Response.json({ access_token: "test-token", expires_in: 3600 });
    if (url.endsWith("/v1/payments/payouts") && init.method === "POST") {
      const body = JSON.parse(String(init.body)) as { sender_batch_header: { sender_batch_id: string }; items: Array<{ note?: string }> };
      sent.push({ senderBatchId: body.sender_batch_header.sender_batch_id, note: body.items[0].note });
      const reply = creates.shift() ?? { status: 201, body: { batch_header: { payout_batch_id: "PPBNEW", batch_status: "PENDING" } } };
      if (reply.body === "__NON_JSON__") return new Response("<html>Gateway Timeout</html>", { status: reply.status });
      return Response.json(reply.body, { status: reply.status });
    }
    const reply = gets.shift() ?? { status: 404, body: { name: "RESOURCE_NOT_FOUND" } };
    return Response.json(reply.body, { status: reply.status });
  });
  return { client: new PayPalPayoutClient(CONFIG, fetchImpl as typeof fetch), sent, fetchImpl };
}

async function approved() {
  const t = await createTestDatabase();
  const company = await payAgentCompany(t.db);
  sandboxFixture(company.organisationId);
  const manager = company.scopes[0];
  const work = await confirmedWork(t.db, manager);
  await approveWorkPayable(t.db, manager, work.payable!.id);
  const payouts = () => t.db.select().from(workPayouts);
  return { t, manager, payableId: work.payable!.id, payouts };
}
vi.spyOn(console, "error").mockImplementation(() => {});

describe("create-payout test values", () => {
  it.each([
    ["ERRPYO001", "SENDER_RESTRICTED", 422],
    ["ERRPYO005", "INSUFFICIENT_FUNDS", 422], ["ERRPYO005", "INSUFFICIENT_FUNDS", 400],
    ["ERRPYO038", "NON_HOLDING_CURRENCY", 422], ["ERRPYO038", "NON_HOLDING_CURRENCY", 400],
  ])("%s %s (HTTP %i) is terminal: FAILED with a plain reason, never PAID, one payout", async (_code, name, status) => {
    const s = await approved();
    try {
      const paypal = fakePayPal([error(status, name)]);
      const { payout } = await submitWorkPayout(s.t.db, paypal.client, s.manager, s.payableId);
      expect(payout).toMatchObject({ status: "FAILED", paidAt: null, lastError: expect.objectContaining({ code: name, outcome: "REJECTED" }) });
      expect(payoutPlainReason(name)).toBeTruthy();
      // A repeat never sends a second payout.
      expect((await submitWorkPayout(s.t.db, paypal.client, s.manager, s.payableId)).submitted).toBe(false);
      expect(paypal.sent).toHaveLength(1);
      expect(await s.payouts()).toHaveLength(1);
    } finally { await s.t.close(); }
  });

  it.each([["ERRPYO003", "AUTHORIZATION_ERROR"], ["ERRPYO001", "SENDER_RESTRICTED"]])("%s %s (HTTP 403, as the Sandbox returns it) is refused before processing: NOT_SENT with a plain reason, resendable with the same IDs", async (_code, name) => {
    const s = await approved();
    try {
      const paypal = fakePayPal([error(403, name)]);
      const first = await submitWorkPayout(s.t.db, paypal.client, s.manager, s.payableId);
      expect(first.payout).toMatchObject({ status: "NOT_SENT", paidAt: null, lastError: expect.objectContaining({ code: name }) });
      expect(payoutPlainReason(name)).toBeTruthy();
      const second = await submitWorkPayout(s.t.db, paypal.client, s.manager, s.payableId);
      expect(second.payout.status).toBe("PROCESSING");
      expect(paypal.sent.map(call => call.senderBatchId)).toEqual([first.payout.senderBatchId, first.payout.senderBatchId]);
      expect(await s.payouts()).toHaveLength(1);
    } finally { await s.t.close(); }
  });

  it.each([
    ["ERRPYO006", "INTERNAL_ERROR", 500], ["ERRPYO036", "REQUEST_TIMEOUT_EXCEEDED", 408], ["ERRPYO036", "REQUEST_TIMEOUT_EXCEEDED", 504],
    ["ERRPYO039", "PREVIOUS_REQUEST_IN_PROGRESS", 400], ["ERRPYO039", "PREVIOUS_REQUEST_IN_PROGRESS", 409],
  ])("%s %s (HTTP %i) may have paid: RECONCILIATION_REQUIRED, and recovery reuses the same sender_batch_id", async (_code, name, status) => {
    const s = await approved();
    try {
      // After the identical resend PayPal accepts the batch, and its status is read straight away.
      const paypal = fakePayPal([error(status, name)], [{ status: 200, body: { batch_header: { payout_batch_id: "PPBNEW", batch_status: "PENDING" } } }]);
      const { payout } = await submitWorkPayout(s.t.db, paypal.client, s.manager, s.payableId);
      expect(payout).toMatchObject({ status: "RECONCILIATION_REQUIRED", paidAt: null, lastError: expect.objectContaining({ code: name, outcome: "UNKNOWN" }) });
      // A manager's send can't create a second payout; status recovery resends the identical request.
      expect((await submitWorkPayout(s.t.db, paypal.client, s.manager, s.payableId)).submitted).toBe(false);
      const recovered = await refreshWorkPayout(s.t.db, paypal.client, s.manager, s.payableId);
      expect(recovered.status).toBe("PROCESSING");
      expect(new Set(paypal.sent.map(call => call.senderBatchId))).toEqual(new Set([payout.senderBatchId]));
      expect(paypal.sent).toHaveLength(2);
      expect(await s.payouts()).toHaveLength(1);
    } finally { await s.t.close(); }
  });

  it("ERRPYO036 as the Sandbox returned it (HTTP 504, no error name) is reconciled, never failed or paid", async () => {
    const s = await approved();
    try {
      // A 504 with a non-JSON body, as the Sandbox returned it.
      const paypal = fakePayPal([{ status: 504, body: "__NON_JSON__" }]);
      const { payout } = await submitWorkPayout(s.t.db, paypal.client, s.manager, s.payableId);
      expect(payout).toMatchObject({ status: "RECONCILIATION_REQUIRED", paidAt: null, lastError: expect.objectContaining({ code: "MALFORMED_RESPONSE", outcome: "UNKNOWN" }) });
      expect(payoutPlainReason("MALFORMED_RESPONSE")).toMatch(/unconfirmed/);
      expect(await s.payouts()).toHaveLength(1);
    } finally { await s.t.close(); }
  });

  it.each([["ERRPYO035", "RATE_LIMIT_VALIDATION", 422], ["ERRPYO035", "RATE_LIMIT_VALIDATION", 429], ["429", "RATE_LIMIT_REACHED", 429]])("%s %s (HTTP %i) is retryable after a backoff, with the same IDs", async (_code, name, status) => {
    const s = await approved();
    try {
      const paypal = fakePayPal([error(status, name)]);
      const first = await submitWorkPayout(s.t.db, paypal.client, s.manager, s.payableId);
      expect(first.payout).toMatchObject({ status: "NOT_SENT", lastError: expect.objectContaining({ code: name }) });
      await expect(submitWorkPayout(s.t.db, paypal.client, s.manager, s.payableId)).rejects.toMatchObject({ feedback: "payout-retry-later" });
      expect(paypal.sent).toHaveLength(1);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + RATE_LIMIT_BACKOFF_MS + 1_000);
      const retried = await submitWorkPayout(s.t.db, paypal.client, s.manager, s.payableId);
      expect(retried.payout.status).toBe("PROCESSING");
      expect(paypal.sent.map(call => call.senderBatchId)).toEqual([first.payout.senderBatchId, first.payout.senderBatchId]);
      expect(await s.payouts()).toHaveLength(1);
    } finally { await s.t.close(); }
  });

  it("DUPLICATE_ITEM on create never produces two payouts: the original is adopted, or the payout is reconciled", async () => {
    const linked = await approved();
    try {
      const paypal = fakePayPal([error(400, "DUPLICATE_ITEM", { links: [{ href: "https://api-m.sandbox.paypal.com/v1/payments/payouts/PPBORIGINAL" }] })]);
      const { payout } = await submitWorkPayout(linked.t.db, paypal.client, linked.manager, linked.payableId);
      expect(payout).toMatchObject({ status: "PROCESSING", paypalBatchId: "PPBORIGINAL", paidAt: null });
      expect(await linked.payouts()).toHaveLength(1);
    } finally { await linked.t.close(); }
    const unlinked = await approved();
    try {
      const paypal = fakePayPal([error(400, "DUPLICATE_ITEM")]);
      const { payout } = await submitWorkPayout(unlinked.t.db, paypal.client, unlinked.manager, unlinked.payableId);
      expect(payout).toMatchObject({ status: "RECONCILIATION_REQUIRED", paidAt: null });
      expect((await submitWorkPayout(unlinked.t.db, paypal.client, unlinked.manager, unlinked.payableId)).submitted).toBe(false);
      expect(await unlinked.payouts()).toHaveLength(1);
    } finally { await unlinked.t.close(); }
  });
});

describe("status (GET) test values through reconciliation", () => {
  async function sent() {
    const s = await approved();
    const accepted = fakePayPal([{ status: 201, body: { batch_header: { payout_batch_id: "PPB1", batch_status: "PENDING" } } }]);
    const { payout } = await submitWorkPayout(s.t.db, accepted.client, s.manager, s.payableId);
    return { ...s, senderItemId: payout.senderItemId };
  }
  const item = (senderItemId: string, transactionStatus: string, name: string | null) => ({ status: 200, body: { batch_header: { payout_batch_id: "PPB1", batch_status: "SUCCESS" },
    items: [{ payout_item_id: "PPI1", transaction_status: transactionStatus, payout_item: { sender_item_id: senderItemId, amount: { value: "78.00", currency: "GBP" } }, ...(name ? { errors: { name } } : {}) }] } });

  it("ERRPYO018 DUPLICATE_ITEM on the status read leaves the recorded status unchanged and unpaid", async () => {
    const s = await sent();
    try {
      const paypal = fakePayPal([], [error(400, "DUPLICATE_ITEM")]);
      await expect(refreshWorkPayout(s.t.db, paypal.client, s.manager, s.payableId)).rejects.toThrow(/status could not be retrieved/);
      expect((await s.payouts())[0]).toMatchObject({ status: "PROCESSING", paidAt: null, lastError: expect.objectContaining({ code: "DUPLICATE_ITEM" }) });
      expect(paypal.sent).toHaveLength(0);
    } finally { await s.t.close(); }
  });

  it.each([
    // Item statuses as the Sandbox returned them for these test values on 7 Nov 2026.
    ["ERRPYO043", "CURRENCY_NOT_SUPPORTED_FOR_RECEIVER", "DENIED", "FAILED"], ["ERRPYO045", "RECEIVER_COUNTRY_NOT_ALLOWED", "FAILED", "FAILED"],
    ["ERRPYO049", "RECEIVING_LIMIT_EXCEEDED", "DENIED", "FAILED"], ["ERRPYO052", "RISK_DECLINE", "FAILED", "FAILED"], ["ERRPYO052", "RISK_DECLINE", "BLOCKED", "FAILED"],
    ["ERRPYO047", "RECEIVER_UNREGISTERED", "UNCLAIMED", "PROCESSING"],
  ])("%s %s (item %s) reconciles to %s with a plain reason, never PAID", async (_code, name, itemStatus, expected) => {
    const s = await sent();
    try {
      const sentBefore = fakePayPal([], [item(s.senderItemId, itemStatus, name)]);
      const updated = await refreshWorkPayout(s.t.db, sentBefore.client, s.manager, s.payableId);
      expect(updated).toMatchObject({ status: expected, paidAt: null, paypalStatus: itemStatus, lastError: { code: name } });
      expect(payoutPlainReason(name)).toBeTruthy();
      expect(sentBefore.sent).toHaveLength(0);
    } finally { await s.t.close(); }
  });
});

describe("Sandbox negative-test switch", () => {
  it("sets items[0].note to one test value only with the flag, outside production builds", async () => {
    expect(payoutNegativeTestNote({ NODE_ENV: "development", FAIRSHIFT_PAYPAL_NEGATIVE_TESTS: "enabled", FAIRSHIFT_PAYPAL_NEGATIVE_TEST_CODE: "ERRPYO005" })).toBe("ERRPYO005");
    expect(payoutNegativeTestNote({ NODE_ENV: "production", FAIRSHIFT_PAYPAL_NEGATIVE_TESTS: "enabled", FAIRSHIFT_PAYPAL_NEGATIVE_TEST_CODE: "ERRPYO005" })).toBeNull();
    expect(payoutNegativeTestNote({ NODE_ENV: "development", FAIRSHIFT_PAYPAL_NEGATIVE_TEST_CODE: "ERRPYO005" })).toBeNull();
    expect(payoutNegativeTestNote({ NODE_ENV: "development", FAIRSHIFT_PAYPAL_NEGATIVE_TESTS: "enabled", FAIRSHIFT_PAYPAL_NEGATIVE_TEST_CODE: "anything else" })).toBeNull();
    // Through the client: the note carries the code with the flag, and never in production.
    const s = await approved();
    try {
      vi.stubEnv("FAIRSHIFT_PAYPAL_NEGATIVE_TESTS", "enabled");
      vi.stubEnv("FAIRSHIFT_PAYPAL_NEGATIVE_TEST_CODE", "ERRPYO005");
      vi.stubEnv("NODE_ENV", "production");
      const prod = fakePayPal([]);
      await submitWorkPayout(s.t.db, prod.client, s.manager, s.payableId);
      expect(prod.sent[0].note).not.toBe("ERRPYO005");
    } finally { await s.t.close(); }
    const d = await approved();
    try {
      vi.stubEnv("FAIRSHIFT_PAYPAL_NEGATIVE_TESTS", "enabled");
      vi.stubEnv("FAIRSHIFT_PAYPAL_NEGATIVE_TEST_CODE", "ERRPYO005");
      vi.stubEnv("NODE_ENV", "development");
      const dev = fakePayPal([]);
      await submitWorkPayout(d.t.db, dev.client, d.manager, d.payableId);
      expect(dev.sent[0].note).toBe("ERRPYO005");
    } finally { await d.t.close(); }
  });
});

void eq;
