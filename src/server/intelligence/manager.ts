import { and, eq } from "drizzle-orm";

import { DEMO_ORGANISATION_ID, DEMO_OUTLET_ID } from "@/server/constants";
import type { DatabaseSession } from "@/server/db/client";
import { outlets, saleTransactions } from "@/server/db/schema";
import { DEMO_AS_OF, DEMO_TARGET_DATE } from "@/server/intelligence/demo";
import { forecastDemand, localDate, shiftDate } from "@/server/intelligence/forecast";

// Scope is pinned on the server. A URL/body cannot select another organisation,
// outlet, policy or source. Verified history always takes precedence over demo.
export async function getManagerForecast(db: DatabaseSession, now = new Date()) {
  const [outlet] = await db.select().from(outlets).where(and(
    eq(outlets.id, DEMO_OUTLET_ID), eq(outlets.organisationId, DEMO_ORGANISATION_ID),
  ));
  if (!outlet) throw new Error("Manager outlet is unavailable.");
  const sales = await db.select().from(saleTransactions).where(and(
    eq(saleTransactions.outletId, outlet.id), eq(saleTransactions.currencyCode, "USD"),
  ));
  const verified = forecastDemand({
    sales, outlet, source: "PAYPAL_SANDBOX", asOf: now,
    targetDate: shiftDate(localDate(now, outlet.timezone), 1),
  });
  if (verified.status === "AVAILABLE") return verified;
  const demo = forecastDemand({
    sales, outlet, source: "DEMO_SEEDED", asOf: DEMO_AS_OF,
    targetDate: DEMO_TARGET_DATE, generatedAt: now,
  });
  return demo.status === "AVAILABLE" ? demo : verified;
}
