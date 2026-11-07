import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveScope } from "@/server/auth/access";
import { organisationEntitled } from "@/server/billing/entitlement";
import type { SubscriptionAdapter, SubscriptionDetails } from "@/server/billing/paypal";
import { processSubscriptionWebhook, refreshSubscription, startSubscription, subscriptionFor } from "@/server/billing/service";
import { subscriptionEvents, subscriptions, users } from "@/server/db/schema";
import { PayPalApiError } from "@/server/integrations/paypal/client";
import { createTestDatabase } from "../helpers/database";
import { business, createOrganisation, personal } from "../helpers/onboarding";
import { paypalHeaders } from "../helpers/paypal";
import { sandboxFixture } from "../helpers/sandbox";
import { planFixture } from "../helpers/subscription-plans";

// PayPal Subscriptions Sandbox negative-test values (developer.paypal.com/subscriptions/test-go-live)
// and webhook edge cases, through FairShift's real subscription service with a fake provider.
// PayPal documents error names, not HTTP statuses; statuses here follow PayPal's general error table.
afterEach(() => vi.unstubAllEnvs());
beforeEach(() => vi.stubEnv("PAYPAL_SINGLE_OUTLET_MONTHLY_PLAN_ID", "P-EXAMPLE"));
const SELECTION = { tier: "SINGLE_OUTLET", billingPeriod: "MONTHLY" } as const;
type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];

