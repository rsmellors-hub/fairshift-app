import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as order } from "@/app/api/paypal/orders/route";
import { POST as capture } from "@/app/api/paypal/orders/[orderId]/capture/route";
import { POST as webhook } from "@/app/api/webhooks/paypal/route";
import { POST as subscriptionWebhook } from "@/app/api/webhooks/paypal-subscriptions/route";
import { sendPayoutAction, refreshPayoutAction } from "@/app/operations-actions";
import { startSubscriptionAction, refreshSubscriptionAction } from "@/app/auth-actions";
import { currentIdentity, operatorAllowed, requireFinancialScope, requireIdentity, requireOwnerCustomer } from "@/server/auth/request";
import { getPayPalClient, getPayPalPayoutClient } from "@/server/integrations/paypal/factory";
import { getSubscriptionAdapter } from "@/server/billing/paypal";
import { getDatabase } from "@/server/db/client";
import { getPayPalConfig } from "@/server/config/env";
import { DEMO_ORGANISATION_ID, DEMO_OUTLET_ID } from "@/server/constants";
import { createSandboxOrder, captureSandboxOrder } from "@/server/domain/transactions";
import { submitWorkPayout, refreshWorkPayout } from "@/server/payments/work-payouts";
import { startSubscription, refreshSubscription } from "@/server/billing/service";
import { auditEvents, saleTransactions, workPayouts, workPayables, subscriptions, providerEvents, subscriptionEvents } from "@/server/db/schema";
import type { Scope } from "@/server/auth/access";
import { createTestDatabase } from "../helpers/database";
import { createFakePayPalAdapter } from "../helpers/paypal";
import { sandboxFixture } from "../helpers/sandbox";

