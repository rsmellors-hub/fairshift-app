import { randomUUID } from "node:crypto";
import { and, asc, eq, gte, inArray, isNotNull, lte, sql, isNull } from "drizzle-orm";
import { worksAt } from "@/server/people/worker-locations";
import { assertRole, type Scope } from "@/server/auth/access";
import type { Database, DatabaseSession } from "@/server/db/client";
import { auditEvents, departments, offerRounds, outlets, shiftOffers, shifts, workers, workPayables, workPolicies } from "@/server/db/schema";
import { UserFacingError } from "@/server/domain/errors";
import { createShiftFromOpportunity } from "@/server/intelligence/opportunity-shifts";
import type { OutletStaffing } from "@/server/intelligence/staffing";
import { offerAssignment } from "@/server/scheduling/operations";

// Suggested shifts (Day 6, Step 1i): each location's open casual gap, cut into shift blocks with that
// location's own shift-length rules (deterministic, no AI). The AI briefing may rank and explain them;
// it never books a shift or chooses a worker. A Manager or Owner approves one in one click: the shift is
// created on the location's work policy, and offers go out in the fair offer order (FS-OFFER-ORDER-DEC-001,
// Owner decisions of 9 November 2026), round 1 then round 2. Workers accept; the Manager finalises.

import { loadHoursRule, loadShiftRules, suggestShifts, type ShiftRules, type SuggestedShift } from "@/server/scheduling/shift-rules";
export { cutWindow, loadHoursRule, loadShiftRules, suggestionKey, suggestShifts, type HoursRule, type ShiftRules, type SuggestedShift } from "@/server/scheduling/shift-rules";
// --- The fair offer order ---------------------------------------------------------------------------

type OperatingScope = Pick<Scope, "organisationId" | "locationId"> & { userId?: string };
const hours = (minutes: number) => `${new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 }).format(minutes / 60)} h`;
const at = (instant: Date, timeZone: string) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(instant);

// Completed, approved hours in the reference period, per worker (FS-PATHWAY-DEC-001).
export async function approvedMinutes(db: DatabaseSession, organisationId: string, workerIds: readonly string[], since: Date) {
  if (!workerIds.length) return new Map<string, number>();
  const rows = await db.select({ workerId: workPayables.workerId, minutes: sql<number>`coalesce(sum(extract(epoch from (${workPayables.scheduledEndsAt} - ${workPayables.scheduledStartsAt})) / 60), 0)`.mapWith(Number) })
    .from(workPayables).where(and(eq(workPayables.organisationId, organisationId), inArray(workPayables.workerId, [...workerIds]), isNotNull(workPayables.approvedAt), gte(workPayables.scheduledStartsAt, since)))
    .groupBy(workPayables.workerId);
  return new Map(rows.map(row => [row.workerId, Math.round(row.minutes)]));
}

// Offers one shift to each worker in turn, keeping those that can take it: workers who are working
// then, or said they're unavailable, are skipped by the same checks as any offer.
async function offerEach(db: Database, shiftId: string, workerIds: readonly string[], scope: OperatingScope) {
  const offered: { workerId: string; offerId: string }[] = [], skipped: { workerId: string; reason: string }[] = [];
  for (const workerId of workerIds) {
    try { const offer = await offerAssignment(db, shiftId, workerId, scope, { round: true }); offered.push({ workerId, offerId: offer.id }); }
    catch (error) { skipped.push({ workerId, reason: error instanceof UserFacingError ? error.feedback : "unavailable" }); }
  }
  return { offered, skipped };
}

// Starts the offer rounds for a shift just created from a suggestion. Round 1 when it has anyone and
// time; otherwise straight to round 2.
export async function startOfferRounds(db: Database, scope: OperatingScope, shiftId: string, now = new Date()) {
  const [shift] = await db.select().from(shifts).where(and(eq(shifts.id, shiftId), eq(shifts.outletId, scope.locationId)));
  if (!shift || shift.status !== "PUBLISHED") throw new UserFacingError("assignment-unavailable", "That shift is no longer open.");
  const [outlet] = await db.select({ timezone: outlets.timezone }).from(outlets).where(eq(outlets.id, scope.locationId));
  const [rules, hoursRule] = [(await loadShiftRules(db, scope.organisationId, [scope.locationId])).get(scope.locationId), await loadHoursRule(db, scope.organisationId)];
  if (!rules || !hoursRule) throw new UserFacingError("offer-rules-missing", "This location's offer settings aren't set yet, so offers can't go out automatically.");
  const pool = await db.select({ id: workers.id, wantsMoreHours: workers.wantsMoreHours }).from(workers)
    .where(and(eq(workers.organisationId, scope.organisationId), worksAt(scope.locationId), eq(workers.workerType, "CASUAL"), eq(workers.status, "ACTIVE"), isNotNull(workers.userId))).orderBy(asc(workers.id));
  const threshold = hoursRule.weeklyThresholdMinutes * hoursRule.referenceWeeks;
  const done = await approvedMinutes(db, scope.organisationId, pool.map(row => row.id), new Date(now.getTime() - hoursRule.referenceWeeks * 7 * 86_400_000));
  const left = (id: string) => Math.max(0, threshold - (done.get(id) ?? 0));
  const first = pool.filter(row => row.wantsMoreHours).sort((a, b) => left(a.id) - left(b.id) || a.id.localeCompare(b.id));
  const closesAt = new Date(Math.min(now.getTime() + rules.firstRoundMinutes * 60_000, shift.startsAt.getTime() - rules.firstRoundCutoffMinutes * 60_000));
  if (first.length && closesAt > now) {
    const result = await offerEach(db, shift.id, first.map(row => row.id), scope);
    if (result.offered.length) {
      const criteria = `Round 1: offered first to workers here who said they want more hours, fewest hours left to this business's ${hours(hoursRule.weeklyThresholdMinutes)}-a-week alert (over ${hoursRule.referenceWeeks} weeks) first. Open until ${at(closesAt, outlet.timezone)}; the earliest acceptances fill the ${shift.requiredHeadcount === 1 ? "place" : `${shift.requiredHeadcount} places`}.`;
      await recordRound(db, scope, shift.id, 1, now, closesAt, criteria, result.offered.map(row => ({ ...row, minutesLeft: left(row.workerId) })), result.skipped);
      return { round: 1, offered: result.offered.length };
    }
  }
  return openSecondRound(db, scope, shift.id, now, closesAt <= now ? "The shift starts too soon for a first round." : first.length ? "No one in round 1 could take it." : "No worker here has said they want more hours.");
}

