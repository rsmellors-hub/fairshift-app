import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestDatabase } from "../helpers/database";
import { confirmedWork, payAgentCompany, testUser } from "../helpers/pay-agent";
import { sandboxFixture } from "../helpers/sandbox";
import { auditEvents, organisations, outlets, payAgentEvents, workPayables, workPayouts, workers } from "@/server/db/schema";
import { seedTestFxRate, TEST_QUOTE_1850 } from "../helpers/fx";
import { AiProviderError, OpenAiStaffingAssessmentProvider, type AssessmentRequest, type AssessmentResponse, type StaffingAssessmentProvider } from "@/server/integrations/openai/staffing-assessment";
import type { PayPalPayoutAdapter, PayoutResult } from "@/server/integrations/paypal/payout-client";
import { mintPayAgentCredentialForManager, payAgentServiceVerifier } from "@/server/pay-agent/identity";
import { claimForModel, finishClaim, MAX_MODEL_ATTEMPTS, recordPayAgentEvent, resolveHold } from "@/server/pay-agent/journal";
import { createPayAgent } from "@/server/pay-agent/orchestrator";
import { confirmedWorkSettlement, PAY_AGENT_DRY_RUN_ENV } from "@/server/pay-agent/settlement";
import { approveWorkPayable, submitWorkPayout } from "@/server/payments/work-payouts";

// The Pay Agent's processing path over persisted evidence, a fake model and a fake payout
// provider. No network: the model and PayPal are in-process doubles.
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const wire = (decision: unknown) => JSON.stringify({ decision });
const settleReply = (payableId: string) => ({ action: "settle_confirmed_work", payableId });
const holdReply = (payableId: string) => ({ action: "hold_for_manager_review", payableId, reasonCode: "CONFIRMATION_DELAY", summary: "Confirmation was recorded long after the shift ended." });

function fakeModel(reply: (payableId: string) => unknown = settleReply) {
  const assess = vi.fn(async (request: AssessmentRequest): Promise<AssessmentResponse> => {
    const { payableId } = JSON.parse(request.input) as { payableId: string };
    return { responseId: "resp_test_1", responseModel: "test-model-2026-01-01", text: wire(reply(payableId)) };
  });
  return { provider: "OPENAI" as const, model: "test-model", assess };
}
function fakePayPal() {
  return {
    createPayout: vi.fn(async (input: { senderBatchId: string }): Promise<PayoutResult> => ({ batchId: `PPB${input.senderBatchId.slice(-8)}`, itemId: null, status: "PENDING", batchStatus: "PENDING", itemStatus: null, transactionId: null })),
    getPayout: vi.fn(),
  } as unknown as PayPalPayoutAdapter & { createPayout: ReturnType<typeof vi.fn> };
}

async function scenario(options: { country?: string; sandbox?: boolean; paymentEmail?: string | null; model?: StaffingAssessmentProvider | null } = {}) {
  const t = await createTestDatabase();
  const company = await payAgentCompany(t.db, { country: options.country });
  if (options.sandbox !== false) sandboxFixture(company.organisationId);
  const manager = company.scopes[0];
  const work = await confirmedWork(t.db, manager, { paymentEmail: options.paymentEmail });
  const fake = fakeModel();
  const model = options.model === undefined ? fake : options.model;
  const paypal = fakePayPal();
  const agent = createPayAgent({ db: t.db, identityVerifier: payAgentServiceVerifier, model: () => model, settlement: confirmedWorkSettlement(t.db, paypal) });
  const credential = mintPayAgentCredentialForManager(manager);
  const eventId = work.payAgentEvent!.id, payableId = work.payable!.id;
  const run = (opts?: { manual?: boolean }) => agent.process({ eventId }, credential, opts);
  const event = async () => (await t.db.select().from(payAgentEvents).where(eq(payAgentEvents.id, eventId)))[0];
  const payable = async () => (await t.db.select().from(workPayables).where(eq(workPayables.id, payableId)))[0];
  const payouts = () => t.db.select().from(workPayouts);
  return { t, manager, work, fake, paypal, agent, credential, eventId, payableId, run, event, payable, payouts };
}

