import { assertSandboxOrganisation } from "@/server/config/deployment";
import { DEMO_ORGANISATION_ID } from "@/server/constants";
import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "@/server/db/client";
import {
  insertOrGetProviderEvent,
  updateProviderEvent,
  writeAuditEvent,
} from "@/server/db/repository";
import { providerEvents } from "@/server/db/schema";
import { decimalToMinorUnits } from "@/server/domain/money";
import { reconcileCapture } from "@/server/domain/transactions";
import type {
  PayPalAdapter,
  PayPalTransmissionHeaders,
} from "@/server/integrations/paypal/client";
import {
  captureCompletedWebhookSchema,
  webhookEventBaseSchema,
} from "@/server/integrations/paypal/schemas";

const transmissionHeadersSchema = z.object({
  authAlgo: z.string().min(1),
  certUrl: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" && (url.hostname === "paypal.com" || url.hostname.endsWith(".paypal.com"));
    }, "Certificate URL must be an HTTPS PayPal URL."),
  transmissionId: z.string().min(1),
  transmissionSig: z.string().min(1),
  transmissionTime: z.string().datetime(),
});

export function readPayPalTransmissionHeaders(headers: Headers): PayPalTransmissionHeaders {
  return transmissionHeadersSchema.parse({
    authAlgo: headers.get("paypal-auth-algo"),
    certUrl: headers.get("paypal-cert-url"),
    transmissionId: headers.get("paypal-transmission-id"),
    transmissionSig: headers.get("paypal-transmission-sig"),
    transmissionTime: headers.get("paypal-transmission-time"),
  });
}

export async function processPayPalWebhook(input: {
  db: Database;
  paypal: PayPalAdapter;
  rawBody: string;
  headers: Headers;
}) {
  assertSandboxOrganisation(DEMO_ORGANISATION_ID);
  const transmission = readPayPalTransmissionHeaders(input.headers);
  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody);
  } catch {
    throw new WebhookError("INVALID_JSON", 400);
  }

  const base = webhookEventBaseSchema.safeParse(payload);
  if (!base.success) throw new WebhookError("INVALID_EVENT", 400);

  const verified = await input.paypal.verifyWebhookSignature(transmission, payload);
  if (!verified) throw new WebhookError("SIGNATURE_VERIFICATION_FAILED", 401);

  const payloadSha256 = createHash("sha256").update(input.rawBody).digest("hex");
  const completed = captureCompletedWebhookSchema.safeParse(payload);

  if (!completed.success) {
    const result = await insertOrGetProviderEvent(input.db, {
      id: randomUUID(),
      providerEventId: base.data.id,
      eventType: base.data.event_type,
      payloadSha256,
      verificationStatus: "VERIFIED",
      processingState: "IGNORED",
      providerCreatedAt: base.data.create_time ? new Date(base.data.create_time) : undefined,
    });
    if (result.inserted) {
      await writeAuditEvent(input.db, {
        id: randomUUID(),
        action: "PAYPAL_WEBHOOK_IGNORED",
        entityType: "provider_event",
        entityId: result.event.id,
        correlationId: transmission.transmissionId,
        metadata: { providerEventId: base.data.id, eventType: base.data.event_type },
      });
    }
    return { status: "IGNORED" as const, duplicate: !result.inserted, httpStatus: 200 };
  }

  const event = completed.data;
  const orderId = event.resource.supplementary_data?.related_ids.order_id ?? null;
  const eventResult = await insertOrGetProviderEvent(input.db, {
    id: randomUUID(),
    providerEventId: event.id,
    eventType: event.event_type,
    payloadSha256,
    paypalOrderId: orderId,
    paypalCaptureId: event.resource.id,
    currencyCode: event.resource.amount.currency_code,
    grossAmountMinor: decimalToMinorUnits(event.resource.amount.value),
    providerStatus: event.resource.status,
    verificationStatus: "VERIFIED",
    processingState: "RECEIVED",
    providerCreatedAt: event.create_time ? new Date(event.create_time) : undefined,
  });

  // Inbox persistence is separate from completion. Serialize deliveries of this
  // event, re-read its state under the lock, then commit sale + audits + terminal
  // state together. A failed attempt rolls back and remains retryable; merely
  // having an inbox row must never produce a success acknowledgement.
  return input.db.transaction(async (tx) => {
    const [stored] = await tx.select().from(providerEvents)
      .where(eq(providerEvents.id, eventResult.event.id)).for("update");
    if (!stored) throw new Error("Persisted provider event disappeared.");

    if (["PROCESSED", "IGNORED", "UNMATCHED"].includes(stored.processingState)) {
      return {
        status: stored.processingState,
        duplicate: true,
        httpStatus: stored.processingState === "UNMATCHED" ? 202 : 200,
      };
    }

    // RECEIVED (and legacy ERROR) is unfinished. Use the original verified
    // capture reference, not replacement evidence from a repeated delivery.
    if (!stored.paypalCaptureId) throw new Error("Capture event has no capture reference.");
    const sale = await reconcileCapture(tx, input.paypal, stored.paypalCaptureId);
    if (!sale) {
      await updateProviderEvent(tx, event.id, { processingState: "UNMATCHED" });
      return { status: "UNMATCHED" as const, duplicate: !eventResult.inserted, httpStatus: 202 };
    }

    await updateProviderEvent(tx, event.id, {
      processingState: "PROCESSED",
      saleTransactionId: sale.id,
    });
    await writeAuditEvent(tx, {
      id: randomUUID(),
      action: "PAYPAL_WEBHOOK_PROCESSED",
      entityType: "provider_event",
      entityId: stored.id,
      correlationId: transmission.transmissionId,
      metadata: {
        providerEventId: event.id,
        eventType: stored.eventType,
        saleTransactionId: sale.id,
        verificationState: sale.verificationState,
      },
    });

    return { status: "PROCESSED" as const, duplicate: !eventResult.inserted, httpStatus: 200 };
  });
}

export class WebhookError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = "WebhookError";
  }
}
