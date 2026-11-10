import { requireScope } from "@/server/auth/request";
import { getDatabase } from "@/server/db/client";
import { getConfigurationStatus } from "@/server/config/env";
import { getOwnerOverview, ownerForecastSummary, ownerStaffingSummary } from "@/server/product/owner-overview";
import { getOwnerSetup } from "@/server/product/owner-setup";
import { getWeeklyForecast } from "@/server/intelligence/weekly";
import { getWeeklyStaffing, type WeeklyStaffing } from "@/server/intelligence/staffing";
import { OwnerReload } from "@/app/owner/overview";
import { NeedsYou, TodayHeader, TodayTiles, WhereShort } from "@/app/owner/today";
import { getTodayNeeds } from "@/server/product/owner-today";
import { users } from "@/server/db/schema";
import { eq } from "drizzle-orm";
import { DisruptionAlerts, type DisruptionAlert } from "@/app/owner/disruption-alerts";
import { affectedShifts } from "@/server/intelligence/early-notice";
import { OwnerSetupChecklist } from "@/app/owner/setup-checklist";
import { ActionFeedback } from "@/app/components/workspace-ui";
import { AiThisWeek } from "@/app/components/ai-signals";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The Owner's Today page. loading.tsx sends a skeleton of the same layout at once; the independent reads
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
  // Design, 10 Nov 2026 (Owner · Today): Needs you, local signals with inline decisions, the week's
  // figures and where each location is short.
  const needs = await getTodayNeeds(db, scope, staffingWeek, now).catch(() => null);
  const timezone = overview.value.locations.find(row => row.id === scope.locationId)?.timezone ?? overview.value.locations[0]?.timezone ?? "UTC";
  // The greeting's name is cosmetic: if it can't be read, the page greets without it.
  const [user] = await (async () => db.select({ firstName: users.firstName }).from(users).where(eq(users.id, scope.userId)))().catch(() => []);
  const names = new Map(overview.value.locations.map(row => [row.id, row.name]));
  return <div className="product-page owner-today"><ActionFeedback status={params?.status} />
    <TodayHeader name={user?.firstName ?? ""} date={now} timezone={timezone} addPersonHref={`/owner/locations/${scope.locationId}#add-team-member`} />
    {setup && setup.some(step => !step.done) ? <OwnerSetupChecklist steps={setup} welcome={!!params?.welcome} /> : null}
    {needs ? <NeedsYou needs={needs} timezone={timezone} teamHref={`/owner/locations/${scope.locationId}?team=invited#team`} /> : null}
    {staffingWeek ? <AiThisWeek outlets={staffingWeek.outlets} act={!scope.demo} /> : null}
    <DisruptionAlerts alerts={alerts} canSend={!scope.demo} demoVisitor={!!scope.demo} />
    {needs ? <TodayTiles staffing={staffing} forecast={forecast} needs={needs} timezone={timezone} /> : null}
    <WhereShort staffing={staffing} names={names} />
  </div>;
}

function OwnerOverviewUnavailable() {
  return <div className="product-page owner-overview"><h1>Overview</h1><section className="owner-empty" role="alert"><h2>Overview could not be loaded</h2><p>Your organisation’s operating information is unavailable. Reload to try again.</p><OwnerReload /></section></div>;
}
