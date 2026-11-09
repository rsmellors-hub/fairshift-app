import { and, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import { AccessError, type Scope } from "@/server/auth/access";
import type { Database, DatabaseSession } from "@/server/db/client";
import { randomUUID } from "node:crypto";
import { localIntelligenceDecisions, localIntelligenceSignalDecisions, memberships, outlets, shiftIncentives, shiftOffers, shifts, workAllocations, workPayables, workPerformanceResults } from "@/server/db/schema";
import { UserFacingError } from "@/server/domain/errors";
import { ensureDemoBooking } from "./booking";
import type { DemoConfig } from "./config";
import { demoAudit, limited } from "./session";

// Enough for several judges at once, without letting one visitor fill the schedule.
export const DEMO_OPEN_SHIFT_LIMIT = 12;
const WRITE_LIMIT = 60, GLOBAL_WRITE_LIMIT = 600, RESET_LIMIT = 6;

// Shifts carrying evidence of finished work. Demo sessions can't change them and a reset keeps them.
async function protectedShiftIds(db: DatabaseSession, organisationId: string) {
  const inOrganisation = db.select({ id: outlets.id }).from(outlets).where(eq(outlets.organisationId, organisationId));
  const rows = await Promise.all([
    db.select({ id: shifts.id }).from(shifts).where(and(inArray(shifts.outletId, inOrganisation), eq(shifts.status, "COMPLETED"))),
    db.select({ id: workPayables.shiftId }).from(workPayables).where(eq(workPayables.organisationId, organisationId)),
    db.select({ id: workPerformanceResults.shiftId }).from(workPerformanceResults).innerJoin(shifts, eq(shifts.id, workPerformanceResults.shiftId)).where(inArray(shifts.outletId, inOrganisation)),
    db.select({ id: shiftIncentives.shiftId }).from(shiftIncentives).innerJoin(shifts, eq(shifts.id, shiftIncentives.shiftId)).where(inArray(shifts.outletId, inOrganisation)),
    db.select({ id: shiftOffers.shiftId }).from(workAllocations).innerJoin(shiftOffers, eq(shiftOffers.id, workAllocations.offerId)).innerJoin(shifts, eq(shifts.id, shiftOffers.shiftId)).where(and(inArray(shifts.outletId, inOrganisation), isNotNull(workAllocations.confirmedAt))),
  ]);
  return [...new Set(rows.flat().map(row => row.id))];
}

// Every write a demo session may make goes through here first. Outside a demo session it does nothing.
export async function guardDemoWrite(db: DatabaseSession, scope: Scope, target: { shiftId?: string; offerId?: string; creatingShift?: boolean }) {
  if (!scope.demo) return;
  await limited(db, `demo-write:${scope.demo.group}`, WRITE_LIMIT);
  await limited(db, "demo-write", GLOBAL_WRITE_LIMIT);
  const held = await protectedShiftIds(db, scope.organisationId);
  let shiftId = target.shiftId;
  if (target.offerId) shiftId = (await db.select({ shiftId: shiftOffers.shiftId }).from(shiftOffers).where(eq(shiftOffers.id, target.offerId)))[0]?.shiftId;
  if (!target.creatingShift && (!shiftId || held.includes(shiftId))) throw new UserFacingError("demo-protected", "This is prepared demonstration evidence, so it can’t be changed.");
  if (target.creatingShift) {
    const [open] = await db.select({ count: sql<number>`count(*)`.mapWith(Number) }).from(shifts).innerJoin(outlets, eq(outlets.id, shifts.outletId))
      .where(and(eq(outlets.organisationId, scope.organisationId), eq(shifts.status, "PUBLISHED"), held.length ? notInArray(shifts.id, held) : undefined));
    if ((open?.count ?? 0) >= DEMO_OPEN_SHIFT_LIMIT) throw new UserFacingError("demo-full", "The demo schedule is full. Use Reset demo to restore the prepared state.");
  }
}

// Restores the prepared state: every live shift in the designated organisation without
// finished-work evidence is closed, with its offers. Nothing is deleted, because acceptance evidence
// is immutable by design: closed records are kept and left out of demo views. People, accounts,
// sales, payments and provider evidence aren't touched. Then the booked casual shift for tomorrow
// that the DEMO early notice needs is made again (ensureDemoBooking), for the demo Worker persona
// where possible, so a fresh notice can always be sent. Running it again changes nothing further.
// Signed-in accounts of the demo business (judges' Owner, Manager and Worker accounts) may reset it too
// (Owner decision, 9 November 2026). A reset also returns the AI story to its start: days whose AI-found
// adjustments were accepted go back to their baseline, and dismissed signals come back, each as a new
// recorded decision (nothing is deleted).
export async function resetDemo(db: Database, config: DemoConfig | null, scope: Scope, now = new Date()) {
  if (!config || scope.organisationId !== config.organisationId) throw new AccessError();
  await limited(db, `demo-reset:${scope.demo?.group ?? scope.userId}`, RESET_LIMIT);
  const closed = await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`demo-reset:${config.organisationId}`}))`);
    const held = await protectedShiftIds(tx, config.organisationId);
    const inOrganisation = tx.select({ id: outlets.id }).from(outlets).where(eq(outlets.organisationId, config.organisationId));
    const live = (await tx.select({ id: shifts.id }).from(shifts).where(and(inArray(shifts.outletId, inOrganisation), eq(shifts.status, "PUBLISHED"), held.length ? notInArray(shifts.id, held) : undefined))).map(row => row.id);
    if (!live.length) return 0;
    // The same path as any cancellation: a database trigger closes the shift's offers and keeps acceptance evidence.
    await tx.update(shifts).set({ status: "CANCELLED", updatedAt: new Date() }).where(inArray(shifts.id, live));
    return live.length;
  });
  const story = await resetAiStory(db, config.organisationId, scope, now);
  const [worker] = await db.select({ workerId: memberships.workerId }).from(memberships).where(and(eq(memberships.id, config.WORKER), eq(memberships.organisationId, config.organisationId)));
  const booking = await ensureDemoBooking(db, { organisationId: config.organisationId, workerId: worker?.workerId, now, rebuild: true });
  await demoAudit(db, config.organisationId, "DEMO_RESET", scope.demo?.group ?? scope.userId, { closedShifts: closed, persona: scope.demo?.persona ?? null, actorUserId: scope.userId, signedIn: !scope.demo, bookedShiftId: booking?.shiftId ?? null, ...story });
  return { closedShifts: closed, booking, ...story };
}

async function resetAiStory(db: Database, organisationId: string, scope: Scope, now: Date) {
  // Only an Owner or Manager decides on AI findings; a Worker's reset leaves those decisions as they are.
  if (scope.role !== "OWNER" && scope.role !== "MANAGER") return { withdrawnDays: 0, restoredSignals: 0 };
  const role = scope.role;
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`demo-reset-ai:${organisationId}`}))`);
    const decisions = await tx.select().from(localIntelligenceDecisions).where(eq(localIntelligenceDecisions.organisationId, organisationId));
    const latest = new Map<string, typeof decisions[number]>();
    for (const row of decisions) { const key = `${row.outletId}:${row.targetDate}`; if (!latest.has(key) || latest.get(key)!.sequence < row.sequence) latest.set(key, row); }
    const withdraw = [...latest.values()].filter(row => row.action === "ACCEPTED");
    if (withdraw.length) await tx.insert(localIntelligenceDecisions).values(withdraw.map(row => ({ id: randomUUID(), organisationId, outletId: row.outletId, targetDate: row.targetDate, sequence: row.sequence + 1, action: "WITHDRAWN",
      adjustmentFingerprint: row.adjustmentFingerprint, adjustments: row.adjustments, policyVersion: row.policyVersion, decidedBy: scope.userId, decidedByRole: role, decidedAt: now })));
    const dismissals = await tx.select().from(localIntelligenceSignalDecisions).where(eq(localIntelligenceSignalDecisions.organisationId, organisationId));
    const last = new Map<string, typeof dismissals[number]>();
    for (const row of dismissals) { const key = `${row.outletId}:${row.signalKey}`; if (!last.has(key) || last.get(key)!.decidedAt < row.decidedAt) last.set(key, row); }
    const restore = [...last.values()].filter(row => row.action === "DISMISSED");
    if (restore.length) await tx.insert(localIntelligenceSignalDecisions).values(restore.map(row => ({ id: randomUUID(), organisationId, outletId: row.outletId, signalKey: row.signalKey, signalId: row.signalId, action: "RESTORED", decidedBy: scope.userId, decidedByRole: role, decidedAt: now })));
    return { withdrawnDays: withdraw.length, restoredSignals: restore.length };
  });
}

// Used by the demo copy, so it only mentions earlier evidence that actually exists.
export async function hasEarlierEvidence(db: DatabaseSession, organisationId: string) {
  const rows = await db.select({ id: workPayables.id }).from(workPayables).where(eq(workPayables.organisationId, organisationId)).limit(1);
  return rows.length > 0;
}
