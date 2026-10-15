import { afterEach, describe, expect, it, vi } from "vitest";

import { getPayPalPayoutConfig } from "@/server/config/env";
import { PayPalPayoutClient, PayPalPayoutError } from "@/server/integrations/paypal/payout-client";

const config = {
  PAYPAL_CLIENT_ID: "test-client",
  PAYPAL_CLIENT_SECRET: "test-secret",
  apiBaseUrl: "https://api-m.sandbox.paypal.com" as const,
};
const token = { access_token: "test-access-token", expires_in: 3600 };
const payout = {
  batch_header: { payout_batch_id: "BATCH-1", batch_status: "PENDING" },
};
const payoutDetails = {
  batch_header: { payout_batch_id: "BATCH-1", batch_status: "PROCESSING" },
  items: [{
    payout_item_id: "ITEM-1",
    transaction_status: "PENDING",
    payout_item: { sender_item_id: "FS-ITEM-1" },
  }],
};

describe("PayPal Payouts REST client", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("obtains and reuses a server-side OAuth token, then creates a payout", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/v1/oauth2/token")) return Response.json(token);
      if (url.includes("?fields=items")) return Response.json(payoutDetails);
      return Response.json(payout, { status: 201 });
    });
    const client = new PayPalPayoutClient(config, fetchMock as typeof fetch);
    const input = { senderBatchId: "FS-BATCH-1", senderItemId: "FS-ITEM-1", recipient: "worker@example.test", amount: "25.00" };
    expect(await client.createPayout(input)).toEqual({ batchId: "BATCH-1", itemId: null, status: "PENDING" });
    expect(await client.getPayout("BATCH-1", "FS-ITEM-1")).toEqual({ batchId: "BATCH-1", itemId: "ITEM-1", status: "PENDING" });
    expect(calls.filter((call) => call.url.endsWith("/v1/oauth2/token"))).toHaveLength(1);
    expect(calls[0].init.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from("test-client:test-secret").toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    });
    const request = calls.find((call) => call.url.endsWith("/v1/payments/payouts"))!;
    expect(request.init.headers).toMatchObject({ Authorization: "Bearer test-access-token", "PayPal-Request-Id": "FS-BATCH-1" });
    expect(JSON.parse(String(request.init.body))).toMatchObject({
      sender_batch_header: { sender_batch_id: "FS-BATCH-1" },
      items: [{ sender_item_id: "FS-ITEM-1", amount: { value: "25.00", currency: "USD" } }],
    });
  });

  it("returns structured provider errors without exposing provider messages", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/v1/oauth2/token")
      ? Response.json(token)
      : Response.json({ name: "INSUFFICIENT_FUNDS", message: "sensitive provider detail" }, { status: 422 }));
    const client = new PayPalPayoutClient(config, fetchMock as typeof fetch);
    await expect(client.createPayout({ senderBatchId: "B1", senderItemId: "I1", recipient: "worker@example.test", amount: "1.00" }))
      .rejects.toMatchObject<Partial<PayPalPayoutError>>({ code: "INSUFFICIENT_FUNDS", status: 422 });
  });

  it("requires configured credentials and rejects a non-sandbox environment", () => {
    vi.stubEnv("PAYPAL_CLIENT_ID", "");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "");
    vi.stubEnv("PAYPAL_ENVIRONMENT", "sandbox");
    expect(() => getPayPalPayoutConfig()).toThrow();
    vi.stubEnv("PAYPAL_CLIENT_ID", "test-client");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "test-secret");
    vi.stubEnv("PAYPAL_ENVIRONMENT", "live");
    expect(() => getPayPalPayoutConfig()).toThrow();
  });
});
