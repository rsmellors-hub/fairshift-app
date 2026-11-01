import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { assertRole, type Scope } from "@/server/auth/access";
import type { DatabaseSession } from "@/server/db/client";
import { commerceConnections, commerceWorkerIdentities, labourPolicies, memberships, outlets, regularStaffCoverage, saleTransactions, subscriptions, teamInvitations, workers, workPolicies } from "@/server/db/schema";

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
  const incentive = active.length ? await anyIn(db.select({ count }).from(workPolicies).where(and(inArray(workPolicies.outletId, active), isNotNull(workPolicies.incentiveTargetMinor)))) : false;
  const labour = await anyIn(db.select({ count }).from(labourPolicies).where(and(eq(labourPolicies.organisationId, scope.organisationId), eq(labourPolicies.status, "ACTIVE"))));
  const covered = new Set((await db.select({ outletId: regularStaffCoverage.outletId }).from(regularStaffCoverage).where(eq(regularStaffCoverage.organisationId, scope.organisationId))).map(row => row.outletId));
  const manager = await anyIn(db.select({ count }).from(memberships).where(and(eq(memberships.organisationId, scope.organisationId), eq(memberships.role, "MANAGER"), eq(memberships.state, "ACTIVE"))))
    || await anyIn(db.select({ count }).from(teamInvitations).where(and(eq(teamInvitations.organisationId, scope.organisationId), eq(teamInvitations.role, "MANAGER"))));
  const casual = await anyIn(db.select({ count }).from(workers).where(and(eq(workers.organisationId, scope.organisationId), eq(workers.workerType, "CASUAL"))));
  const [subscription] = await db.select({ tier: subscriptions.tier }).from(subscriptions).where(eq(subscriptions.organisationId, scope.organisationId));
  // Only worth raising where it applies: a Multi Outlet plan with one location, or sales that can't yet be attributed.
  const locations: OwnerSetupStep[] = subscription?.tier === "MULTI_OUTLET" ? [{ key: "locations", title: "Locations", detail: "Your plan covers up to 5 locations. Add the others so each gets its own forecast.", action: "Add a location", href: "/owner/locations", done: active.length >= 2 }] : [];
  const connected = (await db.select({ outletId: commerceConnections.outletId }).from(commerceConnections).where(and(eq(commerceConnections.organisationId, scope.organisationId), eq(commerceConnections.provider, "SQUARE"), eq(commerceConnections.status, "CONNECTED")))).map(row => row.outletId);
  const unmapped = connected.length ? await db.select({ id: workers.id }).from(workers).leftJoin(commerceWorkerIdentities, and(eq(commerceWorkerIdentities.workerId, workers.id), eq(commerceWorkerIdentities.status, "ACTIVE"))).where(and(inArray(workers.locationId, connected), eq(workers.workerType, "CASUAL"), eq(workers.status, "ACTIVE"), isNull(commerceWorkerIdentities.id))) : [];
  const mapping: OwnerSetupStep[] = casual && connected.length ? [{ key: "mapping", title: "Sales attribution", detail: "Map workers to Square team members so their sales count towards their targets.", action: "Map workers", href: "/manager/team", done: unmapped.length === 0 }] : [];
  return [
    ...locations,
    { key: "history", title: "Commerce history", detail: "Sales history drives the forecast. Connect Square Sandbox to start building it. A forecast needs at least 28 days.", action: "Connect commerce", href: "/owner/reporting", done: history },
    { key: "compensation", title: "Compensation", detail: "Set the hourly or daily terms managers can offer.", action: "Set compensation", href: "/owner/policies", done: compensation },
    { key: "incentive", title: "Incentive", detail: "Add a sales target and a fixed bonus to those terms.", action: "Set an incentive", href: "/owner/policies#work-policies", done: incentive },
    { key: "labour", title: "Labour rule", detail: "How much forecast sales one labour hour covers in your business.", action: "Set the labour rule", href: "/owner/policies#labour-policy", done: labour },
    { key: "coverage", title: "Regular coverage", detail: "Who already works each day, so FairShift only shows the gap.", action: "Add regular coverage", href: "/owner/policies#regular-coverage", done: active.length > 0 && active.every(id => covered.has(id)) },
    { key: "manager", title: "Manager", detail: "Invite someone to run a location, or run it yourself.", action: "Invite a manager", href: "/owner/workforce", done: manager },
    { key: "casual", title: "Casual workers", detail: "Invite the workers who fill your staffing gaps.", action: "Invite workers", href: "/owner/workforce", done: casual },
    ...mapping,
    { key: "forecast", title: "Forecast ready", detail: "Appears once a location has enough sales history, a labour rule and regular coverage.", action: "Open the forecast", href: "/owner/forecast", done: forecastReady },
  ];
}
