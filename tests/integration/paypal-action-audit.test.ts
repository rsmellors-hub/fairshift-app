import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestDatabase } from "../helpers/database";
import { business, createOrganisation, personal } from "../helpers/onboarding";
import { confirmedWork, fakePayAgentModel, fakePayoutClient, payAgentCompany, testUser } from "../helpers/pay-agent";
import { sandboxFixture } from "../helpers/sandbox";
import { planFixture } from "../helpers/subscription-plans";
import { resolveScope, type Scope } from "@/server/auth/access";
import type { SubscriptionAdapter } from "@/server/billing/paypal";
import { refreshSubscription, startSubscription } from "@/server/billing/service";
import { auditEvents, subscriptions, users } from "@/server/db/schema";
import { PayPalApiError } from "@/server/integrations/paypal/client";
import { PayPalPayoutError, type PayPalPayoutAdapter, type PayoutResult } from "@/server/integrations/paypal/payout-client";
import { mintPayAgentCredentialForManager, payAgentServiceVerifier } from "@/server/pay-agent/identity";
import { createPayAgent } from "@/server/pay-agent/orchestrator";
import { confirmedWorkSettlement } from "@/server/pay-agent/settlement";
import { preparePayAgentRetry, rejectPayAgentHold, releasePayAgentHold } from "@/server/pay-agent/service";
import { approveWorkPayable, refreshWorkPayout, submitWorkPayout } from "@/server/payments/work-payouts";
import type { TipAgent } from "@/server/tips/agent";
import { retryTipCheck } from "@/server/tips/wiring";

// Every action a person takes that can lead to a PayPal call leaves an audit row: who, their role, the
// session type (signed in or public demo), the time and the outcome, refusals included. Synthetic tenants
// and provider doubles only; no network.
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];
type Row = typeof auditEvents.$inferSelect;
const rows = (db: Db, action: string) => db.select().from(auditEvents).where(eq(auditEvents.action, action)).orderBy(asc(auditEvents.createdAt));
const meta = (row: Row) => row.metadata as Record<string, unknown>;
const DEMO_GROUP = "7d1f0c9e-0b5a-4c55-9a43-5f1f5a7a2b10";
const publicDemo = (scope: Scope): Scope => ({ ...scope, demo: { persona: scope.role, group: DEMO_GROUP } } as Scope);
const holdReply = (payableId: string) => ({ action: "hold_for_manager_review", payableId, reasonCode: "CONFIRMATION_DELAY", summary: "Confirmation was recorded long after the shift ended.", checks: { hours: "OK", overlap: "OK", timing: "CONCERN", records: "OK" } });
const expectTimed = (list: Row[]) => { for (const row of list) expect(row.createdAt).toBeInstanceOf(Date); };

