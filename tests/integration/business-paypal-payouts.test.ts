import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { sandboxFixture } from "../helpers/sandbox";
import { confirmedWork, payAgentCompany, testUser } from "../helpers/pay-agent";
import { auditEvents, workPayouts } from "@/server/db/schema";
import type { PayPalPayoutAdapter, PayoutResult } from "@/server/integrations/paypal/payout-client";
import { PAYPAL_SANDBOX_API_BASE_URL, PayPalPayoutClient } from "@/server/integrations/paypal/payout-client";
import { connectBusinessPayPal, payoutSenderMode, type PayoutCredentials, type TokenTest } from "@/server/payments/business-paypal";
import { approveWorkPayable, prepareWorkPayout, refreshWorkPayout, submitWorkPayout } from "@/server/payments/work-payouts";

// Per-business PayPal senders behind the deployment switch FAIRSHIFT_PAYOUT_SENDER (12 Nov 2026).
// Synthetic credentials and an in-process PayPal double; no network.
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const KEY = randomBytes(32).toString("base64");
const accepted: TokenTest = async () => ({ appId: "APP-BUSINESS0000000" });
type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];

// A PayPal double that remembers which credentials built each client.
function paypalDouble() {
  const built: PayoutCredentials[] = [];
  const client = {
    createPayout: vi.fn(async (input: { senderBatchId: string }): Promise<PayoutResult> => ({ batchId: `PPB${input.senderBatchId.slice(-8)}`, itemId: null, status: "PENDING", batchStatus: "PENDING", itemStatus: null, transactionId: null })),
    getPayout: vi.fn(async (batchId: string): Promise<PayoutResult> => ({ batchId, itemId: "PPI-1", status: "SUCCESS", batchStatus: "SUCCESS", itemStatus: "SUCCESS", transactionId: "PPT-1", itemAmount: { value: "78.00", currency: "GBP" } })),
  } as unknown as PayPalPayoutAdapter & { createPayout: ReturnType<typeof vi.fn>; getPayout: ReturnType<typeof vi.fn> };
  const factory = (credentials: PayoutCredentials) => { built.push(credentials); return client; };
  return { client, factory, built, kinds: () => built.map(c => c.kind === "BUSINESS" ? `BUSINESS:${c.senderEmail}` : "PLATFORM") };
}

async function business(db: Db) {
  const c = await payAgentCompany(db);
  sandboxFixture(c.organisationId);
  vi.stubEnv("FAIRSHIFT_CREDENTIALS_KEY", KEY);
  const manager = c.scopes[0];
  const owner = { organisationId: c.organisationId, userId: await testUser(db), role: "OWNER" };
  const approvedPayable = async () => {
    const { payable } = await confirmedWork(db, manager);
    await approveWorkPayable(db, manager, payable!.id);
    return payable!;
  };
  const connect = (secret: string, email: string) => connectBusinessPayPal(db, owner, { clientId: "BusinessClientId-0123456789", secret, senderEmail: email }, accepted);
  return { manager, approvedPayable, connect };
}

