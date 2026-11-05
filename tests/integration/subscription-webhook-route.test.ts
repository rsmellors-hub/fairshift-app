import { sandboxFixture } from "../helpers/sandbox";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/webhooks/paypal-subscriptions/route";
import { getDatabase } from "@/server/db/client";
import { subscriptions, subscriptionEvents, users } from "@/server/db/schema";
import { getSubscriptionAdapter, type SubscriptionAdapter } from "@/server/billing/paypal";
import { organisationEntitled } from "@/server/billing/entitlement";
import { createTestDatabase } from "../helpers/database";
import { createOrganisation, personal, business } from "../helpers/onboarding";
import { paypalHeaders } from "../helpers/paypal";
import { planFixture, regularCycleOf } from "../helpers/subscription-plans";

vi.mock("@/server/db/client", () => ({ getDatabase: vi.fn() }));
vi.mock("@/server/billing/paypal", async importOriginal => ({
  ...await importOriginal<typeof import("@/server/billing/paypal")>(),
  getSubscriptionAdapter: vi.fn(),
}));

async function setup() {
  const test = await createTestDatabase();
  const userId = randomUUID();
  await test.db.insert(users).values({ id: userId, email: "owner@example.test", name: "Owner", passwordHash: "not-used", ...personal, emailVerifiedAt: new Date() });
  const org = await createOrganisation(test.db, userId, { ...business, name: "Example Co", locationName: "HQ" });
  await test.db.update(subscriptions).set({ providerId: "I-BOUND", planId: "P-BOUND", status: "APPROVAL_PENDING", tier: "SINGLE_OUTLET", billingPeriod: "MONTHLY", locationLimit: 1, verifiedAt: null }).where(eq(subscriptions.organisationId, org.organisationId));
  sandboxFixture(org.organisationId);
  const details = { id: "I-BOUND", plan_id: "P-BOUND", custom_id: org.organisationId, status: "ACTIVE" as const, plan_overridden: false };
  const adapter: SubscriptionAdapter = {
    create: vi.fn(),
    get: vi.fn(async () => details),
    getPlan: vi.fn(async id => planFixture(id)),
    verifyWebhookSignature: vi.fn(async () => true),
  };
  vi.mocked(getDatabase).mockReturnValue(test.db);
  vi.mocked(getSubscriptionAdapter).mockReturnValue(adapter);
  const stored = async () => (await test.db.select().from(subscriptions).where(eq(subscriptions.organisationId, org.organisationId)))[0];
  return { ...test, org, adapter, details, stored };
}

function request(input: { id?: string; subscriptionId?: string; eventType?: string; status?: string; customId?: string; headers?: Headers } = {}) {
  return new Request("https://example.test/api/webhooks/paypal-subscriptions", {
    method: "POST", headers: input.headers ?? paypalHeaders(),
    body: JSON.stringify({ id: input.id ?? "WH-ACTIVATED", event_type: input.eventType ?? "BILLING.SUBSCRIPTION.ACTIVATED", resource: { id: input.subscriptionId ?? "I-BOUND", status: input.status ?? "ACTIVE", custom_id: input.customId } }),
  });
}

beforeEach(() => vi.stubEnv("PAYPAL_SINGLE_OUTLET_MONTHLY_PLAN_ID", "P-BOUND"));
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });

