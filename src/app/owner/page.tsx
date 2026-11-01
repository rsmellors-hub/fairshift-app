import { requireScope } from "@/server/auth/request";
import { getDatabase } from "@/server/db/client";
import { getConfigurationStatus } from "@/server/config/env";
import { getOwnerOverview, ownerForecastSummary, ownerStaffingSummary } from "@/server/product/owner-overview";
import { getOwnerSetup } from "@/server/product/owner-setup";
import { getWeeklyForecast } from "@/server/intelligence/weekly";
import { getWeeklyStaffing } from "@/server/intelligence/staffing";
import { OwnerOverview, OwnerReload } from "@/app/owner/overview";
import { OwnerSetupChecklist } from "@/app/owner/setup-checklist";
import { ActionFeedback } from "@/app/components/workspace-ui";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export default async function OwnerPage({ searchParams }: { searchParams?: Promise<{ welcome?: string; status?: string }> }) {
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
  // A guide, not a record: if it can't be worked out, the Overview simply goes without it.
  let setup = null;
  try { setup = await getOwnerSetup(getDatabase(), scope, !!staffing?.outlets.some(row => row.casualGapMinutes !== null)); } catch { setup = null; }
  const query = await searchParams, welcome = !!query?.welcome;
  return <div className="product-page"><ActionFeedback status={query?.status} />{setup ? <OwnerSetupChecklist steps={setup} welcome={welcome} /> : null}<OwnerOverview data={data} forecast={forecast} staffing={staffing} /></div>;
}

function OwnerOverviewUnavailable() {
  return <div className="product-page owner-overview"><h1>Overview</h1><section className="owner-empty" role="alert"><h2>Overview could not be loaded</h2><p>Your organisation’s operating information is unavailable. Reload to try again.</p><OwnerReload /></section></div>;
}
