import { isMinorUnitCurrency } from "@/server/domain/currency";
import { UserFacingError } from "@/server/domain/errors";

// Casual-worker entitlements are calculated and recorded in the business's operating
// currency (ZAR for the South African demo, DEC-SA-001). PayPal cannot pay out ZAR, so a
// payout is sent in a supported provider currency (USD, DEC-SA-012). This module turns an
// approved entitlement amount into the exact provider amount that is actually sent, and
// records the rate and its source so a payout is never re-converted. It makes no network or
// model call, applies no fee, and never chooses a rate itself: the one fixed Sandbox demo
// rate is supplied by server configuration from an Owner-approved value. While that value is
// absent the ZAR path fails closed, so no ZAR entitlement can be submitted for payout and the
// approved earnings stay recorded and unpaid.

// The provider currency a ZAR operating entitlement is paid in. PayPal has no ZAR payout.
export const ZAR_PROVIDER_PAYOUT_CURRENCY = "USD";

// Rates are integer micro-units of operating currency per one provider unit, so a rate of
// 1.000000 is 1_000_000 and exact integer arithmetic can be used throughout. No rate value is
// held in code: the one fixed Sandbox demo rate comes only from configuration (see below).
export const FX_RATE_SCALE = 1_000_000;
const FX_RATE_SCALE_BIG = 1_000_000n;

// Where a frozen rate came from. The only source the server accepts is the Owner-fixed
// Sandbox demo rate read from configuration; it is recorded on the reservation for audit and
// shown to the worker. No market or provider rate is ever used.
export const SANDBOX_DEMO_FX_SOURCE = "SANDBOX_DEMO_FIXED";

// Configuration key for the one fixed Sandbox demo rate, in ZAR-micros per one USD. DEC-SA-012
// leaves the numeric rate unrecorded until the Owner supplies it, so this is unset and the
// ZAR->USD path fails closed by default. Request input is never consulted.
export const SANDBOX_DEMO_RATE_ENV = "FAIRSHIFT_SANDBOX_FX_ZAR_PER_USD_MICROS";

// The approved demo FX rate is not configured, so a ZAR entitlement cannot be prepared for a
// provider payout. The entitlement remains recorded and unpaid until the Owner supplies it.
export class ProviderCurrencyRateUnavailableError extends UserFacingError {
  constructor(operatingCurrency: string, providerCurrency: string) {
    super(
      "provider-fx-rate-unavailable",
      `No approved ${operatingCurrency}-to-${providerCurrency} payout rate is configured, so this payout cannot be prepared.`,
    );
    this.name = "ProviderCurrencyRateUnavailableError";
  }
}

// There is no defined provider route from this operating currency to this provider currency.
export class ProviderCurrencyUnsupportedError extends UserFacingError {
  constructor(operatingCurrency: string, providerCurrency: string) {
    super(
      "provider-currency-unsupported",
      `A payout from ${operatingCurrency} to ${providerCurrency} is not supported.`,
    );
    this.name = "ProviderCurrencyUnsupportedError";
  }
}

// The converted amount rounds down to zero, so there is nothing that can be paid.
export class ProviderAmountTooSmallError extends UserFacingError {
  constructor() {
    super("provider-amount-zero", "The converted payout amount rounds down to zero, so it cannot be paid.");
    this.name = "ProviderAmountTooSmallError";
  }
}

// How an approved entitlement maps to the provider leg actually sent to PayPal. An identity
// plan sends the same currency unchanged and carries no rate; a conversion plan carries the
// frozen rate and its source.
export type ProviderCurrencyConversion = {
  providerCurrency: string;
  fxRateMicros: number;
  fxRateSource: string;
};

// The frozen provider leg of a payout. fxRateMicros/fxRateSource are null only when the
// provider currency equals the entitlement currency (no conversion occurred).
export type ProviderAmount = {
  providerCurrency: string;
  providerAmountMinor: number;
  fxRateMicros: number | null;
  fxRateSource: string | null;
};