describe("audit of actions that can lead to a PayPal call", () => {
  it("records who, role, session type, time and outcome for every Pay Agent retry, release and rejection, refusals included", async () => {
    const t = await createTestDatabase();
    try {
      const manager = (await payAgentCompany(t.db)).scopes[0];
      sandboxFixture(manager.organisationId);
      const work = await confirmedWork(t.db, manager);
      const eventId = work.payAgentEvent!.id, payableId = work.payable!.id;
      const paypal = fakePayoutClient();
      const agent = createPayAgent({ db: t.db, identityVerifier: payAgentServiceVerifier, model: () => fakePayAgentModel(holdReply), settlement: confirmedWorkSettlement(t.db, paypal) });
      await agent.process({ eventId }, mintPayAgentCredentialForManager(manager));

      // A public demo visitor is refused, and recorded as a public demo session.
      await expect(preparePayAgentRetry(t.db, publicDemo(manager), payableId)).rejects.toThrow("Access denied");
      await expect(releasePayAgentHold(t.db, publicDemo(manager), eventId, "Checked with the worker: the hours were right.")).rejects.toThrow("Access denied");
      // A held payment can't be retried; a manager can't release a hold on their own work; a rejection needs a reason.
      await expect(preparePayAgentRetry(t.db, manager, payableId)).rejects.toMatchObject({ feedback: "pay-agent-hold-pending" });
      // Held payments are the Owner's to decide (Day 6); one on the Owner's own work goes to someone else.
      const selfManager: Scope = { ...manager, role: "OWNER", userId: work.workerScope.userId };
      await expect(releasePayAgentHold(t.db, selfManager, eventId, "Checked with the worker: the hours were right.")).rejects.toMatchObject({ feedback: "pay-agent-own-work" });
      await expect(rejectPayAgentHold(t.db, manager, eventId, "Hours not worked.")).rejects.toMatchObject({ feedback: "pay-agent-owner-decides" });
      await expect(rejectPayAgentHold(t.db, { ...manager, role: "OWNER" }, eventId, "  ")).rejects.toMatchObject({ feedback: "pay-agent-reject-reason" });
      const releaser: Scope = { ...manager, role: "OWNER", userId: await testUser(t.db) };
      await releasePayAgentHold(t.db, releaser, eventId, "Checked with the worker: the hours were right.");
      await expect(rejectPayAgentHold(t.db, { ...manager, role: "OWNER" }, eventId, "Hours not worked.")).rejects.toMatchObject({ feedback: "pay-agent-hold-unavailable" });
      // A form value that isn't an ID is refused and never stored.
      await expect(releasePayAgentHold(t.db, { ...manager, role: "OWNER" }, "not-an-id", "Checked with the worker: the hours were right.")).rejects.toMatchObject({ feedback: "pay-agent-hold-unavailable" });

      const signedIn = { actorRole: "MANAGER", sessionType: "SIGNED_IN" };
      const ownerSignedIn = { actorRole: "OWNER", sessionType: "SIGNED_IN" };
      const retries = await rows(t.db, "PAY_AGENT_RETRY_REQUESTED");
      expect(retries.map(meta)).toEqual([
        expect.objectContaining({ actorUserId: manager.userId, actorRole: "MANAGER", sessionType: "PUBLIC_DEMO", demoGroup: DEMO_GROUP, outcome: "REFUSED:access-denied", payableId }),
        expect.objectContaining({ actorUserId: manager.userId, ...signedIn, outcome: "REFUSED:pay-agent-hold-pending", payableId }),
      ]);
      expect(retries[1]).toMatchObject({ organisationId: manager.organisationId, outletId: manager.locationId, entityType: "pay_agent_event", entityId: eventId, correlationId: `payable:${payableId}` });

      const releases = await rows(t.db, "PAY_AGENT_HOLD_RELEASE_REQUESTED");
      expect(releases.map(meta)).toEqual([
        expect.objectContaining({ actorUserId: manager.userId, actorRole: "MANAGER", sessionType: "PUBLIC_DEMO", outcome: "REFUSED:access-denied" }),
        expect.objectContaining({ actorUserId: selfManager.userId, ...ownerSignedIn, outcome: "REFUSED:pay-agent-own-work", payableId }),
        expect.objectContaining({ actorUserId: releaser.userId, ...ownerSignedIn, outcome: "RELEASED", payableId }),
        expect.objectContaining({ actorUserId: manager.userId, ...ownerSignedIn, outcome: "REFUSED:pay-agent-hold-unavailable", payableId: null }),
      ]);
      expect(releases[2]).toMatchObject({ entityId: eventId, correlationId: `payable:${payableId}` });
      expect(releases[3]).toMatchObject({ entityId: null, correlationId: `pay-agent-control:${manager.userId}` });

      const rejections = await rows(t.db, "PAY_AGENT_HOLD_REJECT_REQUESTED");
      expect(rejections.map(meta)).toEqual([
        expect.objectContaining({ actorUserId: manager.userId, ...signedIn, outcome: "REFUSED:pay-agent-owner-decides" }),
        expect.objectContaining({ actorUserId: manager.userId, ...ownerSignedIn, outcome: "REFUSED:pay-agent-reject-reason" }),
        expect.objectContaining({ actorUserId: manager.userId, ...ownerSignedIn, outcome: "REFUSED:pay-agent-hold-unavailable" }),
      ]);
      // The journal's own row for the release names the same person, role and session.
      expect((await rows(t.db, "PAY_AGENT_HOLD_RELEASED")).map(meta)).toEqual([expect.objectContaining({ actorUserId: releaser.userId, ...ownerSignedIn, outcome: "RELEASED" })]);
      for (const list of [retries, releases, rejections]) expectTimed(list);
      expect([...retries, ...releases, ...rejections].filter(row => meta(row).sessionType === "SIGNED_IN").every(row => !("demoGroup" in meta(row)))).toBe(true);
      // None of this reached PayPal.
      expect(paypal.createPayout).not.toHaveBeenCalled();
    } finally { await t.close(); }
  });

  it("records each manual payout send and status check with PayPal's outcome or the refusal, and who confirmed the work", async () => {
    const t = await createTestDatabase();
    try {
      const manager = (await payAgentCompany(t.db)).scopes[0];
      sandboxFixture(manager.organisationId);
      const work = await confirmedWork(t.db, manager);
      const payableId = work.payable!.id;
      const getPayout = vi.fn<PayPalPayoutAdapter["getPayout"]>()
        .mockRejectedValueOnce(new PayPalPayoutError("PayPal is busy.", "RATE_LIMIT_REACHED", 429))
        .mockImplementation(async (batchId: string): Promise<PayoutResult> => ({ batchId, itemId: "PPI-1", status: "SUCCESS", batchStatus: "SUCCESS", itemStatus: "SUCCESS", transactionId: "PPT-1", itemAmount: { value: "78.00", currency: "GBP" } }));
      const createPayout = vi.fn(async (input: { senderBatchId: string }): Promise<PayoutResult> => ({ batchId: `PPB${input.senderBatchId.slice(-8)}`, itemId: null, status: "PENDING", batchStatus: "PENDING", itemStatus: null, transactionId: null }));
      const paypal = { createPayout, getPayout } as unknown as PayPalPayoutAdapter;

      await expect(submitWorkPayout(t.db, paypal, work.workerScope, payableId)).rejects.toThrow("Access denied");
      await expect(submitWorkPayout(t.db, paypal, manager, payableId)).rejects.toThrow(/Approve/);
      await approveWorkPayable(t.db, manager, payableId);
      expect((await submitWorkPayout(t.db, paypal, manager, payableId)).submitted).toBe(true);
      expect((await submitWorkPayout(t.db, paypal, manager, payableId)).submitted).toBe(false);
      await expect(refreshWorkPayout(t.db, paypal, manager, payableId)).rejects.toThrow(/could not be retrieved/);
      expect(await refreshWorkPayout(t.db, paypal, manager, payableId)).toMatchObject({ status: "PAID" });
      expect(createPayout).toHaveBeenCalledTimes(1);

      const signedIn = { actorUserId: manager.userId, actorRole: "MANAGER", sessionType: "SIGNED_IN" };
      const sends = await rows(t.db, "PAYOUT_SEND_REQUESTED");
      expect(sends.map(meta)).toEqual([
        expect.objectContaining({ actorUserId: work.workerScope.userId, actorRole: "TEAM_MEMBER", sessionType: "SIGNED_IN", outcome: "REFUSED:access-denied" }),
        expect.objectContaining({ ...signedIn, outcome: "REFUSED" }),
        expect.objectContaining({ ...signedIn, outcome: "SENT:PROCESSING" }),
        expect.objectContaining({ ...signedIn, outcome: "ALREADY_SENT:PROCESSING" }),
      ]);
      expect(sends[2]).toMatchObject({ entityType: "work_payable", entityId: payableId, correlationId: `payable:${payableId}` });
      const checks = await rows(t.db, "PAYOUT_STATUS_CHECK_REQUESTED");
      expect(checks.map(meta)).toEqual([
        expect.objectContaining({ ...signedIn, outcome: "PROVIDER_ERROR:RATE_LIMIT_REACHED" }),
        expect.objectContaining({ ...signedIn, outcome: "STATUS:PAID" }),
      ]);
      expectTimed([...sends, ...checks]);
      // The engine's own rows for a person's send carry the same role and session type.
      expect((await rows(t.db, "PAYOUT_RESERVED")).map(meta)).toEqual([expect.objectContaining({ ...signedIn, senderBatchId: expect.stringMatching(/^FSWP-B-/) })]);
      expect((await rows(t.db, "PAYABLE_APPROVED")).map(meta)).toEqual([expect.objectContaining(signedIn)]);
      // Confirming the work (which starts the Pay Agent) records who confirmed it.
      expect((await rows(t.db, "WORK_CONFIRMED")).map(meta)).toEqual([expect.objectContaining({ ...signedIn, outcome: "CONFIRMED" })]);
    } finally { await t.close(); }
  });

  it("records each subscription checkout and status check with PayPal's answer or the refusal", async () => {
    const t = await createTestDatabase();
    try {
      vi.stubEnv("PAYPAL_SINGLE_OUTLET_MONTHLY_PLAN_ID", "P-EXAMPLE");
      const userId = randomUUID();
      await t.db.insert(users).values({ id: userId, email: "audit-owner@example.test", name: "Owner", passwordHash: "not-used", ...personal, emailVerifiedAt: new Date() });
      const org = await createOrganisation(t.db, userId, { ...business, name: "Audit Co", locationName: "HQ" });
      sandboxFixture(org.organisationId);
      const scope = await resolveScope(t.db, userId, org.membershipId);
      await t.db.update(subscriptions).set({ status: "UNCONFIGURED", verifiedAt: null, providerId: null, planId: null, tier: null, billingPeriod: null, locationLimit: null }).where(eq(subscriptions.organisationId, org.organisationId));
      let status: "APPROVAL_PENDING" | "ACTIVE" = "APPROVAL_PENDING";
      const details = () => ({ id: "I-AUDIT123", custom_id: scope.organisationId, plan_id: "P-EXAMPLE", status, links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=example" }] });
      const get = vi.fn(async () => details()).mockRejectedValueOnce(new PayPalApiError("PayPal is busy.", "RATE_LIMIT_REACHED", 429));
      const adapter: SubscriptionAdapter = { getPlan: async id => planFixture(id), create: vi.fn(async () => details()), get, verifyWebhookSignature: vi.fn(async () => true) };
      const choice = { tier: "SINGLE_OUTLET", billingPeriod: "MONTHLY" } as const;

      await expect(startSubscription(t.db, scope, null, choice)).rejects.toThrow(/unavailable/);
      await startSubscription(t.db, scope, adapter, choice);
      await startSubscription(t.db, scope, adapter, choice);
      await expect(refreshSubscription(t.db, scope, adapter)).rejects.toThrow("PayPal is busy.");
      status = "ACTIVE";
      expect(await refreshSubscription(t.db, scope, adapter)).toMatchObject({ status: "ACTIVE" });
      expect(adapter.create).toHaveBeenCalledTimes(1);

      const owner = { actorUserId: userId, actorRole: "OWNER", sessionType: "SIGNED_IN" };
      const checkouts = await rows(t.db, "SUBSCRIPTION_CHECKOUT_REQUESTED");
      expect(checkouts.map(meta)).toEqual([
        expect.objectContaining({ ...owner, outcome: "REFUSED:subscription-unavailable", tier: "SINGLE_OUTLET", billingPeriod: "MONTHLY" }),
        expect.objectContaining({ ...owner, outcome: "CREATED:APPROVAL_PENDING" }),
        expect.objectContaining({ ...owner, outcome: "EXISTING_SUBSCRIPTION:APPROVAL_PENDING" }),
      ]);
      expect(checkouts[1]).toMatchObject({ entityType: "organisation_subscription", entityId: "I-AUDIT123", correlationId: `subscription:${org.organisationId}` });
      const checks = await rows(t.db, "SUBSCRIPTION_STATUS_CHECKED");
      expect(checks.map(meta)).toEqual([
        expect.objectContaining({ ...owner, outcome: "PROVIDER_ERROR:RATE_LIMIT_REACHED" }),
        expect.objectContaining({ ...owner, outcome: "STATUS:ACTIVE" }),
      ]);
      expect(checks.every(row => row.entityId === "I-AUDIT123")).toBe(true);
      expectTimed([...checkouts, ...checks]);
    } finally { await t.close(); }
  });

  it("records each tip check retry before anything runs, and runs only the Owner's signed-in retry", async () => {
    const t = await createTestDatabase();
    try {
      const manager = (await payAgentCompany(t.db)).scopes[0];
      const owner: Scope = { ...manager, userId: await testUser(t.db), role: "OWNER" };
      const process = vi.fn();
      const agent = { process } as unknown as TipAgent;
      const tasks: Array<() => Promise<unknown>> = [];
      const schedule = (task: () => Promise<unknown>) => { tasks.push(task); };
      const eventId = randomUUID();

      await retryTipCheck(t.db, agent, owner, eventId, schedule);
      await expect(retryTipCheck(t.db, agent, publicDemo(owner), eventId, schedule)).rejects.toThrow("Access denied");
      await expect(retryTipCheck(t.db, agent, manager, eventId, schedule)).rejects.toThrow("Access denied");
      await expect(retryTipCheck(t.db, agent, owner, "not-an-id", schedule)).rejects.toMatchObject({ feedback: "tip-check-unavailable" });
      expect(tasks).toHaveLength(1);
      await tasks[0]();
      expect(process).toHaveBeenCalledWith({ eventId }, expect.anything(), { manual: true });

      const retries = await rows(t.db, "TIP_CHECK_RETRY_REQUESTED");
      expect(retries.map(meta)).toEqual([
        expect.objectContaining({ actorUserId: owner.userId, actorRole: "OWNER", sessionType: "SIGNED_IN", outcome: "RUN_SCHEDULED" }),
        expect.objectContaining({ actorUserId: owner.userId, actorRole: "OWNER", sessionType: "PUBLIC_DEMO", demoGroup: DEMO_GROUP, outcome: "REFUSED:access-denied" }),
        expect.objectContaining({ actorUserId: manager.userId, actorRole: "MANAGER", sessionType: "SIGNED_IN", outcome: "REFUSED:access-denied" }),
        expect.objectContaining({ actorUserId: owner.userId, actorRole: "OWNER", sessionType: "SIGNED_IN", outcome: "REFUSED:tip-check-unavailable" }),
      ]);
      expect(retries.map(row => row.entityId)).toEqual([eventId, eventId, eventId, null]);
      expectTimed(retries);
    } finally { await t.close(); }
  });
});