describe("payout sender switch", () => {
  it("defaults to the platform app and turns on only for the explicit value", () => {
    expect(payoutSenderMode({})).toBe("PLATFORM");
    expect(payoutSenderMode({ FAIRSHIFT_PAYOUT_SENDER: "platform" })).toBe("PLATFORM");
    expect(payoutSenderMode({ FAIRSHIFT_PAYOUT_SENDER: "yes" })).toBe("PLATFORM");
    expect(payoutSenderMode({ FAIRSHIFT_PAYOUT_SENDER: " Business " })).toBe("BUSINESS");
  });

  it("with per-business senders on and nothing connected, blocks the payout before any reservation and never uses the platform app", async () => {
    const t = await createTestDatabase();
    try {
      const b = await business(t.db);
      vi.stubEnv("FAIRSHIFT_PAYOUT_SENDER", "business");
      const payable = await b.approvedPayable();
      const paypal = paypalDouble();
      await expect(submitWorkPayout(t.db, paypal.factory, b.manager, payable.id)).rejects.toMatchObject({ feedback: "paypal-not-connected", message: "Connect your PayPal to pay your team." });
      // The Pay Agent's checks see the same refusal.
      await expect(prepareWorkPayout(t.db, b.manager, { workerId: payable.workerId, amountMinor: 7_800, currencyCode: "GBP" })).rejects.toMatchObject({ feedback: "paypal-not-connected" });
      expect(paypal.built).toHaveLength(0);
      expect(paypal.client.createPayout).not.toHaveBeenCalled();
      expect(await t.db.select().from(workPayouts)).toHaveLength(0);

      // Without the server key the connection can't be opened: still blocked.
      await b.connect("SYNTHETIC-business-secret-ABCD", "fs-test-cafe@business.example.com");
      vi.stubEnv("FAIRSHIFT_CREDENTIALS_KEY", "");
      await expect(submitWorkPayout(t.db, paypal.factory, b.manager, payable.id)).rejects.toMatchObject({ feedback: "paypal-not-connected" });
      expect(paypal.built).toHaveLength(0);
    } finally { await t.close(); }
  });

  it("sends from the business's own app, records the sender, and reads status with the same credentials", async () => {
    const t = await createTestDatabase();
    try {
      const b = await business(t.db);
      vi.stubEnv("FAIRSHIFT_PAYOUT_SENDER", "business");
      const connection = await b.connect("SYNTHETIC-business-secret-ABCD", "FS-Test-Cafe@business.example.com");
      const payable = await b.approvedPayable();
      const paypal = paypalDouble();

      expect((await submitWorkPayout(t.db, paypal.factory, b.manager, payable.id)).submitted).toBe(true);
      expect(paypal.built[0]).toEqual({ kind: "BUSINESS", connectionId: connection.id, clientId: "BusinessClientId-0123456789", secret: "SYNTHETIC-business-secret-ABCD", senderEmail: "fs-test-cafe@business.example.com" });
      const [payout] = await t.db.select().from(workPayouts);
      expect(payout).toMatchObject({ senderConnectionId: connection.id, senderEmail: "fs-test-cafe@business.example.com", status: "PROCESSING" });

      // A business payout is read with the business's credentials even after the deployment returns to the platform app.
      vi.stubEnv("FAIRSHIFT_PAYOUT_SENDER", "platform");
      expect(await refreshWorkPayout(t.db, paypal.factory, b.manager, payable.id)).toMatchObject({ status: "PAID", paypalStatus: "SUCCESS" });
      expect(paypal.kinds()).toEqual(["BUSINESS:fs-test-cafe@business.example.com", "BUSINESS:fs-test-cafe@business.example.com"]);

      const [reserved] = await t.db.select().from(auditEvents).where(eq(auditEvents.action, "PAYOUT_RESERVED"));
      expect(reserved.metadata).toMatchObject({ senderConnectionId: connection.id, senderEmail: "fs-test-cafe@business.example.com" });
      expect(JSON.stringify(await t.db.select().from(auditEvents))).not.toContain("SYNTHETIC-business-secret");
      expect(JSON.stringify(await t.db.select().from(workPayouts))).not.toContain("SYNTHETIC-business-secret");
    } finally { await t.close(); }
  });

  it("keeps reading a payout with the app it was sent from after the business replaces its connection", async () => {
    const t = await createTestDatabase();
    try {
      const b = await business(t.db);
      vi.stubEnv("FAIRSHIFT_PAYOUT_SENDER", "business");
      const first = await b.connect("SYNTHETIC-first-secret-1111", "first@business.example.com");
      const payable = await b.approvedPayable();
      const paypal = paypalDouble();
      await submitWorkPayout(t.db, paypal.factory, b.manager, payable.id);
      await b.connect("SYNTHETIC-second-secret-2222", "second@business.example.com");
      await refreshWorkPayout(t.db, paypal.factory, b.manager, payable.id);
      expect(paypal.built.map(c => c.kind === "BUSINESS" ? c.connectionId : null)).toEqual([first.id, first.id]);
    } finally { await t.close(); }
  });

  it("keeps reconciling a payout reserved under the platform app with the platform credentials after the switch", async () => {
    const t = await createTestDatabase();
    try {
      const b = await business(t.db);
      const payable = await b.approvedPayable();
      const paypal = paypalDouble();
      // Before the switch: platform sender, nothing recorded as a business sender.
      await submitWorkPayout(t.db, paypal.factory, b.manager, payable.id);
      const [payout] = await t.db.select().from(workPayouts);
      expect(payout).toMatchObject({ senderConnectionId: null, senderEmail: null });

      vi.stubEnv("FAIRSHIFT_PAYOUT_SENDER", "business");
      await b.connect("SYNTHETIC-business-secret-ABCD", "fs-test-cafe@business.example.com");
      expect(await refreshWorkPayout(t.db, paypal.factory, b.manager, payable.id)).toMatchObject({ status: "PAID" });
      expect(paypal.kinds()).toEqual(["PLATFORM", "PLATFORM"]);
      expect(paypal.client.createPayout).toHaveBeenCalledTimes(1);
    } finally { await t.close(); }
  });
});

describe("business payout client", () => {
  it("never sends a Sandbox negative-test note through a business's own app", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("FAIRSHIFT_PAYPAL_NEGATIVE_TESTS", "enabled");
    vi.stubEnv("FAIRSHIFT_PAYPAL_NEGATIVE_TEST_CODE", "ERRPYO002");
    const notes: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/v1/oauth2/token")) return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), { status: 200 });
      notes.push((JSON.parse(String(init?.body)) as { items: { note: string }[] }).items[0].note);
      return new Response(JSON.stringify({ batch_header: { payout_batch_id: "PPB1", batch_status: "PENDING" } }), { status: 201 });
    }) as typeof fetch;
    const config = { PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret", apiBaseUrl: PAYPAL_SANDBOX_API_BASE_URL } as const;
    const input = { senderBatchId: "B1", senderItemId: "I1", recipient: "worker@example.test", amount: "1.00", currency: "USD", note: "Manager-approved FairShift work earnings" };
    await new PayPalPayoutClient(config, fetchImpl, 10_000, false).createPayout(input);
    await new PayPalPayoutClient(config, fetchImpl).createPayout(input);
    expect(notes).toEqual(["Manager-approved FairShift work earnings", "ERRPYO002"]);
  });
});
