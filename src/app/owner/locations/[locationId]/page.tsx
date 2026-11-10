import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { WorkspaceUnavailable, ActionFeedback } from "@/app/components/workspace-ui";
import { LocationTeam, TEAM_FILTERS, type TeamFilter } from "@/app/components/location-team";
import { createLocationAction } from "@/app/auth-actions";
import { LocationSettings } from "@/app/owner/location-settings";
import { CardTips, PayTerms, StaffingAndOffers, TradingHours, VenueDetails } from "@/app/owner/location-sections";
import { requireScope } from "@/server/auth/request";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { outlets, subscriptions } from "@/server/db/schema";
import { localDate } from "@/server/intelligence/forecast";
import { getStaffingConfiguration } from "@/server/intelligence/business-policy";
import { locationLimitFor } from "@/server/billing/plans";
import { listPeople } from "@/server/people/people";
import { getOperations } from "@/server/scheduling/operations";
import { loadShiftRules } from "@/server/scheduling/shift-rules";
import { tipSettingsFor } from "@/server/tips/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Locations › one location (design: OwnerLocation, 10 Nov 2026): every location on the left; this
// location's details, team and settings as collapsible sections. The location must belong to the
// Owner's business; another business's identifier is simply not found.
export default async function OwnerLocationPage({ params, searchParams }: { params: Promise<{ locationId: string }>; searchParams?: Promise<{ status?: string; team?: string }> }) {
  const { locationId } = await params;
  const query = await searchParams;
  if (!getConfigurationStatus().databaseConfigured) return <div className="product-page"><WorkspaceUnavailable /></div>;
  if (!/^[0-9a-f-]{36}$/i.test(locationId)) notFound();
  const db = getDatabase();
  const base = await requireScope(["OWNER"]);
  const [location] = await db.select().from(outlets).where(and(eq(outlets.id, locationId), eq(outlets.organisationId, base.organisationId)));
  if (!location) notFound();
  const all = await db.select({ id: outlets.id, name: outlets.name, active: outlets.active }).from(outlets).where(eq(outlets.organisationId, base.organisationId)).orderBy(outlets.name);
  const [subscription] = await db.select().from(subscriptions).where(eq(subscriptions.organisationId, base.organisationId));
  const limit = subscription?.tier === "SINGLE_OUTLET" || subscription?.tier === "MULTI_OUTLET" ? locationLimitFor(subscription.tier) : subscription?.locationLimit ?? null;
  const activeCount = all.filter(row => row.active).length;
  const filter: TeamFilter = query?.team && query.team in TEAM_FILTERS ? query.team as TeamFilter : "everyone";
  const disabled = !!base.demo;
  const basePath = `/owner/locations/${location.id}`;
  // Settings for an inactive location can still be read; its team and settings are shown as kept.
  const scope = location.active ? await requireScope(["OWNER"], { locationId: location.id }) : null;
  const [configuration, operations, rules, tips, people] = scope ? await Promise.all([
    getStaffingConfiguration(db, scope), getOperations(db, scope), loadShiftRules(db, scope.organisationId, [scope.locationId]).then(map => map.get(scope.locationId) ?? null),
    tipSettingsFor(db, scope), listPeople(db, scope, new Date(), { locationId: scope.locationId }),
  ]) : [null, null, null, null, []];
  const today = localDate(new Date(), location.timezone);
  const others = all.filter(row => row.active && row.id !== location.id);
  return <div className="product-page"><div className="location-layout">
    <aside className="location-list" aria-label="Locations">
      <p className="eyebrow">Locations · {activeCount}{limit ? ` of ${limit}` : ""}</p>
      <ul>{all.map(row => <li key={row.id}><Link href={`/owner/locations/${row.id}`} aria-current={row.id === location.id ? "page" : undefined}>{row.name}{row.active ? null : <small> · deactivated</small>}</Link></li>)}</ul>
      {disabled ? null : limit && activeCount >= limit ? <p className="note">{subscription?.tier === "SINGLE_OUTLET" ? "Single plan: 1 location." : `Group plan: up to ${limit}.`} Deactivate one to add another, or change plan in <Link href="/owner/billing">Billing</Link>.</p>
        : <details className="disclosure-inline"><summary>+ Add location</summary><form action={createLocationAction} className="workspace-form"><label>Location name<input name="name" required maxLength={150} /></label><label>Street address<input name="address" maxLength={200} /></label><label>City or town<input name="city" maxLength={100} /></label><label>Postal code<input name="postalCode" maxLength={20} /></label><button className="primary-button">Add location</button></form></details>}
    </aside>
    <div className="location-main">
      <header className="owner-heading"><div><p className="eyebrow"><Link href="/owner/locations">Locations</Link> › {location.name}</p><h1>{location.name}</h1></div></header>
      <ActionFeedback status={query?.status} />
      {scope && configuration && operations ? <>
        <VenueDetails location={location} currency={operations.currency} disabled={disabled} open={!location.address} />
        <LocationTeam people={people} location={{ id: location.id, name: location.name }} otherLocations={others} owner filter={filter} basePath={basePath} timezone={location.timezone} disabled={disabled} previewHref={`/owner/invitation-preview?location=${location.id}`} />
        <TradingHours location={location} configuration={configuration} disabled={disabled} />
        <StaffingAndOffers location={location} configuration={configuration} rules={rules} disabled={disabled} />
        <PayTerms location={location} policies={operations.policies} jurisdiction={operations.wageJurisdiction} today={today} acknowledgement={operations.wageAcknowledgement} disabled={disabled} />
        <CardTips location={location} settings={tips} currency={operations.currency} disabled={disabled} />
      </> : <p className="note">This location is deactivated. Its records are kept; reactivate it to plan or offer shifts here again.</p>}
      <LocationSettings location={location} disabled={disabled} />
    </div>
  </div></div>;
}
