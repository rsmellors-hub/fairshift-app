import { z } from "zod";

// Whether a payout request can have reached PayPal and created a payment:
// NOT_SENT  - PayPal certainly did not process a payout (no request, or refused before processing);
// REJECTED  - PayPal answered and refused this payout request;
// DUPLICATE - PayPal reports the sender_batch_id was already used, so an earlier payout exists;
// UNKNOWN   - the request may have been processed (timeout, network failure, 5xx, unreadable 2xx).
export type PayoutRequestOutcome = "NOT_SENT" | "REJECTED" | "DUPLICATE" | "UNKNOWN";

export class PayPalPayoutError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
    readonly debugId?: string,
    readonly details?: Array<{ field?: string; issue?: string; description?: string }>,
    readonly outcome: PayoutRequestOutcome = "UNKNOWN",
    readonly originalBatchId?: string,
  ) {
    super(message);
    this.name = "PayPalPayoutError";
  }
}

export type PayoutPurpose = "AWARDS" | "PRIZES" | "DONATIONS" | "GOODS" | "SERVICES" | "REBATES" | "CASHBACK" | "DISCOUNTS" | "NON_GOODS_OR_SERVICES";

export type CreatePayoutInput = {
  senderBatchId: string;
  senderItemId: string;
  recipient: string;
  amount: string;
  // ISO-4217 code of the approved amount. Sent as-is: no conversion happens here.
  currency?: string;
  purpose?: PayoutPurpose;
  emailSubject?: string;
  emailMessage?: string;
  note?: string;
};

// `status` is the item status when PayPal returned the item, else the batch status.
export type PayoutResult = {
  batchId: string;
  itemId: string | null;
  status: string;
  batchStatus?: string;
  itemStatus?: string | null;
  transactionId?: string | null;
  itemErrorCode?: string | null;
  // The amount PayPal holds on the item, exactly as PayPal returned it.
  itemAmount?: { value: string; currency: string } | null;
};

export interface PayPalPayoutAdapter {
  createPayout(input: CreatePayoutInput): Promise<PayoutResult>;
  getPayout(batchId: string, senderItemId: string): Promise<PayoutResult>;
}

export const PAYPAL_SANDBOX_API_BASE_URL = "https://api-m.sandbox.paypal.com";

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
    transaction_id: z.string().optional(),
    transaction_status: z.string().optional(),
    errors: z.object({ name: z.string().optional() }).optional(),
    payout_item: z.object({ sender_item_id: z.string().optional(), amount: z.object({ value: z.string(), currency: z.string() }).optional() }).optional(),
  })).optional(),
});
const errorSchema = z.object({
  name: z.string().optional(),
  message: z.string().optional(),
  debug_id: z.string().optional(),
  details: z.array(z.object({
    field: z.string().optional(),
    issue: z.string().optional(),
    description: z.string().optional(),
  })).optional(),
  links: z.array(z.object({ href: z.string().optional() })).optional(),
});

function findPayoutItem(items: z.infer<typeof payoutResponseSchema>["items"], senderItemId: string) {
  return items?.find((candidate) =>
    candidate.sender_item_id === senderItemId || candidate.payout_item?.sender_item_id === senderItemId,
  );
}

function payoutResult(data: z.infer<typeof payoutResponseSchema>, senderItemId: string): PayoutResult {
  const item = findPayoutItem(data.items, senderItemId);
  return {
    batchId: data.batch_header.payout_batch_id,
    itemId: item?.payout_item_id ?? null,
    status: item?.transaction_status ?? data.batch_header.batch_status,
    batchStatus: data.batch_header.batch_status,
    itemStatus: item?.transaction_status ?? null,
    transactionId: item?.transaction_id ?? null,
    itemErrorCode: item?.errors?.name ?? null,
    itemAmount: item?.payout_item?.amount ?? null,
  };
}

// A duplicate sender_batch_id is rejected with a link to the original payout.
function linkedBatchId(links: Array<{ href?: string }> | undefined) {
  for (const link of links ?? []) {
    const match = /\/v1\/payments\/payouts\/([A-Za-z0-9]+)(?:[/?]|$)/.exec(link.href ?? "");
    if (match) return match[1];
  }
  return undefined;
}

