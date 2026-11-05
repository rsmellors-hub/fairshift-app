import { assertSandboxOrganisation, SandboxIsolationError } from "@/server/config/deployment";
import { DEMO_ORGANISATION_ID } from "@/server/constants";
import { currentIdentity, operatorAllowed } from "@/server/auth/request";
import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { getPayPalConfig } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { createSandboxOrder, serializeSale } from "@/server/domain/transactions";
import { PayPalApiError } from "@/server/integrations/paypal/client";
import { getPayPalClient } from "@/server/integrations/paypal/factory";
import { assertSameOrigin, OriginError } from "@/server/security/origin";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const identity=await currentIdentity();
    if (!identity) return NextResponse.json({error:"UNAUTHENTICATED"},{status:401});
    if (!operatorAllowed(identity.user)) return NextResponse.json({error:"FORBIDDEN"},{status:403});
    if (identity.session.demoPersona) return NextResponse.json({error:"FORBIDDEN"},{status:403});
    assertSandboxOrganisation(DEMO_ORGANISATION_ID);
    assertSameOrigin(request);
    const result = await createSandboxOrder(getDatabase(), getPayPalClient(), getPayPalConfig());
    return NextResponse.json(
      { transaction: serializeSale(result.sale), approvalUrl: result.approvalUrl },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof SandboxIsolationError) return NextResponse.json({ error: error.code }, { status: error.status });
    if (error instanceof OriginError) {
      return NextResponse.json({ error: "ORIGIN_REJECTED" }, { status: error.status });
    }
    if (error instanceof ZodError) {
      return NextResponse.json({ error: "PAYPAL_SANDBOX_NOT_CONFIGURED" }, { status: 503 });
    }
    if (error instanceof PayPalApiError) {
      return NextResponse.json(
        { error: error.code, providerStatus: error.status ?? null },
        { status: 502 },
      );
    }
    return NextResponse.json({ error: "ORDER_CREATE_FAILED" }, { status: 500 });
  }
}
