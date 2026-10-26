import { requireScope } from "@/server/auth/request";
import { getDatabase } from "@/server/db/client";
import { getConfigurationStatus } from "@/server/config/env";
import { getOwnerOverview, ownerForecastSummary, ownerStaffingSummary } from "@/server/product/owner-overview";
import { getWeeklyForecast } from "@/server/intelligence/weekly";
import { getWeeklyStaffing } from "@/server/intelligence/staffing";
import { OwnerOverview, OwnerReload } from "@/app/owner/overview";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export default async function OwnerPage() {
  const scope = await requireScope(["OWNER"]);
  if (!getConfigurationStatus().databaseConfigured) return <OwnerOverviewUnavailable />;
  let data;
  try { data = await getOwnerOverview(getDatabase(), scope); }
  catch { return <OwnerOverviewUnavailable />; }
  // A forecast failure leaves the factual sections intact and is shown as unavailable.
  const now = new Date();
  let forecast = null, staffing = null;
  try { forecast = ownerForecastSummary(await getWeeklyForecast(getDatabase(), scope, now)); } catch { forecast = null; }
  try { staffing = ownerStaffingSummary(await getWeeklyStaffing(getDatabase(), scope, now)); } catch { staffing = null; }
  return <div className="product-page"><OwnerOverview data={data} forecast={forecast} staffing={staffing} /></div>;
}

function OwnerOverviewUnavailable() {
  return <div className="product-page owner-overview"><h1>Overview</h1><section className="owner-empty" role="alert"><h2>Overview could not be loaded</h2><p>Your organisation’s operating information is unavailable. Reload to try again.</p><OwnerReload /></section></div>;
}