async function owner(db: Db) {
  const userId = randomUUID();
  await db.insert(users).values({ id: userId, email: `owner-${userId.slice(0, 6)}@example.test`, name: "Owner", passwordHash: "not-used", ...personal, emailVerifiedAt: new Date() });
  const org = await createOrganisation(db, userId, { ...business, name: "Neg Co", locationName: "HQ" });
  sandboxFixture(org.organisationId);
  const scope = await resolveScope(db, userId, org.membershipId);
  await db.update(subscriptions).set({ status: "UNCONFIGURED", verifiedAt: null, providerId: null, planId: null, tier: null, billingPeriod: null, locationLimit: null }).where(eq(subscriptions.organisationId, org.organisationId));
  let status: SubscriptionDetails["status"] = "APPROVAL_PENDING";
  const details = (): SubscriptionDetails => ({ id: "I-NEGATIVE123", custom_id: scope.organisationId, plan_id: "P-EXAMPLE", status, links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=neg" }] });
  const adapter = { getPlan: async (id: string) => planFixture(id), create: vi.fn(async () => details()), get: vi.fn(async () => details()), verifyWebhookSignature: vi.fn(async () => true) };
  return { scope, adapter: adapter as SubscriptionAdapter & typeof adapter, setStatus: (next: SubscriptionDetails["status"]) => { status = next; } };
}
const rows = (db: Db, organisationId: string) => db.select().from(subscriptions).where(eq(subscriptions.organisationId, organisationId));
const webhook = (id: string, type: string) => JSON.stringify({ id, event_type: type, resource: { id: "I-NEGATIVE123" } });

describe("create subscription test values", () => {
  it.each([["ERRSUB032", "INTERNAL_SERVER_ERROR", 500], ["ERRSUB033", "NOT_AUTHORIZED", 403], ["ERRSUB034", "INVALID_REQUEST", 400], ["ERRSUB039", "UNPROCESSABLE_ENTITY", 422]])(
    "%s %s: no subscription or access, no orphan record, and a clean retry with the same request ID", async (_code, name, status) => {
      const t = await createTestDatabase();
      try {
        const { scope, adapter } = await owner(t.db);
        adapter.create.mockRejectedValueOnce(new PayPalApiError("PayPal rejected the request.", name, status));
        await expect(startSubscription(t.db, scope, adapter, SELECTION)).rejects.toBeTruthy();
        const [pending] = await rows(t.db, scope.organisationId);
        expect(pending).toMatchObject({ status: "PENDING", providerId: null, verifiedAt: null, approvalUrl: null });
        expect(await rows(t.db, scope.organisationId)).toHaveLength(1);
        expect(await organisationEntitled(t.db, scope.organisationId)).toBe(false);
        await startSubscription(t.db, scope, adapter, SELECTION);
        const calls = adapter.create.mock.calls as unknown as Array<[{ requestId: string }]>;
        expect(calls[0][0].requestId).toBe(calls[1][0].requestId);
        expect(await rows(t.db, scope.organisationId)).toHaveLength(1);
      } finally { await t.close(); }
    });
});

describe("approval, repeats and status reads", () => {
  it("a buyer who cancels or abandons PayPal approval stays pending with no access, and can restart without a second subscription", async () => {
    const t = await createTestDatabase();
    try {
      const { scope, adapter } = await owner(t.db);
      const first = await startSubscription(t.db, scope, adapter, SELECTION);
      expect(first).toMatchObject({ status: "APPROVAL_PENDING", providerId: "I-NEGATIVE123" });
      // No approval arrived: PayPal still reports APPROVAL_PENDING.
      expect(await refreshSubscription(t.db, scope, adapter)).toMatchObject({ status: "APPROVAL_PENDING" });
      expect(await organisationEntitled(t.db, scope.organisationId)).toBe(false);
      const again = await startSubscription(t.db, scope, adapter, SELECTION);
      expect(again).toMatchObject({ providerId: "I-NEGATIVE123", approvalUrl: first.approvalUrl });
      expect(adapter.create).toHaveBeenCalledTimes(1);
    } finally { await t.close(); }
  });

  it("a double-click or repeated sign-up creates one subscription only", async () => {
    const t = await createTestDatabase();
    try {
      const { scope, adapter } = await owner(t.db);
      await Promise.all([startSubscription(t.db, scope, adapter, SELECTION), startSubscription(t.db, scope, adapter, SELECTION), startSubscription(t.db, scope, adapter, SELECTION)]);
      expect(adapter.create).toHaveBeenCalledTimes(1);
      expect(await rows(t.db, scope.organisationId)).toHaveLength(1);
    } finally { await t.close(); }
  });

  it.each([["ERRSUB044", "INTERNAL_SERVER_ERROR", 500], ["ERRSUB046", "RESOURCE_NOT_FOUND", 404]])("%s %s on the status read: status is not guessed and stays for reconciliation", async (_code, name, status) => {
    const t = await createTestDatabase();
    try {
      const { scope, adapter } = await owner(t.db);
      await startSubscription(t.db, scope, adapter, SELECTION);
      const before = await subscriptionFor(t.db, scope);
      adapter.get.mockRejectedValueOnce(new PayPalApiError("PayPal could not return the subscription.", name, status));
      await expect(refreshSubscription(t.db, scope, adapter)).rejects.toBeTruthy();
      expect(await subscriptionFor(t.db, scope)).toMatchObject({ status: before?.status, verifiedAt: before?.verifiedAt ?? null });
      expect(await organisationEntitled(t.db, scope.organisationId)).toBe(false);
    } finally { await t.close(); }
  });
});

describe("subscription webhooks", () => {
  async function active(db: Db) {
    const s = await owner(db);
    await startSubscription(db, s.scope, s.adapter, SELECTION);
    s.setStatus("ACTIVE");
    return s;
  }
  it("rejects an invalid signature without any state change", async () => {
    const t = await createTestDatabase();
    try {
      const s = await active(t.db);
      s.adapter.verifyWebhookSignature.mockResolvedValueOnce(false);
      await expect(processSubscriptionWebhook(t.db, s.adapter, webhook("WH-BAD", "BILLING.SUBSCRIPTION.ACTIVATED"), paypalHeaders())).rejects.toMatchObject({ code: "SIGNATURE_VERIFICATION_FAILED", status: 401 });
      expect(await subscriptionFor(t.db, s.scope)).toMatchObject({ status: "APPROVAL_PENDING", verifiedAt: null });
      expect(await t.db.select().from(subscriptionEvents)).toHaveLength(0);
    } finally { await t.close(); }
  });

  it("processes a replayed event once", async () => {
    const t = await createTestDatabase();
    try {
      const s = await active(t.db);
      const body = webhook("WH-ACT-1", "BILLING.SUBSCRIPTION.ACTIVATED");
      expect(await processSubscriptionWebhook(t.db, s.adapter, body, paypalHeaders())).toEqual({ duplicate: false });
      expect(await processSubscriptionWebhook(t.db, s.adapter, body, paypalHeaders())).toEqual({ duplicate: true });
      expect(s.adapter.get).toHaveBeenCalledTimes(1);
      expect(await t.db.select().from(subscriptionEvents)).toHaveLength(1);
    } finally { await t.close(); }
  });

  it("never regresses status on out-of-order events: PayPal's current state decides, not the event", async () => {
    const t = await createTestDatabase();
    try {
      const s = await active(t.db);
      expect(await processSubscriptionWebhook(t.db, s.adapter, webhook("WH-2", "BILLING.SUBSCRIPTION.ACTIVATED"), paypalHeaders())).toEqual({ duplicate: false });
      // An older SUSPENDED event delivered late: PayPal still reports ACTIVE, so nothing regresses.
      await processSubscriptionWebhook(t.db, s.adapter, webhook("WH-1", "BILLING.SUBSCRIPTION.SUSPENDED"), paypalHeaders());
      expect(await subscriptionFor(t.db, s.scope)).toMatchObject({ status: "ACTIVE" });
      expect(await organisationEntitled(t.db, s.scope.organisationId)).toBe(true);
      s.setStatus("CANCELLED");
      await processSubscriptionWebhook(t.db, s.adapter, webhook("WH-3", "BILLING.SUBSCRIPTION.CANCELLED"), paypalHeaders());
      expect(await subscriptionFor(t.db, s.scope)).toMatchObject({ status: "CANCELLED" });
      expect(await organisationEntitled(t.db, s.scope.organisationId)).toBe(false);
    } finally { await t.close(); }
  });

  it("accepts BILLING.SUBSCRIPTION.PAYMENT.FAILED and reconciles from PayPal's state", async () => {
    const t = await createTestDatabase();
    try {
      const s = await active(t.db);
      s.setStatus("SUSPENDED");
      expect(await processSubscriptionWebhook(t.db, s.adapter, webhook("WH-PF-1", "BILLING.SUBSCRIPTION.PAYMENT.FAILED"), paypalHeaders())).toEqual({ duplicate: false });
      expect(await subscriptionFor(t.db, s.scope)).toMatchObject({ status: "SUSPENDED" });
      expect(await organisationEntitled(t.db, s.scope.organisationId)).toBe(false);
    } finally { await t.close(); }
  });
});