async function recordRound(db: DatabaseSession, scope: OperatingScope, shiftId: string, round: 1 | 2, openedAt: Date, closesAt: Date | null, criteria: string, offers: unknown[], skipped: unknown[]) {
  const [row] = await db.insert(offerRounds).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: scope.locationId, shiftId, round, openedAt, closesAt, criteria, offers, openedBy: scope.userId ?? null }).onConflictDoNothing().returning();
  if (row) await db.insert(auditEvents).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: scope.locationId, action: `OFFER_ROUND_${round}_OPENED`, entityType: "offer_round", entityId: row.id,
    correlationId: `offer-rounds:${shiftId}`, metadata: { shiftId, offered: offers.length, skipped, closesAt: closesAt?.toISOString() ?? null, actorUserId: scope.userId ?? null } });
  return row;
}

async function openSecondRound(db: Database, scope: OperatingScope, shiftId: string, now: Date, why: string) {
  const offeredAlready = new Set((await db.select({ workerId: shiftOffers.workerId }).from(shiftOffers).where(eq(shiftOffers.shiftId, shiftId))).map(row => row.workerId));
  const pool = await db.select({ id: workers.id }).from(workers)
    .where(and(eq(workers.organisationId, scope.organisationId), worksAt(scope.locationId), eq(workers.workerType, "CASUAL"), eq(workers.status, "ACTIVE"), isNotNull(workers.userId))).orderBy(asc(workers.id));
  const result = await offerEach(db, shiftId, pool.filter(row => !offeredAlready.has(row.id)).map(row => row.id), scope);
  await recordRound(db, scope, shiftId, 2, now, null, `Round 2: open to every other eligible worker at this location until the shift is filled. ${why}`, result.offered, result.skipped);
  return { round: 2, offered: result.offered.length };
}

// Scheduler: when a first round's window has closed and the shift still has places, round 2 opens.
export async function advanceOfferRounds(db: Database, organisationIds: readonly string[], now = new Date()) {
  if (!organisationIds.length) return { opened: 0 };
  const due = await db.select({ round: offerRounds, headcount: shifts.requiredHeadcount }).from(offerRounds).innerJoin(shifts, eq(shifts.id, offerRounds.shiftId))
    .where(and(inArray(offerRounds.organisationId, [...organisationIds]), eq(offerRounds.round, 1), lte(offerRounds.closesAt, now), eq(shifts.status, "PUBLISHED"), sql`${shifts.startsAt} > ${now}`,
      sql`not exists (select 1 from ${offerRounds} r2 where r2.shift_id = ${offerRounds.shiftId} and r2.round = 2)`));
  let opened = 0;
  for (const { round, headcount } of due) {
    const [{ accepted }] = await db.select({ accepted: sql<number>`count(*)`.mapWith(Number) }).from(shiftOffers).where(and(eq(shiftOffers.shiftId, round.shiftId), eq(shiftOffers.status, "ACCEPTED")));
    if (accepted >= headcount) continue;
    await openSecondRound(db, { organisationId: round.organisationId, locationId: round.outletId }, round.shiftId, now, "Round 1's window closed with places still open.");
    opened++;
  }
  return { opened };
}

// --- One-click approval -------------------------------------------------------------------------------