describe("subscription webhook HTTP financial integrity", () => {
  it("returns UNKNOWN_SUBSCRIPTION for an unbound verified provider ID without adopting its organisation claim", async () => {
    const t = await setup();
    try {
      const before = await t.stored();
      const response = await POST(request({ subscriptionId: "I-UNBOUND", customId: t.org.organisationId }));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "UNKNOWN_SUBSCRIPTION" });
      expect(t.adapter.verifyWebhookSignature).toHaveBeenCalledOnce();
      expect(t.adapter.get).not.toHaveBeenCalled();
      expect(await t.stored()).toEqual(before);
      expect(await t.db.select().from(subscriptionEvents)).toHaveLength(0);
      expect(await organisationEntitled(t.db, t.org.organisationId)).toBe(false);
    } finally { await t.close(); }
  });

  it("verifies duplicates without repeating effects and reconciles delayed lifecycle messages against current provider state", async () => {
    const t = await setup();
    try {
      const first = await POST(request());
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ duplicate: false });
      const accepted = await t.stored();
      const events = await t.db.select().from(subscriptionEvents);
      expect(accepted).toMatchObject({ providerId: "I-BOUND", tier: "SINGLE_OUTLET", billingPeriod: "MONTHLY", locationLimit: 1, status: "ACTIVE" });
      const duplicate = await POST(request());
      expect(duplicate.status).toBe(200);
      expect(await duplicate.json()).toEqual({ duplicate: true });
      expect(t.adapter.verifyWebhookSignature).toHaveBeenCalledTimes(2);
      expect(t.adapter.get).toHaveBeenCalledTimes(1);
      expect(await t.stored()).toEqual(accepted);
      expect(await t.db.select().from(subscriptionEvents)).toEqual(events);

      expect((await POST(request({ id: "WH-DELAYED-CREATED", eventType: "BILLING.SUBSCRIPTION.CREATED", status: "APPROVAL_PENDING" }))).status).toBe(200);
      expect((await t.stored()).status).toBe("ACTIVE");
      vi.mocked(t.adapter.get).mockResolvedValue({ ...t.details, status: "CANCELLED" });
      expect((await POST(request({ id: "WH-DELAYED-ACTIVATED" }))).status).toBe(200);
      expect((await t.stored()).status).toBe("CANCELLED");
      expect((await POST(request())).status).toBe(200);
      expect((await t.stored()).status).toBe("CANCELLED");
      expect(await organisationEntitled(t.db, t.org.organisationId)).toBe(false);
    } finally { await t.close(); }
  });

  it.each(["signature", "missing headers", "certificate", "timestamp", "verification API", "details API", "unknown plan", "organisation mismatch", "wrong price"] as const)("does not acknowledge or activate on %s failure", async failure => {
    const t = await setup();
    try {
      const before = await t.stored();
      let headers = paypalHeaders();
      if (failure === "signature") vi.mocked(t.adapter.verifyWebhookSignature).mockResolvedValue(false);
      if (failure === "missing headers") headers = new Headers();
      if (failure === "certificate") headers.set("paypal-cert-url", "https://example.test/untrusted-certificate");
      if (failure === "timestamp") headers.set("paypal-transmission-time", "invalid");
      if (failure === "verification API") vi.mocked(t.adapter.verifyWebhookSignature).mockRejectedValue(new Error("Provider unavailable"));
      if (failure === "details API") vi.mocked(t.adapter.get).mockRejectedValue(new Error("Provider unavailable"));
      if (failure === "unknown plan") vi.mocked(t.adapter.get).mockResolvedValue({ ...t.details, plan_id: "P-UNAPPROVED" });
      if (failure === "organisation mismatch") vi.mocked(t.adapter.get).mockResolvedValue({ ...t.details, custom_id: randomUUID() });
      if (failure === "wrong price") {
        const wrong = planFixture("P-BOUND");
        regularCycleOf(wrong).pricing_scheme!.fixed_price.value = "1.00";
        vi.mocked(t.adapter.getPlan).mockResolvedValue(wrong);
      }
      const response = await POST(request({ headers }));
      expect(response.status).toBe(failure === "signature" ? 401 : ["missing headers", "certificate", "timestamp"].includes(failure) ? 400 : 503);
      expect(await t.stored()).toEqual(before);
      expect(await t.db.select().from(subscriptionEvents)).toHaveLength(0);
      expect(await organisationEntitled(t.db, t.org.organisationId)).toBe(false);
    } finally { await t.close(); }
  });

  it("rolls back reconciliation when event persistence fails, then processes redelivery once", async () => {
    const t = await setup();
    try {
      const before = await t.stored();
      await t.db.execute(sql`CREATE FUNCTION reject_subscription_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected event persistence failure'; END $$`);
      await t.db.execute(sql`CREATE TRIGGER reject_subscription_event BEFORE INSERT ON subscription_events FOR EACH ROW EXECUTE FUNCTION reject_subscription_event()`);
      const failed = await POST(request());
      expect(failed.status).toBe(503);
      expect(await failed.json()).toEqual({ error: "VERIFICATION_UNAVAILABLE" });
      expect(await t.stored()).toEqual(before);
      expect(await t.db.select().from(subscriptionEvents)).toHaveLength(0);
      expect(await organisationEntitled(t.db, t.org.organisationId)).toBe(false);
      await t.db.execute(sql`DROP TRIGGER reject_subscription_event ON subscription_events`);
      expect((await POST(request())).status).toBe(200);
      expect(await organisationEntitled(t.db, t.org.organisationId)).toBe(true);
      expect((await POST(request())).status).toBe(200);
      expect(await t.db.select().from(subscriptionEvents)).toHaveLength(1);
    } finally { await t.close(); }
  });
});


it("refuses a signed webhook for a subscription outside the deployment organisation without changing entitlement", async () => {
  const t = await setup();
  try {
    const before = await t.stored();
    sandboxFixture(randomUUID());
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "SANDBOX_ISOLATION_REQUIRED" });
    expect(t.adapter.get).not.toHaveBeenCalled();
    expect(await t.stored()).toEqual(before);
    expect(await t.db.select().from(subscriptionEvents)).toHaveLength(0);
  } finally { await t.close(); }
});
