import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyProviderConversion,
  configuredSandboxDemoZarConversion,
  ProviderAmountTooSmallError,
  ProviderCurrencyRateUnavailableError,
  ProviderCurrencyUnsupportedError,
  resolveProviderAmount,
  SANDBOX_DEMO_FX_SOURCE,
  SANDBOX_DEMO_RATE_ENV,
  ZAR_PROVIDER_PAYOUT_CURRENCY,
} from "@/server/domain/provider-currency";

// A clearly identified test-only rate (R18.54 = 1 USD, in ZAR-micros per USD). Never the
// Owner-approved demo rate (DEC-SA-012 leaves that unrecorded); used only to exercise the maths.
const TEST_RATE_MICROS = 18_540_000;
const zarToUsd = (amountMinor: number, fxRateMicros = TEST_RATE_MICROS) =>
  applyProviderConversion({ amountMinor, currencyCode: "ZAR" }, { providerCurrency: "USD", fxRateMicros, fxRateSource: "TEST_ONLY" });

afterEach(() => { vi.unstubAllEnvs(); });

describe("provider currency conversion (DEC-SA-012)", () => {
  it("converts ZAR to USD with exact, rounded-down integer arithmetic", () => {
    // R304.00 at 18.54 ZAR/USD is $16.39 (floor of 16.398...), the DEC-SA-012 example figure.
    expect(zarToUsd(30_400)).toEqual({ providerCurrency: "USD", providerAmountMinor: 1_639, fxRateMicros: TEST_RATE_MICROS, fxRateSource: "TEST_ONLY" });
    // R78.00 at 18.54 is $4.20 (floor of 4.207...).
    expect(zarToUsd(7_800).providerAmountMinor).toBe(420);
  });

  it("always rounds the provider amount down, never up", () => {
    // 100 ZAR-cents at 3.00 ZAR/USD is 33.33 US-cents and must floor to 33, not 34.
    expect(zarToUsd(100, 3_000_000).providerAmountMinor).toBe(33);
    // One cent below a whole cent boundary still rounds down.
    expect(zarToUsd(18_539, TEST_RATE_MICROS).providerAmountMinor).toBe(999); // 18539*1e6/18.54e6 = 999.94
    expect(zarToUsd(18_540, TEST_RATE_MICROS).providerAmountMinor).toBe(1_000);
  });

  it("fails closed when no approved demo rate is configured", () => {
    // No rate in configuration: a ZAR entitlement cannot be prepared for payout.
    expect(() => resolveProviderAmount({ amountMinor: 30_400, currencyCode: "ZAR" })).toThrow(ProviderCurrencyRateUnavailableError);
    expect(configuredSandboxDemoZarConversion()).toBeNull();
  });

  it("rejects a zero or negative rate", () => {
    expect(() => zarToUsd(30_400, 0)).toThrow();
    expect(() => zarToUsd(30_400, -1)).toThrow();
    // A non-positive or non-numeric configured rate is treated as absent (fail closed).
    for (const value of ["0", "-5", "18.54", "abc", "", "   ", "1e6"]) {
      vi.stubEnv(SANDBOX_DEMO_RATE_ENV, value);
      expect(configuredSandboxDemoZarConversion()).toBeNull();
    }
  });

  it("rejects an unsupported or same-currency pair", () => {
    // Same currency is not a conversion.
    expect(() => applyProviderConversion({ amountMinor: 100, currencyCode: "USD" }, { providerCurrency: "USD", fxRateMicros: TEST_RATE_MICROS, fxRateSource: "TEST_ONLY" })).toThrow(ProviderCurrencyUnsupportedError);
    // A non-two-decimal / unknown provider currency is refused.
    expect(() => applyProviderConversion({ amountMinor: 100, currencyCode: "ZAR" }, { providerCurrency: "JPY", fxRateMicros: TEST_RATE_MICROS, fxRateSource: "TEST_ONLY" })).toThrow(ProviderCurrencyUnsupportedError);
    expect(() => applyProviderConversion({ amountMinor: 100, currencyCode: "ZAR" }, { providerCurrency: "ZZZ", fxRateMicros: TEST_RATE_MICROS, fxRateSource: "TEST_ONLY" })).toThrow(ProviderCurrencyUnsupportedError);
  });

  it("rejects a conversion that rounds down to zero", () => {
    // R0.01 at 18.54 ZAR/USD is 0.0005 US-cents, which floors to zero and cannot be paid.
    expect(() => zarToUsd(1)).toThrow(ProviderAmountTooSmallError);
  });

  it("rejects a result outside the safe integer range", () => {
    // A tiny rate would blow the amount past the safe integer / database bound.
    expect(() => zarToUsd(Number.MAX_SAFE_INTEGER, 1)).toThrow(/out of range/);
  });

  it("rejects a non-integer or non-positive entitlement amount", () => {
    expect(() => zarToUsd(0)).toThrow();
    expect(() => zarToUsd(-100)).toThrow();
    expect(() => zarToUsd(1.5)).toThrow();
  });

  it("passes GBP and USD through unchanged as an identity leg", () => {
    expect(resolveProviderAmount({ amountMinor: 7_800, currencyCode: "GBP" })).toEqual({ providerCurrency: "GBP", providerAmountMinor: 7_800, fxRateMicros: null, fxRateSource: null });
    expect(resolveProviderAmount({ amountMinor: 12_100, currencyCode: "USD" })).toEqual({ providerCurrency: "USD", providerAmountMinor: 12_100, fxRateMicros: null, fxRateSource: null });
  });

  it("reads a valid configured demo rate and converts ZAR with it", () => {
    vi.stubEnv(SANDBOX_DEMO_RATE_ENV, String(TEST_RATE_MICROS));
    expect(configuredSandboxDemoZarConversion()).toEqual({ providerCurrency: ZAR_PROVIDER_PAYOUT_CURRENCY, fxRateMicros: TEST_RATE_MICROS, fxRateSource: SANDBOX_DEMO_FX_SOURCE });
    expect(resolveProviderAmount({ amountMinor: 30_400, currencyCode: "ZAR" })).toMatchObject({ providerCurrency: "USD", providerAmountMinor: 1_639, fxRateMicros: TEST_RATE_MICROS, fxRateSource: SANDBOX_DEMO_FX_SOURCE });
  });
});
