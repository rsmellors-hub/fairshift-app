import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createTestDatabase } from "../helpers/database";
import { confirmedWork, payAgentCompany, allocatedWork } from "../helpers/pay-agent";
import { approveWorkPayable } from "@/server/payments/work-payouts";
import { auditEvents, payAgentEvents, workAllocations, workPayables, workers } from "@/server/db/schema";
import { confirmWork } from "@/server/scheduling/operations";
import { confirmWorkPerformance } from "@/server/performance/attribution";
import { loadConfirmedWork, modelView, preModelCheck, type ConfirmedWorkEvidence } from "@/server/pay-agent/evidence";
import {
  claimForModel, claimForSettlement, finishClaim, getPayAgentEvent, latestPayAgentEvents, recordModelCall,
  recordPayAgentEvent, recoverablePayAgentEvents, resolveHold,
} from "@/server/pay-agent/journal";

type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];
const eventsOf = (db: Db) => db.select().from(payAgentEvents);
const expireLease = (db: Db, id: string) => db.update(payAgentEvents).set({ leaseExpiresAt: sql`now() - interval '1 second'` }).where(eq(payAgentEvents.id, id));

describe("durable Pay Agent event on manager confirmation", () => {
  it("commits one event with the confirmation and payable, and a replay returns the same event", async () => {
    const t = await createTestDatabase();
    try {
      const manager = (await payAgentCompany(t.db)).scopes[0];
      const work = await confirmedWork(t.db, manager);
      expect(work.payable).toMatchObject({ status: "PENDING_REVIEW", baseAmountMinor: 7_800 });
      expect(work.payAgentEvent).toMatchObject({
        payableId: work.payable!.id, organisationId: manager.organisationId, outletId: manager.locationId,
        status: "PENDING", trigger: "WORK_CONFIRMED", createdBy: manager.userId, attemptCount: 0, modelCallCount: 0, decision: null,
      });
      const evidence = await loadConfirmedWork(t.db, manager, work.payable!.id);
      expect(work.payAgentEvent!.evidenceVersion).toBe(evidence!.evidenceVersion);
      expect(work.payAgentEvent!.evidenceVersion).toMatch(/^[0-9a-f]{64}$/);
      // Replays and concurrent repeats resolve to the one event; nothing is approved or paid.
      const again = await confirmWork(t.db, work.offer.id, manager);
      const concurrent = await Promise.all([1, 2, 3].map(() => confirmWork(t.db, work.offer.id, manager)));
      for (const result of [again, ...concurrent]) expect(result.payAgentEvent!.id).toBe(work.payAgentEvent!.id);
      expect(await eventsOf(t.db)).toHaveLength(1);
      expect(await t.db.select().from(workPayables)).toHaveLength(1);
      expect(await t.db.select().from(auditEvents).where(eq(auditEvents.action, "PAY_AGENT_EVENT_RECORDED"))).toHaveLength(1);
    } finally { await t.close(); }
  });

  it("rolls back confirmation, payable and event together when the event cannot be written", async () => {
    const t = await createTestDatabase();
    try {
      const manager = (await payAgentCompany(t.db)).scopes[0];
      const work = await allocatedWork(t.db, manager);
      await t.db.execute(sql`CREATE FUNCTION test_refuse_pay_agent_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test refusal'; END $$`);
      await t.db.execute(sql`CREATE TRIGGER test_refuse_pay_agent_event BEFORE INSERT ON pay_agent_events FOR EACH ROW EXECUTE FUNCTION test_refuse_pay_agent_event()`);
      await expect(confirmWork(t.db, work.offer.id, manager)).rejects.toThrow();
      expect(await t.db.select().from(workPayables)).toHaveLength(0);
      expect(await eventsOf(t.db)).toHaveLength(0);
      const [allocation] = await t.db.select().from(workAllocations).where(eq(workAllocations.offerId, work.offer.id));
      expect(allocation.confirmedAt).toBeNull();
      expect(await t.db.select().from(auditEvents).where(eq(auditEvents.action, "WORK_CONFIRMED"))).toHaveLength(0);
      // Once the event can be written, the same confirmation commits all three.
      await t.db.execute(sql`DROP TRIGGER test_refuse_pay_agent_event ON pay_agent_events`);
      const result = await confirmWork(t.db, work.offer.id, manager);
      expect(result.payAgentEvent).toMatchObject({ status: "PENDING", payableId: result.payable!.id });
      expect(await eventsOf(t.db)).toHaveLength(1);
    } finally { await t.close(); }
  });

  it("creates no event when no payable is produced, and keeps the confirmation audit", async () => {
    const t = await createTestDatabase();
    try {
      // Commission terms made before Day 6, Step 3a (written directly by the fixture) still confirm, with no payable.
      const manager = (await payAgentCompany(t.db, { country: "South Africa" })).scopes[0];
      const work = await confirmedWork(t.db, manager, { commission: true });
      expect(work).toMatchObject({ payable: null, payableState: "ATTRIBUTION_REQUIRED", payAgentEvent: null });
      expect(await eventsOf(t.db)).toHaveLength(0);
      expect(await t.db.select().from(auditEvents).where(eq(auditEvents.action, "WORK_CONFIRMED"))).toHaveLength(1);
    } finally { await t.close(); }
  });

  it("records an ineligible payable as BLOCKED with its reason, then a new event once performance is confirmed", async () => {
    const t = await createTestDatabase();
    try {
      const manager = (await payAgentCompany(t.db)).scopes[0];
      const work = await confirmedWork(t.db, manager, { incentive: true });
      expect(work.payable).toMatchObject({ incentiveRequired: true, incentiveAmountMinor: null });
      expect(work.payAgentEvent).toMatchObject({ status: "BLOCKED", outcomeCode: "PERFORMANCE_REQUIRED" });
      expect(work.payAgentEvent!.completedAt).not.toBeNull();
      const blocked = await loadConfirmedWork(t.db, manager, work.payable!.id);
      expect(blocked!.missing).toContain("PERFORMANCE_RESULT");
      expect(blocked!.payable.finalAmountMinor).toBeNull();
      // Unknown sales are not zero: confirming the (empty) result is a new, eligible version.
      await confirmWorkPerformance(t.db, manager, work.allocationId, { count: 0, minor: 0 });
      const events = await t.db.select().from(payAgentEvents).where(eq(payAgentEvents.payableId, work.payable!.id));
      expect(events).toHaveLength(2);
      const fresh = events.find(event => event.id !== work.payAgentEvent!.id)!;
      expect(fresh).toMatchObject({ status: "PENDING", trigger: "PERFORMANCE_CONFIRMED", outcomeCode: null });
      expect(fresh.evidenceVersion).not.toBe(work.payAgentEvent!.evidenceVersion);
      expect((await latestPayAgentEvents(t.db, manager, [work.payable!.id])).get(work.payable!.id)!.id).toBe(fresh.id);
    } finally { await t.close(); }
  });
});

