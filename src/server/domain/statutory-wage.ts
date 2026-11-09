// UK statutory minimum wage reference and FairShift's demo wage floor (FS-WAGE-INTEL-DEC-001,
// FS-WAGE-INTEL-DEC-002). A small versioned dataset and a deterministic check. It has no server or
// React dependencies, so the Owner and Manager forms preview exactly the rule the server enforces.
//
// FS-WAGE-INTEL-DEC-002 (Owner, 4 November 2026): for the competition demo, every shift at a location
// under this reference must pay at least the 21-and-over rate in force on the shift's date. That is a
// FairShift competition policy, not a statement that younger workers or apprentices are legally owed
// the adult rate: their lower statutory rates stay visible as reference information, and FairShift
// holds no age or apprenticeship records. It is not an employment-compliance engine and never decides
// an exemption.

export const WAGE_REFERENCE_VERSION = "fs-uk-nmw-v1";

export const UK_MINIMUM_WAGE_SOURCE = {
  publisher: "GOV.UK",
  title: "National Minimum Wage and National Living Wage rates",
  url: "https://www.gov.uk/national-minimum-wage-rates",
  // When FairShift read the page, and the page's own last update per the GOV.UK content API.
  retrievedOn: "2026-11-04",
  publisherUpdatedOn: "2026-11-02",
} as const;

export const WAGE_CATEGORIES = ["AGE_21_AND_OVER", "AGE_18_TO_20", "UNDER_18", "APPRENTICE"] as const;
export type WageCategory = typeof WAGE_CATEGORIES[number];
export const WAGE_CATEGORY_LABEL: Record<WageCategory, string> = {
  AGE_21_AND_OVER: "21 and over",
  AGE_18_TO_20: "18 to 20",
  UNDER_18: "Under 18",
  APPRENTICE: "Apprentice",
};

export type WageReferenceRow = {
  jurisdiction: "UK";
  category: WageCategory;
  validFrom: string;
  // Inclusive. GOV.UK states that the rates change on 1 April every year.
  validTo: string;
  rateMinor: number;
  currencyCode: "GBP";
  sourceUrl: string;
  verification: "VERIFIED";
  retrievedOn: string;
};

// Every value below was checked against the GOV.UK rates tables on the retrieval date. Rates
// before April 2024 used different age bands and are deliberately not included: a shift before
// then has no reference here and is shown as needing verification.
const PERIODS: { validFrom: string; validTo: string; rates: Record<WageCategory, number> }[] = [
  { validFrom: "2024-04-01", validTo: "2025-03-31", rates: { AGE_21_AND_OVER: 1144, AGE_18_TO_20: 860, UNDER_18: 640, APPRENTICE: 640 } },
  { validFrom: "2025-04-01", validTo: "2026-03-31", rates: { AGE_21_AND_OVER: 1221, AGE_18_TO_20: 1000, UNDER_18: 755, APPRENTICE: 755 } },
  { validFrom: "2026-04-01", validTo: "2027-03-31", rates: { AGE_21_AND_OVER: 1271, AGE_18_TO_20: 1085, UNDER_18: 800, APPRENTICE: 800 } },
  // Published on GOV.UK ahead of taking effect.
  { validFrom: "2027-04-01", validTo: "2028-03-31", rates: { AGE_21_AND_OVER: 1321, AGE_18_TO_20: 1127, UNDER_18: 831, APPRENTICE: 831 } },
];

export const UK_MINIMUM_WAGE_REFERENCE: readonly WageReferenceRow[] = PERIODS.flatMap(period => WAGE_CATEGORIES.map(category => ({
  jurisdiction: "UK" as const, category, validFrom: period.validFrom, validTo: period.validTo, rateMinor: period.rates[category],
  currencyCode: "GBP" as const, sourceUrl: UK_MINIMUM_WAGE_SOURCE.url, verification: "VERIFIED" as const, retrievedOn: UK_MINIMUM_WAGE_SOURCE.retrievedOn,
})));

