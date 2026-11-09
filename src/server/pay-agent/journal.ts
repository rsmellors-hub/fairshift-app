import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { Database, DatabaseSession } from "@/server/db/client";
import { auditEvents, payAgentEvents } from "@/server/db/schema";
import { loadConfirmedWork, preModelCheck, type PayAgentScope } from "./evidence";

// The durable Pay Agent journal over pay_agent_events (drizzle/0027_pay_agent_events.sql).
// Every transition is one conditional UPDATE, so the database decides which caller wins:
// a claim succeeds only from a claimable state, takes a new fencing token and an unexpired
// lease, and is finished only by the holder of that token. A crashed or slow holder's late
// write therefore changes nothing, and an expired lease lets recovery take the event over.
// Each finished attempt is also written to audit_events, so retries keep their history.

export type PayAgentEvent = typeof payAgentEvents.$inferSelect;
export type PayAgentEventStatus =
  | "PENDING" | "CLAIMED" | "SKIPPED" | "BLOCKED" | "REJECTED_OUTPUT" | "FAILED_RETRYABLE" | "FAILED_TERMINAL"
  | "DECIDED_SETTLE" | "DECIDED_HOLD" | "HOLD_RELEASED" | "HOLD_REJECTED"
  | "SETTLING" | "DRY_RUN_ELIGIBLE" | "SETTLEMENT_BLOCKED" | "SETTLEMENT_SUBMITTED";
export type PayAgentTrigger = "WORK_CONFIRMED" | "PERFORMANCE_CONFIRMED" | "EVIDENCE_REFRESHED";

// Operational limits, not payment policy. A claim is presumed abandoned after its lease, and
// a model is asked at most MAX_MODEL_ATTEMPTS times for one event; retryable failures wait
// RETRY_DELAY_SECONDS[n] before automatic recovery may try again.
export const CLAIM_LEASE_SECONDS = 120;
export const MAX_MODEL_ATTEMPTS = 3;
export const RETRY_DELAY_SECONDS = [60, 300, 900] as const;
export const MODEL_NOT_CONFIGURED_RETRY_SECONDS = 900;

const LEASE = sql.raw(`now() + interval '${CLAIM_LEASE_SECONDS} seconds'`);
const after = (seconds: number) => sql.raw(`now() + interval '${Math.max(0, Math.trunc(seconds))} seconds'`);
const leaseExpired = (status: "CLAIMED" | "SETTLING") => and(eq(payAgentEvents.status, status), lte(payAgentEvents.leaseExpiresAt, sql`now()`));

async function audit(db: DatabaseSession, event: PayAgentEvent, action: string, metadata: Record<string, unknown>) {
  await db.insert(auditEvents).values({ id: randomUUID(), organisationId: event.organisationId, outletId: event.outletId, action, entityType: "pay_agent_event",
    entityId: event.id, correlationId: `payable:${event.payableId}`, metadata });
}

// Records the Pay Agent event for a payable's current evidence, inside the caller's
// transaction. Unique per (payable, evidence version): a repeat returns the existing event.
// Deterministic outcomes that need no model are recorded as SKIPPED or BLOCKED with their
// authoritative reason, never discarded.
export async function recordPayAgentEvent(tx: DatabaseSession, scope: PayAgentScope, payableId: string, trigger: PayAgentTrigger, createdBy: string | null): Promise<PayAgentEvent> {
  const evidence = await loadConfirmedWork(tx, scope, payableId);
  if (!evidence) throw new Error("Payable unavailable.");
  const outcome = preModelCheck(evidence);
  const now = new Date();
  const [created] = await tx.insert(payAgentEvents).values({
    id: randomUUID(), organisationId: scope.organisationId, outletId: scope.locationId, payableId: evidence.payableId,
    evidenceVersion: evidence.evidenceVersion, trigger, createdBy,
    status: outcome?.status ?? "PENDING", outcomeCode: outcome?.code ?? null, completedAt: outcome ? now : null, createdAt: now, updatedAt: now,
  }).onConflictDoNothing({ target: [payAgentEvents.payableId, payAgentEvents.evidenceVersion] }).returning();
  if (!created) {
    const [existing] = await tx.select().from(payAgentEvents)
      .where(and(eq(payAgentEvents.payableId, evidence.payableId), eq(payAgentEvents.evidenceVersion, evidence.evidenceVersion)));
    return existing;
  }
  await audit(tx, created, "PAY_AGENT_EVENT_RECORDED", { actorUserId: createdBy, trigger, status: created.status, outcomeCode: created.outcomeCode, evidenceVersion: created.evidenceVersion });
  return created;
}

