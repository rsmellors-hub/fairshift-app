import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { assertRole, type Scope } from "@/server/auth/access";
import { requireEntitlement } from "@/server/billing/entitlement";
import type { Database, DatabaseSession } from "@/server/db/client";
import { auditEvents, demandContextFeeds, outletTradingHours, outlets, regularCoverageWindows, workloadPolicies } from "@/server/db/schema";
import { venueContextSchema } from "@/server/intelligence/venue-profile";
import { coverageWindowsSchema, tradingWindowsSchema, workloadPolicyInputSchema, type CoverageWindow, type TradingWindow } from "@/server/intelligence/workload";

// A business's own workload inputs: its service-capacity policy, trading hours and regular
// cover by time of day. Owners configure them; managers only consume the result. FairShift
// supplies no value for any of them.

export type PolicyLevel = "ORGANISATION" | "LOCATION";
type OwnerScope = Pick<Scope, "userId" | "organisationId" | "locationId" | "role">;

async function authoriseOwner(db: DatabaseSession, scope: OwnerScope) {
  assertRole(scope as Scope, ["OWNER"]);
  await requireEntitlement(db, scope.organisationId);
  const [outlet] = await db.select({ id: outlets.id }).from(outlets).where(and(eq(outlets.id, scope.locationId), eq(outlets.organisationId, scope.organisationId)));
  if (!outlet) throw new Error("Location unavailable.");
}

const scopeFilter = (organisationId: string, outletId: string | null) => and(eq(workloadPolicies.organisationId, organisationId), outletId ? eq(workloadPolicies.outletId, outletId) : isNull(workloadPolicies.outletId));

// Appends a new active version unless the active one already says the same thing.
export async function writeWorkloadPolicyVersion(tx: DatabaseSession, input: { organisationId: string; outletId: string | null; transactionsPerStaffHour: number; minimumStaffWhileOpen: number; source: "CONFIGURED" | "REFERENCE"; createdBy: string | null }) {
  const versions = await tx.select().from(workloadPolicies).where(scopeFilter(input.organisationId, input.outletId)).orderBy(desc(workloadPolicies.version)).for("update");
  const active = versions.find(row => row.status === "ACTIVE");
  if (active && active.transactionsPerStaffHour === input.transactionsPerStaffHour && active.minimumStaffWhileOpen === input.minimumStaffWhileOpen && active.source === input.source) return active;
  const now = new Date();
  if (active) await tx.update(workloadPolicies).set({ status: "SUPERSEDED", supersededAt: now }).where(eq(workloadPolicies.id, active.id));
  const [created] = await tx.insert(workloadPolicies).values({ id: randomUUID(), ...input, version: (versions[0]?.version ?? 0) + 1, createdAt: now }).returning();
  await tx.insert(auditEvents).values({ id: randomUUID(), organisationId: input.organisationId, outletId: input.outletId, action: "WORKLOAD_POLICY_SET", entityType: "workload_policy", entityId: created.id,
    correlationId: `workload-policy:${input.organisationId}`, metadata: { actorUserId: input.createdBy, version: created.version, transactionsPerStaffHour: created.transactionsPerStaffHour, minimumStaffWhileOpen: created.minimumStaffWhileOpen, source: created.source } });
  return created;
}

// Organisation default, or an override for the Owner's currently selected location.
export async function setWorkloadPolicy(db: Database, scope: OwnerScope, level: PolicyLevel, input: unknown) {
  await authoriseOwner(db, scope);
  const value = workloadPolicyInputSchema.parse(input);
  return db.transaction(tx => writeWorkloadPolicyVersion(tx, { organisationId: scope.organisationId, outletId: level === "LOCATION" ? scope.locationId : null, ...value, source: "CONFIGURED", createdBy: scope.userId }));
}

// Without a policy at this level the next level applies, or staffing becomes unavailable.
export async function clearWorkloadPolicy(db: Database, scope: OwnerScope, level: PolicyLevel) {
  await authoriseOwner(db, scope);
  const outletId = level === "LOCATION" ? scope.locationId : null;
  return db.transaction(async tx => {
    const [cleared] = await tx.update(workloadPolicies).set({ status: "SUPERSEDED", supersededAt: new Date() })
      .where(and(scopeFilter(scope.organisationId, outletId), eq(workloadPolicies.status, "ACTIVE"))).returning();
    if (cleared) await tx.insert(auditEvents).values({ id: randomUUID(), organisationId: scope.organisationId, outletId, action: "WORKLOAD_POLICY_CLEARED", entityType: "workload_policy", entityId: cleared.id,
      correlationId: `workload-policy:${scope.organisationId}`, metadata: { actorUserId: scope.userId, version: cleared.version } });
    return cleared ?? null;
  });
}

const weekOf = <T extends z.ZodType>(day: T) => z.array(day.nullable()).length(7);

