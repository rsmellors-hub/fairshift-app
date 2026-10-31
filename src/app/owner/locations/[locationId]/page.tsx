import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { selectLocationAction } from "@/app/auth-actions";
import { WorkspaceUnavailable } from "@/app/components/workspace-ui";
import { DataLabel } from "@/app/components/product-ui";
import { money } from "@/app/components/format";
import { longDate, policyDescription, STAFFING_UNAVAILABLE, StaffingDayTable, wholeMoney } from "@/app/components/staffing";
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
  const connection = connections?.find(row => row.outletId === locationId);
  const firstUnavailable = outlet?.days.find(day => day.unavailable)?.unavailable;
  return <div className="product-page"><div className="owner-overview owner-forecast">
    <header className="owner-heading"><div><p className="owner-eyebrow">Location</p><h1>{location.name}</h1><p>{location.timezone}{outlet ? ` · Planning week ${longDate(outlet.days[0].planningDate)} – ${longDate(outlet.days[6].planningDate)}` : ""}</p></div><Link className="owner-link" href="/owner/locations">All locations <span aria-hidden="true">→</span></Link></header>
    {!outlet ? <section className="owner-empty" role="alert"><h2>Planning figures could not be loaded</h2><p>No demand or labour has been assumed. Reload to try again.</p></section> : <>
      <section aria-labelledby="location-source-title" className="owner-attention"><h2 id="location-source-title">Commerce evidence</h2>
        {outlet.evidence ? <><DataLabel kind={isSyntheticSource(outlet.evidence.source) ? "demo" : "fact"}>{SALES_SOURCE[outlet.evidence.source]}</DataLabel><p>Data through {longDate(outlet.evidence.dataThrough)} · {outlet.evidence.ageDays} days before the planning week starts{outlet.evidence.kind === "HISTORICAL" ? ". Historical evidence mapped onto planning weekdays, not current trading." : "."}</p></> : <p>No eligible sales history, so no demand or labour requirement has been assumed.</p>}
        <p>Zettle: {connections === null ? "status could not be loaded" : !connection ? "not connected at this location" : connection.status === "AUTH_FAILED" ? "connection needs attention" : connection.lastSuccess ? `connected · last completed sync ${connection.lastSuccess.startedAt.toISOString().slice(0, 10)}` : "connected · not synced yet"}. <Link href="/owner/reporting">Manage sales sources →</Link></p>
      </section>
      <section aria-labelledby="location-chain-title" className="owner-staffing"><div className="owner-section-heading"><div><h2 id="location-chain-title">From commerce to labour</h2><p>What is recorded, what is expected, what that requires, and what it would cost to cover.</p></div></div>
        <CommercialChain context={outlet.commercial} currency={outlet.currency} outlet={outlet} />
        <p className="owner-note">{outlet.policy ? `Staffing assumption: ${policyDescription(outlet.policy)}. ` : ""}{firstUnavailable ? `${STAFFING_UNAVAILABLE[firstUnavailable]}. ` : ""}Regular staff wages are not held by FairShift, so cost figures cover casual labour only. Nothing here is a saving or a measured return.</p>
      </section>
      <section aria-labelledby="location-days-title" className="owner-staffing"><div className="owner-section-heading"><div><h2 id="location-days-title">Day by day</h2><p>Demand, coverage and the remaining casual gap. No shifts are created here.</p></div>
        {outlet.totals?.casualGapMinutes ? <form action={selectLocationAction}><input type="hidden" name="locationId" value={location.id} /><input type="hidden" name="next" value="plan" /><button className="secondary-button">Plan shifts at {location.name}</button></form> : null}</div>
        <div className="owner-forecast-scroll-inner" role="region" aria-label={`${location.name} staffing by day`} tabIndex={0}><StaffingDayTable outlet={outlet} className="owner-location-table" /></div>
      </section>
      <section aria-labelledby="location-outcome-title" className="owner-attention"><div className="owner-section-heading"><div><h2 id="location-outcome-title">What happened with confirmed casual work</h2><p>Recorded outcomes of past shifts at this location, all time.</p></div><Link className="owner-link" href="/owner/payments">Payments <span aria-hidden="true">→</span></Link></div>
        {outcomes === null ? <p role="alert">Work outcomes could not be loaded.</p> : !outcomes.length ? <p className="owner-quiet">No confirmed casual work yet, so actual labour cost is not available.</p> : outcomes.map(row => <dl className="shift-terms" key={row.currency}>
          <div><dt>Confirmed casual pay</dt><dd>{money(row.confirmedPayMinor, row.currency)} · {row.confirmedShifts} {row.confirmedShifts === 1 ? "shift" : "shifts"}</dd></div>
          <div><dt>Paid · confirmed by PayPal</dt><dd>{money(row.paidMinor, row.currency)}</dd></div>
          <div><dt>Attributed sales · imported, not provider-verified</dt><dd>{row.shiftsWithAttribution ? `${money(row.attributedSalesMinor, row.currency)} · ${row.attributedSalesCount} sales` : "No confirmed results"}</dd></div>
          <div><dt>Attributed sales per unit of pay</dt><dd>{row.shiftsWithAttribution && row.payWithAttributionMinor > 0 ? `${new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 }).format(row.attributedSalesMinor / row.payWithAttributionMinor)}× on ${row.shiftsWithAttribution} ${row.shiftsWithAttribution === 1 ? "shift" : "shifts"}` : "Not available"}</dd></div>
        </dl>)}
        {outcomes?.length ? <p className="owner-note">A ratio of recorded figures, not a measure of what the shift caused: those sales may have happened anyway. {outlet.currency && outlet.commercial?.recent ? `For scale, this location’s latest seven days of chosen evidence total ${wholeMoney(outlet.commercial.recent.salesMinor, outlet.currency)}.` : ""}</p> : null}
      </section>
    </>}
  </div></div>;
}