export async function getPayAgentEvent(db: DatabaseSession, scope: PayAgentScope, eventId: string): Promise<PayAgentEvent | null> {
  if (!z.uuid().safeParse(eventId).success) return null;
  const [event] = await db.select().from(payAgentEvents).where(and(
    eq(payAgentEvents.id, eventId), eq(payAgentEvents.organisationId, scope.organisationId), eq(payAgentEvents.outletId, scope.locationId),
  ));
  return event ?? null;
}

// The most recent event of each payable, in scope.
export async function latestPayAgentEvents(db: DatabaseSession, scope: PayAgentScope, payableIds: string[]): Promise<Map<string, PayAgentEvent>> {
  const latest = new Map<string, PayAgentEvent>();
  if (!payableIds.length) return latest;
  const rows = await db.select().from(payAgentEvents).where(and(
    eq(payAgentEvents.organisationId, scope.organisationId), eq(payAgentEvents.outletId, scope.locationId), inArray(payAgentEvents.payableId, payableIds),
  )).orderBy(desc(payAgentEvents.createdAt));
  for (const row of rows) if (!latest.has(row.payableId)) latest.set(row.payableId, row);
  return latest;
}

async function claim(db: DatabaseSession, scope: PayAgentScope, eventId: string, status: "CLAIMED" | "SETTLING", claimable: SQL | undefined): Promise<PayAgentEvent | null> {
  if (!z.uuid().safeParse(eventId).success) return null;
  const [row] = await db.update(payAgentEvents).set({
    status, claimToken: randomUUID(), claimedAt: sql`now()`, leaseExpiresAt: LEASE,
    attemptCount: sql`${payAgentEvents.attemptCount} + 1`, outcomeCode: null, nextAttemptAt: null, completedAt: null, updatedAt: sql`now()`,
    ...(status === "CLAIMED" ? { errorClass: null, configuredModel: null, responseModel: null, responseId: null } : { dryRun: null }),
  }).where(and(eq(payAgentEvents.id, eventId), eq(payAgentEvents.organisationId, scope.organisationId), eq(payAgentEvents.outletId, scope.locationId), claimable)).returning();
  return row ?? null;
}

// Claims an event for its model decision. Automatic processing takes a new event, a due
// retryable failure or an abandoned claim; a manager's retry may also restart a rejected
// output or a terminal model failure (within MAX_MODEL_ATTEMPTS, checked by the caller).
export function claimForModel(db: DatabaseSession, scope: PayAgentScope, eventId: string, options: { manual: boolean }) {
  return claim(db, scope, eventId, "CLAIMED", options.manual
    ? or(inArray(payAgentEvents.status, ["PENDING", "FAILED_RETRYABLE", "REJECTED_OUTPUT", "FAILED_TERMINAL"]), leaseExpired("CLAIMED"))
    : or(eq(payAgentEvents.status, "PENDING"), and(eq(payAgentEvents.status, "FAILED_RETRYABLE"), lte(payAgentEvents.nextAttemptAt, sql`now()`)), leaseExpired("CLAIMED")));
}

// Claims a decided (or manager-released) event for the settlement gates. A manager's retry
// may also re-run the gates after a dry run or a block, under the same evidence version.
export function claimForSettlement(db: DatabaseSession, scope: PayAgentScope, eventId: string, options: { manual: boolean }) {
  return claim(db, scope, eventId, "SETTLING", options.manual
    ? or(inArray(payAgentEvents.status, ["DECIDED_SETTLE", "HOLD_RELEASED", "DRY_RUN_ELIGIBLE", "SETTLEMENT_BLOCKED"]), leaseExpired("SETTLING"))
    : or(inArray(payAgentEvents.status, ["DECIDED_SETTLE", "HOLD_RELEASED"]), leaseExpired("SETTLING")));
}

// Counts a model call against the owned claim before it is made, so a crash mid-call
// still counts towards MAX_MODEL_ATTEMPTS. False when the claim is no longer owned.
export async function recordModelCall(db: DatabaseSession, claimed: PayAgentEvent): Promise<PayAgentEvent | null> {
  const [row] = await db.update(payAgentEvents).set({ modelCallCount: sql`${payAgentEvents.modelCallCount} + 1`, updatedAt: sql`now()` })
    .where(and(eq(payAgentEvents.id, claimed.id), eq(payAgentEvents.status, "CLAIMED"), eq(payAgentEvents.claimToken, claimed.claimToken!))).returning();
  return row ?? null;
}