describe("confirmed-work evidence reader", () => {
  it("is scoped, keeps its version through settlement-only changes and changes with work evidence", async () => {
    const t = await createTestDatabase();
    try {
      const company = await payAgentCompany(t.db, { locations: 2 });
      const [manager, otherLocation] = company.scopes;
      const outsider = (await payAgentCompany(t.db)).scopes[0];
      const work = await confirmedWork(t.db, manager);
      const id = work.payable!.id;
      const first = (await loadConfirmedWork(t.db, manager, id))!;
      expect((await loadConfirmedWork(t.db, manager, id))!.evidenceVersion).toBe(first.evidenceVersion);
      expect(await loadConfirmedWork(t.db, otherLocation, id)).toBeNull();
      expect(await loadConfirmedWork(t.db, outsider, id)).toBeNull();
      expect(await loadConfirmedWork(t.db, manager, "not-a-uuid")).toBeNull();
      expect(first).toMatchObject({ missing: [], managerRejected: false, payout: null, offer: { status: "ACCEPTED" }, allocation: { state: "ALLOCATED" }, acceptance: { termsVersion: 1, acknowledged: true } });
      expect(preModelCheck(first)).toBeNull();

      // Approval and the payment destination are settlement facts, outside the version.
      await approveWorkPayable(t.db, manager, id);
      await t.db.update(workers).set({ paypalPayoutEmail: "changed.destination@example.test" }).where(eq(workers.id, work.worker.id));
      expect((await loadConfirmedWork(t.db, manager, id))!.evidenceVersion).toBe(first.evidenceVersion);
      // A change to the worker's eligibility is work evidence: the version moves.
      await t.db.update(workers).set({ status: "INACTIVE" }).where(eq(workers.id, work.worker.id));
      const changed = (await loadConfirmedWork(t.db, manager, id))!;
      expect(changed.evidenceVersion).not.toBe(first.evidenceVersion);
      expect(preModelCheck(changed)).toEqual({ status: "BLOCKED", code: "WORKER_NOT_ELIGIBLE" });
    } finally { await t.close(); }
  });

  it("shows the model work facts only: no names, contact details, amounts, currency or funding", async () => {
    const t = await createTestDatabase();
    try {
      const manager = (await payAgentCompany(t.db, { country: "South Africa" })).scopes[0];
      const work = await confirmedWork(t.db, manager, { paymentEmail: "visible.destination@example.test" });
      const evidence = (await loadConfirmedWork(t.db, manager, work.payable!.id))!;
      expect(evidence.payable).toMatchObject({ currencyCode: "ZAR", baseAmountMinor: 23_400, finalAmountMinor: 23_400 });
      const view = modelView(evidence);
      const keys: string[] = [], values: unknown[] = [];
      const walk = (value: unknown) => {
        if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) { keys.push(key.toLowerCase()); walk(item); }
        else values.push(value);
      };
      walk(view);
      for (const key of keys) for (const hidden of ["amount", "currency", "rate", "recipient", "email", "name", "merchant", "funding", "worker", "user", "confirmedby"]) expect(key).not.toContain(hidden);
      for (const value of values) {
        expect([23_400, 3_900, 234, 39]).not.toContain(value);
        if (typeof value === "string") {
          expect(value).not.toContain("@");
          for (const hidden of [work.worker.displayName, work.worker.email, "ZAR", work.worker.id, manager.userId]) expect(value).not.toBe(hidden);
        }
      }
      expect(view).toMatchObject({ payableId: evidence.payableId, evidenceVersion: evidence.evidenceVersion, terms: { earningsModel: "HOURLY", payableTermsVersion: 1, acceptedTermsVersion: 1 }, missing: [] });
    } finally { await t.close(); }
  });

  it("orders deterministic pre-model outcomes: payout, rejection, authority, incentive, nothing payable", () => {
    const base = {
      organisationId: "o", locationId: "l", payableId: "p", evidenceVersion: "v",
      payable: { id: "p", workerId: "w", shiftId: "s", offerId: "f", allocationId: "a", acceptanceId: "c", status: "PENDING_REVIEW", termsVersion: 1, calculationMethod: "confirm-as-scheduled-v1", earningsModel: "HOURLY", currencyCode: "GBP", rateMinor: 1300, baseAmountMinor: 7800, incentiveRequired: false, incentiveAmountMinor: null, finalAmountMinor: 7800, approvedAmountMinor: null, approvedCurrencyCode: null, scheduledStartsAt: new Date(0), scheduledEndsAt: new Date(1), confirmedAt: new Date(2), confirmedBy: "manager" },
      allocation: { id: "a", state: "ALLOCATED", confirmedAt: new Date(2) }, offer: { id: "f", status: "ACCEPTED" },
      acceptance: { id: "c", termsVersion: 1, acceptedAt: new Date(0), acknowledged: true },
      shift: { id: "s", status: "PUBLISHED", termsVersion: 1, startsAt: new Date(0), endsAt: new Date(1) },
      worker: { id: "w", status: "ACTIVE", locationId: "l", workerType: "CASUAL", userId: "worker" },
      performance: null, payout: null, managerRejected: false, missing: [], overlappingConfirmedWork: 0,
    } satisfies ConfirmedWorkEvidence;
    const variant = (change: (value: ConfirmedWorkEvidence) => void) => { const value = structuredClone(base) as ConfirmedWorkEvidence; change(value); return preModelCheck(value); };
    expect(preModelCheck(base)).toBeNull();
    expect(variant(v => { v.payout = { id: "x", status: "PROCESSING" }; v.managerRejected = true; })).toEqual({ status: "SKIPPED", code: "PAYOUT_EXISTS" });
    expect(variant(v => { v.managerRejected = true; v.allocation = null; })).toEqual({ status: "BLOCKED", code: "MANAGER_REJECTED" });
    expect(variant(v => { v.allocation = null; })).toEqual({ status: "BLOCKED", code: "COMPLETION_REQUIRED" });
    expect(variant(v => { v.payable.confirmedBy = null; })).toEqual({ status: "BLOCKED", code: "COMPLETION_REQUIRED" });
    expect(variant(v => { v.payable.confirmedBy = "worker"; })).toEqual({ status: "BLOCKED", code: "INDEPENDENT_CONFIRMATION_REQUIRED" });
    expect(variant(v => { v.allocation!.state = "REACCEPTANCE_REQUIRED"; })).toEqual({ status: "BLOCKED", code: "ALLOCATION_REQUIRED" });
    expect(variant(v => { v.offer = { id: "f", status: "CANCELLED" }; })).toEqual({ status: "BLOCKED", code: "ACCEPTANCE_REQUIRED" });
    expect(variant(v => { v.acceptance!.termsVersion = 2; })).toEqual({ status: "BLOCKED", code: "TERMS_REQUIRED" });
    expect(variant(v => { v.worker!.locationId = "elsewhere"; })).toEqual({ status: "BLOCKED", code: "WORKER_NOT_ELIGIBLE" });
    expect(variant(v => { v.shift = null; })).toEqual({ status: "BLOCKED", code: "EVIDENCE_INVALID" });
    expect(variant(v => { v.payable.finalAmountMinor = null; })).toEqual({ status: "BLOCKED", code: "PERFORMANCE_REQUIRED" });
    expect(variant(v => { v.payable.finalAmountMinor = 0; })).toEqual({ status: "SKIPPED", code: "NOTHING_PAYABLE" });
  });
});

