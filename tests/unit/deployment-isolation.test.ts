import { afterEach, describe, expect, it, vi } from "vitest";
import { deploymentMode, assertSandboxDeployment, assertSandboxFinancialScope, SandboxIsolationError } from "@/server/config/deployment";
import { getPayPalClient, getPayPalPayoutClient } from "@/server/integrations/paypal/factory";
import { PayPalClient } from "@/server/integrations/paypal/client";
import { PayPalPayoutClient } from "@/server/integrations/paypal/payout-client";
import { getSubscriptionAdapter, PayPalSubscriptions } from "@/server/billing/paypal";
import { getConfigurationStatus } from "@/server/config/env";
import { sandboxFixture } from "../helpers/sandbox";
import { DEMO_ORGANISATION_ID } from "@/server/constants";

vi.mock("@/server/integrations/paypal/client", () => ({ PayPalClient: vi.fn(class {}) }));
vi.mock("@/server/integrations/paypal/payout-client", () => ({ PayPalPayoutClient: vi.fn(class {}) }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
const credentials = () => {
  vi.stubEnv("PAYPAL_CLIENT_ID", "fixture"); vi.stubEnv("PAYPAL_CLIENT_SECRET", "fixture");
  vi.stubEnv("PAYPAL_WEBHOOK_ID", "orders-listener"); vi.stubEnv("PAYPAL_SUBSCRIPTION_WEBHOOK_ID", "subscription-listener");
  vi.stubEnv("APP_BASE_URL", "https://isolated.example.test");
};

describe("server deployment authority", () => {
  it.each([undefined, "", "LIVE_CUSTOMER", "sandbox", "HOSTED_SANDBOX_DEMO "])("fails closed for mode %s even with Sandbox credentials and public demo flags", mode => {
    sandboxFixture(); credentials();
    vi.stubEnv("FAIRSHIFT_PUBLIC_DEMO", "enabled");
    vi.stubEnv("FAIRSHIFT_DEPLOYMENT_MODE", mode);
    expect(deploymentMode()).toBe("LIVE_CUSTOMER");
    expect(() => getPayPalClient()).toThrow(SandboxIsolationError);
    expect(() => getPayPalPayoutClient()).toThrow(SandboxIsolationError);
    expect(getSubscriptionAdapter()).toBeNull();
    expect(PayPalClient).not.toHaveBeenCalled(); expect(PayPalPayoutClient).not.toHaveBeenCalled();
    expect(getConfigurationStatus()).toMatchObject({ paypalConfigured: false, paypalPayoutConfigured: false });
  });
  it.each([undefined, "", "invalid"])("requires an explicit valid isolated organisation: %s", id => {
    sandboxFixture(); vi.stubEnv("FAIRSHIFT_SANDBOX_ORGANISATION_ID", id);
    expect(() => assertSandboxDeployment()).toThrow(SandboxIsolationError);
  });
  it.each(["PAYPAL_ENV", "PAYPAL_ENVIRONMENT"])("refuses conflicting %s instead of switching provider hosts", key => {
    sandboxFixture(); credentials(); vi.stubEnv(key, "live");
    expect(() => getPayPalClient()).toThrow(SandboxIsolationError);
    expect(() => getPayPalPayoutClient()).toThrow(SandboxIsolationError);
    expect(getSubscriptionAdapter()).toBeNull();
    expect(PayPalClient).not.toHaveBeenCalled(); expect(PayPalPayoutClient).not.toHaveBeenCalled();
  });
  it("constructs Sandbox clients only with explicit isolated server configuration, including production Node runtime", () => {
    sandboxFixture(); credentials(); vi.stubEnv("NODE_ENV", "production");
    getPayPalClient(); getPayPalPayoutClient();
    expect(getSubscriptionAdapter()).toBeInstanceOf(PayPalSubscriptions);
    expect(PayPalClient).toHaveBeenCalledWith(expect.objectContaining({ apiBaseUrl: "https://api-m.sandbox.paypal.com" }));
    expect(PayPalPayoutClient).toHaveBeenCalledWith(expect.objectContaining({ apiBaseUrl: "https://api-m.sandbox.paypal.com" }));
    expect(assertSandboxDeployment()).toBe(DEMO_ORGANISATION_ID);
    expect(() => assertSandboxFinancialScope({ organisationId: DEMO_ORGANISATION_ID })).not.toThrow();
    expect(() => assertSandboxFinancialScope({ organisationId: "22222222-2222-4222-8222-222222222222" })).toThrow(SandboxIsolationError);
    expect(() => assertSandboxFinancialScope({ organisationId: DEMO_ORGANISATION_ID, demo: { persona: "OWNER" } })).toThrow(SandboxIsolationError);
  });
});