// Where the FairShift demo minimum applies (FS-WAGE-INTEL-DEC-002): England, the demonstration
// jurisdiction the Owner confirmed, from the location's own country or else the business's (the same
// precedence as the location's currency). Plain UK values are treated as England, because nothing
// else would place such a location, and an ambiguous country must not bypass the demo safeguard.
// Scotland and Wales publish the same GOV.UK rates but are outside the approved demo scope, so pay
// there isn't checked or enforced. Northern Ireland isn't assumed: its source couldn't be read.
export type WageJurisdiction =
  | { jurisdiction: "ENGLAND"; country: string }
  // Day 6, Step 3a (Owner instruction, 9 November 2026): each business's own country rule sets the floor,
  // South Africa included: its national minimum wage per ordinary hour (src/server/domain/sa-wage-reference.ts).
  | { jurisdiction: "SOUTH_AFRICA"; country: string }
  | { jurisdiction: null; country: string | null; reason: "COUNTRY_NOT_STATED" | "NO_REFERENCE_FOR_COUNTRY" | "NATION_NOT_VERIFIED" | "OUTSIDE_DEMO_JURISDICTION" };
const DEMO_JURISDICTION_COUNTRIES = new Set(["england", "united kingdom", "uk", "gb", "great britain"]);
const OUTSIDE_DEMO_UK_NATIONS = new Set(["scotland", "wales"]);
const SOUTH_AFRICA_COUNTRIES = new Set(["south africa", "za", "rsa", "republic of south africa"]);
// South Africa's rule (the only rate FairShift holds for it): R30.23 per ordinary hour, binding from
// 1 March 2026, compared through 28 February 2027 because the next adjustment wasn't final when checked.
// Kept here, not imported, so this module stays dependency-free; sa-wage-reference.ts cites the source.
const SOUTH_AFRICA_FLOOR = { rateMinor: 3023, currencyCode: "ZAR", validFrom: "2026-03-01", validTo: "2027-02-28", name: "South African National Minimum Wage" } as const;
export function wageJurisdiction(input: { locationCountry?: string | null; organisationCountry?: string | null }): WageJurisdiction {
  const country = input.locationCountry?.trim() ? input.locationCountry.trim() : input.organisationCountry?.trim() || null;
  if (!country) return { jurisdiction: null, country: null, reason: "COUNTRY_NOT_STATED" };
  const key = country.toLowerCase();
  if (DEMO_JURISDICTION_COUNTRIES.has(key)) return { jurisdiction: "ENGLAND", country };
  if (SOUTH_AFRICA_COUNTRIES.has(key)) return { jurisdiction: "SOUTH_AFRICA", country };
  if (OUTSIDE_DEMO_UK_NATIONS.has(key)) return { jurisdiction: null, country, reason: "OUTSIDE_DEMO_JURISDICTION" };
  if (key === "northern ireland") return { jurisdiction: null, country, reason: "NATION_NOT_VERIFIED" };
  return { jurisdiction: null, country, reason: "NO_REFERENCE_FOR_COUNTRY" };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export type RatePeriod = { validFrom: string; validTo: string; rates: { category: WageCategory; rateMinor: number }[] };
export function ratesInForce(date: string): RatePeriod | null {
  if (!ISO_DATE.test(date)) return null;
  const period = PERIODS.find(row => row.validFrom <= date && date <= row.validTo);
  return period ? { validFrom: period.validFrom, validTo: period.validTo, rates: WAGE_CATEGORIES.map(category => ({ category, rateMinor: period.rates[category] })) } : null;
}
// The next published change after a date, if the reference holds one.
export function nextRateChange(date: string): RatePeriod | null {
  const next = PERIODS.find(row => row.validFrom > date);
  return next ? ratesInForce(next.validFrom) : null;
}

// The FairShift competition policy that sets the enforced floor (FS-WAGE-INTEL-DEC-002).
export const DEMO_WAGE_POLICY = { decision: "FS-WAGE-INTEL-DEC-002", category: "AGE_21_AND_OVER" as WageCategory, label: "FairShift demo minimum" } as const;

export type WageTerms =
  | { earningsModel: "HOURLY"; rateMinor: number }
  // A fixed amount for the shift, compared as pay per scheduled hour.
  | { earningsModel: "DAILY"; rateMinor: number; durationMs: number }
  | { earningsModel: "COMMISSION" };

export type WageCheckStatus = "RATE_CHECKED" | "BELOW_DEMO_MINIMUM" | "REFERENCE_UNAVAILABLE" | "NOT_CHECKABLE" | "OUTSIDE_DEMO_SCOPE";
export type WageCheckReason =
  | "MEETS_DEMO_MINIMUM" | "BELOW_DEMO_MINIMUM"
  | "NO_JURISDICTION" | "OUTSIDE_DEMO_JURISDICTION" | "NO_REFERENCE_FOR_DATE" | "CURRENCY_MISMATCH" | "VARIABLE_PAY" | "INVALID_TERMS";
export type WageCheck = {
  status: WageCheckStatus;
  reason: WageCheckReason;
  date: string;
  jurisdiction: WageJurisdiction;
  period: RatePeriod | null;
  // The enforced floor: the 21-and-over rate in force on the date, when the reference has one.
  floorMinor: number | null;
  // True where the demo floor applies. There, only RATE_CHECKED terms can be offered.
  enforced: boolean;
  version: typeof WAGE_REFERENCE_VERSION;
  // The floor's currency and name, from the country rule that applies.
  floorCurrency: string | null;
  floorName: string | null;
};

// Exact comparison of pay per hour with a rate, in integers: hourly rate, or a fixed amount over the scheduled time.
function compare(terms: Exclude<WageTerms, { earningsModel: "COMMISSION" }>, rateMinor: number) {
  if (terms.earningsModel === "HOURLY") return Math.sign(terms.rateMinor - rateMinor);
  const pay = BigInt(terms.rateMinor) * 3_600_000n, floor = BigInt(rateMinor) * BigInt(terms.durationMs);
  return pay === floor ? 0 : pay > floor ? 1 : -1;
}

// No worker facts are taken: no age or apprenticeship path can lower the floor.
export function checkWage(input: { jurisdiction: WageJurisdiction; date: string; currencyCode: string; terms: WageTerms }): WageCheck {
  const { jurisdiction, date, terms } = input;
  if (jurisdiction.jurisdiction === "SOUTH_AFRICA") {
    const inForce = ISO_DATE.test(date) && SOUTH_AFRICA_FLOOR.validFrom <= date && date <= SOUTH_AFRICA_FLOOR.validTo;
    const za = (status: WageCheckStatus, reason: WageCheckReason): WageCheck => ({ status, reason, date, jurisdiction, period: null, floorMinor: inForce ? SOUTH_AFRICA_FLOOR.rateMinor : null, enforced: true, version: WAGE_REFERENCE_VERSION, floorCurrency: "ZAR", floorName: SOUTH_AFRICA_FLOOR.name });
    if (terms.earningsModel === "COMMISSION") return za("NOT_CHECKABLE", "VARIABLE_PAY");
    if (!inForce) return za("REFERENCE_UNAVAILABLE", "NO_REFERENCE_FOR_DATE");
    if (input.currencyCode !== SOUTH_AFRICA_FLOOR.currencyCode) return za("NOT_CHECKABLE", "CURRENCY_MISMATCH");
    if (!Number.isSafeInteger(terms.rateMinor) || terms.rateMinor < 0 || (terms.earningsModel === "DAILY" && !(Number.isSafeInteger(terms.durationMs) && terms.durationMs > 0))) return za("NOT_CHECKABLE", "INVALID_TERMS");
    return compare(terms, SOUTH_AFRICA_FLOOR.rateMinor) >= 0 ? za("RATE_CHECKED", "MEETS_DEMO_MINIMUM") : za("BELOW_DEMO_MINIMUM", "BELOW_DEMO_MINIMUM");
  }
  const enforced = jurisdiction.jurisdiction === "ENGLAND";
  const period = enforced ? ratesInForce(date) : null;
  const floorMinor = period?.rates.find(row => row.category === DEMO_WAGE_POLICY.category)?.rateMinor ?? null;
  const result = (status: WageCheckStatus, reason: WageCheckReason): WageCheck => ({ status, reason, date, jurisdiction, period, floorMinor, enforced, version: WAGE_REFERENCE_VERSION, floorCurrency: enforced ? "GBP" : null, floorName: enforced ? DEMO_WAGE_POLICY.label : null });
  // Day 6, Step 3a: commission casual terms guarantee no pay per hour, so they are never offered, anywhere.
  if (terms.earningsModel === "COMMISSION") return result("NOT_CHECKABLE", "VARIABLE_PAY");
  if (jurisdiction.jurisdiction === null && jurisdiction.reason === "OUTSIDE_DEMO_JURISDICTION") return result("OUTSIDE_DEMO_SCOPE", "OUTSIDE_DEMO_JURISDICTION");
  if (!enforced) return result("REFERENCE_UNAVAILABLE", "NO_JURISDICTION");
  // Where the floor applies but can't be established, nothing is shown as checked or offered.
  if (floorMinor === null) return result("REFERENCE_UNAVAILABLE", "NO_REFERENCE_FOR_DATE");
  if (input.currencyCode !== "GBP") return result("NOT_CHECKABLE", "CURRENCY_MISMATCH");
  if (!Number.isSafeInteger(terms.rateMinor) || terms.rateMinor < 0 || (terms.earningsModel === "DAILY" && !(Number.isSafeInteger(terms.durationMs) && terms.durationMs > 0)))
    return result("NOT_CHECKABLE", "INVALID_TERMS");
  return compare(terms, floorMinor) >= 0 ? result("RATE_CHECKED", "MEETS_DEMO_MINIMUM") : result("BELOW_DEMO_MINIMUM", "BELOW_DEMO_MINIMUM");
}

// The wage check for stored shift or policy terms. Daily terms need the shift's times.
export function termsForWageCheck(terms: { earningsModel: string; rateMinor: number | null }, times?: { startsAt: Date; endsAt: Date }): WageTerms | null {
  if (terms.earningsModel === "COMMISSION") return { earningsModel: "COMMISSION" };
  if (terms.rateMinor === null) return null;
  if (terms.earningsModel === "HOURLY") return { earningsModel: "HOURLY", rateMinor: terms.rateMinor };
  if (terms.earningsModel === "DAILY" && times) return { earningsModel: "DAILY", rateMinor: terms.rateMinor, durationMs: times.endsAt.getTime() - times.startsAt.getTime() };
  return null;
}

// Day 6, Step 3a: where FairShift holds no wage rule for the location's country or the shift's date,
// the minimum wage is not checked. Such shifts are offered only after the Owner has acknowledged that
// for the location (audited; see wage-acknowledgement.ts). Terms below a floor, commission, and terms
// that can't be read as pay per hour are never offered.
export const wageNotChecked = (check: WageCheck) => check.status === "REFERENCE_UNAVAILABLE" || check.status === "OUTSIDE_DEMO_SCOPE";
export const wageAllowsOffer = (check: WageCheck, ownerAcknowledgedNotChecked = false) =>
  check.status === "RATE_CHECKED" || (wageNotChecked(check) && ownerAcknowledgedNotChecked);

export const WAGE_STATUS_LABEL: Record<WageCheckStatus, string> = {
  RATE_CHECKED: "Rate checked",
  BELOW_DEMO_MINIMUM: "Below FairShift demo minimum",
  REFERENCE_UNAVAILABLE: "Minimum wage not checked",
  NOT_CHECKABLE: "Pay can’t be checked",
  OUTSIDE_DEMO_SCOPE: "Minimum wage not checked",
};

// For a fixed amount: how long a shift it covers at the given hourly rate, in whole minutes.
export function minutesCovered(fixedMinor: number, hourlyMinor: number) {
  return hourlyMinor > 0 ? Math.floor((fixedMinor * 60) / hourlyMinor) : null;
}

// Deterministic words for a check. Figures are formatted by the caller's money function.
export function wageCheckExplanation(check: WageCheck, money: (minor: number) => string): string {
  const floor = check.floorMinor === null ? "" : money(check.floorMinor);
  if (check.jurisdiction.jurisdiction === "SOUTH_AFRICA") switch (check.reason) {
    case "MEETS_DEMO_MINIMUM": return `At or above ${floor} an hour, the ${check.floorName} in force on ${check.date}.`;
    case "BELOW_DEMO_MINIMUM": return `Below ${floor} an hour, the ${check.floorName} in force on ${check.date}, so shifts can’t be created or offered on these terms.`;
    case "NO_REFERENCE_FOR_DATE": return `Minimum wage not checked: FairShift holds no verified South African minimum wage for ${check.date}. Shifts are offered here only after the Owner acknowledges that under Compensation.`;
    case "CURRENCY_MISMATCH": return "These terms aren’t in rand, so they can’t be checked against the South African minimum wage and can’t be offered here.";
    case "VARIABLE_PAY": return "Commission has no guaranteed hourly pay, so it can’t be checked against the minimum wage and can’t be offered.";
    default: return "These terms can’t be read as pay per hour, so they can’t be offered here.";
  }
  switch (check.reason) {
    case "MEETS_DEMO_MINIMUM":
      return `At or above ${floor} an hour, the 21-and-over rate in force on ${check.date}, which is the FairShift demo minimum.`;
    case "BELOW_DEMO_MINIMUM":
      return `Below ${floor} an hour, the 21-and-over rate in force on ${check.date}. FairShift’s demo policy uses that rate for every shift, so shifts can’t be created or offered on these terms.`;
    case "NO_JURISDICTION":
      return check.jurisdiction.jurisdiction === null && check.jurisdiction.reason === "NATION_NOT_VERIFIED"
        ? "Minimum wage not checked: FairShift’s UK reference hasn’t been verified for Northern Ireland. Shifts are offered here only after the Owner acknowledges that under Compensation."
        : check.jurisdiction.jurisdiction === null && check.jurisdiction.reason === "COUNTRY_NOT_STATED"
          ? "Minimum wage not checked: this location has no country recorded, so FairShift can’t tell which minimum wage applies. Shifts are offered here only after the Owner acknowledges that under Compensation."
          : `Minimum wage not checked: FairShift holds no minimum wage rule for ${check.jurisdiction.country ?? "this country"}. Shifts are offered here only after the Owner acknowledges that under Compensation.`;
    case "OUTSIDE_DEMO_JURISDICTION":
      return "Minimum wage not checked: FairShift’s UK minimum applies to England, the demonstration jurisdiction. Shifts are offered here only after the Owner acknowledges that under Compensation.";
    case "NO_REFERENCE_FOR_DATE":
      return `Minimum wage not checked: FairShift’s reference has no verified rates for ${check.date}. Shifts are offered here only after the Owner acknowledges that under Compensation.`;
    case "CURRENCY_MISMATCH":
      return "These terms aren’t in pounds, so they can’t be checked against the demo minimum and can’t be offered here.";
    case "VARIABLE_PAY":
      return "Commission has no guaranteed hourly pay, so it can’t be checked against a minimum wage and can’t be offered.";
    case "INVALID_TERMS":
      return "These terms can’t be read as pay per hour, so they can’t be offered here.";
  }
}
