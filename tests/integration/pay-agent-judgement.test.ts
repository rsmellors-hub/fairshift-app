import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { confirmedWork, fakePayoutClient, payAgentCompany, testUser } from "../helpers/pay-agent";
import { sandboxFixture } from "../helpers/sandbox";
import type { Scope } from "@/server/auth/access";
import { auditEvents, payAgentEvents } from "@/server/db/schema";
import type { AssessmentRequest, StaffingAssessmentProvider } from "@/server/integrations/openai/staffing-assessment";
import { loadConfirmedWork, modelView, preModelCheck } from "@/server/pay-agent/evidence";
import { mintPayAgentCredentialForManager, payAgentServiceVerifier } from "@/server/pay-agent/identity";
import { createPayAgent } from "@/server/pay-agent/orchestrator";
import { toPayAgentEventView } from "@/server/pay-agent/presentation";
import { releasePayAgentHold, rejectPayAgentHold } from "@/server/pay-agent/service";
import { PAY_AGENT_DRY_RUN_ENV, confirmedWorkSettlement } from "@/server/pay-agent/settlement";
import { getWorkerWorkspace } from "@/server/product/workspace";
import { tipAnomalyFacts } from "@/server/tips/agent";
import { PayAgentPanel } from "@/app/manager/pay-agent-panel";

afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });
type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];

// A stand-in for the model's judgement, doing what the instructions ask with the facts FairShift
// computed: hold overlapping work or hours beyond the shift, otherwise settle. Real model calls are
// never made in tests; what matters here is that the facts reach it and its checklist reaches people.
function judgingModel(): StaffingAssessmentProvider & { assess: ReturnType<typeof vi.fn> } {
  const assess = vi.fn(async (request: AssessmentRequest) => {
    const view = JSON.parse(request.input) as { payableId: string; anomalyChecks: { overlappingConfirmedWork: number; payableMinutesBeyondShiftRecord: number | null } };
    const ok = { hours: "OK", overlap: "OK", timing: "OK", records: "OK" };
    const decision = view.anomalyChecks.overlappingConfirmedWork > 0
      ? { action: "hold_for_manager_review", payableId: view.payableId, reasonCode: "OVERLAPPING_WORK", summary: "This shift overlaps other confirmed work by the same person at the same time.", checks: { ...ok, overlap: "CONCERN" } }
      : view.anomalyChecks.payableMinutesBeyondShiftRecord ? { action: "hold_for_manager_review", payableId: view.payableId, reasonCode: "HOURS_MISMATCH", summary: "The paid hours run beyond the shift record.", checks: { ...ok, hours: "CONCERN" } }
        : { action: "settle_confirmed_work", payableId: view.payableId, checks: ok };
    return { responseId: "resp_judge", responseModel: "judge-model", text: JSON.stringify({ decision }) };
  });
  return { provider: "OPENAI", model: "judge-model", assess } as never;
}
const agentFor = (db: Db, model: StaffingAssessmentProvider) => createPayAgent({ db, identityVerifier: payAgentServiceVerifier, model: () => model, settlement: confirmedWorkSettlement(db, fakePayoutClient()) });
const eventOf = async (db: Db, id: string) => (await db.select().from(payAgentEvents).where(eq(payAgentEvents.id, id)))[0];