function isDuplicate(name: string | undefined, details: Array<{ field?: string; issue?: string }> | undefined) {
  return /DUPLICATE/i.test(name ?? "") || (details ?? []).some((detail) => /sender_batch_id/i.test(detail.field ?? "") || /DUPLICATE/i.test(detail.issue ?? ""));
}

// Named PayPal outcomes that the HTTP status alone would misclassify (PayPal Payouts test values
// ERRPYO036 and ERRPYO039; rate limits ERRPYO035 / RATE_LIMIT_REACHED). A timeout, or an earlier
// request with the same sender_batch_id still in progress, may still pay: it is UNKNOWN, so the
// payout is reconciled with the same IDs and never sent as a new payment. A rate limit is refused
// before processing: NOT_SENT, resendable with the same IDs after a backoff.
const UNKNOWN_OUTCOME_NAMES: ReadonlySet<string> = new Set(["INTERNAL_ERROR", "INTERNAL_SERVER_ERROR", "REQUEST_TIMEOUT_EXCEEDED", "PREVIOUS_REQUEST_IN_PROGRESS"]);
const RATE_LIMIT_NAMES: ReadonlySet<string> = new Set(["RATE_LIMIT_REACHED", "RATE_LIMIT_VALIDATION"]);
export function isRateLimitCode(code: string | null | undefined) {
  return !!code && RATE_LIMIT_NAMES.has(code);
}
export function outcomeForPayPalError(status: number, name: string | undefined): PayoutRequestOutcome {
  if (name && UNKNOWN_OUTCOME_NAMES.has(name)) return "UNKNOWN";
  if (name && RATE_LIMIT_NAMES.has(name)) return "NOT_SENT";
  return outcomeForStatus(status);
}

// Sandbox negative testing (Owner requirement, 7 Nov 2026): sets items[0].note to one PayPal
// Payouts test value. Only outside production builds and only with the explicit flag; the client
// itself refuses any host but the Sandbox. Never set in an ordinary environment.
export const PAYOUT_NEGATIVE_TESTS_ENV = "FAIRSHIFT_PAYPAL_NEGATIVE_TESTS";
export const PAYOUT_NEGATIVE_TEST_CODE_ENV = "FAIRSHIFT_PAYPAL_NEGATIVE_TEST_CODE";
export function payoutNegativeTestNote(env: Record<string, string | undefined> = process.env): string | null {
  if (env.NODE_ENV === "production" || env[PAYOUT_NEGATIVE_TESTS_ENV] !== "enabled") return null;
  const code = env[PAYOUT_NEGATIVE_TEST_CODE_ENV]?.trim();
  return code && /^ERRPYO\d{3}$/.test(code) ? code : null;
}

function outcomeForStatus(status: number): PayoutRequestOutcome {
  if (status >= 500) return "UNKNOWN";
  // Authentication, authorisation and rate-limit refusals are made before a payout is processed.
  if (status === 401 || status === 403 || status === 429) return "NOT_SENT";
  return "REJECTED";
}

type PayoutConfig = {
  PAYPAL_CLIENT_ID: string;
  PAYPAL_CLIENT_SECRET: string;
  apiBaseUrl: typeof PAYPAL_SANDBOX_API_BASE_URL;
};