describe("durable Pay Agent journal", () => {
  it("claims atomically, fences late writers and lets an expired claim be taken over", async () => {
    const t = await createTestDatabase();
    try {
      const manager = (await payAgentCompany(t.db)).scopes[0];
      const outsider = (await payAgentCompany(t.db)).scopes[0];
      const { payAgentEvent } = await confirmedWork(t.db, manager);
      const id = payAgentEvent!.id;
      expect(await getPayAgentEvent(t.db, outsider, id)).toBeNull();
      expect(await claimForModel(t.db, outsider, id, { manual: true })).toBeNull();

      const first = (await claimForModel(t.db, manager, id, { manual: false }))!;
      expect(first).toMatchObject({ status: "CLAIMED", attemptCount: 1 });
      // A live claim is never stolen, even by a manager's retry or a settlement claim.
      expect(await claimForModel(t.db, manager, id, { manual: true })).toBeNull();
      expect(await claimForSettlement(t.db, manager, id, { manual: true })).toBeNull();
      expect(await recordModelCall(t.db, first)).toMatchObject({ modelCallCount: 1 });

      await expireLease(t.db, id);
      const second = (await claimForModel(t.db, manager, id, { manual: false }))!;
      expect(second).toMatchObject({ status: "CLAIMED", attemptCount: 2, modelCallCount: 1 });
      expect(second.claimToken).not.toBe(first.claimToken);
      // The first attempt's late result and model-call count are refused.
      expect(await finishClaim(t.db, first, { status: "DECIDED_SETTLE", decision: "SETTLE" })).toBeNull();
      expect(await recordModelCall(t.db, first)).toBeNull();

      const failed = await finishClaim(t.db, second, { status: "FAILED_RETRYABLE", outcomeCode: "MODEL_FAILED", errorClass: "TIMEOUT", retryAfterSeconds: 60 });
      expect(failed).toMatchObject({ status: "FAILED_RETRYABLE", errorClass: "TIMEOUT", claimToken: null, leaseExpiresAt: null });
      expect(failed!.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
      // Not due yet for automatic recovery, but a manager's retry may take it now.
      expect(await claimForModel(t.db, manager, id, { manual: false })).toBeNull();
      expect((await recoverablePayAgentEvents(t.db)).map(event => event.id)).not.toContain(id);
      const third = (await claimForModel(t.db, manager, id, { manual: true }))!;
      expect(third).toMatchObject({ attemptCount: 3, errorClass: null, outcomeCode: null });
      const held = await finishClaim(t.db, third, { status: "DECIDED_HOLD", decision: "HOLD", reasonCode: "CONFIRMATION_DELAY", summary: "Confirmed nine days after the shift ended." });
      expect(held).toMatchObject({ status: "DECIDED_HOLD", decision: "HOLD", reasonCode: "CONFIRMATION_DELAY", completedAt: null });
      expect(held!.decidedAt).not.toBeNull();
      const audits = await t.db.select().from(auditEvents).where(eq(auditEvents.action, "PAY_AGENT_ATTEMPT_FINISHED"));
      expect(audits.map(row => (row.metadata as { status: string }).status)).toEqual(["FAILED_RETRYABLE", "DECIDED_HOLD"]);
    } finally { await t.close(); }
  });

  it("enforces the state machine, immutable identity, final decisions and retention in the database", async () => {
    const t = await createTestDatabase();
    try {
      const manager = (await payAgentCompany(t.db)).scopes[0];
      const { payAgentEvent, payable } = await confirmedWork(t.db, manager);
      const id = payAgentEvent!.id;
      const where = eq(payAgentEvents.id, id);
      await expect(t.db.delete(payAgentEvents).where(where)).rejects.toThrow();
      await expect(t.db.update(payAgentEvents).set({ evidenceVersion: "0".repeat(64) }).where(where)).rejects.toThrow();
      await expect(t.db.update(payAgentEvents).set({ status: "DRY_RUN_ELIGIBLE", outcomeCode: "DRY_RUN_ELIGIBLE" }).where(where)).rejects.toThrow();
      await expect(t.db.update(payAgentEvents).set({ status: "DECIDED_SETTLE", decision: "SETTLE", decidedAt: new Date() }).where(where)).rejects.toThrow();
      await expect(t.db.insert(payAgentEvents).values({ id: randomUUID(), organisationId: manager.organisationId, outletId: manager.locationId, payableId: payable!.id, evidenceVersion: "1".repeat(64), trigger: "EVIDENCE_REFRESHED", status: "DRY_RUN_ELIGIBLE", outcomeCode: "DRY_RUN_ELIGIBLE" })).rejects.toThrow();
      // A model cannot write an amount or recipient: those columns do not exist. A HOLD needs a known reason.
      const claimed = (await claimForModel(t.db, manager, id, { manual: false }))!;
      await expect(t.db.update(payAgentEvents).set({ claimToken: randomUUID(), attemptCount: claimed.attemptCount + 1, leaseExpiresAt: sql`now() + interval '1 minute'` }).where(where)).rejects.toThrow();
      await expect(finishClaim(t.db, claimed, { status: "DECIDED_HOLD", decision: "HOLD", reasonCode: "FRIENDLY_REQUEST", summary: "x" })).rejects.toThrow();
      const decided = (await finishClaim(t.db, claimed, { status: "DECIDED_SETTLE", decision: "SETTLE" }))!;
      await expect(t.db.update(payAgentEvents).set({ decision: "HOLD", reasonCode: "HOURS_MISMATCH", summary: "changed" }).where(where)).rejects.toThrow();
      await expect(resolveHold(t.db, manager, id, { resolution: "RELEASED", userId: manager.userId, note: null })).resolves.toBeNull();
      expect(decided.status).toBe("DECIDED_SETTLE");
    } finally { await t.close(); }
  });

  it("records a manager's hold resolution once, with the actor", async () => {
    const t = await createTestDatabase();
    try {
      const manager = (await payAgentCompany(t.db)).scopes[0];
      const { payAgentEvent } = await confirmedWork(t.db, manager);
      const claimed = (await claimForModel(t.db, manager, payAgentEvent!.id, { manual: false }))!;
      await finishClaim(t.db, claimed, { status: "DECIDED_HOLD", decision: "HOLD", reasonCode: "HOURS_MISMATCH", summary: "Shift record shows 8 hours; accepted schedule shows 6." });
      await expect(resolveHold(t.db, manager, payAgentEvent!.id, { resolution: "REJECTED", userId: manager.userId, note: "" })).rejects.toThrow();
      const rejected = await resolveHold(t.db, manager, payAgentEvent!.id, { resolution: "REJECTED", userId: manager.userId, note: "Worker left early; not payable as confirmed." });
      expect(rejected).toMatchObject({ status: "HOLD_REJECTED", resolution: "REJECTED", resolvedBy: manager.userId, outcomeCode: "MANAGER_REJECTED" });
      expect(await resolveHold(t.db, manager, payAgentEvent!.id, { resolution: "RELEASED", userId: manager.userId, note: null })).toBeNull();
      await expect(t.db.update(payAgentEvents).set({ resolutionNote: "edited" }).where(eq(payAgentEvents.id, payAgentEvent!.id))).rejects.toThrow();
      // The rejection is sticky for this payable: later evidence cannot reopen payment.
      const evidence = (await loadConfirmedWork(t.db, manager, payAgentEvent!.payableId))!;
      expect(evidence.managerRejected).toBe(true);
      expect(preModelCheck(evidence)).toEqual({ status: "BLOCKED", code: "MANAGER_REJECTED" });
      const [audit] = await t.db.select().from(auditEvents).where(eq(auditEvents.action, "PAY_AGENT_HOLD_REJECTED"));
      expect(audit.metadata).toMatchObject({ actorUserId: manager.userId, reasonCode: "HOURS_MISMATCH" });
    } finally { await t.close(); }
  });

  it("survives a restart: the same event, state and claim rules are read back from disk", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "fs-pay-agent-journal-"));
    try {
      const first = await createTestDatabase(directory);
      const manager = (await payAgentCompany(first.db)).scopes[0];
      const { payAgentEvent } = await confirmedWork(first.db, manager);
      const claimed = (await claimForModel(first.db, manager, payAgentEvent!.id, { manual: false }))!;
      await first.close();

      const second = await createTestDatabase(directory);
      try {
        const [row] = await second.db.select().from(payAgentEvents).where(and(eq(payAgentEvents.id, payAgentEvent!.id), eq(payAgentEvents.status, "CLAIMED")));
        expect(row).toMatchObject({ claimToken: claimed.claimToken, attemptCount: 1, evidenceVersion: payAgentEvent!.evidenceVersion });
        // After the restart the claim is still live, so it is not taken; once expired, recovery may take it.
        expect(await claimForModel(second.db, manager, row.id, { manual: false })).toBeNull();
        await expireLease(second.db, row.id);
        expect((await recoverablePayAgentEvents(second.db)).map(event => event.id)).toContain(row.id);
        expect(await claimForModel(second.db, manager, row.id, { manual: false })).toMatchObject({ attemptCount: 2 });
      } finally { await second.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("records a second confirmation for unchanged evidence as the same event", async () => {
    const t = await createTestDatabase();
    try {
      const manager = (await payAgentCompany(t.db)).scopes[0];
      const { payAgentEvent, payable } = await confirmedWork(t.db, manager);
      const replay = await t.db.transaction(tx => recordPayAgentEvent(tx, manager, payable!.id, "EVIDENCE_REFRESHED", manager.userId));
      expect(replay.id).toBe(payAgentEvent!.id);
      expect(replay.trigger).toBe("WORK_CONFIRMED");
      expect(await eventsOf(t.db)).toHaveLength(1);
    } finally { await t.close(); }
  });
});
