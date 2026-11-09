import { requireScope } from "@/server/auth/request";
import { getDatabase } from "@/server/db/client";
import { getConfigurationStatus } from "@/server/config/env";
import { getOwnerOverview, ownerForecastSummary, ownerStaffingSummary } from "@/server/product/owner-overview";
import { getOwnerSetup } from "@/server/product/owner-setup";
import { getWeeklyForecast } from "@/server/intelligence/weekly";
import { getWeeklyStaffing, type WeeklyStaffing } from "@/server/intelligence/staffing";
import { OwnerOverview, OwnerReload } from "@/app/owner/overview";
import { DisruptionAlerts, type DisruptionAlert } from "@/app/owner/disruption-alerts";
import { affectedShifts } from "@/server/intelligence/early-notice";
import { OwnerSetupChecklist } from "@/app/owner/setup-checklist";
import { ActionFeedback } from "@/app/components/workspace-ui";
import { AiThisWeek } from "@/app/components/ai-signals";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The Owner's Overview. loading.tsx sends a skeleton of the same layout at once; the independent reads
// then run in parallel, and a failure in one leaves the others intact.
export default async function OwnerPage({ searchParams }: { searchParams?: Promise<{ welcome?: string; status?: string }> }) {
  const scope = await requireScope(["OWNER"]);
  if (!getConfigurationStatus().databaseConfigured) return <OwnerOverviewUnavailable />;
  const db = getDatabase(), now = new Date();
  const [overview, weekly, week, query] = await Promise.allSettled([getOwnerOverview(db, scope), getWeeklyForecast(db, scope, now), getWeeklyStaffing(db, scope, now), searchParams]);
  if (overview.status === "rejected") return <OwnerOverviewUnavailable />;
  // A forecast failure leaves the factual sections intact and is shown as unavailable.
  const forecast = weekly.status === "fulfilled" ? ownerForecastSummary(weekly.value) : null;
  const staffingWeek: WeeklyStaffing | null = week.status === "fulfilled" ? week.value : null;
  const staffing = staffingWeek ? ownerStaffingSummary(staffingWeek) : null;
  // High-severity capacity signals at any location: something that could stop it trading.
  const raised: DisruptionAlert[] = (staffingWeek?.outlets ?? []).flatMap(outlet => (outlet.localIntelligence?.alerts ?? []).map(signal => ({ outletId: outlet.outletId, outletName: outlet.outletName, timezone: outlet.timezone, signal })));
  // For a likely closure: the casual workers whose allocated shifts it covers; and the setup guide. Either
  // can fail on its own: the alert then shows without a recommendation, the Overview without the guide.
  const [alerts, setup] = await Promise.all([
    Promise.all(raised.map(async alert => alert.signal.closureLikely ? { ...alert, affected: await affectedShifts(db, { organisationId: scope.organisationId, outletId: alert.outletId, timezone: alert.timezone }, alert.signal, now) } : alert))
      .catch(() => { console.error("Early-notice candidates could not be read; alerts show without them."); return raised; }),
    getOwnerSetup(db, scope, !!staffing?.outlets.some(row => row.casualGapMinutes !== null)).catch(() => null),
  ]);
  const params = query.status === "fulfilled" ? query.value : undefined;
  return <div className="product-page"><ActionFeedback status={params?.status} />
    {staffingWeek ? <AiThisWeek outlets={staffingWeek.outlets} /> : null}
    {setup ? <OwnerSetupChecklist steps={setup} welcome={!!params?.welcome} /> : null}
    <DisruptionAlerts alerts={alerts} canSend={!scope.demo} demoVisitor={!!scope.demo} />
    <OwnerOverview data={overview.value} forecast={forecast} staffing={staffing} />
  </div>;
}

function OwnerOverviewUnavailable() {
  return <div className="product-page owner-overview"><h1>Overview</h1><section className="owner-empty" role="alert"><h2>Overview could not be loaded</h2><p>Your organisation’s operating information is unavailable. Reload to try again.</p><OwnerReload /></section></div>;
}
