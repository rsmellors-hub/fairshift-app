import { randomUUID } from "node:crypto";
import type { DatabaseSession } from "@/server/db/client";
import { locationShiftRules, organisationHoursRules } from "@/server/db/schema";
import { loadHoursRule, loadShiftRules } from "@/server/scheduling/shift-rules";

// Default offer settings for a new location and business (Owner instruction, 11 Nov 2026: seed the
// defaults so Fill › Approve works for a new business). The values are the Owner's decisions of
// 9 November 2026 (docs/FS-HACK-SA-AMENDMENT-001.md): shifts 4–8 h, preferring 6 h; a first round of
// 2 h, or until 12 h before the shift; cancellation pay 50% within 24 h; the hours alert at 20 h a week
// over 12 weeks. They are written once as the location's and business's own settings (source DEFAULT),
// which the Owner changes under Locations › Staffing and offers; an Owner's own settings are never overwritten.
export const DEFAULT_SHIFT_RULES = { minMinutes: 240, maxMinutes: 480, preferredMinutes: 360, firstRoundMinutes: 120, firstRoundCutoffMinutes: 720, cancellationPercent: 50, cancellationWindowMinutes: 1440 } as const;
export const DEFAULT_HOURS_RULE = { weeklyThresholdMinutes: 20 * 60, referenceWeeks: 12 } as const;

export async function ensureDefaultRules(db: DatabaseSession, organisationId: string, outletId: string, userId: string | null = null) {
  const added = { shiftRules: false, hoursRule: false };
  if (!(await loadShiftRules(db, organisationId, [outletId])).has(outletId)) {
    await db.insert(locationShiftRules).values({ id: randomUUID(), organisationId, outletId, ...DEFAULT_SHIFT_RULES, source: "DEFAULT", createdBy: userId });
    added.shiftRules = true;
  }
  if (!await loadHoursRule(db, organisationId)) {
    await db.insert(organisationHoursRules).values({ id: randomUUID(), organisationId, ...DEFAULT_HOURS_RULE, source: "DEFAULT", createdBy: userId });
    added.hoursRule = true;
  }
  return added;
}
