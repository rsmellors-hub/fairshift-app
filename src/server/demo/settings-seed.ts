import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "@/server/db/client";
import { locationShiftRules, organisationHoursRules, outlets } from "@/server/db/schema";
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
  return { shiftRulesAdded: missing.length };
}

