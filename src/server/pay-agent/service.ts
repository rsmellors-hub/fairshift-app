import { after } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { Scope } from "@/server/auth/access";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase, type Database } from "@/server/db/client";
import { workPayables } from "@/server/db/schema";
import { UserFacingError } from "@/server/domain/errors";
import { getPayPalPayoutClient } from "@/server/integrations/paypal/factory";
import { loadConfirmedWork } from "./evidence";
import { mintPayAgentCredentialForManager, mintPayAgentCredentialForRecovery, payAgentServiceVerifier, type PayAgentServiceCredential } from "./identity";
import { getPayAgentEvent, latestPayAgentEvents, recordPayAgentEvent, recoverablePayAgentEvents, resolveHold, type PayAgentEvent } from "./journal";
import { payAgentModelFor } from "./model";
import { createPayAgent, type PayAgentRun } from "./orchestrator";
import { confirmedWorkSettlement } from "./settlement";

// Production wiring of the FairShift Pay Agent (DEC-SA-011): the server-minted service identity,
// the configured model (only for the isolated Sandbox demo organisation) and the settlement
// adapter over the shared payout engine. The PayPal client is constructed only if a live,
// non-dry-run payout is actually reached.
export function payAgentFor(db: Database) {
  return createPayAgent({ db, identityVerifier: payAgentServiceVerifier, model: payAgentModelFor, settlement: confirmedWorkSettlement(db, getPayPalPayoutClient) });
}
export type PayAgent = ReturnType<typeof payAgentFor>;

export type AfterResponse = (task: () => Promise<unknown>) => void;
// Runs Pay Agent work after the response has been sent (next/server `after`, which also runs
// after a redirect). The durable event, not this callback, is the source of truth: if the process
// stops first, a manager's retry or the startup sweep takes the event up. Errors are contained
// here and never undo the confirmation. Outside a request (a script or a direct call) nothing is
// scheduled at all, never a detached promise: the event simply stays PENDING for recovery.
export const afterResponse: AfterResponse = task => {
  try {
    after(async () => {
      try { await task(); }
      catch (error) { console.error("Pay Agent processing did not complete; its durable event remains for recovery.", { error: error instanceof Error ? error.name : "unknown" }); }
    });
  } catch { /* No request scope: recovery takes up the durable event. */ }
};

type ManagerScope = Pick<Scope, "userId" | "organisationId" | "locationId" | "role" | "demo" | "workerId">;

// After a manager's confirmation has committed, processes its new PENDING event once the response
// is sent. The confirmation never waits for the model, and nothing here can make it fail. A worker
// or demo persona schedules nothing and never obtains the service credential.
export function schedulePayAgentEvent(agent: PayAgent, scope: ManagerScope, event: Pick<PayAgentEvent, "id" | "status"> | null | undefined, schedule: AfterResponse = afterResponse): boolean {
  if (!event || event.status !== "PENDING" || scope.demo || (scope.role !== "OWNER" && scope.role !== "MANAGER")) return false;
  try {
    const credential = mintPayAgentCredentialForManager(scope);
    schedule(() => agent.process({ eventId: event.id }, credential));
    return true;
  } catch { return false; }
}

// After a performance confirmation has committed: schedules the payable's latest event, which
// that confirmation recorded. Never fails the confirmation.
export async function scheduleLatestPayAgentEvent(db: Database, agent: PayAgent, scope: ManagerScope, allocationId: string, schedule: AfterResponse = afterResponse): Promise<boolean> {
  try {
    const [payable] = await db.select({ id: workPayables.id }).from(workPayables).where(and(
      eq(workPayables.allocationId, allocationId), eq(workPayables.organisationId, scope.organisationId), eq(workPayables.outletId, scope.locationId),
    ));
    if (!payable) return false;
    return schedulePayAgentEvent(agent, scope, (await latestPayAgentEvents(db, scope, [payable.id])).get(payable.id), schedule);
  } catch { return false; }
}

const RETRYABLE: ReadonlySet<string> = new Set(["PENDING", "CLAIMED", "FAILED_RETRYABLE", "REJECTED_OUTPUT", "FAILED_TERMINAL", "DECIDED_SETTLE", "HOLD_RELEASED", "SETTLING", "DRY_RUN_ELIGIBLE", "SETTLEMENT_BLOCKED"]);

// A manager's "Retry Pay Agent" for one payable. When the payable's evidence has changed since its
// latest event, a new event is recorded for the current evidence; otherwise the latest event is
// retried in place: a pending, failed or rejected model decision (within the attempt limit), or
// the settlement gates after a dry run or a block. Returns what to process after the response.
export async function preparePayAgentRetry(db: Database, scope: ManagerScope, payableId: string): Promise<{ eventId: string; status: string; credential: PayAgentServiceCredential; run: boolean }> {
  const credential = mintPayAgentCredentialForManager(scope);
  const evidence = z.uuid().safeParse(payableId).success ? await loadConfirmedWork(db, scope, payableId) : null;
  if (!evidence) throw new UserFacingError("pay-agent-unavailable", "This payment isn't available here.");
  const latest = (await latestPayAgentEvents(db, scope, [payableId])).get(payableId);
  if (!latest || latest.evidenceVersion !== evidence.evidenceVersion) {
    const event = await db.transaction(tx => recordPayAgentEvent(tx, scope, payableId, "EVIDENCE_REFRESHED", scope.userId));
    return { eventId: event.id, status: event.status, credential, run: event.status === "PENDING" };
  }
  if (latest.status === "DECIDED_HOLD") throw new UserFacingError("pay-agent-hold-pending", "Release or reject the Pay Agent's hold first.");
  if (!RETRYABLE.has(latest.status)) throw new UserFacingError("pay-agent-nothing-to-retry", "There is nothing for the Pay Agent to retry for this payment.");
  return { eventId: latest.id, status: latest.status, credential, run: true };
}

