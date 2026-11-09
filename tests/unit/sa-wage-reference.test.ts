import { describe, expect, it } from "vitest";
import { isSouthAfricanJurisdiction, SA_NATIONAL_MINIMUM_WAGE, saWageIndicator, saWageIndicatorExplanation } from "@/server/domain/sa-wage-reference";
import { wageJurisdiction } from "@/server/domain/statutory-wage";

const money = (minor: number) => `R${(minor / 100).toFixed(2)}`;
const hourly = (rateMinor: number) => ({ earningsModel: "HOURLY" as const, rateMinor });
const sa = (terms: Parameters<typeof saWageIndicator>[0]["terms"], date = "2026-11-10", currencyCode = "ZAR") => saWageIndicator({ country: "South Africa", date, currencyCode, terms });

describe("South African national minimum wage reference indicator", () => {
  it("compares the offered hourly rate with R30.23 from 1 March 2026", () => {
    expect(SA_NATIONAL_MINIMUM_WAGE).toMatchObject({ rateMinor: 3_023, currencyCode: "ZAR", validFrom: "2026-03-01" });
    expect(sa(hourly(4_500))).toMatchObject({ status: "ABOVE_REFERENCE", offeredHourlyMinor: 4_500, referenceMinor: 3_023, blocking: false });
    expect(sa(hourly(3_023))).toMatchObject({ status: "EQUAL_TO_REFERENCE", blocking: false });
    expect(sa(hourly(3_022))).toMatchObject({ status: "BELOW_REFERENCE", blocking: true });
    expect(sa(hourly(3_023), "2026-03-01")).toMatchObject({ status: "EQUAL_TO_REFERENCE" });
  });

  it("compares a fixed amount exactly per scheduled hour", () => {
    // R241.84 for 8 hours is exactly R30.23 an hour; a cent less is below.
    expect(sa({ earningsModel: "DAILY", rateMinor: 24_184, durationMs: 8 * 3_600_000 })).toMatchObject({ status: "EQUAL_TO_REFERENCE", offeredHourlyMinor: 3_023 });
    expect(sa({ earningsModel: "DAILY", rateMinor: 24_183, durationMs: 8 * 3_600_000 })).toMatchObject({ status: "BELOW_REFERENCE", offeredHourlyMinor: 3_022 });
  });

  it("doesn't compare what it can't read, outside South Africa, outside rand or outside its checked dates", () => {
    expect(sa({ earningsModel: "COMMISSION" })).toMatchObject({ status: "NOT_COMPARED", reason: "VARIABLE_PAY" });
    expect(sa(null)).toMatchObject({ status: "NOT_COMPARED", reason: "INVALID_TERMS" });
    expect(sa(hourly(-1))).toMatchObject({ status: "NOT_COMPARED", reason: "INVALID_TERMS" });
    expect(sa(hourly(4_500), "2026-11-10", "USD")).toMatchObject({ status: "NOT_COMPARED", reason: "CURRENCY_NOT_ZAR" });
    expect(sa(hourly(4_500), "2026-02-28")).toMatchObject({ status: "NOT_COMPARED", reason: "DATE_BEFORE_REFERENCE" });
    expect(sa(hourly(4_500), "2027-03-01")).toMatchObject({ status: "NOT_COMPARED", reason: "DATE_NOT_CHECKED" });
    expect(saWageIndicator({ country: "England", date: "2026-11-10", currencyCode: "ZAR", terms: hourly(4_500) })).toMatchObject({ status: "NOT_COMPARED", reason: "NOT_SOUTH_AFRICA" });
    expect(isSouthAfricanJurisdiction(wageJurisdiction({ locationCountry: null, organisationCountry: "South Africa" }))).toBe(true);
    expect(isSouthAfricanJurisdiction(wageJurisdiction({ locationCountry: "England", organisationCountry: "South Africa" }))).toBe(false);
  });

  it("says it is a reference comparison, never a compliance or employment-status finding, and never a block", () => {
    const below = saWageIndicatorExplanation(sa(hourly(2_500)), money);
    expect(below).toContain("Offered R25.00 an hour, below R30.23 an hour");
    expect(below).toContain("can’t be created or offered");
    for (const text of [below, saWageIndicatorExplanation(sa(hourly(4_500)), money)]) {
      expect(text).toContain("isn’t a legal compliance check");
      expect(text).toContain("doesn’t decide employment status");
      expect(text).not.toMatch(/compliant|can’t be offered|employee|contractor/i);
    }
  });
});