describe("Pay Agent decisions from persisted evidence", () => {
  it("accepts a valid SETTLE and stops at the dry run: no approval, reservation or PayPal request", async () => {
    const s = await scenario();
    try {
      expect(await s.run()).toMatchObject({ status: "DRY_RUN_ELIGIBLE", outcomeCode: "DRY_RUN_ELIGIBLE" });
      expect(await s.event()).toMatchObject({
        status: "DRY_RUN_ELIGIBLE", decision: "SETTLE", dryRun: true, configuredModel: "test-model", responseModel: "test-model-2026-01-01",
        responseId: "resp_test_1", modelCallCount: 1, attemptCount: 2, payoutId: null, claimToken: null,
      });
      expect(s.paypal.createPayout).not.toHaveBeenCalled();
      expect(await s.payouts()).toHaveLength(0);
      expect(await s.payable()).toMatchObject({ status: "PENDING_REVIEW", approvedBy: null, approvedAmountMinor: null });
      // The model saw the payable ID and work facts only.
      const request = s.fake.assess.mock.calls[0][0];
      expect(request.schemaName).toBe("fairshift_pay_agent_decision_v2");
      expect(Object.keys(JSON.parse(request.input)).sort()).toEqual(["acceptedSchedule", "allocation", "evidenceVersion", "incentive", "managerConfirmation", "missing", "payableId", "performance", "shiftRecord", "terms"]);
      expect(request.input).not.toContain("@");
      expect(request.input).not.toContain(s.work.worker.displayName);
      // A repeat replays the recorded outcome without another model call.
      expect(await s.run()).toMatchObject({ status: "DRY_RUN_ELIGIBLE" });
      expect(s.fake.assess).toHaveBeenCalledTimes(1);
      const audits = await s.t.db.select().from(auditEvents).where(eq(auditEvents.action, "PAY_AGENT_ATTEMPT_FINISHED"));
      expect(audits.map(row => (row.metadata as { status: string }).status)).toEqual(["DECIDED_SETTLE", "DRY_RUN_ELIGIBLE"]);
    } finally { await s.t.close(); }
  });

  it("accepts a HOLD with its reason and summary, and the manual pay actions refuse until a manager resolves it", async () => {
    const model = fakeModel(holdReply);
    const s = await scenario({ model });
    try {
      expect(await s.run()).toMatchObject({ status: "DECIDED_HOLD" });
      expect(await s.event()).toMatchObject({ decision: "HOLD", reasonCode: "CONFIRMATION_DELAY", summary: "Confirmation was recorded long after the shift ended.", attemptCount: 1, completedAt: null });
      await expect(approveWorkPayable(s.t.db, s.manager, s.payableId)).rejects.toMatchObject({ feedback: "pay-agent-hold" });
      await expect(submitWorkPayout(s.t.db, s.paypal, s.manager, s.payableId)).rejects.toMatchObject({ feedback: "pay-agent-hold" });
      expect(await s.run({ manual: true })).toMatchObject({ status: "DECIDED_HOLD" });
      expect(model.assess).toHaveBeenCalledTimes(1);
      expect(await s.payouts()).toHaveLength(0);
    } finally { await s.t.close(); }
  });

  it.each([
    ["an unknown hold reason", (id: string) => ({ action: "hold_for_manager_review", payableId: id, reasonCode: "WORKER_ASKED", summary: "The worker asked." }), "UNKNOWN_REASON"],
    ["another payable", () => ({ action: "settle_confirmed_work", payableId: randomUUID() }), "WRONG_PAYABLE"],
    ["an unsupported action", (id: string) => ({ action: "create_payout", payableId: id }), "UNSUPPORTED_ACTION"],
    ["financial facts from the model", (id: string) => ({ action: "settle_confirmed_work", payableId: id, amountMinor: 1, currency: "USD", recipient: "attacker@example.invalid", fxRate: 1, organisationId: randomUUID(), merchant: "m", fundingSource: "f" }), "EXTRA_FIELDS"],
  ] as const)("rejects %s and records it durably without changing money", async (_label, reply, errorClass) => {
    const model = fakeModel(reply);
    const s = await scenario({ model });
    try {
      expect(await s.run()).toMatchObject({ status: "REJECTED_OUTPUT", outcomeCode: "OUTPUT_REJECTED" });
      expect(await s.event()).toMatchObject({ errorClass, responseId: "resp_test_1", decision: null, completedAt: expect.any(Date) });
      expect(s.paypal.createPayout).not.toHaveBeenCalled();
      expect(await s.payouts()).toHaveLength(0);
      expect(await s.payable()).toMatchObject({ status: "PENDING_REVIEW", baseAmountMinor: 7_800, currencyCode: "GBP", approvedAmountMinor: null });
      expect(await s.run()).toMatchObject({ status: "REJECTED_OUTPUT" });
      expect(model.assess).toHaveBeenCalledTimes(1);
    } finally { await s.t.close(); }
  });

  it("records a model refusal as a terminal failure that only a manager's retry may repeat", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id: "resp_refused", model: "test-model", status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "No." }] }] }), { status: 200 }));
    const s = await scenario({ model: new OpenAiStaffingAssessmentProvider("test-key", "test-model", fetchMock, 30_000) });
    try {
      expect(await s.run()).toMatchObject({ status: "FAILED_TERMINAL", outcomeCode: "MODEL_FAILED" });
      expect(await s.event()).toMatchObject({ errorClass: "REFUSAL", configuredModel: "test-model", responseId: null, modelCallCount: 1 });
      expect(await s.run()).toMatchObject({ status: "FAILED_TERMINAL" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await s.run({ manual: true })).toMatchObject({ status: "FAILED_TERMINAL" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(await s.event()).toMatchObject({ modelCallCount: 2, attemptCount: 2 });
      expect(await s.payouts()).toHaveLength(0);
    } finally { await s.t.close(); }
  });

  it("records timeouts and network failures as retryable, retries a network failure once, and stops at the attempt limit", async () => {
    const assess = vi.fn(async (request: AssessmentRequest): Promise<AssessmentResponse> => { void request; throw new AiProviderError("TIMEOUT"); });
    const s = await scenario({ model: { provider: "OPENAI", model: "test-model", assess } });
    const due = () => s.t.db.update(payAgentEvents).set({ nextAttemptAt: sql`now() - interval '1 second'` }).where(eq(payAgentEvents.id, s.eventId));
    try {
      expect(await s.run()).toMatchObject({ status: "FAILED_RETRYABLE", outcomeCode: "MODEL_FAILED" });
      const first = await s.event();
      expect(first).toMatchObject({ errorClass: "TIMEOUT", modelCallCount: 1 });
      expect(first.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
      expect(await s.run()).toMatchObject({ status: "FAILED_RETRYABLE" });
      expect(assess).toHaveBeenCalledTimes(1);
      assess.mockImplementation(async () => { throw new AiProviderError("NETWORK_ERROR"); });
      await due();
      expect(await s.run()).toMatchObject({ status: "FAILED_RETRYABLE" });
      expect(assess).toHaveBeenCalledTimes(3);
      expect(await s.event()).toMatchObject({ errorClass: "NETWORK_ERROR", modelCallCount: 2 });
      await due();
      expect(await s.run()).toMatchObject({ status: "FAILED_TERMINAL", outcomeCode: "ATTEMPTS_EXHAUSTED" });
      expect(await s.event()).toMatchObject({ errorClass: "NETWORK_ERROR", modelCallCount: MAX_MODEL_ATTEMPTS });
      expect(await s.run({ manual: true })).toMatchObject({ status: "FAILED_TERMINAL", outcomeCode: "ATTEMPTS_EXHAUSTED" });
      expect(assess).toHaveBeenCalledTimes(5);
      expect(await s.payouts()).toHaveLength(0);
    } finally { await s.t.close(); }
  });

  it("records a missing model as retryable without any call or change to the obligation", async () => {
    const s = await scenario({ model: null });
    try {
      expect(await s.run()).toMatchObject({ status: "FAILED_RETRYABLE", outcomeCode: "MODEL_NOT_CONFIGURED" });
      expect(await s.event()).toMatchObject({ errorClass: "NOT_CONFIGURED", modelCallCount: 0 });
      expect(await s.payable()).toMatchObject({ status: "PENDING_REVIEW", baseAmountMinor: 7_800 });
    } finally { await s.t.close(); }
  });

  it("blocks stale evidence before the model, and evidence that changes during the model call", async () => {
    const stale = await scenario();
    try {
      await stale.t.db.update(workers).set({ status: "INACTIVE" }).where(eq(workers.id, stale.work.worker.id));
      expect(await stale.run()).toMatchObject({ status: "BLOCKED", outcomeCode: "EVIDENCE_STALE" });
      expect(stale.fake.assess).not.toHaveBeenCalled();
    } finally { await stale.t.close(); }
    const changing = await scenario();
    try {
      changing.fake.assess.mockImplementationOnce(async request => {
        await changing.t.db.update(workers).set({ status: "INACTIVE" }).where(eq(workers.id, changing.work.worker.id));
        return { responseId: "resp_changed", responseModel: "test-model", text: wire(settleReply(JSON.parse(request.input).payableId)) };
      });
      expect(await changing.run()).toMatchObject({ status: "BLOCKED", outcomeCode: "EVIDENCE_CHANGED" });
      expect(await changing.event()).toMatchObject({ responseId: "resp_changed", decision: null });
      expect(changing.paypal.createPayout).not.toHaveBeenCalled();
    } finally { await changing.t.close(); }
  });

  it("refuses another tenant's credential, a forged credential and a trigger carrying extra facts", async () => {
    const s = await scenario();
    try {
      const outsider = (await payAgentCompany(s.t.db)).scopes[0];
      expect(await s.agent.process({ eventId: s.eventId }, mintPayAgentCredentialForManager(outsider))).toMatchObject({ status: "NOT_FOUND", event: null });
      expect(await s.agent.process({ eventId: s.eventId }, { organisationId: s.manager.organisationId, locationId: s.manager.locationId })).toMatchObject({ status: "UNAUTHORISED" });
      expect(await s.agent.process({ eventId: s.eventId, payableId: s.payableId }, s.credential)).toMatchObject({ status: "INVALID_TRIGGER" });
      expect(await s.event()).toMatchObject({ status: "PENDING", attemptCount: 0 });
      expect(s.fake.assess).not.toHaveBeenCalled();
    } finally { await s.t.close(); }
  });

  it("takes no action when the shared engine already holds a payout for the payable", async () => {
    const s = await scenario();
    try {
      await approveWorkPayable(s.t.db, s.manager, s.payableId);
      await submitWorkPayout(s.t.db, s.paypal, s.manager, s.payableId);
      expect(await s.run()).toMatchObject({ status: "SKIPPED", outcomeCode: "PAYOUT_EXISTS" });
      expect(s.fake.assess).not.toHaveBeenCalled();
      expect(s.paypal.createPayout).toHaveBeenCalledTimes(1);
    } finally { await s.t.close(); }
  });

  it("completes an event whose claim was abandoned and ignores the abandoned owner's late result", async () => {
    const s = await scenario();
    try {
      const abandoned = (await claimForModel(s.t.db, s.manager, s.eventId, { manual: false }))!;
      expect(await s.run()).toMatchObject({ status: "CLAIMED" });
      expect(s.fake.assess).not.toHaveBeenCalled();
      await s.t.db.update(payAgentEvents).set({ leaseExpiresAt: sql`now() - interval '1 second'` }).where(eq(payAgentEvents.id, s.eventId));
      expect(await s.run()).toMatchObject({ status: "DRY_RUN_ELIGIBLE" });
      expect(await finishClaim(s.t.db, abandoned, { status: "FAILED_TERMINAL", outcomeCode: "MODEL_FAILED", errorClass: "TIMEOUT" })).toBeNull();
      expect(await s.event()).toMatchObject({ status: "DRY_RUN_ELIGIBLE", attemptCount: 3, modelCallCount: 1 });
    } finally { await s.t.close(); }
  });

  it("makes one model call for concurrent triggers of the same event", async () => {
    const s = await scenario();
    try {
      const results = await Promise.all([s.run(), s.run(), s.run()]);
      expect(s.fake.assess).toHaveBeenCalledTimes(1);
      expect(results.map(result => result.status)).toContain("DRY_RUN_ELIGIBLE");
      expect(await s.event()).toMatchObject({ status: "DRY_RUN_ELIGIBLE", modelCallCount: 1 });
    } finally { await s.t.close(); }
  });
});

