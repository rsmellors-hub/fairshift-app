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
    expect(await client.createPayout(input)).toMatchObject({ batchId: "BATCH-1", itemId: null, status: "PENDING", batchStatus: "PENDING", itemStatus: null });
    expect(await client.getPayout("BATCH-1", "FS-ITEM-1")).toMatchObject({ batchId: "BATCH-1", itemId: "ITEM-1", status: "PENDING", batchStatus: "PROCESSING", itemStatus: "PENDING" });
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

  it("sends the given currency and purpose unchanged, and keeps the incentive request in USD without a purpose", async () => {
    const bodies: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (String(input).endsWith("/v1/oauth2/token")) return Response.json(token);
      bodies.push(JSON.parse(String(init.body)));
      return Response.json(payout, { status: 201 });
    });
    const client = new PayPalPayoutClient(config, fetchMock as typeof fetch);
    await client.createPayout({ senderBatchId: "FSWP-B-1", senderItemId: "FSWP-I-1", recipient: "worker@example.test", amount: "72.00", currency: "GBP", purpose: "SERVICES", note: "Work earnings" });
    await client.createPayout({ senderBatchId: "FS-BATCH-2", senderItemId: "FS-ITEM-2", recipient: "worker@example.test", amount: "25.00" });
    expect(bodies[0]).toMatchObject({ items: [{ amount: { value: "72.00", currency: "GBP" }, purpose: "SERVICES", note: "Work earnings", receiver: "worker@example.test", sender_item_id: "FSWP-I-1" }] });
    expect(bodies[1]).toMatchObject({ items: [{ amount: { value: "25.00", currency: "USD" } }] });
    expect((bodies[1] as { items: object[] }).items[0]).not.toHaveProperty("purpose");
    await expect(client.createPayout({ senderBatchId: "B", senderItemId: "I", recipient: "worker@example.test", amount: "72", currency: "GBP" }))
      .rejects.toMatchObject({ code: "INVALID_PAYOUT_AMOUNT", outcome: "NOT_SENT" });
    await expect(client.createPayout({ senderBatchId: "B", senderItemId: "I", recipient: "worker@example.test", amount: "72.00", currency: "gbp" }))
      .rejects.toMatchObject({ outcome: "NOT_SENT" });
    expect(bodies).toHaveLength(2);
  });

  it("classifies whether a failed payout request can have created a payout", async () => {
    const create = (respond: () => Promise<Response> | Response, tokenResponse: () => Response = () => Response.json(token)) => new PayPalPayoutClient(config, vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith("/v1/oauth2/token") ? tokenResponse() : respond()) as typeof fetch)
      .createPayout({ senderBatchId: "B1", senderItemId: "I1", recipient: "worker@example.test", amount: "1.00", currency: "GBP" });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    // No token, no payout request.
    await expect(create(() => Response.json(payout), () => Response.json({ name: "invalid_client" }, { status: 401 }))).rejects.toMatchObject({ outcome: "NOT_SENT" });
    await expect(create(() => Response.json(payout), () => { throw new TypeError("fetch failed"); })).rejects.toMatchObject({ outcome: "NOT_SENT", code: "NETWORK_ERROR" });
    // Refused before processing.
    await expect(create(() => Response.json({ name: "AUTHENTICATION_FAILURE" }, { status: 401 }))).rejects.toMatchObject({ outcome: "NOT_SENT" });
    await expect(create(() => Response.json({ name: "RATE_LIMIT_REACHED" }, { status: 429 }))).rejects.toMatchObject({ outcome: "NOT_SENT" });
    // Refused by PayPal.
    await expect(create(() => Response.json({ name: "VALIDATION_ERROR", debug_id: "dbg-1", details: [{ field: "items[0].amount.currency", issue: "CURRENCY_NOT_SUPPORTED" }] }, { status: 400 })))
      .rejects.toMatchObject({ outcome: "REJECTED", code: "VALIDATION_ERROR", debugId: "dbg-1", status: 400 });
    // May have been processed.
    await expect(create(() => { throw new DOMException("timed out", "TimeoutError"); })).rejects.toMatchObject({ outcome: "UNKNOWN", code: "TIMEOUT" });
    await expect(create(() => { throw new TypeError("socket hang up"); })).rejects.toMatchObject({ outcome: "UNKNOWN", code: "NETWORK_ERROR" });
    await expect(create(() => Response.json({ name: "INTERNAL_SERVER_ERROR" }, { status: 500 }))).rejects.toMatchObject({ outcome: "UNKNOWN" });
    await expect(create(() => new Response("<html>", { status: 502 }))).rejects.toMatchObject({ outcome: "UNKNOWN" });
    await expect(create(() => new Response("not json", { status: 201 }))).rejects.toMatchObject({ outcome: "UNKNOWN" });
    await expect(create(() => Response.json({ unexpected: true }, { status: 201 }))).rejects.toMatchObject({ outcome: "UNKNOWN", code: "MALFORMED_RESPONSE" });
    // An earlier payout already holds this sender_batch_id.
    await expect(create(() => Response.json({ name: "USER_BUSINESS_ERROR", details: [{ field: "sender_batch_id", issue: "Batch with given sender_batch_id already exists" }], links: [{ href: "https://api-m.sandbox.paypal.com/v1/payments/payouts/ORIGBATCH1" }] }, { status: 400 })))
      .rejects.toMatchObject({ outcome: "DUPLICATE", originalBatchId: "ORIGBATCH1" });
  });

  it("reads the item's PayPal transaction and status, and never accepts a non-Sandbox host", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/v1/oauth2/token") ? Response.json(token) : Response.json({
      batch_header: { payout_batch_id: "BATCH-1", batch_status: "SUCCESS" },
      items: [{ payout_item_id: "ITEM-1", transaction_id: "TX-1", transaction_status: "SUCCESS", payout_item: { sender_item_id: "FSWP-I-1", amount: { value: "121.00", currency: "GBP" } } }],
    }));
    expect(await new PayPalPayoutClient(config, fetchMock as typeof fetch).getPayout("BATCH-1", "FSWP-I-1"))
      .toMatchObject({ batchId: "BATCH-1", itemId: "ITEM-1", transactionId: "TX-1", itemStatus: "SUCCESS", batchStatus: "SUCCESS", itemAmount: { value: "121.00", currency: "GBP" } });
    expect(() => new PayPalPayoutClient({ ...config, apiBaseUrl: "https://api-m.paypal.com" as never })).toThrow(/Sandbox/);
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
