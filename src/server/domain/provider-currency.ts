import { isMinorUnitCurrency } from "@/server/domain/currency";
import { UserFacingError } from "@/server/domain/errors";

// Casual-worker entitlements are calculated and recorded in the business's operating
// currency (ZAR for the South African demo, DEC-SA-001). PayPal cannot pay out ZAR, so a
// payout is sent in a supported provider currency (USD, DEC-SA-012). This module turns an
// approved entitlement amount into the exact provider amount that is actually sent, and
// records the rate and its source so a payout is never re-converted. It makes no network or
// model call, applies no fee, and never chooses a rate itself: the rate is the newest fresh
// ECB reference rate (DEC-SA-012, 7 November 2026), supplied by server/fx/reference-rates.ts.
// Without one the ZAR path fails closed, so no ZAR entitlement can be submitted for payout and
// the approved earnings stay recorded and unpaid.

// The provider currency a ZAR operating entitlement is paid in. PayPal has no ZAR payout.
export const ZAR_PROVIDER_PAYOUT_CURRENCY = "USD";

// Rates are integer micro-units of operating currency per one provider unit, so a rate of
// 1.000000 is 1_000_000 and exact integer arithmetic can be used throughout. No rate value is
// held in code: rates come only from recorded ECB reference rates.
export const FX_RATE_SCALE = 1_000_000;
const FX_RATE_SCALE_BIG = 1_000_000n;

// No ECB reference rate from the last 3 business days is recorded, so a ZAR entitlement cannot
// be prepared for a provider payout (DEC-SA-012). The entitlement remains recorded and unpaid.
export class ProviderCurrencyRateUnavailableError extends UserFacingError {
  constructor(operatingCurrency: string, providerCurrency: string) {
    super(
      "provider-fx-rate-unavailable",
      `No ${operatingCurrency}-to-${providerCurrency} reference rate from the last 3 business days is available, so this payout cannot be prepared.`,
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

// Resolves the provider leg for an approved entitlement. A ZAR entitlement is converted to USD
// with the conversion `zarConversion` returns (the newest fresh ECB reference rate), which throws
// provider-fx-rate-unavailable when there is none. Any other operating currency is sent in its
// own currency unchanged (identity); whether that currency may actually be paid out is decided by
// the payout route gate, not here.
export async function resolveProviderAmount(entitlement: { amountMinor: number; currencyCode: string }, zarConversion: () => Promise<ProviderCurrencyConversion>): Promise<ProviderAmount> {
  assertEntitlementAmount(entitlement.amountMinor);
  if (entitlement.currencyCode === "ZAR") return applyProviderConversion(entitlement, await zarConversion());
  return {
    providerCurrency: entitlement.currencyCode,
    providerAmountMinor: entitlement.amountMinor,
    fxRateMicros: null,
    fxRateSource: null,
  };
}