export type ClaimFinish = {
  status: PayAgentEventStatus;
  outcomeCode?: string | null; errorClass?: string | null;
  configuredModel?: string | null; responseModel?: string | null; responseId?: string | null;
  decision?: "SETTLE" | "HOLD"; reasonCode?: string; summary?: string; checks?: Record<string, string>;
  dryRun?: boolean | null; payoutId?: string | null;
  retryAfterSeconds?: number;
};
const TERMINAL: ReadonlySet<PayAgentEventStatus> = new Set(["SKIPPED", "BLOCKED", "REJECTED_OUTPUT", "FAILED_TERMINAL", "HOLD_REJECTED", "DRY_RUN_ELIGIBLE", "SETTLEMENT_BLOCKED", "SETTLEMENT_SUBMITTED"]);

// Finishes the attempt that owns `claimed` (compare-and-set on its token and phase) and
// writes the attempt to audit_events in the same transaction. Null when the claim was lost:
// that late result is discarded, never written over the current owner's state.
export async function finishClaim(db: Database, claimed: PayAgentEvent, finish: ClaimFinish): Promise<PayAgentEvent | null> {
  const { retryAfterSeconds, decision, reasonCode, summary, checks, ...values } = finish;
  return db.transaction(async tx => {
    const [row] = await tx.update(payAgentEvents).set({
      ...values,
      ...(decision ? { decision, reasonCode: reasonCode ?? null, summary: summary ?? null, checks: checks ?? null, decidedAt: sql`now()` } : {}),
      nextAttemptAt: retryAfterSeconds === undefined ? null : after(retryAfterSeconds),
      completedAt: TERMINAL.has(finish.status) ? sql`now()` : null,
      claimToken: null, claimedAt: null, leaseExpiresAt: null, updatedAt: sql`now()`,
    }).where(and(eq(payAgentEvents.id, claimed.id), eq(payAgentEvents.status, claimed.status), eq(payAgentEvents.claimToken, claimed.claimToken!))).returning();
    if (!row) return null;
    await audit(tx, row, "PAY_AGENT_ATTEMPT_FINISHED", {
      actorService: "fairshift-pay-agent", attempt: row.attemptCount, modelCalls: row.modelCallCount, phase: claimed.status, status: row.status,
      outcomeCode: row.outcomeCode, errorClass: row.errorClass, decision: row.decision, reasonCode: row.reasonCode,
      configuredModel: row.configuredModel, responseModel: row.responseModel, responseId: row.responseId, dryRun: row.dryRun, payoutId: row.payoutId,
    });
    return row;
  });
}

// A manager's release or rejection of a HOLD (existing Owner/Manager permission). Final.
export async function resolveHold(db: Database, scope: PayAgentScope, eventId: string, input: { resolution: "RELEASED" | "REJECTED"; userId: string; note: string | null; actor?: { actorUserId: string; actorRole: string; sessionType: string } }): Promise<PayAgentEvent | null> {
  if (!z.uuid().safeParse(eventId).success) return null;
  return db.transaction(async tx => {
    const rejected = input.resolution === "REJECTED";
    const [row] = await tx.update(payAgentEvents).set({
      status: rejected ? "HOLD_REJECTED" : "HOLD_RELEASED", resolution: input.resolution, resolvedBy: input.userId, resolvedAt: sql`now()`, resolutionNote: input.note,
      outcomeCode: rejected ? "MANAGER_REJECTED" : null, completedAt: rejected ? sql`now()` : null, updatedAt: sql`now()`,
    }).where(and(eq(payAgentEvents.id, eventId), eq(payAgentEvents.organisationId, scope.organisationId), eq(payAgentEvents.outletId, scope.locationId), eq(payAgentEvents.status, "DECIDED_HOLD"))).returning();
    if (!row) return null;
    await audit(tx, row, rejected ? "PAY_AGENT_HOLD_REJECTED" : "PAY_AGENT_HOLD_RELEASED", { actorUserId: input.userId, ...input.actor, outcome: input.resolution, managerOverride: !rejected, reasonCode: row.reasonCode, note: input.note });
    return row;
  });
}

// Events that recovery may take forward: new, due for a retry, decided or released but not
// yet through the gates, or held by an abandoned claim. Oldest first.
export async function recoverablePayAgentEvents(db: DatabaseSession, limit = 25): Promise<PayAgentEvent[]> {
  return db.select().from(payAgentEvents).where(or(
    eq(payAgentEvents.status, "PENDING"),
    and(eq(payAgentEvents.status, "FAILED_RETRYABLE"), lte(payAgentEvents.nextAttemptAt, sql`now()`), lt(payAgentEvents.modelCallCount, MAX_MODEL_ATTEMPTS)),
    inArray(payAgentEvents.status, ["DECIDED_SETTLE", "HOLD_RELEASED"]),
    leaseExpired("CLAIMED"), leaseExpired("SETTLING"),
  )).orderBy(asc(payAgentEvents.createdAt)).limit(limit);
}
