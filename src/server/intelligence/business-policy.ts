import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { assertRole, type Scope } from "@/server/auth/access";
import { requireEntitlement } from "@/server/billing/entitlement";
import type { Database, DatabaseSession } from "@/server/db/client";
import { auditEvents, labourPolicies, outlets, regularStaffCoverage } from "@/server/db/schema";
import { isMinorUnitCurrency } from "@/server/domain/currency";
import { localDate } from "@/server/intelligence/forecast";
import { loadDailySales } from "@/server/intelligence/sales-history";
import { selectForecastSource } from "@/server/intelligence/weekly";

// A business's own staffing inputs: its labour-productivity policy and its regular
// rota. Owners configure them; managers only consume the resolved result.

export const MAX_SALES_MINOR_PER_LABOUR_HOUR = 10_000_000;
export type PolicyLevel = "ORGANISATION" | "LOCATION";
type OwnerScope = Pick<Scope, "userId" | "organisationId" | "locationId" | "role">;

const policyInput = z.object({
  currencyCode: z.string().refine(isMinorUnitCurrency, "Unsupported currency."),
  salesMinorPerLabourHour: z.number().int().min(1).max(MAX_SALES_MINOR_PER_LABOUR_HOUR),
}).strict();

async function authoriseOwner(db: DatabaseSession, scope: OwnerScope) {
  assertRole(scope as Scope, ["OWNER"]);
  await requireEntitlement(db, scope.organisationId);
  const [outlet] = await db.select({ id: outlets.id }).from(outlets).where(and(eq(outlets.id, scope.locationId), eq(outlets.organisationId, scope.organisationId)));
  if (!outlet) throw new Error("Location unavailable.");
}

const scopeFilter = (organisationId: string, outletId: string | null) => and(eq(labourPolicies.organisationId, organisationId), outletId ? eq(labourPolicies.outletId, outletId) : isNull(labourPolicies.outletId));

// Appends a new active version unless the active one already says the same thing.
export async function writeLabourPolicyVersion(tx: DatabaseSession, input: { organisationId: string; outletId: string | null; currencyCode: string; salesMinorPerLabourHour: number; source: "CONFIGURED" | "REFERENCE"; createdBy: string | null }) {
  const versions = await tx.select().from(labourPolicies).where(scopeFilter(input.organisationId, input.outletId)).orderBy(desc(labourPolicies.version)).for("update");
  const active = versions.find(row => row.status === "ACTIVE");
  if (active && active.currencyCode === input.currencyCode && active.salesMinorPerLabourHour === input.salesMinorPerLabourHour && active.source === input.source) return active;
  const now = new Date();
  if (active) await tx.update(labourPolicies).set({ status: "SUPERSEDED", supersededAt: now }).where(eq(labourPolicies.id, active.id));
  const [created] = await tx.insert(labourPolicies).values({ id: randomUUID(), ...input, version: (versions[0]?.version ?? 0) + 1, createdAt: now }).returning();
  await tx.insert(auditEvents).values({ id: randomUUID(), organisationId: input.organisationId, outletId: input.outletId, action: "LABOUR_POLICY_SET", entityType: "labour_policy", entityId: created.id,
    correlationId: `labour-policy:${input.organisationId}`, metadata: { actorUserId: input.createdBy, version: created.version, currencyCode: created.currencyCode, salesMinorPerLabourHour: created.salesMinorPerLabourHour, source: created.source } });
  return created;
}

// Organisation default, or an override for the Owner's currently selected location.
export async function setLabourPolicy(db: Database, scope: OwnerScope, level: PolicyLevel, input: unknown) {
  await authoriseOwner(db, scope);
  const value = policyInput.parse(input);
  return db.transaction(tx => writeLabourPolicyVersion(tx, { organisationId: scope.organisationId, outletId: level === "LOCATION" ? scope.locationId : null, ...value, source: "CONFIGURED", createdBy: scope.userId }));
}

