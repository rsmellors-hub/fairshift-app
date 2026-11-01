import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { selectLocationAction } from "@/app/auth-actions";
import { WorkspaceUnavailable } from "@/app/components/workspace-ui";
import { DataLabel } from "@/app/components/product-ui";
import { money } from "@/app/components/format";
import { labourHours, longDate, policyDescription, STAFFING_UNAVAILABLE, staffingAssumption, StaffingDayTable, wholeMoney } from "@/app/components/staffing";
import { WeekCover } from "@/app/manager/plan-week";
import { CommercialChain } from "@/app/owner/commerce-labour";
import { SALES_SOURCE } from "@/app/owner/sales";
import { requireScope } from "@/server/auth/request";
import { getCommerceConnections } from "@/server/commerce/connections";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { outlets } from "@/server/db/schema";
import { getWorkOutcomes } from "@/server/intelligence/commerce-labour";
import { isSyntheticSource } from "@/server/intelligence/forecast";
import { getWeeklyStaffing } from "@/server/intelligence/staffing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// One outlet from commerce through to staffing and money. The location must belong to
// the session's organisation; another tenant's identifier is simply not found.
export default async function OwnerLocationPage({ params }: { params: Promise<{ locationId: string }> }) {
  const { locationId } = await params;
  if (!getConfigurationStatus().databaseConfigured) return <div className="product-page"><WorkspaceUnavailable /></div>;
  const scope = await requireScope(["OWNER"]);
  if (!/^[0-9a-f-]{36}$/i.test(locationId)) notFound();
  const db = getDatabase();
  const [location] = await db.select().from(outlets).where(and(eq(outlets.id, locationId), eq(outlets.organisationId, scope.organisationId)));
  if (!location) notFound();
  let staffing = null, outcomes = null, connections = null;
  try { staffing = await getWeeklyStaffing(db, scope, new Date()); } catch { staffing = null; }
  try { outcomes = (await getWorkOutcomes(db, scope)).filter(row => row.outletId === locationId); } catch { outcomes = null; }
  try { connections = await getCommerceConnections(db, scope); } catch { connections = null; }
  const outlet = staffing?.outlets.find(row => row.outletId === locationId) ?? null;
  const connection = connections?.find(row => row.outletId === locationId && row.provider === "SQUARE");
  const firstUnavailable = outlet?.days.find(day => day.unavailable)?.unavailable;
  return <div className="product-page"><div className="owner-overview owner-forecast">
    <header className="owner-heading"><div><p className="eyebrow"><Link href="/owner/locations">All locations</Link>{outlet ? ` · Planning week ${longDate(outlet.days[0].planningDate)} – ${longDate(outlet.days[6].planningDate)}` : ""}</p><h1>{location.name}</h1><p>Times at this location: {location.timezone}</p></div>
      {outlet?.totals?.casualGapMinutes ? <form action={selectLocationAction}><input type="hidden" name="locationId" value={location.id} /><input type="hidden" name="next" value="plan" /><button className="primary-button">Plan shifts at {location.name}</button></form> : null}</header>
    {!outlet ? <section className="owner-empty" role="alert"><h2>Planning figures could not be loaded</h2><p>No demand or labour has been assumed. Reload to try again.</p></section> : <>
      <ol className="demand-flow" aria-label="From forecast demand to the remaining gap">
        <li><span>Forecast demand</span><strong>{outlet.commercial?.forecast && outlet.currency ? wholeMoney(outlet.commercial.forecast.totalMinor, outlet.currency) : "Not available"}</strong><small>Expected sales, next 7 days</small></li>
        <li><span>Labour needed</span><strong>{outlet.totals ? labourHours(outlet.totals.requiredMinutes) : "Not available"}</strong><small>{outlet.policy ? staffingAssumption(outlet.policy) : "No labour policy"}</small></li>
        <li><span>Existing coverage</span><strong>{outlet.totals ? labourHours(outlet.totals.coverageMinutes) : "Not available"}</strong><small>{outlet.totals ? `Regular ${labourHours(outlet.totals.regularMinutes)} · allocated casual ${labourHours(outlet.totals.allocatedCasualMinutes)}` : "Regular coverage not set"}</small></li>
        <li className="demand-flow-gap"><span>Remaining gap</span><strong>{outlet.totals ? labourHours(outlet.totals.casualGapMinutes) : "Not available"}</strong><small>{outlet.totals ? `Approx. ${outlet.totals.indicativeShifts} ${outlet.totals.indicativeShifts === 1 ? "shift" : "shifts"} to fill · none created` : "Can’t be calculated yet"}</small></li>
      </ol>
      <section className="panel" aria-label="Staffing by day"><WeekCover outlet={outlet} act={false} /></section>
      <section aria-labelledby="location-source-title" className="panel"><h2 id="location-source-title">Commerce evidence</h2>
        {outlet.evidence ? <><DataLabel kind={isSyntheticSource(outlet.evidence.source) ? "demo" : "fact"}>{SALES_SOURCE[outlet.evidence.source]}</DataLabel><p>Data through {longDate(outlet.evidence.dataThrough)} · {outlet.evidence.ageDays} days before the planning week starts{outlet.evidence.kind === "HISTORICAL" ? ". Historical evidence mapped onto planning weekdays, not current trading." : "."}</p></> : <p>No eligible sales history, so no demand or labour requirement has been assumed.</p>}
        <p>Square Sandbox: {connections === null ? "status could not be loaded" : !connection ? "not connected at this location" : connection.status === "AUTH_FAILED" ? "connection needs attention" : connection.lastSuccess ? `connected · last completed sync ${connection.lastSuccess.startedAt.toISOString().slice(0, 10)}` : "connected · not synced yet"}. <Link href="/owner/reporting">Manage sales sources <span aria-hidden="true">→</span></Link></p>
      </section>
      <section aria-labelledby="location-days-title" className="owner-staffing"><div className="owner-section-heading"><div><h2 id="location-days-title">Day by day</h2><p>Demand, coverage and the remaining casual gap. No shifts are created here.</p></div></div>
        <div className="owner-forecast-scroll-inner table-frame" role="region" aria-label={`${location.name} staffing by day`} tabIndex={0}><StaffingDayTable outlet={outlet} className="owner-location-table" /></div>
        <p className="note">{outlet.policy ? `Staffing assumption: ${policyDescription(outlet.policy)}. ` : ""}{firstUnavailable ? `${STAFFING_UNAVAILABLE[firstUnavailable]}. ` : ""}</p>
      </section>
      <details className="panel disclosure"><summary id="location-chain-title">From commerce to labour: the full working</summary>
        <CommercialChain context={outlet.commercial} currency={outlet.currency} outlet={outlet} />
        <p className="note">Regular staff wages are not held by FairShift, so cost figures cover casual labour only. Nothing here is a saving or a measured return.</p>
      </details>
      <section aria-labelledby="location-outcome-title" className="panel"><div className="panel-head"><h2 id="location-outcome-title">What happened with confirmed casual work</h2><Link className="text-link" href="/owner/payments">Payments <span aria-hidden="true">→</span></Link></div>
        {outcomes === null ? <p role="alert">Work outcomes could not be loaded.</p> : !outcomes.length ? <p className="note">No confirmed casual work yet, so actual labour cost is not available.</p> : outcomes.map(row => <dl className="shift-terms" key={row.currency}>
          <div><dt>Confirmed casual pay</dt><dd>{money(row.confirmedPayMinor, row.currency)} · {row.confirmedShifts} {row.confirmedShifts === 1 ? "shift" : "shifts"}</dd></div>
          <div><dt>Paid · confirmed by PayPal</dt><dd>{money(row.paidMinor, row.currency)}</dd></div>
          <div><dt>Attributed sales · confirmed by a manager</dt><dd>{row.shiftsWithAttribution ? `${money(row.attributedSalesMinor, row.currency)} · ${row.attributedSalesCount} sales` : "No confirmed results"}</dd></div>
          <div><dt>Attributed sales per unit of pay</dt><dd>{row.shiftsWithAttribution && row.payWithAttributionMinor > 0 ? `${new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 }).format(row.attributedSalesMinor / row.payWithAttributionMinor)}× on ${row.shiftsWithAttribution} ${row.shiftsWithAttribution === 1 ? "shift" : "shifts"}` : "Not available"}</dd></div>
        </dl>)}
        {outcomes?.length ? <p className="note">A ratio of recorded figures, not a measure of what the shift caused: those sales may have happened anyway. {outlet.currency && outlet.commercial?.recent ? `For scale, this location’s latest seven days of chosen evidence total ${wholeMoney(outlet.commercial.recent.salesMinor, outlet.currency)}.` : ""}</p> : null}
      </section>
    </>}
  </div></div>;
}