// The selected location's trading hours, Monday..Sunday. An empty list is a day stated as
// closed; null means this day isn't set, so its planning is unavailable, not closed.
export async function setTradingHours(db: Database, scope: OwnerScope, week: unknown) {
  await authoriseOwner(db, scope);
  const days = weekOf(tradingWindowsSchema).parse(week) as (TradingWindow[] | null)[];
  return db.transaction(async tx => {
    const unset = days.flatMap((value, i) => value === null ? [i + 1] : []);
    if (unset.length) await tx.delete(outletTradingHours).where(and(eq(outletTradingHours.outletId, scope.locationId), inArray(outletTradingHours.isoWeekday, unset)));
    for (const [i, windows] of days.entries()) if (windows !== null) await tx.insert(outletTradingHours).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: scope.locationId, isoWeekday: i + 1, windows, source: "CONFIGURED" }).onConflictDoUpdate({
      target: [outletTradingHours.outletId, outletTradingHours.isoWeekday], set: { windows, source: "CONFIGURED", updatedAt: new Date() } });
    await tx.insert(auditEvents).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: scope.locationId, action: "TRADING_HOURS_SET", entityType: "outlet", entityId: scope.locationId,
      correlationId: `trading-hours:${scope.locationId}`, metadata: { actorUserId: scope.userId, days } });
  });
}

// Regular staff by time of day, Monday..Sunday. An empty list is a stated zero; null is not set.
export async function setRegularCoverage(db: Database, scope: OwnerScope, week: unknown) {
  await authoriseOwner(db, scope);
  const days = weekOf(coverageWindowsSchema).parse(week) as (CoverageWindow[] | null)[];
  return db.transaction(async tx => {
    const unset = days.flatMap((value, i) => value === null ? [i + 1] : []);
    if (unset.length) await tx.delete(regularCoverageWindows).where(and(eq(regularCoverageWindows.outletId, scope.locationId), inArray(regularCoverageWindows.isoWeekday, unset)));
    for (const [i, windows] of days.entries()) if (windows !== null) await tx.insert(regularCoverageWindows).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: scope.locationId, isoWeekday: i + 1, windows, source: "CONFIGURED" }).onConflictDoUpdate({
      target: [regularCoverageWindows.outletId, regularCoverageWindows.isoWeekday], set: { windows, source: "CONFIGURED", updatedAt: new Date() } });
    await tx.insert(auditEvents).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: scope.locationId, action: "REGULAR_COVERAGE_SET", entityType: "outlet", entityId: scope.locationId,
      correlationId: `regular-coverage:${scope.locationId}`, metadata: { actorUserId: scope.userId, days } });
  });
}

// The selected location's venue profile and coordinates. New coordinates drop the forecast and
// events fetched for the old ones, so they can't be read as this location's, and the next
// planning page fetches afresh.
export async function setVenueContext(db: Database, scope: OwnerScope, input: unknown) {
  await authoriseOwner(db, scope);
  const value = venueContextSchema.parse(input);
  return db.transaction(async tx => {
    const [before] = await tx.select({ latitude: outlets.latitude, longitude: outlets.longitude }).from(outlets).where(and(eq(outlets.id, scope.locationId), eq(outlets.organisationId, scope.organisationId))).for("update");
    if (!before) throw new Error("Location not found.");
    await tx.update(outlets).set({ ...value, venueContextSource: "CONFIGURED", updatedAt: new Date() }).where(eq(outlets.id, scope.locationId));
    if (before.latitude !== value.latitude || before.longitude !== value.longitude) await tx.update(demandContextFeeds).set({ currentSignalIds: [], lastSuccessAt: null, lastFailureCode: null, lastAttemptAt: new Date(0) }).where(eq(demandContextFeeds.outletId, scope.locationId));
    await tx.insert(auditEvents).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: scope.locationId, action: "VENUE_CONTEXT_SET", entityType: "outlet", entityId: scope.locationId, correlationId: `venue-context:${scope.locationId}`, metadata: { actorUserId: scope.userId, ...value } });
  });
}

// What the Owner sees and edits for the selected location.
export async function getStaffingConfiguration(db: DatabaseSession, scope: OwnerScope) {
  await authoriseOwner(db, scope);
  const policies = await db.select().from(workloadPolicies).where(and(eq(workloadPolicies.organisationId, scope.organisationId), eq(workloadPolicies.status, "ACTIVE")));
  const trading = await db.select().from(outletTradingHours).where(and(eq(outletTradingHours.organisationId, scope.organisationId), eq(outletTradingHours.outletId, scope.locationId)));
  const coverage = await db.select().from(regularCoverageWindows).where(and(eq(regularCoverageWindows.organisationId, scope.organisationId), eq(regularCoverageWindows.outletId, scope.locationId)));
  const [venue] = await db.select({ venueProfile: outlets.venueProfile, latitude: outlets.latitude, longitude: outlets.longitude, source: outlets.venueContextSource }).from(outlets).where(and(eq(outlets.id, scope.locationId), eq(outlets.organisationId, scope.organisationId)));
  return {
    venue: venue ?? { venueProfile: null, latitude: null, longitude: null, source: null },
    organisationPolicy: policies.find(row => row.outletId === null) ?? null,
    locationPolicy: policies.find(row => row.outletId === scope.locationId) ?? null,
    trading: Array.from({ length: 7 }, (_, i) => { const row = trading.find(item => item.isoWeekday === i + 1); return row ? { windows: tradingWindowsSchema.parse(row.windows) as TradingWindow[], source: row.source } : null; }),
    coverage: Array.from({ length: 7 }, (_, i) => { const row = coverage.find(item => item.isoWeekday === i + 1); return row ? { windows: coverageWindowsSchema.parse(row.windows) as CoverageWindow[], source: row.source } : null; }),
  };
}
