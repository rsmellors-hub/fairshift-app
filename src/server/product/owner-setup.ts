import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { assertRole, type Scope } from "@/server/auth/access";
import type { DatabaseSession } from "@/server/db/client";
import { commerceConnections, commerceWorkerIdentities, localIntelligenceRuns, memberships, outletTradingHours, outlets, saleTransactions, subscriptions, teamInvitations, workers, workloadPolicies, workPolicies } from "@/server/db/schema";

export type OwnerSetupStep = { key: string; title: string; detail: string; action: string; href: string; done: boolean };

// What the Owner still has to set up, read from the records that make each step true.
// forecastReady comes from the staffing week the caller already calculated.
export async function getOwnerSetup(db: DatabaseSession, scope: Scope, forecastReady: boolean): Promise<OwnerSetupStep[]> {
  assertRole(scope, ["OWNER"]);
  const active = (await db.select({ id: outlets.id }).from(outlets).where(and(eq(outlets.organisationId, scope.organisationId), eq(outlets.active, true)))).map(row => row.id);
  const anyIn = async (query: Promise<{ count: number }[]>) => ((await query)[0]?.count ?? 0) > 0;
  const count = sql<number>`count(*)`.mapWith(Number);
  const history = active.length ? await anyIn(db.select({ count }).from(saleTransactions).where(inArray(saleTransactions.outletId, active))) : false;
  const compensation = active.length ? await anyIn(db.select({ count }).from(workPolicies).where(inArray(workPolicies.outletId, active))) : false;
  const capacity = await anyIn(db.select({ count }).from(workloadPolicies).where(and(eq(workloadPolicies.organisationId, scope.organisationId), eq(workloadPolicies.status, "ACTIVE"))));
  const trading = new Set((await db.select({ outletId: outletTradingHours.outletId }).from(outletTradingHours).where(eq(outletTradingHours.organisationId, scope.organisationId))).map(row => row.outletId));
  const manager = await anyIn(db.select({ count }).from(memberships).where(and(eq(memberships.organisationId, scope.organisationId), eq(memberships.role, "MANAGER"), eq(memberships.state, "ACTIVE"))))
    || await anyIn(db.select({ count }).from(teamInvitations).where(and(eq(teamInvitations.organisationId, scope.organisationId), eq(teamInvitations.role, "MANAGER"))));
  const casual = await anyIn(db.select({ count }).from(workers).where(and(eq(workers.organisationId, scope.organisationId), eq(workers.workerType, "CASUAL"))));
  const [subscription] = await db.select({ tier: subscriptions.tier }).from(subscriptions).where(eq(subscriptions.organisationId, scope.organisationId));
  // Only worth raising where it applies: a Multi Outlet plan with one location, or sales that can't yet be attributed.
  const locations: OwnerSetupStep[] = subscription?.tier === "MULTI_OUTLET" ? [{ key: "locations", title: "Locations", detail: "Your plan covers up to 5 locations. Add the others so each gets its own forecast.", action: "Add a location", href: "/owner/locations", done: active.length >= 2 }] : [];
  const connected = (await db.select({ outletId: commerceConnections.outletId }).from(commerceConnections).where(and(eq(commerceConnections.organisationId, scope.organisationId), eq(commerceConnections.provider, "SQUARE"), eq(commerceConnections.status, "CONNECTED")))).map(row => row.outletId);
  const unmapped = connected.length ? await db.select({ id: workers.id }).from(workers).leftJoin(commerceWorkerIdentities, and(eq(commerceWorkerIdentities.workerId, workers.id), eq(commerceWorkerIdentities.status, "ACTIVE"))).where(and(inArray(workers.locationId, connected), eq(workers.workerType, "CASUAL"), eq(workers.status, "ACTIVE"), isNull(commerceWorkerIdentities.id))) : [];
  const mapping: OwnerSetupStep[] = casual && connected.length ? [{ key: "mapping", title: "Sales attribution", detail: "Map workers to Square team members so their sales count towards their targets.", action: "Map workers", href: "/manager/team", done: unmapped.length === 0 }] : [];
  // Design, 10 Nov 2026: the checklist follows the setup flow (Setup steps 2–6), for every active location.
  const places = active.length ? await db.select({ id: outlets.id, address: outlets.address, pin: outlets.pinConfirmedAt }).from(outlets).where(inArray(outlets.id, active)) : [];
  const first = places.find(place => !place.address || !place.pin) ?? places[0];
  const discovered = active.length ? await anyIn(db.select({ count }).from(localIntelligenceRuns).where(inArray(localIntelligenceRuns.outletId, active))) : false;
  const [sub] = await db.select({ status: subscriptions.status }).from(subscriptions).where(eq(subscriptions.organisationId, scope.organisationId));
  const step = (name: string) => `/onboarding?step=${name}${first ? `&location=${first.id}` : ""}`;
  return [
    { key: "subscription", title: "Subscription", detail: "Your 30-day free trial, approved in PayPal Sandbox.", action: "Open Billing", href: "/owner/billing", done: sub?.status === "ACTIVE" },
    { key: "venue", title: "Venue address and pin", detail: "Each location’s address and a confirmed map pin, so FairShift knows where to look.", action: "Place the pin", href: first ? `/owner/locations/${first.id}/pin` : step("venue"), done: places.length > 0 && places.every(place => !!place.address && !!place.pin) },
    { key: "discovery", title: "AI first look", detail: "A first search of what’s happening near your venue: events, notices and holidays.", action: "See the first look", href: step("venue"), done: discovered },
    { key: "history", title: "Sales history", detail: "Connect Square, upload past sales, or start with sample history. A forecast needs at least 28 days.", action: "Add sales history", href: step("sales"), done: history },
    { key: "compensation", title: "Pay terms", detail: "A role and hourly rate, checked against the minimum wage, and the tip rule.", action: "Set pay terms", href: step("pay"), done: compensation },
    { key: "capacity", title: "Service capacity and minimum cover", detail: "How many bills one person serves an hour, and the fewest staff while open.", action: "Set staffing", href: first ? `/owner/locations/${first.id}#staffing` : step("venue"), done: capacity && active.length > 0 && active.every(id => trading.has(id)) },
    { key: "casual", title: "Team", detail: "Invite the people who work your shifts.", action: "Invite your team", href: step("team"), done: casual || manager },
    ...locations, ...mapping,
    { key: "forecast", title: "Forecast ready", detail: "Appears once a location has enough sales history, capacity, trading hours and regular cover.", action: "Open the plan", href: "/manager/plan", done: forecastReady },
  ];
}
