import { eq, sql } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { after } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestDatabase } from "../helpers/database";
import { allocatedWork, confirmedWork, fakePayAgentModel, fakePayoutClient, payAgentCompany, testUser } from "../helpers/pay-agent";
import { sandboxFixture } from "../helpers/sandbox";
import type { Scope } from "@/server/auth/access";
import { requireFinancialScope, requireScope } from "@/server/auth/request";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { payAgentEvents, shifts, workPayables, workPayouts, workers } from "@/server/db/schema";
import type { StaffingAssessmentProvider } from "@/server/integrations/openai/staffing-assessment";
import { payAgentServiceVerifier } from "@/server/pay-agent/identity";
import { claimForModel, claimForSettlement, finishClaim } from "@/server/pay-agent/journal";
import { createPayAgent } from "@/server/pay-agent/orchestrator";
import { PAY_AGENT_DRY_RUN_ENV, confirmedWorkSettlement } from "@/server/pay-agent/settlement";
import { preparePayAgentRetry, rejectPayAgentHold, releasePayAgentHold, runPayAgentRetry, runReleasedHold, schedulePayAgentEvent, sweepPayAgentEvents } from "@/server/pay-agent/service";
import { submitConfirmedWorkPayout } from "@/server/payments/work-payouts";
import { confirmPerformanceAction, confirmWorkAction, rejectPayAgentHoldAction } from "@/app/operations-actions";
import { ManagerWorkspace } from "@/app/manager/workspace";
import { WorkerWorkspace } from "@/app/worker/workspace";

vi.mock("@/server/auth/request", () => ({ requireScope: vi.fn(), requireFinancialScope: vi.fn() }));
vi.mock("@/server/db/client", () => ({ getDatabase: vi.fn() }));
vi.mock("@/server/config/env", async importOriginal => ({ ...(await importOriginal<typeof import("@/server/config/env")>()), getConfigurationStatus: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); }, notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", async importOriginal => ({ ...(await importOriginal<typeof import("next/server")>()), after: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });

type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];
const form = (values: Record<string, string>) => { const result = new FormData(); for (const [key, value] of Object.entries(values)) result.set(key, value); return result; };
const holdReply = (payableId: string) => ({ action: "hold_for_manager_review", payableId, reasonCode: "CONFIRMATION_DELAY", summary: "Confirmation was recorded long after the shift ended.", checks: { hours: "OK", overlap: "OK", timing: "CONCERN", records: "OK" } });
const agentFor = (db: Db, model: StaffingAssessmentProvider | null, paypal = fakePayoutClient()) =>
  createPayAgent({ db, identityVerifier: payAgentServiceVerifier, model: () => model, settlement: confirmedWorkSettlement(db, paypal) });
const eventOf = async (db: Db, id: string) => (await db.select().from(payAgentEvents).where(eq(payAgentEvents.id, id)))[0];
function capture() {
  const tasks: Array<() => Promise<unknown>> = [];
  return { tasks, schedule: (task: () => Promise<unknown>) => { tasks.push(task); } };
}
function wireActions(db: Db, scope: Scope) {
  vi.mocked(getDatabase).mockReturnValue(db);
  vi.mocked(getConfigurationStatus).mockReturnValue({ databaseConfigured: true } as ReturnType<typeof getConfigurationStatus>);
  vi.mocked(requireFinancialScope).mockResolvedValue(scope);
  vi.mocked(requireScope).mockResolvedValue(scope);
  const scheduled: Array<() => unknown> = [];
  vi.mocked(after).mockImplementation(task => { scheduled.push(task as () => unknown); });
  return scheduled;
}

