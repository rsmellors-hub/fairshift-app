import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { sandboxBusinessAllowed } from "@/server/config/deployment";
import { assertSandboxPayoutLimits, GBP_CAP_FALLBACK_USD_PER_GBP } from "@/server/payments/sandbox-limits";

// Owner decision 10 Nov 2026: every business on the hosted Sandbox may pay out, capped at 5 payouts and
// US$100 a day; an env switch restores demo-only isolation.
const DEMO = "00000000-0000-4000-8000-0000000000d1";
afterEach(() => { vi.unstubAllEnvs(); });
function sandbox() { vi.stubEnv("FAIRSHIFT_DEPLOYMENT_MODE", "HOSTED_SANDBOX_DEMO"); vi.stubEnv("FAIRSHIFT_SANDBOX_ORGANISATION_ID", DEMO); vi.stubEnv("PAYPAL_ENVIRONMENT", "sandbox"); }

describe("Sandbox scope and payout caps", () => {
  it("opens the Sandbox to every business unless the switch restores demo-only, and never in live mode", () => {
    const other = randomUUID();
    sandbox();
    expect(sandboxBusinessAllowed(DEMO)).toBe(true);
    expect(sandboxBusinessAllowed(other)).toBe(true);
    vi.stubEnv("FAIRSHIFT_SANDBOX_SCOPE", "DEMO_ONLY");
    expect(sandboxBusinessAllowed(other)).toBe(false);
    expect(sandboxBusinessAllowed(DEMO)).toBe(true);
    vi.stubEnv("FAIRSHIFT_SANDBOX_SCOPE", "");
    vi.stubEnv("FAIRSHIFT_DEPLOYMENT_MODE", "LIVE_CUSTOMER");
    expect(sandboxBusinessAllowed(other)).toBe(false);
  });

  it("refuses a payout above US$100 a day for a business other than the demo, counting GBP conservatively without an ECB GBP rate", async () => {
    sandbox();
    const t = await createTestDatabase();
    try {
      const other = randomUUID();
      await expect(assertSandboxPayoutLimits(t.db, other, { providerCurrency: "USD", providerAmountMinor: 100_00 })).resolves.toBeUndefined();
      await expect(assertSandboxPayoutLimits(t.db, other, { providerCurrency: "USD", providerAmountMinor: 100_01 })).rejects.toMatchObject({ feedback: "sandbox-payout-limit" });
      const pounds = Math.floor(100_00 / GBP_CAP_FALLBACK_USD_PER_GBP);
      await expect(assertSandboxPayoutLimits(t.db, other, { providerCurrency: "GBP", providerAmountMinor: pounds })).resolves.toBeUndefined();
      await expect(assertSandboxPayoutLimits(t.db, other, { providerCurrency: "GBP", providerAmountMinor: pounds + 100 })).rejects.toMatchObject({ feedback: "sandbox-payout-limit" });
      await expect(assertSandboxPayoutLimits(t.db, other, { providerCurrency: "EUR", providerAmountMinor: 1 })).rejects.toMatchObject({ feedback: "sandbox-payout-limit-unchecked" });
      // The demo business's Sandbox payouts were already isolated and stay as they were.
      await expect(assertSandboxPayoutLimits(t.db, DEMO, { providerCurrency: "USD", providerAmountMinor: 500_00 })).resolves.toBeUndefined();
    } finally { await t.close(); }
  });
});
