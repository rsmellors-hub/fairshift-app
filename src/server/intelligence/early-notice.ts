import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray, lt } from "drizzle-orm";
import { assertRole, type Scope } from "@/server/auth/access";
import { requireEntitlement } from "@/server/billing/entitlement";
import type { Database, DatabaseSession } from "@/server/db/client";
import { auditEvents, notifications, shiftOffers, shifts, workAllocations, workers } from "@/server/db/schema";
import { UserFacingError } from "@/server/domain/errors";
import { localDate, shiftDate, startOfLocalDay } from "@/server/intelligence/forecast";
import { coversBlock } from "@/server/intelligence/local-intelligence-contract";
import type { LocalSignalView } from "@/server/intelligence/local-intelligence-service";
import { notify } from "@/server/notifications/service";

// Early shift notice (Owner decision, 8 November 2026). When AI finds, with a source, that a location
// will probably be unable to trade, FairShift recommends telling the casual workers whose allocated
// shifts that covers, early, so a short-notice cancellation is avoided. Nothing is sent until the Owner
// confirms. A notice cancels no shift and changes no pay: accepted terms, and how a cancellation would
// be handled, stay exactly as they are. Each worker hears once per shift and finding.

export type AffectedShift = { offerId: string; shiftId: string; workerId: string; workerName: string; startsAt: Date; endsAt: Date; noticeAt: Date | null };
export const noticeKey = (signalKey: string, offerId: string) => `early-notice:${signalKey}:${offerId}`;
const minuteOf = (instant: Date, timeZone: string) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(instant).map(part => [part.type, part.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
};

// Allocated casual work at the location, not yet started, that the finding bears on in any hour.
export async function affectedShifts(db: DatabaseSession, target: { organisationId: string; outletId: string; timezone: string }, signal: Pick<LocalSignalView, "key" | "validFrom" | "validTo" | "startMinute" | "endMinute" | "shiftBlocks">, now: Date): Promise<AffectedShift[]> {
  const from = startOfLocalDay(signal.validFrom, target.timezone), to = startOfLocalDay(shiftDate(signal.validTo, 1), target.timezone);
  const rows = await db.select({ offerId: shiftOffers.id, shiftId: shifts.id, workerId: workers.id, workerName: workers.displayName, startsAt: shifts.startsAt, endsAt: shifts.endsAt })
    .from(workAllocations).innerJoin(shiftOffers, eq(shiftOffers.id, workAllocations.offerId)).innerJoin(shifts, eq(shifts.id, shiftOffers.shiftId)).innerJoin(workers, eq(workers.id, shiftOffers.workerId))
    .where(and(eq(shifts.outletId, target.outletId), eq(workers.organisationId, target.organisationId), eq(workers.workerType, "CASUAL"),
      eq(workAllocations.state, "ALLOCATED"), eq(shiftOffers.status, "ACCEPTED"), eq(shifts.status, "PUBLISHED"), gt(shifts.startsAt, now), lt(shifts.startsAt, to), gt(shifts.endsAt, from)));
  const covered = rows.filter(row => {
    const date = localDate(row.startsAt, target.timezone), start = minuteOf(row.startsAt, target.timezone);
    const end = localDate(row.endsAt, target.timezone) === date ? minuteOf(row.endsAt, target.timezone) : 1440;
    for (let minute = start; minute < end; minute += 60) if (coversBlock(signal, date, { start: minute, end: Math.min(minute + 60, end) })) return true;
    return false;
  });
  if (!covered.length) return [];
  const sent = await db.select({ key: notifications.eventKey, createdAt: notifications.createdAt }).from(notifications).where(inArray(notifications.eventKey, covered.map(row => noticeKey(signal.key, row.offerId))));
  return covered.map(row => ({ ...row, noticeAt: sent.find(notice => notice.key === noticeKey(signal.key, row.offerId))?.createdAt ?? null })).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

export type EarlyNoticeAlert = { signal: LocalSignalView; outletId: string; outletName: string; timezone: string };

// The Owner's confirmation. The form names only the location and the finding: whether it is still a
// current closure alert, and who it affects, are worked out again here. Public demo visitors are
// simulated and send nothing (Owner decision, 9 November 2026); a signed-in Owner, including a judge's
// account of the demo business, sends it in the app.
export async function sendEarlyNotice(db: Database, scope: Pick<Scope, "userId" | "organisationId" | "role" | "demo">, input: { outletId: string; signalKey: string }, readAlert: (outletId: string, signalKey: string) => Promise<EarlyNoticeAlert | null>, now = new Date()) {
  assertRole(scope as Scope, ["OWNER"]);
  if (scope.demo) throw new UserFacingError("demo-simulated", "Simulated in the public demo: no notice was sent.");
  await requireEntitlement(db, scope.organisationId);
  const alert = await readAlert(input.outletId, input.signalKey);
  if (!alert || !alert.signal.closureLikely) throw new UserFacingError("early-notice-unavailable", "That alert is no longer current, so no notice was sent.");
  const affected = (await affectedShifts(db, { organisationId: scope.organisationId, outletId: alert.outletId, timezone: alert.timezone }, alert.signal, now)).filter(row => !row.noticeAt);
  if (!affected.length) throw new UserFacingError("early-notice-none", "Every casual worker this affects has already had the notice.");
  const people = await db.select({ id: workers.id, email: workers.email, userId: workers.userId }).from(workers).where(and(eq(workers.organisationId, scope.organisationId), inArray(workers.id, affected.map(row => row.workerId))));
  const pending = affected;
  const day = (instant: Date) => new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: alert.timezone }).format(instant);
  const time = (instant: Date) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: alert.timezone }).format(instant);
  // A DEMO scenario's notice says so, and names no source: it has none.
  const demo = !!alert.signal.demo;
  return db.transaction(async tx => {
    let sent = 0;
    for (const shift of pending) {
      const person = people.find(row => row.id === shift.workerId);
      if (!person?.email) continue;
      const notice = await notify(tx, { id: randomUUID(), organisationId: scope.organisationId, userId: person.userId, workerId: person.id, recipientEmail: person.email, eventKey: noticeKey(alert.signal.key, shift.offerId), kind: "EARLY_SHIFT_NOTICE", entityId: shift.offerId,
        title: `${demo ? "DEMO: " : ""}Your shift on ${day(shift.startsAt)} may not go ahead`,
        body: `${alert.signal.name} may stop ${alert.outletName} trading on ${day(shift.startsAt)}. This is an early heads-up from your employer so you can plan. Your manager will confirm whether your ${time(shift.startsAt)}–${time(shift.endsAt)} shift goes ahead. This notice doesn’t cancel your shift, and it doesn’t change your accepted terms or how a cancellation would be handled. ${demo ? "This is a DEMO scenario made for the demonstration, not a real event." : `Where this came from: ${alert.signal.sourceUrl}`}`,
        href: "/worker/shifts" });
      if (notice) sent++;
    }
    await tx.insert(auditEvents).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: alert.outletId, action: "EARLY_SHIFT_NOTICE_SENT", entityType: "local_intelligence_signal", entityId: alert.signal.id,
      correlationId: `local-intelligence:${alert.outletId}`, metadata: { actorUserId: scope.userId, signalKey: alert.signal.key, offerIds: pending.map(row => row.offerId), sent, demoScenario: demo, publicDemo: scope.demo ? { persona: scope.demo.persona, group: scope.demo.group } : null } });
    return { sent, workerIds: [...new Set(pending.map(row => row.workerId))] };
  });
}
