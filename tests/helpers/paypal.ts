import type { PayPalAdapter } from "@/server/integrations/paypal/client";
import type { CaptureDetails } from "@/server/integrations/paypal/schemas";

export function createFakePayPalAdapter(overrides: Partial<PayPalAdapter> = {}): PayPalAdapter {
  const capture: CaptureDetails = {
    id: "CAPTURE123456",
    status: "COMPLETED",
    amount: { currency_code: "USD", value: "5.00" },
    create_time: "2026-10-14T10:00:00.000Z",
    update_time: "2026-10-14T10:00:01.000Z",
    supplementary_data: { related_ids: { order_id: "ORDER123456" } },
  };

  return {
    async createOrder() {
      return {
        orderId: "ORDER123456",
        providerStatus: "CREATED",
        approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER123456",
      };
    },
    async captureOrder() {
      return {
        orderId: "ORDER123456",
        providerStatus: "COMPLETED",
        customId: "FS-test",
        capture,
      };
    },
    async getCapture() {
      return capture;
    },
    async verifyWebhookSignature() {
      return true;
    },
    ...overrides,
  };
}

export function paypalHeaders() {
  return new Headers({
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
    "paypal-transmission-id": "transmission-1",
    "paypal-transmission-sig": "signature",
    "paypal-transmission-time": "2026-10-14T10:00:02.000Z",
  });
}

export function captureWebhook(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: "WH-EVENT-1",
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    create_time: "2026-10-14T10:00:02.000Z",
    resource: {
      id: "CAPTURE123456",
      status: "COMPLETED",
      amount: { currency_code: "USD", value: "5.00" },
      create_time: "2026-10-14T10:00:00.000Z",
      update_time: "2026-10-14T10:00:01.000Z",
      supplementary_data: { related_ids: { order_id: "ORDER123456" } },
    },
    ...overrides,
  });
}
