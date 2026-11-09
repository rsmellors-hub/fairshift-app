import { describe, expect, it } from "vitest";
import {
  checkWage, DEMO_WAGE_POLICY, minutesCovered, nextRateChange, ratesInForce, termsForWageCheck, UK_MINIMUM_WAGE_REFERENCE,
  UK_MINIMUM_WAGE_SOURCE, WAGE_STATUS_LABEL, wageAllowsOffer, wageCheckExplanation, wageJurisdiction, type WageTerms,
} from "@/server/domain/statutory-wage";
import { validateWageExplanation, wageExplanationInput } from "@/server/intelligence/wage-explanation";

// FS-WAGE-INTEL-DEC-002: the 21-and-over rate in force on the shift's date is the enforced demo minimum.
const ENGLAND = wageJurisdiction({ locationCountry: "England" });
const hourly = (rateMinor: number): WageTerms => ({ earningsModel: "HOURLY", rateMinor });
const check = (rateMinor: number, date = "2026-11-04", jurisdiction = ENGLAND) => checkWage({ jurisdiction, date, currencyCode: "GBP", terms: hourly(rateMinor) });
const gbp = (minor: number) => `£${(minor / 100).toFixed(2)}`;

describe("UK statutory wage reference data", () => {
  it("holds the GOV.UK schedule exactly, with full provenance on every row", () => {
    const table = (date: string) => Object.fromEntries(ratesInForce(date)!.rates.map(row => [row.category, row.rateMinor]));
    expect(table("2024-04-01")).toEqual({ AGE_21_AND_OVER: 1144, AGE_18_TO_20: 860, UNDER_18: 640, APPRENTICE: 640 });
    expect(table("2025-04-01")).toEqual({ AGE_21_AND_OVER: 1221, AGE_18_TO_20: 1000, UNDER_18: 755, APPRENTICE: 755 });
    expect(table("2026-04-01")).toEqual({ AGE_21_AND_OVER: 1271, AGE_18_TO_20: 1085, UNDER_18: 800, APPRENTICE: 800 });
    expect(table("2027-04-01")).toEqual({ AGE_21_AND_OVER: 1321, AGE_18_TO_20: 1127, UNDER_18: 831, APPRENTICE: 831 });
    expect(UK_MINIMUM_WAGE_REFERENCE).toHaveLength(16);
    for (const row of UK_MINIMUM_WAGE_REFERENCE) expect(row).toMatchObject({ jurisdiction: "UK", currencyCode: "GBP", sourceUrl: "https://www.gov.uk/national-minimum-wage-rates", verification: "VERIFIED", retrievedOn: "2026-11-04" });
    expect(UK_MINIMUM_WAGE_SOURCE.publisher).toBe("GOV.UK");
  });

  it("has contiguous, non-overlapping periods", () => {
    const periods = [...new Set(UK_MINIMUM_WAGE_REFERENCE.map(row => `${row.validFrom}|${row.validTo}`))].map(text => text.split("|"));
    for (let i = 1; i < periods.length; i++) {
      const dayAfter = new Date(Date.parse(`${periods[i - 1][1]}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      expect(periods[i][0]).toBe(dayAfter);
    }
  });
});

describe("jurisdiction: the approved England demo scope", () => {
  it("applies the demo minimum to England and to plain UK country values, location country first", () => {
    for (const country of ["England", " england ", "United Kingdom", "UK", "GB", "great britain"]) expect(wageJurisdiction({ locationCountry: country }).jurisdiction).toBe("ENGLAND");
    expect(wageJurisdiction({ locationCountry: null, organisationCountry: "United Kingdom" }).jurisdiction).toBe("ENGLAND");
    // Day 6, Step 3a: South Africa has its own country rule; a country FairShift holds none for has no reference.
    expect(wageJurisdiction({ locationCountry: "South Africa", organisationCountry: "United Kingdom" })).toMatchObject({ jurisdiction: "SOUTH_AFRICA" });
    expect(wageJurisdiction({ locationCountry: "Kenya", organisationCountry: "United Kingdom" })).toMatchObject({ jurisdiction: null, reason: "NO_REFERENCE_FOR_COUNTRY" });
  });
  it("keeps Scotland and Wales outside the demo scope: not checked, offered only after the Owner acknowledges it", () => {
    for (const country of ["Scotland", "Wales", " wales "]) {
      const jurisdiction = wageJurisdiction({ locationCountry: country, organisationCountry: "England" });
      expect(jurisdiction).toMatchObject({ jurisdiction: null, reason: "OUTSIDE_DEMO_JURISDICTION" });
      for (const rate of [100, 800, 1500]) {
        const result = checkWage({ jurisdiction, date: "2026-11-04", currencyCode: "GBP", terms: hourly(rate) });
        expect(result).toMatchObject({ status: "OUTSIDE_DEMO_SCOPE", reason: "OUTSIDE_DEMO_JURISDICTION", enforced: false, period: null, floorMinor: null });
        expect(wageAllowsOffer(result)).toBe(false);
        expect(wageAllowsOffer(result, true)).toBe(true);
      }
    }
    expect(WAGE_STATUS_LABEL.OUTSIDE_DEMO_SCOPE).toBe("Minimum wage not checked");
    expect(wageCheckExplanation(checkWage({ jurisdiction: wageJurisdiction({ locationCountry: "Scotland" }), date: "2026-11-04", currencyCode: "GBP", terms: hourly(800) }), gbp)).toContain("applies to England");
  });
  it("doesn't assume a reference it hasn't verified, or a country it wasn't given", () => {
    expect(wageJurisdiction({ locationCountry: "Northern Ireland" })).toMatchObject({ jurisdiction: null, reason: "NATION_NOT_VERIFIED" });
    expect(wageJurisdiction({})).toMatchObject({ jurisdiction: null, reason: "COUNTRY_NOT_STATED" });
  });
});

describe("1–3. the adult demo minimum by effective date", () => {
  it("1. uses £12.71 for England shifts from 1 April 2026", () => {
    expect(check(1271, "2026-04-01")).toMatchObject({ status: "RATE_CHECKED", floorMinor: 1271, enforced: true });
    expect(check(1271, "2027-03-31")).toMatchObject({ status: "RATE_CHECKED", floorMinor: 1271 });
  });
  it("2. uses £13.21 from 1 April 2027, and not before", () => {
    expect(check(1321, "2027-04-01")).toMatchObject({ status: "RATE_CHECKED", floorMinor: 1321 });
    expect(check(1320, "2027-04-01").status).toBe("BELOW_DEMO_MINIMUM");
    // A published future rate is not treated as already in force.
    expect(check(1271, "2027-03-31").status).toBe("RATE_CHECKED");
    expect(nextRateChange("2026-11-04")).toMatchObject({ validFrom: "2027-04-01" });
  });
  it("3. switches at the effective date: the same rate is checked on one side and below on the other", () => {
    expect(check(1250, "2026-03-31")).toMatchObject({ status: "RATE_CHECKED", floorMinor: 1221 });
    expect(check(1250, "2026-04-01")).toMatchObject({ status: "BELOW_DEMO_MINIMUM", floorMinor: 1271 });
    expect(check(1300, "2027-03-31").status).toBe("RATE_CHECKED");
    expect(check(1300, "2027-04-01").status).toBe("BELOW_DEMO_MINIMUM");
  });
});

describe("4–6. Owner rate against the floor", () => {
  it("4. a rate above the floor is checked and offerable", () => {
    expect(check(1500)).toMatchObject({ status: "RATE_CHECKED", reason: "MEETS_DEMO_MINIMUM" });
    expect(wageAllowsOffer(check(1500))).toBe(true);
  });
  it("5. a rate equal to the floor is checked and offerable", () => {
    expect(check(1271).status).toBe("RATE_CHECKED");
    expect(wageAllowsOffer(check(1271))).toBe(true);
  });
  it("6. a rate below the floor is blocked", () => {
    for (const rate of [1270, 1200, 800, 0]) {
      expect(check(rate)).toMatchObject({ status: "BELOW_DEMO_MINIMUM", reason: "BELOW_DEMO_MINIMUM" });
      expect(wageAllowsOffer(check(rate))).toBe(false);
    }
    expect(WAGE_STATUS_LABEL.BELOW_DEMO_MINIMUM).toBe("Below FairShift demo minimum");
  });
  it("checks fixed daily pay exactly, as pay per scheduled hour", () => {
    const daily = (minor: number, hours: number) => checkWage({ jurisdiction: ENGLAND, date: "2026-11-04", currencyCode: "GBP", terms: { earningsModel: "DAILY", rateMinor: minor, durationMs: hours * 3_600_000 } });
    expect(daily(9_600, 7.5).status).toBe("RATE_CHECKED");
    expect(daily(10_168, 8).status).toBe("RATE_CHECKED");
    expect(daily(10_167, 8).status).toBe("BELOW_DEMO_MINIMUM");
    expect(daily(9_600, 8).status).toBe("BELOW_DEMO_MINIMUM");
    expect(minutesCovered(9_600, 1_271)).toBe(453);
  });
});

describe("10. no youth or apprentice bypass", () => {
  it("enforces the adult rate even where a younger or apprentice rate would be lower", () => {
    // £10.85 (18–20) and £8.00 (under 18, apprentice) are reference information only.
    for (const rate of [1085, 1084, 800]) expect(check(rate).status).toBe("BELOW_DEMO_MINIMUM");
    expect(DEMO_WAGE_POLICY).toMatchObject({ decision: "FS-WAGE-INTEL-DEC-002", category: "AGE_21_AND_OVER" });
  });
  it("takes no worker facts at all", () => {
    expect(checkWage.length).toBe(1);
    const withExtras = checkWage({ jurisdiction: ENGLAND, date: "2026-11-04", currencyCode: "GBP", terms: hourly(800), ...({ worker: { ageOnDate: 17, apprenticeship: "FIRST_YEAR" } } as object) });
    expect(withExtras.status).toBe("BELOW_DEMO_MINIMUM");
  });
  it("says it is FairShift policy, without claiming younger workers are owed the adult rate", () => {
    const text = wageCheckExplanation(check(1200), gbp);
    expect(text).toContain("FairShift’s demo policy uses that rate for every shift");
    expect(text).not.toMatch(/complian|legally|guarantee|required by law/i);
  });
});

describe("11. missing or unsupported reference information", () => {
  it("never shows a rate as checked, or lets it through, where an enforced floor can't be established", () => {
    for (const date of ["2024-03-31", "2028-04-01", "not-a-date"]) {
      const result = check(5000, date);
      expect(result).toMatchObject({ status: "REFERENCE_UNAVAILABLE", reason: "NO_REFERENCE_FOR_DATE", enforced: true, floorMinor: null });
      expect(wageAllowsOffer(result)).toBe(false);
    }
    const notCheckable = [
      checkWage({ jurisdiction: ENGLAND, date: "2026-11-04", currencyCode: "USD", terms: hourly(5000) }),
      checkWage({ jurisdiction: ENGLAND, date: "2026-11-04", currencyCode: "GBP", terms: { earningsModel: "COMMISSION" } }),
      checkWage({ jurisdiction: ENGLAND, date: "2026-11-04", currencyCode: "GBP", terms: hourly(-1) }),
    ];
    expect(notCheckable.map(row => row.reason)).toEqual(["CURRENCY_MISMATCH", "VARIABLE_PAY", "INVALID_TERMS"]);
    for (const row of notCheckable) { expect(row.status).toBe("NOT_CHECKABLE"); expect(wageAllowsOffer(row)).toBe(false); }
    expect(termsForWageCheck({ earningsModel: "DAILY", rateMinor: 9_600 })).toBeNull();
  });
  it("marks locations outside the reference as not checked, offered only after the Owner acknowledges it", () => {
    for (const jurisdiction of [wageJurisdiction({ locationCountry: "Kenya" }), wageJurisdiction({ locationCountry: "Northern Ireland" }), wageJurisdiction({})]) {
      const result = checkWage({ jurisdiction, date: "2026-11-04", currencyCode: "USD", terms: hourly(1) });
      expect(result).toMatchObject({ status: "REFERENCE_UNAVAILABLE", reason: "NO_JURISDICTION", enforced: false });
      expect(wageAllowsOffer(result)).toBe(false);
      expect(wageAllowsOffer(result, true)).toBe(true);
    }
    expect(WAGE_STATUS_LABEL.REFERENCE_UNAVAILABLE).toBe("Minimum wage not checked");
  });
});

describe("bounded AI wage explanation contract", () => {
  it("accepts words only, and rejects figures, compliance claims and other shapes", () => {
    const ok = "This rate meets the FairShift demo minimum for the shift date, which follows the statutory rate for workers aged twenty-one and over.";
    expect(validateWageExplanation(JSON.stringify({ explanation: ok }))).toBe(ok);
    for (const bad of ["The rate is above £12.71 for everyone in this category.", "This rate is legally compliant for every worker you employ.", "This guarantees that every worker is paid properly here.", "Some workers may be exempt from the minimum wage here."])
      expect(validateWageExplanation(JSON.stringify({ explanation: bad }))).toBeNull();
    expect(validateWageExplanation(JSON.stringify({ explanation: ok, rate: 1 }))).toBeNull();
    expect(validateWageExplanation("not json")).toBeNull();
  });
  it("gives the model the deterministic check and the demo policy, with no identities", () => {
    const input = wageExplanationInput(check(1200), { basis: "HOURLY", rateMinor: 1200 });
    expect(input).toMatchObject({ status: "BELOW_DEMO_MINIMUM", enforcedFloorCategory: "AGE_21_AND_OVER", workerFactsHeldByFairShift: { age: false, apprenticeship: false } });
    // The jurisdiction code is policy context; no country value, place or person from FairShift's records is sent.
    expect(input.jurisdiction).toBe("ENGLAND");
    expect(JSON.stringify(input)).not.toContain('"England"');
    expect(JSON.stringify(input)).not.toMatch(/United Kingdom|Leeds|name|email/i);
  });
});

// Day 6, Step 3a (Owner instruction, 9 November 2026): the floor comes from each business's country rule.
describe("South Africa's country rule", () => {
  const za = wageJurisdiction({ locationCountry: "South Africa" });
  it("enforces R30.23 an hour from 1 March 2026, in rand, and refuses what can't be checked", () => {
    expect(checkWage({ jurisdiction: za, date: "2026-11-10", currencyCode: "ZAR", terms: hourly(3_023) })).toMatchObject({ status: "RATE_CHECKED", enforced: true, floorMinor: 3_023, floorCurrency: "ZAR", floorName: "South African National Minimum Wage" });
    const below = checkWage({ jurisdiction: za, date: "2026-11-10", currencyCode: "ZAR", terms: hourly(3_022) });
    expect(below).toMatchObject({ status: "BELOW_DEMO_MINIMUM" });
    expect(wageAllowsOffer(below)).toBe(false);
    expect(wageCheckExplanation(below, minor => `R${(minor / 100).toFixed(2)}`)).toContain("Below R30.23 an hour, the South African National Minimum Wage");
    expect(wageAllowsOffer(checkWage({ jurisdiction: za, date: "2026-11-10", currencyCode: "USD", terms: hourly(9_000) }))).toBe(false);
    expect(wageAllowsOffer(checkWage({ jurisdiction: za, date: "2026-11-10", currencyCode: "ZAR", terms: { earningsModel: "COMMISSION" } }))).toBe(false);
    expect(checkWage({ jurisdiction: za, date: "2027-03-01", currencyCode: "ZAR", terms: hourly(9_000) })).toMatchObject({ status: "REFERENCE_UNAVAILABLE", reason: "NO_REFERENCE_FOR_DATE" });
  });
});