describe("confirmation to Pay Agent processing", () => {
  it("answers the manager before any Pay Agent work; processing runs after the response from the durable event", async () => {
    const t = await createTestDatabase();
    try {
      const manager = (await payAgentCompany(t.db)).scopes[0];
      const work = await allocatedWork(t.db, manager);
      const scheduled = wireActions(t.db, manager);
      await expect(confirmWorkAction(form({ offerId: work.offer.id, confirmed: "yes" }))).rejects.toThrow("REDIRECT:/settlements?status=saved");
      // Committed and answered: one pending event, and its processing only scheduled.
      const [event] = await t.db.select().from(payAgentEvents);
      expect(event).toMatchObject({ status: "PENDING", attemptCount: 0, trigger: "WORK_CONFIRMED" });
      expect(scheduled).toHaveLength(1);
      // After the response the event is processed. No model is configured for this tenant, which is
      // recorded durably and retryable; the confirmation and payable are untouched.
      await scheduled[0]();
      expect(await eventOf(t.db, event.id)).toMatchObject({ status: "FAILED_RETRYABLE", outcomeCode: "MODEL_NOT_CONFIGURED", modelCallCount: 0 });
      expect(await t.db.select().from(workPayables)).toHaveLength(1);
    } finally { await t.close(); }
  });

  it("never lets the confirmation wait for the model", async () => {
    const t = await createTestDatabase();
    try {
      const manager = (await payAgentCompany(t.db)).scopes[0];
      sandboxFixture(manager.organisationId);
      let release!: () => void;
      const model = fakePayAgentModel();
      const replied = model.assess.getMockImplementation()!;
      model.assess.mockImplementation(async request => { await new Promise<void>(resolve => { release = resolve; }); return replied(request); });
      const work = await confirmedWork(t.db, manager);
      const { tasks, schedule } = capture();
      expect(schedulePayAgentEvent(agentFor(t.db, model), manager, work.payAgentEvent, schedule)).toBe(true);
      expect(model.assess).not.toHaveBeenCalled();
      const running = tasks[0]();
      await vi.waitFor(() => expect(model.assess).toHaveBeenCalledTimes(1));
      // Confirmation is committed while the model is still answering.
      expect(await eventOf(t.db, work.payAgentEvent!.id)).toMatchObject({ status: "CLAIMED" });
      expect((await t.db.select().from(workPayables))[0]).toMatchObject({ status: "PENDING_REVIEW" });
      release();
      await running;
      expect(await eventOf(t.db, work.payAgentEvent!.id)).toMatchObject({ status: "DRY_RUN_ELIGIBLE" });
    } finally { await t.close(); }
  });

  it("schedules nothing, and mints no service credential, for a worker, a public demo persona or a finished event", async () => {
    const t = await createTestDatabase();
    try {
      const manager = (await payAgentCompany(t.db)).scopes[0];
      const work = await confirmedWork(t.db, manager);
      const { tasks, schedule } = capture();
      const agent = agentFor(t.db, fakePayAgentModel());
      expect(schedulePayAgentEvent(agent, work.workerScope, work.payAgentEvent, schedule)).toBe(false);
      expect(schedulePayAgentEvent(agent, { ...manager, demo: { persona: "MANAGER", group: "public" } }, work.payAgentEvent, schedule)).toBe(false);
      expect(schedulePayAgentEvent(agent, manager, { ...work.payAgentEvent!, status: "DRY_RUN_ELIGIBLE" }, schedule)).toBe(false);
      expect(schedulePayAgentEvent(agent, manager, null, schedule)).toBe(false);
      expect(tasks).toHaveLength(0);
      await expect(preparePayAgentRetry(t.db, work.workerScope, work.payable!.id)).rejects.toThrow("Access denied");
      await expect(rejectPayAgentHold(t.db, { ...manager, demo: { persona: "MANAGER", group: "public" } }, work.payAgentEvent!.id, "No")).rejects.toThrow("Access denied");
    } finally { await t.close(); }
  });

  it("schedules the new event a performance confirmation records", async () => {
    const t = await createTestDatabase();
    try {
      const manager = (await payAgentCompany(t.db)).scopes[0];
      const work = await confirmedWork(t.db, manager, { incentive: true });
      expect(work.payAgentEvent).toMatchObject({ status: "BLOCKED", outcomeCode: "PERFORMANCE_REQUIRED" });
      const scheduled = wireActions(t.db, manager);
      await expect(confirmPerformanceAction(form({ allocationId: work.allocationId, complete: "yes", seenCount: "0", seenMinor: "0" }))).rejects.toThrow("REDIRECT:/manager/review?status=saved");
      const events = await t.db.select().from(payAgentEvents).where(eq(payAgentEvents.payableId, work.payable!.id));
      expect(events.map(event => event.status).sort()).toEqual(["BLOCKED", "PENDING"]);
      expect(scheduled).toHaveLength(1);
    } finally { await t.close(); }
  });
});

