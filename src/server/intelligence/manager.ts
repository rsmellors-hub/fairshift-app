import type { Scope } from "@/server/auth/access";
import { and, eq } from "drizzle-orm";

import type { DatabaseSession } from "@/server/db/client";
import { outlets } from "@/server/db/schema";
import { forecastResultSchema, localDate, METHOD_VERSION, shiftDate, staffedForecast, startOfLocalDay, STAFFING_POLICY_CURRENCY } from "@/server/intelligence/forecast";
import { loadDailySales, syntheticHistoryAllowed } from "@/server/intelligence/sales-history";
import { selectForecastSource } from "@/server/intelligence/weekly";

// Scope is pinned on the server. A URL/body cannot select another organisation,
// outlet, policy or source. The history is chosen by the same deterministic
// eligibility rule as the weekly forecast, so a handful of provider records never
// replaces a complete history; the target is the first day of that planning week.
export async function getManagerForecast(db: DatabaseSession, now: Date, scope:Pick<Scope,"organisationId"|"locationId"> & Partial<Pick<Scope,"demo">>) {
  const [outlet] = await db.select().from(outlets).where(and(
    eq(outlets.id, scope.locationId), eq(outlets.organisationId, scope.organisationId),
  ));
  if (!outlet) throw new Error("Manager outlet is unavailable.");
  const today = localDate(now, outlet.timezone);
  const allowSynthetic = syntheticHistoryAllowed(scope);
  const selection = selectForecastSource(await loadDailySales(db, scope.organisationId, [outlet.id], allowSynthetic), today, allowSynthetic);
  if (selection.status === "NONE") {
    return forecastResultSchema.parse({
      methodVersion: METHOD_VERSION, organisationId: outlet.organisationId, outletId: outlet.id, outletName: outlet.name,
      timezone: outlet.timezone, targetDate: shiftDate(today, 1), currency: STAFFING_POLICY_CURRENCY, source: "PAYPAL_SANDBOX",
      dataAsOf: startOfLocalDay(today, outlet.timezone).toISOString(), generatedAt: now.toISOString(),
      status: "UNAVAILABLE", reason: "NO_ELIGIBLE_HISTORY",
    });
  }
  return staffedForecast({
    days: selection.days, outlet, source: selection.source, currency: selection.currency,
    dataThrough: selection.dataThrough, targetDate: selection.firstTarget,
    asOf: startOfLocalDay(shiftDate(selection.dataThrough, 1), outlet.timezone), generatedAt: now,
  });
}