vi.mock("@/server/auth/request", () => ({ currentIdentity: vi.fn(), operatorAllowed: vi.fn(), requireFinancialScope: vi.fn(), requireIdentity: vi.fn(), requireOwnerCustomer: vi.fn() }));
vi.mock("@/server/db/client", () => ({ getDatabase: vi.fn() }));
vi.mock("@/server/integrations/paypal/factory", () => ({ getPayPalClient: vi.fn(), getPayPalPayoutClient: vi.fn() }));
vi.mock("@/server/billing/paypal", async original => ({ ...await original<typeof import("@/server/billing/paypal")>(), getSubscriptionAdapter: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const scope: Scope = { userId: randomUUID(), organisationId: DEMO_ORGANISATION_ID, locationId: DEMO_OUTLET_ID, role: "MANAGER", organisationName: "Isolated", locationName: "Test" };
const identity = (demoPersona: string | null = null) => ({ user: { id: scope.userId }, session: { demoPersona } }) as never;
const request = () => new Request("https://isolated.example.test/api/paypal/orders?deployment=HOSTED_SANDBOX_DEMO", { method: "POST", headers: { origin: "https://isolated.example.test", "x-fairshift-deployment-mode": "HOSTED_SANDBOX_DEMO" }, body: JSON.stringify({ deploymentMode: "HOSTED_SANDBOX_DEMO", organisationId: DEMO_ORGANISATION_ID }) });
const form = () => { const f = new FormData(); f.set("tier", "SINGLE_OUTLET"); f.set("billingPeriod", "MONTHLY"); f.set("payableId", randomUUID()); f.set("deploymentMode", "HOSTED_SANDBOX_DEMO"); return f; };
beforeEach(() => {
  // These tests cover demo-only isolation, restored by its switch (Owner decision 10 Nov 2026).
  vi.stubEnv("FAIRSHIFT_SANDBOX_SCOPE", "DEMO_ONLY");
  sandboxFixture();
  vi.stubEnv("DATABASE_URL", "postgres://fixture:fixture@127.0.0.1:1/unused");
  vi.stubEnv("PAYPAL_CLIENT_ID", "fixture"); vi.stubEnv("PAYPAL_CLIENT_SECRET", "fixture"); vi.stubEnv("PAYPAL_WEBHOOK_ID", "fixture"); vi.stubEnv("APP_BASE_URL", "https://isolated.example.test");
  vi.mocked(currentIdentity).mockResolvedValue(identity()); vi.mocked(operatorAllowed).mockReturnValue(true);
  vi.mocked(requireFinancialScope).mockResolvedValue(scope);
  vi.mocked(requireOwnerCustomer).mockResolvedValue({ ...scope, role: "OWNER" });
  vi.mocked(requireIdentity).mockResolvedValue(identity());
});
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });

const routes = [
  ["order", () => order(request())],
  ["capture", () => capture(request(), { params: Promise.resolve({ orderId: "ORDER123456" }) })],
  ["capture webhook", () => webhook(request())],
  ["subscription webhook", () => subscriptionWebhook(request())],
] as const;

describe("PayPal HTTP and action isolation", () => {
  it.each(routes)("blocks live %s before provider construction or financial DB access despite browser mode inputs", async (_name, run) => {
    vi.stubEnv("FAIRSHIFT_DEPLOYMENT_MODE", "LIVE_CUSTOMER");
    const response = await run();
    expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: "SANDBOX_ISOLATION_REQUIRED" });
    expect(getPayPalClient).not.toHaveBeenCalled(); expect(getPayPalPayoutClient).not.toHaveBeenCalled(); expect(getSubscriptionAdapter).not.toHaveBeenCalled(); expect(getDatabase).not.toHaveBeenCalled();
  });
  it.each([sendPayoutAction, refreshPayoutAction])("blocks live payout actions before construction and financial DB access", async action => {
    vi.stubEnv("FAIRSHIFT_DEPLOYMENT_MODE", "LIVE_CUSTOMER");
    await expect(action(form())).rejects.toThrow("REDIRECT:/settlements?status=sandbox-isolation-required");
    expect(getPayPalPayoutClient).not.toHaveBeenCalled(); expect(getDatabase).not.toHaveBeenCalled();
  });
  it.each([sendPayoutAction, refreshPayoutAction])("blocks wrong-tenant and public-persona actions before construction", async action => {
    for (const refused of [{ ...scope, organisationId: randomUUID() }, { ...scope, demo: { persona: "MANAGER" as const, group: "public" } }]) {
      vi.mocked(requireFinancialScope).mockResolvedValue(refused);
      await expect(action(form())).rejects.toThrow("sandbox-isolation-required");
    }
    expect(getPayPalPayoutClient).not.toHaveBeenCalled(); expect(getDatabase).not.toHaveBeenCalled();
  });
  it("blocks live subscription checkout and refresh before constructing an adapter or creating financial state", async () => {
    vi.stubEnv("FAIRSHIFT_DEPLOYMENT_MODE", "LIVE_CUSTOMER");
    await expect(startSubscriptionAction(form())).rejects.toThrow("REDIRECT:/subscribe?status=unavailable");
    await expect(refreshSubscriptionAction()).rejects.toThrow("REDIRECT:/subscribe?status=error");
    expect(getSubscriptionAdapter).not.toHaveBeenCalled(); expect(getDatabase).not.toHaveBeenCalled();
  });
  it("refuses another tenant's checkout before acquisition can create a subscription row", async () => {
    vi.mocked(requireOwnerCustomer).mockResolvedValue({ ...scope, role: "OWNER", organisationId: randomUUID() });
    await expect(startSubscriptionAction(form())).rejects.toThrow("REDIRECT:/subscribe?status=unavailable");
    expect(getSubscriptionAdapter).not.toHaveBeenCalled(); expect(getDatabase).not.toHaveBeenCalled();
  });
  it("refuses public demo operator writes even if operator allowlisting were to overlap", async () => {
    vi.mocked(currentIdentity).mockResolvedValue(identity("OWNER"));
    for (const run of [routes[0][1], routes[1][1]]) expect((await run()).status).toBe(403);
    expect(getPayPalClient).not.toHaveBeenCalled(); expect(getDatabase).not.toHaveBeenCalled();
  });
  it("refuses the fixed-organisation operator experiment in a differently isolated tenant", async () => {
    sandboxFixture(randomUUID());
    expect((await order(request())).status).toBe(403);
    expect(getPayPalClient).not.toHaveBeenCalled(); expect(getDatabase).not.toHaveBeenCalled();
  });
  it("retains authenticated isolated operator order creation and capture with fake provider evidence", async () => {
    const t = await createTestDatabase();
    try {
      vi.mocked(getDatabase).mockReturnValue(t.db);
      vi.mocked(getPayPalClient).mockReturnValue(createFakePayPalAdapter() as ReturnType<typeof getPayPalClient>);
      const response = await order(request());
      expect(response.status).toBe(201);
      expect(getPayPalClient).toHaveBeenCalledOnce();
      const sales = await t.db.select().from(saleTransactions);
      expect(sales).toHaveLength(1);
      const sale = sales[0], fake = createFakePayPalAdapter();
      vi.mocked(getPayPalClient).mockReturnValue(createFakePayPalAdapter({
        async captureOrder() { return { ...(await fake.captureOrder("ORDER123456", "fixture")), customId: sale.internalReference }; },
      }) as ReturnType<typeof getPayPalClient>);
      const captured = await capture(request(), { params: Promise.resolve({ orderId: "ORDER123456" }) });
      expect(captured.status).toBe(200);
      expect((await t.db.select().from(saleTransactions))[0].verificationState).toBe("VERIFIED");
    } finally { await t.close(); }
  });
  it("leaves all persisted financial state unchanged when direct Sandbox services reject live deployment", async () => {
    const t = await createTestDatabase();
    try {
      const snapshot = async () => Promise.all([saleTransactions, workPayouts, workPayables, subscriptions, providerEvents, subscriptionEvents].map(table => t.db.select().from(table)));
      const before = await snapshot(), auditBefore = await t.db.select().from(auditEvents), config = getPayPalConfig();
      const paypal = createFakePayPalAdapter({ createOrder: vi.fn(), captureOrder: vi.fn() });
      const payout = { createPayout: vi.fn(), getPayout: vi.fn() };
      const adapter = { create: vi.fn(), get: vi.fn(), getPlan: vi.fn(), verifyWebhookSignature: vi.fn() };
      vi.stubEnv("FAIRSHIFT_DEPLOYMENT_MODE", "LIVE_CUSTOMER");
      for (const run of [
        () => createSandboxOrder(t.db, paypal, config), () => captureSandboxOrder(t.db, paypal, "ORDER123456"),
        () => submitWorkPayout(t.db, payout, scope, randomUUID()), () => refreshWorkPayout(t.db, payout, scope, randomUUID()),
        () => startSubscription(t.db, { ...scope, role: "OWNER" }, adapter), () => refreshSubscription(t.db, { ...scope, role: "OWNER" }, adapter),
      ]) await expect(run()).rejects.toMatchObject({ code: "SANDBOX_ISOLATION_REQUIRED" });
      expect(await snapshot()).toEqual(before);
      // A person's refused payout and checkout requests are recorded as refusals; nothing else is written.
      const added = (await t.db.select().from(auditEvents)).filter(row => !auditBefore.some(old => old.id === row.id));
      expect(added.map(row => [row.action, (row.metadata as { outcome?: string }).outcome]).sort()).toEqual([
        ["PAYOUT_SEND_REQUESTED", "REFUSED:sandbox-isolation-required"], ["PAYOUT_STATUS_CHECK_REQUESTED", "REFUSED:sandbox-isolation-required"], ["SUBSCRIPTION_CHECKOUT_REQUESTED", "REFUSED:sandbox-isolation-required"],
      ]);
      for (const fn of [paypal.createOrder, paypal.captureOrder, payout.createPayout, payout.getPayout, adapter.create, adapter.get]) expect(fn).not.toHaveBeenCalled();
    } finally { await t.close(); }
  });
});