describe("recovery of interrupted Pay Agent work", () => {
  it("sweeps up pending, abandoned and decided events, and leaves live claims, holds and finished events alone", async () => {
    const t = await createTestDatabase();
    try {
      const manager = (await payAgentCompany(t.db)).scopes[0];
      sandboxFixture(manager.organisationId);
      const event = async () => (await confirmedWork(t.db, manager)).payAgentEvent!;
      const pending = await event(), abandoned = await event(), decided = await event(), live = await event(), held = await event();
      await claimForModel(t.db, manager, abandoned.id, { manual: false });
      await t.db.update(payAgentEvents).set({ leaseExpiresAt: sql`now() - interval '1 second'` }).where(eq(payAgentEvents.id, abandoned.id));
      await finishClaim(t.db, (await claimForModel(t.db, manager, decided.id, { manual: false }))!, { status: "DECIDED_SETTLE", decision: "SETTLE" });
      await claimForModel(t.db, manager, live.id, { manual: false });
      await finishClaim(t.db, (await claimForModel(t.db, manager, held.id, { manual: false }))!, { status: "DECIDED_HOLD", decision: "HOLD", reasonCode: "HOURS_MISMATCH", summary: "Accepted schedule and shift record differ." });
      const model = fakePayAgentModel();
      const agent = agentFor(t.db, model);
      const results = await sweepPayAgentEvents(t.db, agent);
      expect(new Set(results.map(result => result.eventId))).toEqual(new Set([pending.id, abandoned.id, decided.id]));
      for (const id of [pending.id, abandoned.id, decided.id]) expect(await eventOf(t.db, id)).toMatchObject({ status: "DRY_RUN_ELIGIBLE" });
      // The decided event went straight to the gates: only the other two asked the model.
      expect(model.assess).toHaveBeenCalledTimes(2);
      expect(await eventOf(t.db, live.id)).toMatchObject({ status: "CLAIMED" });
      expect(await eventOf(t.db, held.id)).toMatchObject({ status: "DECIDED_HOLD" });
      expect(await sweepPayAgentEvents(t.db, agent)).toEqual([]);
    } finally { await t.close(); }
  });

  it("recovers a settlement interrupted after its reservation without a second payout", async () => {
    vi.stubEnv(PAY_AGENT_DRY_RUN_ENV, "false");
    const t = await createTestDatabase();
    try {
      const manager = (await payAgentCompany(t.db)).scopes[0];
      sandboxFixture(manager.organisationId);
      const { payAgentEvent, payable } = await confirmedWork(t.db, manager);
      await finishClaim(t.db, (await claimForModel(t.db, manager, payAgentEvent!.id, { manual: false }))!, { status: "DECIDED_SETTLE", decision: "SETTLE" });
      const settling = (await claimForSettlement(t.db, manager, payAgentEvent!.id, { manual: false }))!;
      // The process reserved and sent the payout through the shared engine, then stopped.
      const paypal = fakePayoutClient();
      await submitConfirmedWorkPayout(t.db, paypal, { organisationId: manager.organisationId, locationId: manager.locationId, authorisedBy: manager.userId, basis: "MANAGER_CONFIRMED_COMPLETION", payAgentEventId: payAgentEvent!.id, verify: async () => undefined }, payable!.id);
      await t.db.update(payAgentEvents).set({ leaseExpiresAt: sql`now() - interval '1 second'` }).where(eq(payAgentEvents.id, settling.id));
      await sweepPayAgentEvents(t.db, agentFor(t.db, fakePayAgentModel(), paypal));
      const [payout] = await t.db.select().from(workPayouts);
      expect(await eventOf(t.db, payAgentEvent!.id)).toMatchObject({ status: "SETTLEMENT_SUBMITTED", outcomeCode: "PAYOUT_EXISTS", payoutId: payout.id });
      expect(paypal.createPayout).toHaveBeenCalledTimes(1);
      expect(await t.db.select().from(workPayouts)).toHaveLength(1);
      expect(payout.status).toBe("PROCESSING");
    } finally { await t.close(); }
  });
});