describe("Pay Agent settlement gates", () => {
  it("fails closed without a fresh ECB reference rate for South African ZAR earnings", async () => {
    const s = await scenario({ country: "South Africa" });
    try {
      expect(await s.run()).toMatchObject({ status: "SETTLEMENT_BLOCKED", outcomeCode: "provider-fx-rate-unavailable" });
      expect(await s.event()).toMatchObject({ decision: "SETTLE", dryRun: true });
      expect(s.paypal.createPayout).not.toHaveBeenCalled();
      expect(await s.payouts()).toHaveLength(0);
      expect(await s.payable()).toMatchObject({ currencyCode: "ZAR", baseAmountMinor: 7_800, status: "PENDING_REVIEW" });
    } finally { await s.t.close(); }
  });

  it("fails closed on an unverified route, outside the Sandbox organisation and without payment details", async () => {
    const legacy = await scenario({ country: "United States" });
    try {
      expect(legacy.work.payable).toMatchObject({ currencyCode: "USD" });
      // A USD obligation at a location now in South Africa: historical currency evidence is no SA route.
      await legacy.t.db.update(outlets).set({ country: "South Africa" }).where(eq(outlets.id, legacy.manager.locationId));
      await legacy.t.db.update(organisations).set({ country: "South Africa" }).where(eq(organisations.id, legacy.manager.organisationId));
      expect(await legacy.run()).toMatchObject({ status: "SETTLEMENT_BLOCKED", outcomeCode: "payout-route-unverified" });
    } finally { await legacy.t.close(); }
    const ordinary = await scenario({ sandbox: false });
    try { expect(await ordinary.run()).toMatchObject({ status: "SETTLEMENT_BLOCKED", outcomeCode: "sandbox-isolation-required" }); } finally { await ordinary.t.close(); }
    const unregistered = await scenario({ paymentEmail: null });
    try { expect(await unregistered.run()).toMatchObject({ status: "SETTLEMENT_BLOCKED", outcomeCode: "payment-details-required" }); } finally { await unregistered.t.close(); }
  });

  it("stays a dry run even with a fresh reference rate, a payment destination and a payout client", async () => {
    const s = await scenario({ country: "South Africa" });
    try {
      await seedTestFxRate(s.t.db, TEST_QUOTE_1850);
      expect(await s.run()).toMatchObject({ status: "DRY_RUN_ELIGIBLE" });
      expect(s.paypal.createPayout).not.toHaveBeenCalled();
      expect(await s.payouts()).toHaveLength(0);
      expect(await s.payable()).toMatchObject({ status: "PENDING_REVIEW", approvedAmountMinor: null });
    } finally { await s.t.close(); }
  });

  it("settles through the shared engine only after dry-run is explicitly off, exactly once", async () => {
    vi.stubEnv(PAY_AGENT_DRY_RUN_ENV, "false");
    const s = await scenario();
    try {
      expect(await s.run()).toMatchObject({ status: "SETTLEMENT_SUBMITTED", outcomeCode: "PAYOUT_RESERVED" });
      const [payout] = await s.payouts();
      expect(payout).toMatchObject({ payableId: s.payableId, status: "PROCESSING", amountMinor: 7_800, currencyCode: "GBP", providerAmountMinor: 7_800, fxRateMicros: null, requestedBy: null, paidAt: null });
      expect(await s.event()).toMatchObject({ payoutId: payout.id, dryRun: false });
      expect(await s.payable()).toMatchObject({ status: "APPROVED", approvedBy: s.manager.userId, approvedAmountMinor: 7_800, approvedCurrencyCode: "GBP" });
      const [approval] = await s.t.db.select().from(auditEvents).where(eq(auditEvents.action, "PAYABLE_APPROVED"));
      expect(approval.metadata).toMatchObject({ actorUserId: null, actorService: "fairshift-pay-agent", basis: "MANAGER_CONFIRMED_COMPLETION", authorisedBy: s.manager.userId, payAgentEventId: s.eventId,
        // FS-APPROVER-DEC-001: the confirming manager is approver of record, on the stated basis.
        approverOfRecord: s.manager.userId, approverDecision: "FS-APPROVER-DEC-001", approverBasis: "Manager confirmation at preauthorised fixed terms (DEC-SA-011)" });
      expect(await s.run({ manual: true })).toMatchObject({ status: "SETTLEMENT_SUBMITTED" });
      expect(s.paypal.createPayout).toHaveBeenCalledTimes(1);
      expect(await s.payouts()).toHaveLength(1);
      // PayPal only accepted the request: nothing is called paid.
      expect((await s.payouts())[0].status).toBe("PROCESSING");
    } finally { await s.t.close(); }
  });

  it("freezes a ZAR payout's USD leg at the newest ECB rate when dry-run is off", async () => {
    vi.stubEnv(PAY_AGENT_DRY_RUN_ENV, "false");
    const s = await scenario({ country: "South Africa" });
    try {
      const rate = await seedTestFxRate(s.t.db, TEST_QUOTE_1850);
      expect(await s.run()).toMatchObject({ status: "SETTLEMENT_SUBMITTED" });
      expect((await s.payouts())[0]).toMatchObject({ amountMinor: 7_800, currencyCode: "ZAR", providerCurrency: "USD", providerAmountMinor: 421, fxRateMicros: 18_500_000, fxRateSource: `ECB_EUROFXREF_DAILY:${rate.rateDate}` });
      expect(s.paypal.createPayout).toHaveBeenCalledWith(expect.objectContaining({ amount: "4.21", currency: "USD" }));
    } finally { await s.t.close(); }
  });
});