export class PayPalPayoutClient implements PayPalPayoutAdapter {
  private accessToken: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly config: PayoutConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
    // False for a business's own app: Sandbox negative-test notes go only through the platform app.
    private readonly negativeTests = true,
  ) {
    // Sandbox only: a live host is never accepted, whatever the configuration says.
    if (config.apiBaseUrl !== PAYPAL_SANDBOX_API_BASE_URL) throw new Error("PayPal payouts are restricted to the Sandbox environment.");
  }

  async createPayout(input: CreatePayoutInput) {
    const currency = input.currency ?? "USD";
    if (!/^[A-Z]{3}$/.test(currency) || !/^\d+\.\d{2}$/.test(input.amount)) {
      throw new PayPalPayoutError("Invalid payout amount.", "INVALID_PAYOUT_AMOUNT", undefined, undefined, undefined, "NOT_SENT");
    }
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
          email_subject: input.emailSubject ?? "FairShift shift incentive",
          email_message: input.emailMessage ?? "A manager-approved FairShift shift incentive is available in your PayPal account.",
        },
        items: [{
          recipient_type: "EMAIL",
          amount: { value: input.amount, currency },
          receiver: input.recipient,
          sender_item_id: input.senderItemId,
          note: (this.negativeTests ? payoutNegativeTestNote() : null) ?? input.note ?? "Manager-approved FairShift shift incentive",
          ...(input.purpose ? { purpose: input.purpose } : {}),
        }],
      }),
    }, true);
    const parsed = payoutResponseSchema.safeParse(response);
    // PayPal answered with success, so the payout may exist even though the body is unreadable.
    if (!parsed.success) throw new PayPalPayoutError("Malformed PayPal payout response.", "MALFORMED_RESPONSE", undefined, undefined, undefined, "UNKNOWN");
    return payoutResult(parsed.data, input.senderItemId);
  }

  async getPayout(batchId: string, senderItemId: string) {
    const response = await this.authorizedRequest(`/v1/payments/payouts/${encodeURIComponent(batchId)}?fields=items`, { method: "GET" }, false);
    const parsed = payoutResponseSchema.safeParse(response);
    if (!parsed.success) throw new PayPalPayoutError("Malformed PayPal payout status response.", "MALFORMED_RESPONSE");
    return payoutResult(parsed.data, senderItemId);
  }

  private async authorizedRequest(path: string, init: RequestInit, payoutRequest: boolean) {
    let accessToken: string;
    try {
      accessToken = await this.getAccessToken();
    } catch (error) {
      // No payout request is made without a token.
      if (error instanceof PayPalPayoutError) throw new PayPalPayoutError(error.message, error.code, error.status, error.debugId, error.details, "NOT_SENT");
      throw error;
    }
    return this.request(path, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${accessToken}` },
    }, payoutRequest);
  }

  private async getAccessToken() {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 30_000) return this.accessToken.value;
    const basic = Buffer.from(`${this.config.PAYPAL_CLIENT_ID}:${this.config.PAYPAL_CLIENT_SECRET}`).toString("base64");
    const response = await this.request("/v1/oauth2/token", {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    }, false);
    const parsed = tokenSchema.safeParse(response);
    if (!parsed.success) throw new PayPalPayoutError("Malformed PayPal OAuth response.", "MALFORMED_TOKEN_RESPONSE", undefined, undefined, undefined, "NOT_SENT");
    this.accessToken = { value: parsed.data.access_token, expiresAt: Date.now() + parsed.data.expires_in * 1000 };
    return this.accessToken.value;
  }

  private async request(path: string, init: RequestInit, payoutRequest: boolean): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.apiBaseUrl}${path}`, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      const code = error instanceof DOMException && error.name === "TimeoutError" ? "TIMEOUT" : "NETWORK_ERROR";
      throw new PayPalPayoutError("PayPal request could not be completed.", code, undefined, undefined, undefined, "UNKNOWN");
    }
    let data: unknown;
    try { data = await response.json(); } catch {
      const outcome = !payoutRequest || response.ok ? "UNKNOWN" : outcomeForStatus(response.status);
      throw new PayPalPayoutError("PayPal returned a non-JSON response.", "MALFORMED_RESPONSE", response.status, undefined, undefined, outcome);
    }
    if (!response.ok) {
      const error = errorSchema.safeParse(data);

      const code = error.success ? error.data.name ?? "PAYPAL_HTTP_ERROR" : "PAYPAL_HTTP_ERROR";
      const debugId = error.success ? error.data.debug_id : undefined;
      const details = error.success ? error.data.details : undefined;
      const duplicate = payoutRequest && error.success && isDuplicate(error.data.name, details);
      const outcome = duplicate ? "DUPLICATE" : payoutRequest ? outcomeForPayPalError(response.status, error.success ? error.data.name : undefined) : outcomeForStatus(response.status);

      // Structured identifiers only: provider messages and request bodies are not logged.
      console.error("PayPal API rejected request", {
        status: response.status,
        code,
        debugId,
        details: details?.map(({ field, issue }) => ({ field, issue })),
      });

      throw new PayPalPayoutError(
        "PayPal rejected the payout request.",
        code,
        response.status,
        debugId,
        details,
        outcome,
        duplicate && error.success ? linkedBatchId(error.data.links) : undefined,
      );
    }
    return data;
  }
}
