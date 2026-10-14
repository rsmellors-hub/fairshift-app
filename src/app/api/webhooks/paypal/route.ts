import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { getDatabase } from "@/server/db/client";
import { PayPalApiError } from "@/server/integrations/paypal/client";
import { getPayPalClient } from "@/server/integrations/paypal/factory";
import {
  processPayPalWebhook,
  WebhookError,
} from "@/server/integrations/paypal/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rawBody = await request.text();
  try {
    const result = await processPayPalWebhook({
      db: getDatabase(),
      paypal: getPayPalClient(),
      rawBody,
      headers: request.headers,
    });
    return NextResponse.json(
      { status: result.status, duplicate: result.duplicate },
      { status: result.httpStatus },
    );
  } catch (error) {
    if (error instanceof WebhookError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    if (error instanceof ZodError) {
      return NextResponse.json({ error: "MISSING_OR_INVALID_PAYPAL_HEADERS" }, { status: 400 });
    }
    if (error instanceof PayPalApiError) {
      // Non-2xx permits provider redelivery. Unfinished inbox rows remain
      // retryable even when authenticity was already verified on this attempt.
      return NextResponse.json({ error: "PAYPAL_VERIFICATION_UNAVAILABLE" }, { status: 503 });
    }
    return NextResponse.json({ error: "WEBHOOK_PROCESSING_FAILED" }, { status: 500 });
  }
}
