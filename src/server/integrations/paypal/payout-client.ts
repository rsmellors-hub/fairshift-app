import { z } from "zod";

export class PayPalPayoutError extends Error {
  constructor(message: string, readonly code: string, readonly status?: number) {
    super(message);
    this.name = "PayPalPayoutError";
  }
}

export interface PayPalPayoutAdapter {
  createPayout(input: {
    senderBatchId: string;
    senderItemId: string;
    recipient: string;
    amount: string;
  }): Promise<{ batchId: string; itemId: string | null; status: string }>;
  getPayout(batchId: string, senderItemId: string): Promise<{
    batchId: string;
    itemId: string | null;
    status: string;
  }>;
}

const tokenSchema = z.object({ access_token: z.string().min(1), expires_in: z.number().positive() });
const batchHeaderSchema = z.object({
  payout_batch_id: z.string().min(1),
  batch_status: z.string().min(1),
});
const payoutResponseSchema = z.object({
  batch_header: batchHeaderSchema,
  items: z.array(z.object({
    payout_item_id: z.string().min(1).optional(),
    sender_item_id: z.string().optional(),
    transaction_status: z.string().optional(),
    payout_item: z.object({ sender_item_id: z.string().optional() }).optional(),
  })).optional(),
});

function findPayoutItem(items: z.infer<typeof payoutResponseSchema>["items"], senderItemId: string) {
  return items?.find((candidate) =>
    candidate.sender_item_id === senderItemId || candidate.payout_item?.sender_item_id === senderItemId,
  );
}

type PayoutConfig = {
  PAYPAL_CLIENT_ID: string;
  PAYPAL_CLIENT_SECRET: string;
  apiBaseUrl: "https://api-m.sandbox.paypal.com";
};

export class PayPalPayoutClient implements PayPalPayoutAdapter {
  private accessToken: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly config: PayoutConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  async createPayout(input: { senderBatchId: string; senderItemId: string; recipient: string; amount: string }) {
    const response = await this.authorizedRequest("/v1/payments/payouts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "PayPal-Request-Id": input.senderBatchId,
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        sender_batch_header: {
          sender_batch_id: input.senderBatchId,
          email_subject: "FairShift shift incentive",
          email_message: "A manager-approved FairShift shift incentive is available in your PayPal account.",
        },
        items: [{
          recipient_type: "EMAIL",
          amount: { value: input.amount, currency: "USD" },
          receiver: input.recipient,
          sender_item_id: input.senderItemId,
          note: "Manager-approved FairShift shift incentive",
        }],
      }),
    });
    const parsed = payoutResponseSchema.safeParse(response);
    if (!parsed.success) throw new PayPalPayoutError("Malformed PayPal payout response.", "MALFORMED_RESPONSE");
    const item = findPayoutItem(parsed.data.items, input.senderItemId);
    return {
      batchId: parsed.data.batch_header.payout_batch_id,
      itemId: item?.payout_item_id ?? null,
      status: item?.transaction_status ?? parsed.data.batch_header.batch_status,
    };
  }

  async getPayout(batchId: string, senderItemId: string) {
    const response = await this.authorizedRequest(`/v1/payments/payouts/${encodeURIComponent(batchId)}?fields=items`, { method: "GET" });
    const parsed = payoutResponseSchema.safeParse(response);
    if (!parsed.success) throw new PayPalPayoutError("Malformed PayPal payout status response.", "MALFORMED_RESPONSE");
    const item = findPayoutItem(parsed.data.items, senderItemId);
    return {
      batchId: parsed.data.batch_header.payout_batch_id,
      itemId: item?.payout_item_id ?? null,
      status: item?.transaction_status ?? parsed.data.batch_header.batch_status,
    };
  }

  private async authorizedRequest(path: string, init: RequestInit) {
    const accessToken = await this.getAccessToken();
    return this.request(path, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${accessToken}` },
    });
  }

  private async getAccessToken() {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 30_000) return this.accessToken.value;
    const basic = Buffer.from(`${this.config.PAYPAL_CLIENT_ID}:${this.config.PAYPAL_CLIENT_SECRET}`).toString("base64");
    const response = await this.request("/v1/oauth2/token", {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    const parsed = tokenSchema.safeParse(response);
    if (!parsed.success) throw new PayPalPayoutError("Malformed PayPal OAuth response.", "MALFORMED_TOKEN_RESPONSE");
    this.accessToken = { value: parsed.data.access_token, expiresAt: Date.now() + parsed.data.expires_in * 1000 };
    return this.accessToken.value;
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.apiBaseUrl}${path}`, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      const code = error instanceof DOMException && error.name === "TimeoutError" ? "TIMEOUT" : "NETWORK_ERROR";
      throw new PayPalPayoutError("PayPal request could not be completed.", code);
    }
    let data: unknown;
    try { data = await response.json(); } catch {
      throw new PayPalPayoutError("PayPal returned a non-JSON response.", "MALFORMED_RESPONSE", response.status);
    }
    if (!response.ok) {
      const error = z.object({ name: z.string().optional(), message: z.string().optional() }).safeParse(data);
      throw new PayPalPayoutError("PayPal rejected the payout request.", error.success ? error.data.name ?? "PAYPAL_HTTP_ERROR" : "PAYPAL_HTTP_ERROR", response.status);
    }
    return data;
  }
}