describe("manager resolution of a Pay Agent hold", () => {
  it("releases a hold through the settlement gates without asking the model again, recording the manager", async () => {
    vi.stubEnv(PAY_AGENT_DRY_RUN_ENV, "false");
    const model = fakeModel(holdReply);
    const s = await scenario({ model });
    try {
      expect(await s.run()).toMatchObject({ status: "DECIDED_HOLD" });
      const releaser = await testUser(s.t.db);
      expect(await resolveHold(s.t.db, s.manager, s.eventId, { resolution: "RELEASED", userId: releaser, note: null })).toMatchObject({ status: "HOLD_RELEASED", resolvedBy: releaser });
      expect(await s.run()).toMatchObject({ status: "SETTLEMENT_SUBMITTED" });
      expect(model.assess).toHaveBeenCalledTimes(1);
      expect(await s.payable()).toMatchObject({ status: "APPROVED", approvedBy: releaser });
      const [approval] = await s.t.db.select().from(auditEvents).where(eq(auditEvents.action, "PAYABLE_APPROVED"));
      expect(approval.metadata).toMatchObject({ basis: "MANAGER_RELEASED_HOLD", authorisedBy: releaser, actorService: "fairshift-pay-agent" });
      const [release] = await s.t.db.select().from(auditEvents).where(eq(auditEvents.action, "PAY_AGENT_HOLD_RELEASED"));
      expect(release.metadata).toMatchObject({ actorUserId: releaser, managerOverride: true });
    } finally { await s.t.close(); }
  });

  it("keeps a rejected payable unpaid on every path, even after new evidence", async () => {
    const s = await scenario({ model: fakeModel(holdReply) });
    try {
      await s.run();
      await resolveHold(s.t.db, s.manager, s.eventId, { resolution: "REJECTED", userId: s.manager.userId, note: "Hours were not worked as confirmed." });
      expect(await s.run({ manual: true })).toMatchObject({ status: "HOLD_REJECTED", outcomeCode: "MANAGER_REJECTED" });
      await expect(approveWorkPayable(s.t.db, s.manager, s.payableId)).rejects.toMatchObject({ feedback: "pay-agent-rejected" });
      await expect(submitWorkPayout(s.t.db, s.paypal, s.manager, s.payableId)).rejects.toMatchObject({ feedback: "pay-agent-rejected" });
      await s.t.db.update(workers).set({ paypalPayoutEmail: "new.destination@example.test", locationId: s.manager.locationId }).where(eq(workers.id, s.work.worker.id));
      await s.t.db.update(workers).set({ status: "INACTIVE" }).where(eq(workers.id, s.work.worker.id));
      const later = await s.t.db.transaction(tx => recordPayAgentEvent(tx, s.manager, s.payableId, "EVIDENCE_REFRESHED", s.manager.userId));
      expect(later).toMatchObject({ status: "BLOCKED", outcomeCode: "MANAGER_REJECTED" });
      expect(s.paypal.createPayout).not.toHaveBeenCalled();
      expect(await s.payouts()).toHaveLength(0);
      expect(await s.payable()).toMatchObject({ status: "PENDING_REVIEW", approvedAmountMinor: null });
    } finally { await s.t.close(); }
  });
});