// Without a policy at this level the next level applies, or labour becomes unavailable.
export async function clearLabourPolicy(db: Database, scope: OwnerScope, level: PolicyLevel) {
  await authoriseOwner(db, scope);
  const outletId = level === "LOCATION" ? scope.locationId : null;
  return db.transaction(async tx => {
    const [cleared] = await tx.update(labourPolicies).set({ status: "SUPERSEDED", supersededAt: new Date() })
      .where(and(scopeFilter(scope.organisationId, outletId), eq(labourPolicies.status, "ACTIVE"))).returning();
    if (cleared) await tx.insert(auditEvents).values({ id: randomUUID(), organisationId: scope.organisationId, outletId, action: "LABOUR_POLICY_CLEARED", entityType: "labour_policy", entityId: cleared.id,
      correlationId: `labour-policy:${scope.organisationId}`, metadata: { actorUserId: scope.userId, version: cleared.version } });
    return cleared ?? null;
  });
}

const coverageInput = z.array(z.number().int().min(0).max(1_440_000).nullable()).length(7);

// The selected location's standing weekly rota, planned minutes Monday..Sunday.
// Zero is a configured zero; null means this weekday is not set, so its gap is unavailable.
export async function setRegularCoverage(db: Database, scope: OwnerScope, plannedMinutes: unknown) {
  await authoriseOwner(db, scope);
  const minutes = coverageInput.parse(plannedMinutes);
  return db.transaction(async tx => {
    const unset = minutes.flatMap((value, i) => value === null ? [i + 1] : []);
    if (unset.length) await tx.delete(regularStaffCoverage).where(and(eq(regularStaffCoverage.outletId, scope.locationId), inArray(regularStaffCoverage.isoWeekday, unset)));
    const rows = minutes.flatMap((value, i) => value === null ? [] : [{ id: randomUUID(), organisationId: scope.organisationId, outletId: scope.locationId, isoWeekday: i + 1, plannedMinutes: value, source: "CONFIGURED" }]);
    if (rows.length) for (const row of rows) await tx.insert(regularStaffCoverage).values(row).onConflictDoUpdate({
      target: [regularStaffCoverage.outletId, regularStaffCoverage.isoWeekday], set: { plannedMinutes: row.plannedMinutes, source: "CONFIGURED", updatedAt: new Date() } });
    await tx.insert(auditEvents).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: scope.locationId, action: "REGULAR_COVERAGE_SET", entityType: "outlet", entityId: scope.locationId,
      correlationId: `regular-coverage:${scope.locationId}`, metadata: { actorUserId: scope.userId, plannedMinutes: minutes } });
    return rows.length;
  });
}

// What the Owner sees and edits for the selected location.
export async function getStaffingConfiguration(db: DatabaseSession, scope: OwnerScope) {
  await authoriseOwner(db, scope);
  const policies = await db.select().from(labourPolicies).where(and(eq(labourPolicies.organisationId, scope.organisationId), eq(labourPolicies.status, "ACTIVE")));
  const coverage = await db.select().from(regularStaffCoverage).where(and(eq(regularStaffCoverage.organisationId, scope.organisationId), eq(regularStaffCoverage.outletId, scope.locationId)));
  const [outlet] = await db.select({ timezone: outlets.timezone }).from(outlets).where(eq(outlets.id, scope.locationId));
  const selection = selectForecastSource(await loadDailySales(db, scope.organisationId, [scope.locationId]), localDate(new Date(), outlet.timezone));
  return {
    organisationPolicy: policies.find(row => row.outletId === null) ?? null,
    locationPolicy: policies.find(row => row.outletId === scope.locationId) ?? null,
    coverage: Array.from({ length: 7 }, (_, i) => coverage.find(row => row.isoWeekday === i + 1) ?? null),
    evidenceCurrency: selection.status === "SELECTED" ? selection.currency : null,
  };
}