describe("Pay Agent judgement beyond the rules (Day 6, Step 1g)", () => {
  it("holds overlapping work at two locations that every deterministic rule passes, and shows its checklist to manager, Owner and worker", async () => {
    const t = await createTestDatabase();
    try {
      const [first, second] = (await payAgentCompany(t.db, { locations: 2 })).scopes;
      sandboxFixture(first.organisationId);
      // The same person (same telephone) booked and confirmed at both locations for the same hours.
      const here = await confirmedWork(t.db, first);
      await confirmedWork(t.db, second);
      const evidence = (await loadConfirmedWork(t.db, first, here.payable!.id))!;
      expect(preModelCheck(evidence)).toBeNull();
      expect(evidence.overlappingConfirmedWork).toBe(1);
      expect(modelView(evidence).anomalyChecks).toEqual({ payableMinutesBeyondShiftRecord: 0, overlappingConfirmedWork: 1 });

      const model = judgingModel();
      await agentFor(t.db, model).process({ eventId: here.payAgentEvent!.id }, mintPayAgentCredentialForManager(first));
      const sent = JSON.parse(model.assess.mock.calls[0][0].input);
      expect(JSON.stringify(sent)).not.toContain("+44");
      const held = await eventOf(t.db, here.payAgentEvent!.id);
      expect(held).toMatchObject({ status: "DECIDED_HOLD", reasonCode: "OVERLAPPING_WORK", checks: { hours: "OK", overlap: "CONCERN", timing: "OK", records: "OK" } });

      // The manager sees the checklist and that it waits for the Owner; only the Owner can decide.
      const view = toPayAgentEventView(held as never);
      const managerPanel = renderToStaticMarkup(PayAgentPanel({ event: view, payableId: here.payable!.id, demo: false, timezone: "Europe/London" }));
      expect(managerPanel).toContain("✓");
      expect(managerPanel).toContain("Hours match the accepted shift");
      expect(managerPanel).toContain(`<span aria-hidden="true">!</span>`);
      expect(managerPanel).toContain("Overlaps other confirmed work at the same time: held for the Owner");
      expect(managerPanel).toContain("Held for the Owner to decide");
      expect(managerPanel).not.toContain("Release as calculated");
      expect(renderToStaticMarkup(PayAgentPanel({ event: view, payableId: here.payable!.id, demo: false, timezone: "Europe/London", owner: true }))).toContain("Release as calculated");
      await expect(releasePayAgentHold(t.db, first, held.id, "Checked with the worker: the hours were right.")).rejects.toMatchObject({ feedback: "pay-agent-owner-decides" });
      await expect(rejectPayAgentHold(t.db, first, held.id, "No")).rejects.toMatchObject({ feedback: "pay-agent-owner-decides" });

      // The worker sees the same checklist and the plain reason on their own earnings.
      const worker = await getWorkerWorkspace(t.db, here.workerScope);
      const row = worker.assignments.find(item => item.payable?.id === here.payable!.id)!;
      expect(row.payAgentChecklist).toContainEqual({ ok: false, text: "Overlaps other confirmed work at the same time: held for the Owner" });
      expect(row.payAgentHoldSummary).toBe("This shift overlaps other confirmed work by the same person at the same time.");

      // The Owner releases it: payment checks run without asking the model again.
      const owner: Scope = { ...first, role: "OWNER", userId: await testUser(t.db) };
      await expect(releasePayAgentHold(t.db, owner, held.id, "  ")).rejects.toMatchObject({ feedback: "pay-agent-release-reason" });
      // Live settlement (Owner decision, 9 November 2026, amending FS-APPROVER-DEC-001): the Owner is the
      // approver of record, with the AI finding and the Owner's written reason stored.
      vi.stubEnv(PAY_AGENT_DRY_RUN_ENV, "false");
      const released = await releasePayAgentHold(t.db, owner, held.id, "Checked with the worker: the other booking was cancelled verbally.");
      expect(await eventOf(t.db, held.id)).toMatchObject({ status: "HOLD_RELEASED", resolvedBy: owner.userId, resolutionNote: "Checked with the worker: the other booking was cancelled verbally." });
      await agentFor(t.db, model).process({ eventId: released.eventId }, released.credential);
      expect(model.assess).toHaveBeenCalledTimes(1);
      const [approval] = await t.db.select().from(auditEvents).where(eq(auditEvents.action, "PAYABLE_APPROVED"));
      expect(approval.metadata).toMatchObject({ approverOfRecord: owner.userId, approverDecision: "FS-APPROVER-DEC-001", releasedBy: owner.userId,
        ownerReason: "Checked with the worker: the other booking was cancelled verbally.", holdFinding: { reasonCode: "OVERLAPPING_WORK", checks: { overlap: "CONCERN" } } });
      expect((approval.metadata as { approverBasis: string }).approverBasis).toContain("Owner released a Pay Agent hold");
    } finally { await t.close(); }
  });

  it("settles clean work with every check ticked", async () => {
    const t = await createTestDatabase();
    try {
      const [manager] = (await payAgentCompany(t.db)).scopes;
      sandboxFixture(manager.organisationId);
      const work = await confirmedWork(t.db, manager);
      await agentFor(t.db, judgingModel()).process({ eventId: work.payAgentEvent!.id }, mintPayAgentCredentialForManager(manager));
      const event = await eventOf(t.db, work.payAgentEvent!.id);
      expect(event).toMatchObject({ decision: "SETTLE", checks: { hours: "OK", overlap: "OK", timing: "OK", records: "OK" } });
      const panel = renderToStaticMarkup(PayAgentPanel({ event: toPayAgentEventView(event as never), payableId: work.payable!.id, demo: false, timezone: "Europe/London" }));
      expect(panel).not.toContain(`<span aria-hidden="true">!</span>`);
      expect((panel.match(/✓/g) ?? []).length).toBe(4);
    } finally { await t.close(); }
  });

  it("gives the tip check its location's history and the rows that look duplicated", () => {
    const at = (s: number) => new Date(Date.UTC(2026, 10, 1, 12, 0, s));
    const row = (id: string, workerId: string, billMinor: number, tipMinor: number, transactionAt: Date) => ({ row: { id, workerId, billMinor, tipMinor, transactionAt } });
    const facts = tipAnomalyFacts({ allocation: { totalTipMinor: 90_000 } as never, history: [10_000, 12_000, 11_000, 9_000], rows: [
      row("r1", "w1", 20_000, 2_000, at(0)), row("r2", "w1", 20_000, 2_000, at(45)), row("r3", "w2", 20_000, 2_000, at(50)), row("r4", "w1", 20_000, 2_000, at(400)),
    ] as never });
    expect(facts).toEqual({ historyCount: 4, historyMedianTotalMinor: 10_000, historyMaxTotalMinor: 12_000, totalAgainstMedianBps: 90_000, possibleDuplicateRowPairs: [["r1", "r2"]] });
    expect(tipAnomalyFacts({ allocation: { totalTipMinor: 5_000 } as never, rows: [] })).toMatchObject({ historyCount: 0, historyMedianTotalMinor: null, totalAgainstMedianBps: null });
  });
});