describe("Pay Agent processing edge cases", () => {
  it("does not disclose an identity-check failure and refuses triggers that carry anything but an event ID", async () => {
    const s = await scenario();
    try {
      const failing = createPayAgent({ db: s.t.db, identityVerifier: { authenticate: async () => { throw new Error("credential-secret"); } }, model: () => s.fake, settlement: confirmedWorkSettlement(s.t.db, s.paypal) });
      const refused = await failing.process({ eventId: s.eventId }, s.credential);
      expect(refused).toMatchObject({ status: "UNAUTHORISED", event: null });
      expect(JSON.stringify(refused)).not.toContain("credential-secret");
      for (const raw of [{ eventId: s.eventId, amount: 1 }, { eventId: s.eventId, payableId: s.payableId }, { eventId: s.eventId, identity: {} }, { payableId: s.payableId }, { eventId: "not-an-id" }, null, "event"]) {
        expect(await s.agent.process(raw, s.credential)).toMatchObject({ status: "INVALID_TRIGGER" });
      }
      expect(s.fake.assess).not.toHaveBeenCalled();
      expect(await s.event()).toMatchObject({ status: "PENDING", attemptCount: 0 });
    } finally { await s.t.close(); }
  });

  it("reports a payout made while the model was deciding, and never settles again", async () => {
    const s = await scenario();
    try {
      s.fake.assess.mockImplementationOnce(async request => {
        await approveWorkPayable(s.t.db, s.manager, s.payableId);
        await submitWorkPayout(s.t.db, s.paypal, s.manager, s.payableId);
        return { responseId: "resp_late", responseModel: "test-model", text: wire(settleReply(JSON.parse(request.input).payableId)) };
      });
      expect(await s.run()).toMatchObject({ status: "SKIPPED", outcomeCode: "PAYOUT_EXISTS" });
      expect(await s.event()).toMatchObject({ responseId: "resp_late", decision: null });
      expect(s.paypal.createPayout).toHaveBeenCalledTimes(1);
      expect(await s.payouts()).toHaveLength(1);
    } finally { await s.t.close(); }
  });
});
