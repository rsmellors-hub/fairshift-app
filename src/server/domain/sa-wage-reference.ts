import type { WageJurisdiction, WageTerms } from "@/server/domain/statutory-wage";

// South African national minimum wage reference: a small indicator that compares an offered hourly
// rate with the published rate per ordinary hour. It never blocks an offer, never changes a wage,
// payable or payout, and is not a compliance check. It doesn't decide whether anyone is an employee
// or an independent contractor, and casual work in FairShift isn't assumed to be employee payroll.
// It has no server or React dependencies, so every page shows exactly the same comparison.

export const SA_WAGE_REFERENCE_VERSION = "fs-za-nmw-v1";

export const SA_MINIMUM_WAGE_SOURCE = {
  publisher: "South African Government (Department of Employment and Labour)",
  title: "Minister Nomakhosazana Meth increases statutory National Minimum Wage to R30,23 per hour",
  url: "https://www.gov.za/news/media-statements/minister-nomakhosazana-meth-increases-statutory-national-minimum-wage-r3023",
  publishedOn: "2026-02-03",
  retrievedOn: "2026-11-06",
} as const;

// R30.23 per ordinary hour, binding from 1 March 2026. The source states no end date. The 2027
// adjustment was still under consultation when this was checked, so dates from 1 March 2027 aren't
// compared rather than compared with a rate that may have changed.
export const SA_NATIONAL_MINIMUM_WAGE = { rateMinor: 3023, currencyCode: "ZAR", validFrom: "2026-03-01", comparedThrough: "2027-02-28" } as const;

export type SaWageIndicatorStatus = "ABOVE_REFERENCE" | "EQUAL_TO_REFERENCE" | "BELOW_REFERENCE" | "NOT_COMPARED";
export type SaWageIndicatorReason = "COMPARED" | "NOT_SOUTH_AFRICA" | "CURRENCY_NOT_ZAR" | "VARIABLE_PAY" | "INVALID_TERMS" | "DATE_BEFORE_REFERENCE" | "DATE_NOT_CHECKED";
export type SaWageIndicator = {
  status: SaWageIndicatorStatus;
  reason: SaWageIndicatorReason;
  date: string;
  // The offered pay per hour in minor units, rounded down for a fixed amount. Null when there isn't one.
  offeredHourlyMinor: number | null;
  referenceMinor: number;
  version: typeof SA_WAGE_REFERENCE_VERSION;
  // Always false: this indicator never stops a shift being created or offered.
  blocking: false;
};

const SOUTH_AFRICA = new Set(["south africa", "za", "rsa", "republic of south africa"]);
export const isSouthAfrica = (country?: string | null) => !!country && SOUTH_AFRICA.has(country.trim().toLowerCase());
// The country the existing wage jurisdiction resolved, from the location or else the business.
export const isSouthAfricanJurisdiction = (jurisdiction: WageJurisdiction | null | undefined) => !!jurisdiction && isSouthAfrica(jurisdiction.country);

export function saWageIndicator(input: { country: string | null; date: string; currencyCode: string; terms: WageTerms | null }): SaWageIndicator {
  const { date, terms } = input;
  const result = (status: SaWageIndicatorStatus, reason: SaWageIndicatorReason, offeredHourlyMinor: number | null = null): SaWageIndicator =>
    ({ status, reason, date, offeredHourlyMinor, referenceMinor: SA_NATIONAL_MINIMUM_WAGE.rateMinor, version: SA_WAGE_REFERENCE_VERSION, blocking: false });
  if (!isSouthAfrica(input.country)) return result("NOT_COMPARED", "NOT_SOUTH_AFRICA");
  if (input.currencyCode !== SA_NATIONAL_MINIMUM_WAGE.currencyCode) return result("NOT_COMPARED", "CURRENCY_NOT_ZAR");
  if (!terms) return result("NOT_COMPARED", "INVALID_TERMS");
  if (terms.earningsModel === "COMMISSION") return result("NOT_COMPARED", "VARIABLE_PAY");
  if (!Number.isSafeInteger(terms.rateMinor) || terms.rateMinor < 0 || (terms.earningsModel === "DAILY" && !(Number.isSafeInteger(terms.durationMs) && terms.durationMs > 0)))
    return result("NOT_COMPARED", "INVALID_TERMS");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return result("NOT_COMPARED", "INVALID_TERMS");
  // Exact integer comparison: an hourly rate, or a fixed amount over the scheduled time.
  const durationMs = terms.earningsModel === "HOURLY" ? 3_600_000n : BigInt(terms.durationMs);
  const pay = BigInt(terms.rateMinor) * 3_600_000n, reference = BigInt(SA_NATIONAL_MINIMUM_WAGE.rateMinor) * durationMs;
  const offered = Number(pay / durationMs);
  if (date < SA_NATIONAL_MINIMUM_WAGE.validFrom) return result("NOT_COMPARED", "DATE_BEFORE_REFERENCE", offered);
  if (date > SA_NATIONAL_MINIMUM_WAGE.comparedThrough) return result("NOT_COMPARED", "DATE_NOT_CHECKED", offered);
  return result(pay > reference ? "ABOVE_REFERENCE" : pay === reference ? "EQUAL_TO_REFERENCE" : "BELOW_REFERENCE", "COMPARED", offered);
}

export const SA_WAGE_STATUS_LABEL: Record<SaWageIndicatorStatus, string> = {
  ABOVE_REFERENCE: "Above minimum wage reference",
  EQUAL_TO_REFERENCE: "Equal to minimum wage reference",
  BELOW_REFERENCE: "Below minimum wage reference",
  NOT_COMPARED: "Not compared",
};

const DISCLAIMER = "A reference comparison only: it isn’t a legal compliance check and doesn’t decide employment status.";

// Deterministic words for an indicator. Figures are formatted by the caller's money function.
export function saWageIndicatorExplanation(indicator: SaWageIndicator, money: (minor: number) => string): string {
  const reference = `${money(indicator.referenceMinor)} an hour`;
  const offered = indicator.offeredHourlyMinor === null ? null : `${money(indicator.offeredHourlyMinor)} an hour`;
  const nmw = `the South African national minimum wage per ordinary hour from 1 March 2026`;
  switch (indicator.status) {
    case "ABOVE_REFERENCE": return `Offered ${offered}, above ${reference}, ${nmw}. ${DISCLAIMER}`;
    case "EQUAL_TO_REFERENCE": return `Offered ${offered}, equal to ${reference}, ${nmw}. ${DISCLAIMER}`;
    case "BELOW_REFERENCE": return `Offered ${offered}, below ${reference}, ${nmw}. The shift can still be offered; check the terms. ${DISCLAIMER}`;
    case "NOT_COMPARED":
      switch (indicator.reason) {
        case "VARIABLE_PAY": return "Commission has no fixed hourly pay, so it isn’t compared with the minimum wage reference.";
        case "CURRENCY_NOT_ZAR": return "These terms aren’t in rand, so they aren’t compared with the South African minimum wage reference.";
        case "DATE_BEFORE_REFERENCE": return `FairShift’s reference starts on 1 March 2026, so ${offered ?? "this pay"} isn’t compared for an earlier date.`;
        case "DATE_NOT_CHECKED": return `FairShift hasn’t checked the minimum wage for dates from 1 March 2027, so ${offered ?? "this pay"} isn’t compared.`;
        case "NOT_SOUTH_AFRICA": return "This location isn’t in South Africa, so the South African reference doesn’t apply.";
        default: return "These terms can’t be read as pay per hour, so they aren’t compared.";
      }
  }
}
