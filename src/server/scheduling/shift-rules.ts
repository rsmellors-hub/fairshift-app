import { and, desc, eq, inArray } from "drizzle-orm";
import type { DatabaseSession } from "@/server/db/client";
import { locationShiftRules, organisationHoursRules } from "@/server/db/schema";
import type { OutletStaffing } from "@/server/intelligence/staffing";
import { formatClock } from "@/server/intelligence/workload";

// A location's shift-length rules and offer-round window, and a business's guaranteed-hours alert:
// Owner settings stored as dated versions (Owner decisions, 9 November 2026). No defaults in code.
export type ShiftRules = { minMinutes: number; maxMinutes: number; preferredMinutes: number; firstRoundMinutes: number; firstRoundCutoffMinutes: number; cancellationPercent: number; cancellationWindowMinutes: number; source: string; createdAt: Date };
export type HoursRule = { weeklyThresholdMinutes: number; referenceWeeks: number; source: string; createdAt: Date };

// --- Rules: the latest dated version stands ------------------------------------------------------

export async function loadShiftRules(db: DatabaseSession, organisationId: string, outletIds: readonly string[]) {
  if (!outletIds.length) return new Map<string, ShiftRules>();
  const rows = await db.select().from(locationShiftRules).where(and(eq(locationShiftRules.organisationId, organisationId), inArray(locationShiftRules.outletId, [...outletIds]))).orderBy(desc(locationShiftRules.createdAt));
  const result = new Map<string, ShiftRules>();
  for (const row of rows) if (!result.has(row.outletId)) result.set(row.outletId, row);
  return result;
}
export async function loadHoursRule(db: DatabaseSession, organisationId: string): Promise<HoursRule | null> {
  const [row] = await db.select().from(organisationHoursRules).where(eq(organisationHoursRules.organisationId, organisationId)).orderBy(desc(organisationHoursRules.createdAt)).limit(1);
  return row ?? null;
}


export type SuggestedShift = { key: string; date: string; start: number; end: number; minutes: number; headcount: number; window: string; windowRemainingMinutes: number; startsAt: string; endsAt: string };

const QUARTER = 15;
const roundQuarter = (minutes: number) => Math.round(minutes / QUARTER) * QUARTER;
export const suggestionKey = (date: string, start: number, end: number) => `${date}T${formatClock(start)}-${formatClock(end)}`;

// One open window cut into blocks: as close to the preferred length as the rules allow, every block
// between the minimum and maximum. A window shorter than the minimum becomes one minimum-length block,
// kept inside the day's trading hours. Headcount is the window's peak casual staff, never resized to
// avoid an offer or a threshold.
export function cutWindow(window: { start: number; end: number }, rules: Pick<ShiftRules, "minMinutes" | "maxMinutes" | "preferredMinutes">, trading: { open: number; close: number }) {
  const length = window.end - window.start;
  if (length <= 0) return [];
  if (length < rules.minMinutes) {
    const end = Math.min(trading.close, window.start + rules.minMinutes);
    const start = Math.max(trading.open, end - rules.minMinutes);
    return [{ start, end: Math.max(end, start + Math.min(rules.minMinutes, trading.close - trading.open)) }];
  }
  let count = Math.max(1, Math.round(length / rules.preferredMinutes));
  while (length / count > rules.maxMinutes) count++;
  while (count > 1 && length / count < rules.minMinutes) count--;
  const blocks: { start: number; end: number }[] = [];
  let start = window.start;
  for (let i = 0; i < count; i++) {
    const end = i === count - 1 ? window.end : Math.min(window.end, start + roundQuarter((window.end - start) / (count - i)));
    blocks.push({ start, end });
    start = end;
  }
  return blocks;
}

const toInstant = (periodStartsAt: string, periodStart: number, minute: number) => new Date(Date.parse(periodStartsAt) + (minute - periodStart) * 60_000).toISOString();

// Every open window in the planning week, cut into suggested shifts. Without rules there are none.
export function suggestShifts(outlet: Pick<OutletStaffing, "days"> & { shiftRules?: ShiftRules | null }): SuggestedShift[] {
  const rules = outlet.shiftRules;
  if (!rules) return [];
  return outlet.days.flatMap(day => {
    if (!day.blocks.length) return [];
    const trading = { open: Math.min(...day.blocks.map(block => block.start)), close: Math.max(...day.blocks.map(block => block.end)) };
    return day.periods.filter(period => period.state === "OPEN" && period.remainingMinutes > 0).flatMap(period => cutWindow(period, rules, trading).map(block => ({
      key: suggestionKey(day.planningDate, block.start, block.end), date: day.planningDate, start: block.start, end: block.end, minutes: block.end - block.start,
      headcount: Math.max(1, period.peakCasualStaff), window: `${formatClock(period.start)}-${formatClock(period.end)}`, windowRemainingMinutes: period.remainingMinutes,
      startsAt: toInstant(period.startsAt, period.start, block.start), endsAt: toInstant(period.startsAt, period.start, block.end),
    })));
  });
}