describe("manager hold resolution and retry", () => {
  it("releases a hold by another manager through the gates without the model, and refuses the worker's own release", async () => {
    const t = await createTestDatabase();
    try {
      const manager = (await payAgentCompany(t.db)).scopes[0];
      sandboxFixture(manager.organisationId);
      const model = fakePayAgentModel(holdReply);
      const work = await confirmedWork(t.db, manager);
      const agent = agentFor(t.db, model);
      await agent.process({ eventId: work.payAgentEvent!.id }, (await import("@/server/pay-agent/identity")).mintPayAgentCredentialForManager(manager));
      // A manager who is this worker cannot release their own hold.
      // Held payments are the Owner's to decide (Day 6); one on the Owner's own work goes to someone else.
      const selfManager: Scope = { ...manager, role: "OWNER", userId: work.workerScope.userId };
      await expect(releasePayAgentHold(t.db, selfManager, work.payAgentEvent!.id, "Checked with the worker: the hours were right.")).rejects.toMatchObject({ feedback: "pay-agent-own-work" });
      await expect(preparePayAgentRetry(t.db, manager, work.payable!.id)).rejects.toMatchObject({ feedback: "pay-agent-hold-pending" });
      const releaser: Scope = { ...manager, role: "OWNER", userId: await testUser(t.db) };
      const { tasks, schedule } = capture();
      runReleasedHold(agent, await releasePayAgentHold(t.db, releaser, work.payAgentEvent!.id, "Checked with the worker: the hours were right."), schedule);
      expect(await eventOf(t.db, work.payAgentEvent!.id)).toMatchObject({ status: "HOLD_RELEASED", resolvedBy: releaser.userId });
      await tasks[0]();
      expect(await eventOf(t.db, work.payAgentEvent!.id)).toMatchObject({ status: "DRY_RUN_ELIGIBLE", resolution: "RELEASED" });
      expect(model.assess).toHaveBeenCalledTimes(1);
      await expect(releasePayAgentHold(t.db, releaser, work.payAgentEvent!.id, "Checked with the worker: the hours were right.")).rejects.toMatchObject({ feedback: "pay-agent-hold-unavailable" });
    } finally { await t.close(); }
  });

  it("rejects a hold only with a reason, keeps it unpaid and leaves nothing to retry", async () => {
    const t = await createTestDatabase();
    try {
      const manager = (await payAgentCompany(t.db)).scopes[0];
      sandboxFixture(manager.organisationId);
      const work = await confirmedWork(t.db, manager);
      await agentFor(t.db, fakePayAgentModel(holdReply)).process({ eventId: work.payAgentEvent!.id }, (await import("@/server/pay-agent/identity")).mintPayAgentCredentialForManager(manager));
      // Held payments are the Owner's to decide (Day 6).
      wireActions(t.db, { ...manager, role: "OWNER" });
      await expect(rejectPayAgentHoldAction(form({ eventId: work.payAgentEvent!.id, reason: "  " }))).rejects.toThrow("REDIRECT:/settlements?status=pay-agent-reject-reason");
      await expect(rejectPayAgentHoldAction(form({ eventId: work.payAgentEvent!.id, reason: "Hours were not worked as confirmed." }))).rejects.toThrow("REDIRECT:/settlements?status=saved");
      expect(await eventOf(t.db, work.payAgentEvent!.id)).toMatchObject({ status: "HOLD_REJECTED", resolvedBy: manager.userId, resolutionNote: "Hours were not worked as confirmed." });
      await expect(preparePayAgentRetry(t.db, manager, work.payable!.id)).rejects.toMatchObject({ feedback: "pay-agent-nothing-to-retry" });
      expect((await t.db.select().from(workPayables))[0]).toMatchObject({ status: "PENDING_REVIEW", approvedAmountMinor: null });
      expect(await t.db.select().from(workPayouts)).toHaveLength(0);
    } finally { await t.close(); }
  });

  it("retries in place when evidence is unchanged, and records a new event when it has changed", async () => {
    const t = await createTestDatabase();
    try {
      const manager = (await payAgentCompany(t.db)).scopes[0];
      sandboxFixture(manager.organisationId);
      const work = await confirmedWork(t.db, manager, { paymentEmail: null });
      const model = fakePayAgentModel();
      const agent = agentFor(t.db, model);
      const { tasks, schedule } = capture();
      // No model yet: a durable, retryable outcome. A manager's retry runs it again in place.
      await agentFor(t.db, null).process({ eventId: work.payAgentEvent!.id }, (await import("@/server/pay-agent/identity")).mintPayAgentCredentialForManager(manager));
      runPayAgentRetry(agent, await preparePayAgentRetry(t.db, manager, work.payable!.id), schedule);
      await tasks[0]();
      expect(await eventOf(t.db, work.payAgentEvent!.id)).toMatchObject({ status: "SETTLEMENT_BLOCKED", outcomeCode: "payment-details-required" });
      // The worker adds payment details (not work evidence): a retry re-runs only the gates.
      await t.db.update(workers).set({ paypalPayoutEmail: "casual.sandbox@example.test" }).where(eq(workers.id, work.worker.id));
      runPayAgentRetry(agent, await preparePayAgentRetry(t.db, manager, work.payable!.id), schedule);
      await tasks[1]();
      expect(await eventOf(t.db, work.payAgentEvent!.id)).toMatchObject({ status: "DRY_RUN_ELIGIBLE" });
      expect(model.assess).toHaveBeenCalledTimes(1);
      // Changed work evidence: the retry records a new event for the current version and processes it.
      await t.db.update(shifts).set({ status: "COMPLETED" }).where(eq(shifts.id, work.shift.id));
      const prepared = await preparePayAgentRetry(t.db, manager, work.payable!.id);
      expect(prepared.eventId).not.toBe(work.payAgentEvent!.id);
      expect(await eventOf(t.db, prepared.eventId)).toMatchObject({ status: "PENDING", trigger: "EVIDENCE_REFRESHED", createdBy: manager.userId });
      runPayAgentRetry(agent, prepared, schedule);
      await tasks[2]();
      expect(await eventOf(t.db, prepared.eventId)).toMatchObject({ status: "DRY_RUN_ELIGIBLE" });
      expect(model.assess).toHaveBeenCalledTimes(2);
    } finally { await t.close(); }
  });
});

