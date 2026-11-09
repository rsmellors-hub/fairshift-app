import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "@/server/db/client";
import { departments, locationShiftRules, organisationHoursRules, outlets, workPolicies } from "@/server/db/schema";
import { SA_REFERENCE_ORGANISATION } from "@/server/reference/sa-reference";
import { createDepartment, createWorkPolicy } from "@/server/scheduling/operations";
import { DEMO_BOOKING } from "./booking";
import { loadHoursRule, loadShiftRules } from "@/server/scheduling/shift-rules";

// Seed data for the fictional demo business only (R1: demo values live in seed data). The values are the
// Owner's decisions of 9 November 2026 (docs/FS-HACK-SA-AMENDMENT-001.md); they are written once as the
// business's and each location's own settings (source DEMO_SEED), which the Owner can change. FairShift's
// code reads only those stored settings, never these values.
// Added once where none exists, so an Owner's own change is never overwritten.
export const DEMO_SHIFT_RULES = { minMinutes: 240, maxMinutes: 480, preferredMinutes: 360, firstRoundMinutes: 120, firstRoundCutoffMinutes: 720 } as const;
export const DEMO_HOURS_RULE = { weeklyThresholdMinutes: 20 * 60, referenceWeeks: 12 } as const;
export async function ensureDemoRules(db: Database, organisationId: string) {
  const sites = await db.select({ id: outlets.id }).from(outlets).where(eq(outlets.organisationId, organisationId));
  const existing = await loadShiftRules(db, organisationId, sites.map(site => site.id));
  const missing = sites.filter(site => !existing.has(site.id));
  if (missing.length) await db.insert(locationShiftRules).values(missing.map(site => ({ id: randomUUID(), organisationId, outletId: site.id, ...DEMO_SHIFT_RULES, source: "DEMO_SEED" })));
  if (!await loadHoursRule(db, organisationId)) await db.insert(organisationHoursRules).values({ id: randomUUID(), organisationId, ...DEMO_HOURS_RULE, source: "DEMO_SEED" });
  return { shiftRulesAdded: missing.length, payTermsAdded: await ensureDemoPayTerms(db, organisationId) };
}

// Every location of the fictional demo business gets the demo's casual role and hourly terms (the
// Owner-approved demo value of 8 November 2026, R45.00 an hour, above the national minimum), so a
// suggested shift can be approved anywhere. Created through the normal operations, once per location;
// an Owner's own roles and terms are left as they are. Only the demo business is seeded.
export async function ensureDemoPayTerms(db: Database, organisationId: string) {
  if (organisationId !== SA_REFERENCE_ORGANISATION.id) return 0;
  const sites = await db.select({ id: outlets.id }).from(outlets).where(and(eq(outlets.organisationId, organisationId), eq(outlets.active, true)));
  let added = 0;
  for (const site of sites) {
    const scope = { organisationId, locationId: site.id };
    const [department] = await db.select({ id: departments.id }).from(departments).where(and(eq(departments.outletId, site.id), eq(departments.name, DEMO_BOOKING.department))).limit(1);
    if (!department) { await createDepartment(db, DEMO_BOOKING.department, scope); added++; }
    const [policy] = await db.select({ id: workPolicies.id }).from(workPolicies).where(and(eq(workPolicies.outletId, site.id), eq(workPolicies.name, DEMO_BOOKING.policy), eq(workPolicies.earningsModel, "HOURLY"), isNull(workPolicies.incentiveTargetMinor))).limit(1);
    if (!policy) { await createWorkPolicy(db, { earningsModel: "HOURLY", rateMinor: DEMO_BOOKING.rateMinor }, DEMO_BOOKING.policy, scope); added++; }
  }
  return added;
}

