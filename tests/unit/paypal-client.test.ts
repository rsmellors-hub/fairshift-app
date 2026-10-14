import { describe, expect, it, vi } from "vitest";

import type { PayPalConfig } from "@/server/config/env";
import { PayPalApiError, PayPalClient } from "@/server/integrations/paypal/client";

const config: PayPalConfig = {
  PAYPAL_ENV: "sandbox",
  PAYPAL_CLIENT_ID: "client-id",
  PAYPAL_CLIENT_SECRET: "client-secret",
  PAYPAL_WEBHOOK_ID: "webhook-id",
  APP_BASE_URL: "http://localhost:3000",
  PAYPAL_SANDBOX_CURRENCY: "USD",
  PAYPAL_SANDBOX_AMOUNT: "5.00",
  apiBaseUrl: "https://api-m.sandbox.paypal.com",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function tokenResponse() {
  return jsonResponse({ access_token: "server-token", expires_in: 3600, token_type: "Bearer" });
}

describe("PayPal client", () => {
  it("handles token failure without exposing credentials", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "invalid_client" }, 401));
    const client = new PayPalClient(config, fetchMock as typeof fetch);
    await expect(client.getCapture("CAPTURE1")).rejects.toMatchObject({
      code: "PAYPAL_HTTP_ERROR",
      status: 401,
    });
  });

  it("creates an order and returns the sandbox approval URL", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        jsonResponse({
          id: "ORDER123456",
          status: "CREATED",
          links: [{ href: "https://www.sandbox.paypal.com/approve", rel: "payer-action", method: "GET" }],
        }, 201),
      );
    const client = new PayPalClient(config, fetchMock as typeof fetch);
    await expect(
      client.createOrder({
        internalReference: "FS-1",
        outletReference: "outlet-1",
        currencyCode: "USD",
        amount: "5.00",
        returnUrl: "http://localhost:3000/checkout/return",
        cancelUrl: "http://localhost:3000/checkout/cancel",
      }),
    ).resolves.toMatchObject({ orderId: "ORDER123456", providerStatus: "CREATED" });
  });

  it("surfaces order and capture HTTP failures", async () => {
    const orderFetch = vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(jsonResponse({}, 422));
    await expect(
      new PayPalClient(config, orderFetch as typeof fetch).createOrder({
        internalReference: "FS-1",
        outletReference: "outlet-1",
        currencyCode: "USD",
        amount: "5.00",
        returnUrl: "http://localhost:3000/checkout/return",
        cancelUrl: "http://localhost:3000/checkout/cancel",
      }),
    ).rejects.toBeInstanceOf(PayPalApiError);

    const captureFetch = vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(jsonResponse({}, 422));
    await expect(
      new PayPalClient(config, captureFetch as typeof fetch).captureOrder("ORDER123456", "request-1"),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("captures an order and retrieves capture details", async () => {
    const capture = {
      id: "CAPTURE123456",
      status: "COMPLETED",
      amount: { currency_code: "USD", value: "5.00" },
      supplementary_data: { related_ids: { order_id: "ORDER123456" } },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        jsonResponse({
          id: "ORDER123456",
          status: "COMPLETED",
          purchase_units: [{ custom_id: "FS-1", payments: { captures: [capture] } }],
        }),
      )
      .mockResolvedValueOnce(jsonResponse(capture));
    const client = new PayPalClient(config, fetchMock as typeof fetch);
    await expect(client.captureOrder("ORDER123456", "request-1")).resolves.toMatchObject({
      customId: "FS-1",
      capture: { id: "CAPTURE123456" },
    });
    await expect(client.getCapture("CAPTURE123456")).resolves.toMatchObject({ status: "COMPLETED" });
  });

  it("rejects malformed provider responses", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(jsonResponse({ status: "COMPLETED" }));
    await expect(
      new PayPalClient(config, fetchMock as typeof fetch).getCapture("CAPTURE123456"),
    ).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  });

  it("maps network failures without leaking request data", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network unavailable");
    });
    await expect(
      new PayPalClient(config, fetchMock as typeof fetch).getCapture("CAPTURE123456"),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });

  it("classifies provider timeouts distinctly", async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException("request timed out", "TimeoutError");
    });
    await expect(
      new PayPalClient(config, fetchMock as typeof fetch).getCapture("CAPTURE123456"),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});