describe("what managers and workers see", () => {
  it("shows the manager the agent's status, decision, reason, summary and response ID, and the worker only a plain status", async () => {
    const t = await createTestDatabase();
    try {
      const manager = (await payAgentCompany(t.db)).scopes[0];
      sandboxFixture(manager.organisationId);
      const work = await confirmedWork(t.db, manager);
      await agentFor(t.db, fakePayAgentModel(holdReply)).process({ eventId: work.payAgentEvent!.id }, (await import("@/server/pay-agent/identity")).mintPayAgentCredentialForManager(manager));
      // The Owner sees the actions on a held payment (Day 6: holds are the Owner's to decide).
      wireActions(t.db, { ...manager, role: "OWNER" });
      const review = renderToStaticMarkup(await ManagerWorkspace({ area: "review" }));
      for (const text of ["Pay Agent", "Held for the Owner", "Hold for the Owner · Confirmation delay", "Confirmation was recorded long after the shift ended.", "resp_test_1", "Release as calculated", "Reject payment", "Resolve the Pay Agent&#x27;s hold to continue."]) expect(review).toContain(text);
      expect(review).not.toContain("Approve £78.00");
      vi.mocked(requireScope).mockResolvedValue(work.workerScope);
      const earnings = renderToStaticMarkup(await WorkerWorkspace({ area: "earnings" }));
      expect(earnings).toContain("Under review");
      expect(earnings).toContain("The business owner is reviewing this payment.");
      // Day 6, Step 1g: the worker sees the plain explanation and the checklist for their own pay, never codes or model detail.
      expect(earnings).toContain("Why it’s held: Confirmation was recorded long after the shift ended.");
      expect(earnings).toContain("Confirmed unusually long after the shift: held for the Owner");
      for (const hidden of ["DECIDED_HOLD", "CONFIRMATION_DELAY", "resp_test_1", "test-model"]) expect(earnings).not.toContain(hidden);
    } finally { await t.close(); }
  });

  it("shows a dry-run outcome to the manager and 'Pay pending' to the worker, never 'Paid'", async () => {
    const t = await createTestDatabase();
    try {
      const manager = (await payAgentCompany(t.db)).scopes[0];
      sandboxFixture(manager.organisationId);
      const work = await confirmedWork(t.db, manager);
      await agentFor(t.db, fakePayAgentModel()).process({ eventId: work.payAgentEvent!.id }, (await import("@/server/pay-agent/identity")).mintPayAgentCredentialForManager(manager));
      // The Owner sees the actions on a held payment (Day 6: holds are the Owner's to decide).
      wireActions(t.db, { ...manager, role: "OWNER" });
      const review = renderToStaticMarkup(await ManagerWorkspace({ area: "review" }));
      for (const text of ["Demo dry run: all checks passed", "Recommendation", "Settle", "Dry-run outcome", "nothing was sent to PayPal", "Retry agent checks"]) expect(review).toContain(text);
      // No button names payment before a payout exists (the existing work-payables guard).
      expect(review).not.toMatch(/<button[^>]*>[^<]*\bPay\b/);
      vi.mocked(requireScope).mockResolvedValue(work.workerScope);
      const earnings = renderToStaticMarkup(await WorkerWorkspace({ area: "earnings" }));
      expect(earnings).toContain("Pay pending");
      expect(earnings).not.toMatch(/>\s*Paid\s*</);
      expect(earnings).not.toContain("DRY_RUN_ELIGIBLE");
    } finally { await t.close(); }
  });
});