// Matches the database bound for minor-unit amounts (bigint, two-decimal currencies only).
const MAX_MINOR = Number.MAX_SAFE_INTEGER;

function assertEntitlementAmount(amountMinor: number) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor > MAX_MINOR) {
    throw new Error("Entitlement amount must be a positive whole number of minor units within range.");
  }
}

// Exact operating->provider conversion. The rate is operating-currency micro-units per one
// provider unit, so provider minor units = floor(amountMinor * 1_000_000 / fxRateMicros).
// BigInt keeps the intermediate product exact and never overflows or rounds in floating
// point; integer division truncates toward zero, which for these positive values is floor, so
// the amount is always rounded down, never up. Rejects a non-positive or non-integer rate, an
// unsupported or same currency pair, a zero result and an out-of-range result.
export function applyProviderConversion(
  entitlement: { amountMinor: number; currencyCode: string },
  conversion: ProviderCurrencyConversion,
): ProviderAmount {
  assertEntitlementAmount(entitlement.amountMinor);
  if (!Number.isSafeInteger(conversion.fxRateMicros) || conversion.fxRateMicros <= 0) {
    throw new Error("A conversion rate must be a positive whole number of micro-units.");
  }
  if (
    !isMinorUnitCurrency(entitlement.currencyCode) ||
    !isMinorUnitCurrency(conversion.providerCurrency) ||
    entitlement.currencyCode === conversion.providerCurrency
  ) {
    throw new ProviderCurrencyUnsupportedError(entitlement.currencyCode, conversion.providerCurrency);
  }
  const providerBig = (BigInt(entitlement.amountMinor) * FX_RATE_SCALE_BIG) / BigInt(conversion.fxRateMicros);
  const providerAmountMinor = Number(providerBig);
  if (providerAmountMinor <= 0) throw new ProviderAmountTooSmallError();
  if (!Number.isSafeInteger(providerAmountMinor) || providerAmountMinor > MAX_MINOR) {
    throw new Error("The converted payout amount is out of range.");
  }
  return {
    providerCurrency: conversion.providerCurrency,
    providerAmountMinor,
    fxRateMicros: conversion.fxRateMicros,
    fxRateSource: conversion.fxRateSource,
  };
}

// The one fixed Sandbox demo rate from server configuration only. Returns null when nothing
// valid is configured, which is the default (DEC-SA-012 leaves the numeric rate unrecorded),
// so callers fail closed. Never a market, provider or request-supplied value.
export function configuredSandboxDemoZarConversion(): ProviderCurrencyConversion | null {
  const raw = process.env[SANDBOX_DEMO_RATE_ENV]?.trim();
  if (!raw || !/^[0-9]+$/.test(raw)) return null;
  const micros = Number(raw);
  if (!Number.isSafeInteger(micros) || micros <= 0) return null;
  return { providerCurrency: ZAR_PROVIDER_PAYOUT_CURRENCY, fxRateMicros: micros, fxRateSource: SANDBOX_DEMO_FX_SOURCE };
}

// Resolves the provider leg for an approved entitlement using server configuration. A ZAR
// entitlement is converted to USD with the configured Owner-approved Sandbox demo rate, or
// fails closed when no rate is configured. Any other operating currency is sent in its own
// currency unchanged (identity); whether that currency may actually be paid out is decided by
// the payout route gate, not here.
export function resolveProviderAmount(entitlement: { amountMinor: number; currencyCode: string }): ProviderAmount {
  assertEntitlementAmount(entitlement.amountMinor);
  if (entitlement.currencyCode === "ZAR") {
    const conversion = configuredSandboxDemoZarConversion();
    if (!conversion) throw new ProviderCurrencyRateUnavailableError("ZAR", ZAR_PROVIDER_PAYOUT_CURRENCY);
    return applyProviderConversion(entitlement, conversion);
  }
  return {
    providerCurrency: entitlement.currencyCode,
    providerAmountMinor: entitlement.amountMinor,
    fxRateMicros: null,
    fxRateSource: null,
  };
}
