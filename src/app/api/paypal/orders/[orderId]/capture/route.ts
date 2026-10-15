import { currentIdentity, operatorAllowed } from "@/server/auth/request";
import { NextResponse } from "next/server";
import { z, ZodError } from "zod";

import { getDatabase } from "@/server/db/client";
import {
  captureSandboxOrder,
  serializeSale,
  TransactionError,
} from "@/server/domain/transactions";
import { PayPalApiError } from "@/server/integrations/paypal/client";
import { getPayPalClient } from "@/server/integrations/paypal/factory";
import { assertSameOrigin, OriginError } from "@/server/security/origin";

export const runtime = "nodejs";

const orderIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

export async function POST(
  request: Request,
  context: { params: Promise<{ orderId: string }> },
) {
  try {
    const identity=await currentIdentity();
    if (!identity) return NextResponse.json({error:"UNAUTHENTICATED"},{status:401});
    if (!operatorAllowed(identity.user)) return NextResponse.json({error:"FORBIDDEN"},{status:403});
    assertSameOrigin(request);
    const { orderId: rawOrderId } = await context.params;
    const orderId = orderIdSchema.parse(rawOrderId);
    const sale = await captureSandboxOrder(getDatabase(), getPayPalClient(), orderId);
    return NextResponse.json({ transaction: serializeSale(sale) });
  } catch (error) {
    if (error instanceof OriginError) {
      return NextResponse.json({ error: "ORIGIN_REJECTED" }, { status: error.status });
    }
    if (error instanceof TransactionError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    if (error instanceof ZodError) {
      return NextResponse.json({ error: "INVALID_ORDER_OR_CONFIGURATION" }, { status: 400 });
    }
    if (error instanceof PayPalApiError) {
      return NextResponse.json(
        { error: error.code, providerStatus: error.status ?? null },
        { status: 502 },
      );
    }
    return NextResponse.json({ error: "CAPTURE_FAILED" }, { status: 500 });
  }
}
