import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PRICE_LIST } from "@/server/billing/plans";
import { resolveProviderAmount } from "@/server/domain/provider-currency";
import { finalPayableMinor } from "@/server/domain/work-payable";
import { payoutAmount } from "@/server/payments/work-payouts";
import { directShares, equalShares } from "@/server/tips/policy";

// Owner decision, 8 November 2026: "VAT is never applied to worker earnings or tips." The 15% VAT
// exists only in the subscription price list, which already includes it.
describe("no VAT on worker earnings, tips or payouts", () => {
  it("a casual payable is the agreed pay, with nothing added", () => {
    expect(finalPayableMinor({ baseAmountMinor: 27_000 })).toBe(27_000); // 6 h × R45.00 = R270.00
    expect(finalPayableMinor({ baseAmountMinor: 27_000, incentiveAmountMinor: 0 })).toBe(27_000);
  });

  it("tip shares add up to exactly the tips, with nothing added or withheld", () => {
    expect(equalShares(10_000, ["a", "b", "c"]).reduce((sum, share) => sum + share.amountMinor, 0)).toBe(10_000);
    expect(directShares([{ workerId: "a", tipMinor: 2_500 }, { workerId: "b", tipMinor: 1_000 }, { workerId: null, tipMinor: 500 }]))
      .toEqual({ shares: expect.arrayContaining([{ workerId: "a", amountMinor: 2_500 }, { workerId: "b", amountMinor: 1_000 }]), unallocatedMinor: 500 });
  });

  it("the US dollar payout converts the rand entitlement only", async () => {
    const leg = await resolveProviderAmount({ amountMinor: 27_000, currencyCode: "ZAR" },
      async () => ({ providerCurrency: "USD", fxRateMicros: 16_538_200, fxRateSource: "ECB_EUROFXREF_DAILY:2026-11-06" }));
    // R270.00 ÷ 16.5382, rounded down: US$16.32. With 15% VAT added it would have been US$18.77.
    expect(leg).toMatchObject({ providerCurrency: "USD", providerAmountMinor: 1_632 });
    expect(payoutAmount(leg.providerAmountMinor, leg.providerCurrency)).toBe("16.32");
  });

  it("only the subscription price list knows about VAT", () => {
    expect(PRICE_LIST.vatPercent).toBe(15);
    const roots = ["src/server/payments", "src/server/tips", "src/server/pay-agent", "src/server/fx", "src/server/performance",
      "src/server/domain/work-payable.ts", "src/server/domain/work-terms.ts", "src/server/domain/provider-currency.ts", "src/server/domain/incentive.ts"];
    const files = (path: string): string[] => statSync(path).isDirectory() ? readdirSync(path).flatMap(name => files(join(path, name))) : /\.tsx?$/.test(path) ? [path] : [];
    const checked = roots.flatMap(files);
    expect(checked.length).toBeGreaterThan(10);
    for (const file of checked) expect(readFileSync(file, "utf8"), file).not.toMatch(/\bVAT\b|\bvat(?:Percent|Rate|Amount|Minor)\b/i);
  });
});
