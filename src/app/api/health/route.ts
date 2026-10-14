import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const configuration = getConfigurationStatus();
  if (!configuration.databaseConfigured) {
    return NextResponse.json(
      { status: "not_ready", database: "NOT_CONFIGURED", paypal: configuration.environment },
      { status: 503 },
    );
  }

  try {
    await getDatabase().execute(sql`select 1`);
    return NextResponse.json({
      status: "ready",
      database: "CONNECTED",
      paypal: configuration.paypalConfigured ? "SANDBOX_CONFIGURED" : "NOT_CONFIGURED",
    });
  } catch {
    return NextResponse.json(
      { status: "not_ready", database: "ERROR", paypal: configuration.environment },
      { status: 503 },
    );
  }
}