export function runPayAgentRetry(agent: PayAgent, prepared: { eventId: string; credential: PayAgentServiceCredential; run: boolean }, schedule: AfterResponse = afterResponse) {
  if (prepared.run) schedule(() => agent.process({ eventId: prepared.eventId }, prepared.credential, { manual: true }));
}

async function heldEvent(db: Database, scope: ManagerScope, eventId: string) {
  const event = await getPayAgentEvent(db, scope, eventId);
  if (!event || event.status !== "DECIDED_HOLD") throw new UserFacingError("pay-agent-hold-unavailable", "This hold has already been resolved or isn't available.");
  return event;
}

// A manager releases a hold: the payable goes through the settlement gates without asking the
// model again, and the journal records the manager's override. A hold on a manager's own work
// must be released by someone else.
export async function releasePayAgentHold(db: Database, scope: ManagerScope, eventId: string): Promise<{ eventId: string; credential: PayAgentServiceCredential }> {
  const credential = mintPayAgentCredentialForManager(scope);
  const event = await heldEvent(db, scope, eventId);
  const evidence = await loadConfirmedWork(db, scope, event.payableId);
  if (!evidence) throw new UserFacingError("pay-agent-unavailable", "This payment isn't available here.");
  if ((scope.workerId && scope.workerId === evidence.payable.workerId) || (evidence.worker?.userId && evidence.worker.userId === scope.userId)) {
    throw new UserFacingError("pay-agent-own-work", "A hold on your own work must be released by another manager.");
  }
  const released = await resolveHold(db, scope, eventId, { resolution: "RELEASED", userId: scope.userId, note: null });
  if (!released) throw new UserFacingError("pay-agent-hold-unavailable", "This hold has already been resolved or isn't available.");
  return { eventId: released.id, credential };
}

export function runReleasedHold(agent: PayAgent, released: { eventId: string; credential: PayAgentServiceCredential }, schedule: AfterResponse = afterResponse) {
  schedule(() => agent.process({ eventId: released.eventId }, released.credential));
}

// A manager rejects a hold, with a reason: the payable stays unpaid on every path.
export async function rejectPayAgentHold(db: Database, scope: ManagerScope, eventId: string, note: string): Promise<PayAgentEvent> {
  mintPayAgentCredentialForManager(scope);
  const reason = note.trim();
  if (!reason || reason.length > 500) throw new UserFacingError("pay-agent-reject-reason", "Give a reason for rejecting this payment, in up to 500 characters.");
  await heldEvent(db, scope, eventId);
  const rejected = await resolveHold(db, scope, eventId, { resolution: "REJECTED", userId: scope.userId, note: reason });
  if (!rejected) throw new UserFacingError("pay-agent-hold-unavailable", "This hold has already been resolved or isn't available.");
  return rejected;
}

// Recovery of interrupted work: events left PENDING, due for a retry, decided or released but not
// yet through the gates, or held by an expired claim. Each runs under a recovery credential scoped
// to the event's own organisation and location; atomic claims make a sweep that races live
// processing harmless, and a payout already held by the shared engine is never sent again.
export async function sweepPayAgentEvents(db: Database, agent: PayAgent, limit = 25): Promise<PayAgentRun[]> {
  const results: PayAgentRun[] = [];
  for (const event of await recoverablePayAgentEvents(db, limit)) {
    try { results.push(await agent.process({ eventId: event.id }, mintPayAgentCredentialForRecovery(event))); }
    catch { results.push({ eventId: event.id, status: "UNAVAILABLE", outcomeCode: null, event: null }); }
  }
  return results;
}

// Startup sweep, from src/instrumentation.ts. Never blocks the server from starting.
export function startPayAgentRecovery() {
  if (process.env.NEXT_PHASE === "phase-production-build" || !getConfigurationStatus().databaseConfigured) return;
  const db = getDatabase();
  void sweepPayAgentEvents(db, payAgentFor(db)).catch(error => {
    console.error("Pay Agent startup recovery did not complete; events remain for a later sweep or retry.", { error: error instanceof Error ? error.name : "unknown" });
  });
  // The Pay Agent's tip checks (FS-TIP-AGENT-DEC-001) recover the same way, from their own journal.
  void import("@/server/tips/wiring").then(({ sweepTips }) => sweepTips(db)).catch(error => {
    console.error("Pay Agent tip recovery did not complete; events remain for a later sweep or retry.", { error: error instanceof Error ? error.name : "unknown" });
  });
}
