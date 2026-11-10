import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { selectLocationAction } from "@/app/auth-actions";
import { WorkspaceUnavailable } from "@/app/components/workspace-ui";
import { DataLabel } from "@/app/components/product-ui";
import { money } from "@/app/components/format";
import { AcceptedContextNote, labourHours, longDate, policyDescription, policySummary, ServiceDays, STAFFING_UNAVAILABLE, StaffingDayTable, transactions, wholeMoney, WorkloadSetupNotice } from "@/app/components/staffing";
import { WeekCover } from "@/app/manager/plan-week";
import { CommercialChain } from "@/app/owner/commerce-labour";
import { SALES_SOURCE } from "@/app/owner/sales";
import { requireScope } from "@/server/auth/request";
import { getCommerceConnections } from "@/server/commerce/connections";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { organisations, outlets } from "@/server/db/schema";
import { localDate as zonedDate } from "@/server/intelligence/forecast";
import { ratesInForce, wageJurisdiction } from "@/server/domain/statutory-wage";
import { DemoFloorPolicy, longDay, WageSource } from "@/app/components/wage-check";
import { getWorkOutcomes } from "@/server/intelligence/commerce-labour";
import { isSyntheticSource } from "@/server/intelligence/forecast";
import { getWeeklyStaffing } from "@/server/intelligence/staffing";
import { LocationSettings } from "@/app/owner/location-settings";

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
  // The statutory wage reference for this location, from its country or else the business's.
  const [organisation] = await db.select({ country: organisations.country }).from(organisations).where(eq(organisations.id, scope.organisationId));
  const wage = wageJurisdiction({ locationCountry: location.country, organisationCountry: organisation?.country });
  const wageToday = zonedDate(new Date(), location.timezone), wagePeriod = wage.jurisdiction === "ENGLAND" ? ratesInForce(wageToday) : null;
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
      <WorkloadSetupNotice outlets={[outlet]} owner />
      <ol className="demand-flow" aria-label="From expected transactions to the remaining requirement">
        <li><span>Expected transactions</span><strong>{outlet.days.every(day => day.expectedMilliTransactions !== null) ? transactions(outlet.days.reduce((sum, day) => sum + day.expectedMilliTransactions!, 0)) : "Not available"}</strong><small>Next 7 days, inside trading hours</small></li>
        <li><span>Staff capacity needed</span><strong>{outlet.totals ? labourHours(outlet.totals.requiredMinutes) : "Not available"}</strong><small>{outlet.policy ? policySummary(outlet.policy) : "Service capacity not set"}</small></li>
        <li><span>Existing coverage</span><strong>{outlet.totals ? labourHours(outlet.totals.coverageMinutes) : "Not available"}</strong><small>{outlet.totals ? `Regular ${labourHours(outlet.totals.regularMinutes)} · allocated casual ${labourHours(outlet.totals.allocatedCasualMinutes)}` : outlet.regularCoverage ? "Regular coverage is set" : "Regular coverage not set"}</small></li>
        <li className="demand-flow-gap"><span>Casual requirement</span><strong>{outlet.totals ? labourHours(outlet.totals.casualGapMinutes) : "Not available"}</strong><small>{outlet.totals ? "By time of day · no shifts created" : "Can’t be calculated yet"}</small></li>
      </ol>
      <p className="note">Expected sales {outlet.commercial?.forecast && outlet.currency ? wholeMoney(outlet.commercial.forecast.totalMinor, outlet.currency) : "not available"} in the next 7 days: commercial context, not part of the staffing figures.</p>
      <AcceptedContextNote outlets={[outlet]} />
      <section className="panel wage-reference" aria-labelledby="location-wage-title"><div className="panel-head"><h2 id="location-wage-title">Minimum wage reference</h2>{wage.jurisdiction === "ENGLAND" ? <span className="status-badge status-badge-fact">England demo jurisdiction · {wage.country}</span> : wage.jurisdiction === null && wage.reason === "OUTSIDE_DEMO_JURISDICTION" ? <span className="status-badge status-badge-neutral">Outside demo jurisdiction</span> : <span className="status-badge status-badge-warning">Statutory reference unavailable</span>}</div>
        {wagePeriod ? <><p>FairShift demo minimum today, {longDay(wageToday)}: <strong>{money(wagePeriod.rates[0].rateMinor, "GBP")} an hour</strong>, the 21-and-over National Living Wage. Every shift here is checked against the rate for its own date, and shifts below it can’t be created or offered. <Link className="text-link" href="/owner/policies#wage-reference">See all rates and your terms</Link></p><DemoFloorPolicy /><WageSource period={wagePeriod} /></>
          : <p>{wage.jurisdiction === null && wage.reason === "COUNTRY_NOT_STATED" ? "No country is recorded for this location, so FairShift can’t tell which minimum wage applies." : wage.jurisdiction === null && wage.reason === "NATION_NOT_VERIFIED" ? "FairShift’s UK reference hasn’t been verified for Northern Ireland." : wage.jurisdiction === null && wage.reason === "OUTSIDE_DEMO_JURISDICTION" ? `FairShift’s demo minimum applies to England, the demonstration jurisdiction. This location is in ${wage.country}.` : wage.jurisdiction === null ? `FairShift holds a verified minimum wage reference for the UK only. This location is in ${wage.country}.` : `FairShift has no verified rates for ${longDay(wageToday)}.`} Pay here isn’t checked against a statutory minimum.</p>}
      </section>
      <section className="panel" aria-labelledby="location-service-title"><h2 id="location-service-title">By time of day</h2><p className="panel-lede">When each day is covered and when it isn’t. No shifts are created here.</p><ServiceDays outlet={outlet} /></section>
      <section className="panel" aria-label="Staffing by day"><WeekCover outlet={outlet} act={false} /></section>
      <section aria-labelledby="location-source-title" className="panel"><h2 id="location-source-title">Commerce evidence</h2>
        {outlet.evidence ? <><DataLabel kind={isSyntheticSource(outlet.evidence.source) ? "demo" : "fact"}>{SALES_SOURCE[outlet.evidence.source]}</DataLabel><p>Data through {longDate(outlet.evidence.dataThrough)} · {outlet.evidence.ageDays} days before the planning week starts{outlet.evidence.kind === "HISTORICAL" ? ". Historical evidence mapped onto planning weekdays, not current trading." : "."}</p></> : <p>No eligible sales history, so no demand or labour requirement has been assumed.</p>}
        <p className="note">Square Sandbox evidence comes from a UK (GBP) test seller, not from this location’s own till.</p>
        <p>Square Sandbox: {connections === null ? "status could not be loaded" : !connection ? "not connected at this location" : connection.status === "AUTH_FAILED" ? "connection needs attention" : connection.lastSuccess ? `connected · last completed sync ${connection.lastSuccess.startedAt.toISOString().slice(0, 10)}` : "connected · not synced yet"}. <Link href="/owner/reporting">Manage sales sources <span aria-hidden="true">→</span></Link></p>
      </section>
      <section aria-labelledby="location-days-title" className="owner-staffing"><div className="owner-section-heading"><div><h2 id="location-days-title">Day by day</h2><p>Demand, coverage and the remaining casual requirement. No shifts are created here.</p></div></div>
        <div className="owner-forecast-scroll-inner table-frame" role="region" aria-label={`${location.name} staffing by day`} tabIndex={0}><StaffingDayTable outlet={outlet} className="owner-location-table" /></div>
        <p className="note">{outlet.policy ? `Workload policy: ${policyDescription(outlet.policy)}. ` : ""}{firstUnavailable ? `${STAFFING_UNAVAILABLE[firstUnavailable]}. ` : ""}</p>
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
  <LocationSettings location={location} disabled={!!scope.demo} />
  </div></div>;
}
