import type { PayPalConfig } from "@/server/config/env";
import {
  type CaptureDetails,
  captureOrderResponseSchema,
  captureSchema,
  createOrderResponseSchema,
  tokenResponseSchema,
  verifyWebhookResponseSchema,
} from "@/server/integrations/paypal/schemas";

type Fetch = typeof fetch;

export class PayPalApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "PayPalApiError";
  }
}

export interface PayPalAdapter {
  createOrder(input: {
    internalReference: string;
    outletReference: string;
    currencyCode: "USD";
    amount: string;
    returnUrl: string;
    cancelUrl: string;
  }): Promise<{ orderId: string; providerStatus: string; approvalUrl: string }>;
  captureOrder(
    orderId: string,
    requestId: string,
  ): Promise<{
    orderId: string;
    providerStatus: string;
    customId?: string;
    capture: CaptureDetails;
  }>;
  getCapture(captureId: string): Promise<CaptureDetails>;
  verifyWebhookSignature(
    headers: PayPalTransmissionHeaders,
    webhookEvent: unknown,
  ): Promise<boolean>;
}

export interface PayPalTransmissionHeaders {
  authAlgo: string;
  certUrl: string;
  transmissionId: string;
  transmissionSig: string;
  transmissionTime: string;
}

export class PayPalClient implements PayPalAdapter {
  private accessToken: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly config: PayPalConfig,
    private readonly fetchImpl: Fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  async createOrder(input: {
    internalReference: string;
    outletReference: string;
    currencyCode: "USD";
    amount: string;
    returnUrl: string;
    cancelUrl: string;
  }) {
    const response = await this.authorizedRequest("/v2/checkout/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "PayPal-Request-Id": input.internalReference,
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: input.outletReference,
            custom_id: input.internalReference,
            description: "FairShift sandbox integration proof sale",
            amount: { currency_code: input.currencyCode, value: input.amount },
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: "FairShift Sandbox",
              user_action: "PAY_NOW",
              return_url: input.returnUrl,
              cancel_url: input.cancelUrl,
            },
          },
        },
      }),
    });

    const parsed = createOrderResponseSchema.safeParse(response);
    if (!parsed.success) throw new PayPalApiError("Malformed create-order response.", "MALFORMED_RESPONSE");

    const approval = parsed.data.links.find(
      (link) => link.rel === "payer-action" || link.rel === "approve",
    );
    if (!approval) throw new PayPalApiError("PayPal response did not include an approval URL.", "MISSING_APPROVAL_URL");

    return {
      orderId: parsed.data.id,
      providerStatus: parsed.data.status,
      approvalUrl: approval.href,
    };
  }

  async captureOrder(orderId: string, requestId: string) {
    const response = await this.authorizedRequest(
      `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "PayPal-Request-Id": requestId,
          Prefer: "return=representation",
        },
        body: "{}",
      },
    );

    const parsed = captureOrderResponseSchema.safeParse(response);
    if (!parsed.success) throw new PayPalApiError("Malformed capture-order response.", "MALFORMED_RESPONSE");

    const purchaseUnit = parsed.data.purchase_units[0];
    return {
      orderId: parsed.data.id,
      providerStatus: parsed.data.status,
      customId: purchaseUnit.custom_id,
      capture: purchaseUnit.payments.captures[0],
    };
  }

  async getCapture(captureId: string) {
    const response = await this.authorizedRequest(
      `/v2/payments/captures/${encodeURIComponent(captureId)}`,
      { method: "GET" },
    );
    const parsed = captureSchema.safeParse(response);
    if (!parsed.success) throw new PayPalApiError("Malformed capture-details response.", "MALFORMED_RESPONSE");
    return parsed.data;
  }

  async verifyWebhookSignature(headers: PayPalTransmissionHeaders, webhookEvent: unknown) {
    const response = await this.authorizedRequest("/v1/notifications/verify-webhook-signature", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        auth_algo: headers.authAlgo,
        cert_url: headers.certUrl,
        transmission_id: headers.transmissionId,
        transmission_sig: headers.transmissionSig,
        transmission_time: headers.transmissionTime,
        webhook_id: this.config.PAYPAL_WEBHOOK_ID,
        webhook_event: webhookEvent,
      }),
    });
    const parsed = verifyWebhookResponseSchema.safeParse(response);
    if (!parsed.success) throw new PayPalApiError("Malformed webhook-verification response.", "MALFORMED_RESPONSE");
    return parsed.data.verification_status === "SUCCESS";
  }

  private async getAccessToken() {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 30_000) {
      return this.accessToken.value;
    }

    const basic = Buffer.from(
      `${this.config.PAYPAL_CLIENT_ID}:${this.config.PAYPAL_CLIENT_SECRET}`,
      "utf8",
    ).toString("base64");

    const response = await this.performFetch("/v1/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });

    const parsed = tokenResponseSchema.safeParse(response);
    if (!parsed.success) throw new PayPalApiError("Malformed OAuth token response.", "MALFORMED_TOKEN_RESPONSE");

    this.accessToken = {
      value: parsed.data.access_token,
      expiresAt: Date.now() + parsed.data.expires_in * 1000,
    };
    return this.accessToken.value;
  }

  protected async authorizedRequest(path: string, init: RequestInit) {
    const accessToken = await this.getAccessToken();
    return this.performFetch(path, {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${accessToken}`,
      },
    });
  }

  private async performFetch(path: string, init: RequestInit) {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.apiBaseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const code = error instanceof DOMException && error.name === "TimeoutError" ? "TIMEOUT" : "NETWORK_ERROR";
      throw new PayPalApiError("PayPal request could not be completed.", code);
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new PayPalApiError("PayPal returned a non-JSON response.", "MALFORMED_RESPONSE", response.status);
    }

    if (!response.ok) {
      throw new PayPalApiError("PayPal rejected the request.", "PAYPAL_HTTP_ERROR", response.status);
    }

    return data;
  }
}