// The suggestion is only a pointer: it is worked out again here from the current figures and rules.
export async function approveSuggestedShift(db: Database, scope: Scope, input: { key: string; departmentId: string; policyId: string }, readOutlet: () => Promise<(OutletStaffing & { shiftRules?: ShiftRules | null }) | null>, now = new Date()) {
  assertRole(scope, ["OWNER", "MANAGER"]);
  const outlet = await readOutlet();
  const suggestion = outlet ? suggestShifts(outlet).find(row => row.key === input.key) : null;
  if (!suggestion) throw new UserFacingError("opportunity-changed", "This suggested shift has changed. Check the latest figures.");
  if (Date.parse(suggestion.startsAt) <= now.getTime()) throw new UserFacingError("opportunity-changed", "This suggested shift has already started.");
  // Approving twice never makes a second shift: one already published at these times stands for it.
  if ((await approvedShiftFor(db, scope, suggestion)).length) throw new UserFacingError("suggestion-approved", "This suggested shift has already been approved.");
  const shift = await createShiftFromOpportunity(db, { departmentId: input.departmentId, policyId: input.policyId, startsAt: new Date(suggestion.startsAt), endsAt: new Date(suggestion.endsAt), requiredHeadcount: suggestion.headcount, date: suggestion.date, window: suggestion.window }, scope, now);
  await db.insert(auditEvents).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: scope.locationId, action: "SUGGESTED_SHIFT_APPROVED", entityType: "shift", entityId: shift.id,
    correlationId: `offer-rounds:${shift.id}`, metadata: { actorUserId: scope.userId, role: scope.role, suggestion } });
  const rounds = await startOfferRounds(db, scope, shift.id, now);
  return { shift, ...rounds };
}

// The published shift(s) at this location exactly matching a suggestion: it has been approved.
export function approvedShiftFor(db: DatabaseSession, scope: Pick<Scope, "locationId">, suggestion: Pick<SuggestedShift, "startsAt" | "endsAt">) {
  return db.select({ id: shifts.id, requiredHeadcount: shifts.requiredHeadcount }).from(shifts)
    .where(and(eq(shifts.outletId, scope.locationId), eq(shifts.status, "PUBLISHED"), eq(shifts.startsAt, new Date(suggestion.startsAt)), eq(shifts.endsAt, new Date(suggestion.endsAt))));
}

// What each shift's rounds were, for the Manager's view and each worker's offer.
export async function roundsForShifts(db: DatabaseSession, scope: Pick<Scope, "organisationId" | "locationId">, shiftIds: readonly string[]) {
  if (!shiftIds.length) return new Map<string, (typeof offerRounds.$inferSelect)[]>();
  const rows = await db.select().from(offerRounds).where(and(eq(offerRounds.organisationId, scope.organisationId), eq(offerRounds.outletId, scope.locationId), inArray(offerRounds.shiftId, [...shiftIds]))).orderBy(asc(offerRounds.round));
  const map = new Map<string, (typeof offerRounds.$inferSelect)[]>();
  for (const row of rows) map.set(row.shiftId, [...(map.get(row.shiftId) ?? []), row]);
  return map;
}

// What the Plan page needs beside the suggestions: the roles and hourly pay terms to choose from, and,
// for each suggestion already approved, its shift's rounds and how many have accepted.
export async function suggestionContext(db: DatabaseSession, scope: Pick<Scope, "organisationId" | "locationId">, suggestions: readonly SuggestedShift[]) {
  const [departmentRows, policyRows] = await Promise.all([
    db.select({ id: departments.id, name: departments.name }).from(departments).where(eq(departments.outletId, scope.locationId)).orderBy(asc(departments.name)),
    db.select({ id: workPolicies.id, name: workPolicies.name, earningsModel: workPolicies.earningsModel, rateMinor: workPolicies.rateMinor, currencyCode: workPolicies.currencyCode }).from(workPolicies).where(and(eq(workPolicies.outletId, scope.locationId), isNull(workPolicies.supersededAt))).orderBy(asc(workPolicies.name)),
  ]);
  const approved = new Map<string, { shiftId: string; rounds: { round: number; closesAt: Date | null; offered: number }[]; accepted: number; headcount: number }>();
  const matches = await Promise.all(suggestions.map(async suggestion => ({ suggestion, shift: (await approvedShiftFor(db, scope, suggestion))[0] })));
  const shiftIds = matches.flatMap(row => row.shift ? [row.shift.id] : []);
  const rounds = await roundsForShifts(db, scope, shiftIds);
  const accepted = shiftIds.length ? await db.select({ shiftId: shiftOffers.shiftId, count: sql<number>`count(*)`.mapWith(Number) }).from(shiftOffers).where(and(inArray(shiftOffers.shiftId, shiftIds), eq(shiftOffers.status, "ACCEPTED"))).groupBy(shiftOffers.shiftId) : [];
  for (const { suggestion, shift } of matches) if (shift) approved.set(suggestion.key, { shiftId: shift.id, headcount: shift.requiredHeadcount, accepted: accepted.find(row => row.shiftId === shift.id)?.count ?? 0,
    rounds: (rounds.get(shift.id) ?? []).map(row => ({ round: row.round, closesAt: row.closesAt, offered: Array.isArray(row.offers) ? row.offers.length : 0 })) });
  return { departments: departmentRows, policies: policyRows.filter(row => row.earningsModel === "HOURLY" && (row.rateMinor ?? 0) > 0).map(({ id, name, rateMinor, currencyCode }) => ({ id, name, rateMinor: rateMinor!, currencyCode })), approved };
}
