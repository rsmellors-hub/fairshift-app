import { describe, expect, it } from "vitest";
import { classifySaDate, classifySaInstant, saPublicHolidays, SA_PUBLIC_HOLIDAYS_RANGE, SA_PUBLIC_HOLIDAYS_SOURCE } from "@/server/reference/sa-public-holidays";
import { SA_REFERENCE_LOCATIONS, SA_REFERENCE_STORE_CODES, saReferenceDates, saReferenceTransactions } from "@/server/reference/sa-reference";

describe("South African public holiday reference, 1 August 2026 – 31 March 2027", () => {
  it("lists exactly the official holidays in the range, once each", () => {
    const holidays = saPublicHolidays();
    // gov.za/about-sa/public-holidays, read 6 November 2026, plus the Owner-supplied election proclamation.
    expect(holidays.map(row => [row.date, row.name, row.kind])).toEqual([
      ["2026-08-09", "National Women’s Day", "STATUTORY"],
      ["2026-08-10", "National Women’s Day observed", "SUNDAY_OBSERVED"],
      ["2026-09-24", "Heritage Day", "STATUTORY"],
      ["2026-11-04", "Local Government Elections", "PROCLAIMED"],
      ["2026-12-16", "Day of Reconciliation", "STATUTORY"],
      ["2026-12-25", "Christmas Day", "STATUTORY"],
      ["2026-12-26", "Day of Goodwill", "STATUTORY"],
      ["2027-01-01", "New Year’s Day", "STATUTORY"],
      ["2027-03-21", "Human Rights Day", "STATUTORY"],
      ["2027-03-22", "Human Rights Day observed", "SUNDAY_OBSERVED"],
      ["2027-03-26", "Good Friday", "STATUTORY"],
      ["2027-03-29", "Family Day", "STATUTORY"],
    ]);
    expect(new Set(holidays.map(row => row.date)).size).toBe(holidays.length);
  });

  it("recognises a Sunday holiday and the Monday after it", () => {
    expect(new Date("2026-08-09T12:00:00Z").getUTCDay()).toBe(0);
    expect(classifySaDate("2026-08-09")).toMatchObject({ status: "PUBLIC_HOLIDAY", holiday: { name: "National Women’s Day", kind: "STATUTORY", observes: null } });
    expect(classifySaDate("2026-08-10")).toMatchObject({ status: "PUBLIC_HOLIDAY", holiday: { kind: "SUNDAY_OBSERVED", observes: "2026-08-09", authority: "Public Holidays Act 36 of 1994, section 2(1)" } });
    // Saturday holidays carry no Monday.
    expect(classifySaDate("2026-12-28")).toMatchObject({ status: "NOT_A_PUBLIC_HOLIDAY" });
    expect(classifySaDate("2026-09-24")).toMatchObject({ status: "PUBLIC_HOLIDAY", holiday: { name: "Heritage Day" } });
  });

  it("recognises the exceptional 4 November 2026 election holiday with its stated provenance", () => {
    expect(classifySaDate("2026-11-04")).toMatchObject({ status: "PUBLIC_HOLIDAY", holiday: {
      kind: "PROCLAIMED", authority: "Proclamation 346, Government Gazette 55352", verification: "OWNER_SUPPLIED_NOT_VERIFIED" } });
    expect(classifySaDate("2026-11-05")).toMatchObject({ status: "NOT_A_PUBLIC_HOLIDAY" });
    for (const row of saPublicHolidays().filter(holiday => holiday.kind !== "PROCLAIMED")) {
      expect(row).toMatchObject({ verification: "VERIFIED_OFFICIAL_LIST", sourceUrl: SA_PUBLIC_HOLIDAYS_SOURCE.url });
    }
  });

  it("uses Africa/Johannesburg local dates and says nothing outside the checked range", () => {
    // 22:30 UTC on 3 November is 00:30 on 4 November in Johannesburg.
    expect(classifySaInstant(new Date("2026-11-03T22:30:00Z"))).toMatchObject({ status: "PUBLIC_HOLIDAY", date: "2026-11-04" });
    expect(classifySaInstant(new Date("2026-11-03T21:30:00Z"))).toMatchObject({ status: "NOT_A_PUBLIC_HOLIDAY", date: "2026-11-03" });
    expect(classifySaDate("2026-07-31")).toMatchObject({ status: "OUTSIDE_REFERENCE" });
    expect(classifySaDate("2027-04-27")).toMatchObject({ status: "OUTSIDE_REFERENCE" });
    expect(saPublicHolidays("2026-01-01", "2026-07-31")).toEqual([]);
    expect(SA_PUBLIC_HOLIDAYS_RANGE).toEqual({ from: "2026-08-01", through: "2027-03-31" });
    expect(() => classifySaDate("2026-02-30")).toThrow();
  });

  it("adds no demand effect: holidays trade inside the same band as ordinary days of their kind", () => {
    const holidays = new Set(saPublicHolidays().map(row => row.date));
    const dates = saReferenceDates(SA_PUBLIC_HOLIDAYS_RANGE.from, SA_PUBLIC_HOLIDAYS_RANGE.through);
    for (const code of SA_REFERENCE_STORE_CODES) {
      const location = SA_REFERENCE_LOCATIONS.find(row => row.code === code)!;
      const base = location.hourly.reduce((sum, value) => sum + value, 0);
      for (const date of dates.filter(day => holidays.has(day))) {
        const weekend = [0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay());
        const ratio = saReferenceTransactions(code, date).length / (base * (weekend ? location.weekendFactor : 1));
        // Day-to-day variation is about 6%; any holiday factor would leave this band.
        expect(ratio).toBeGreaterThan(Math.exp(-0.3));
        expect(ratio).toBeLessThan(Math.exp(0.3));
      }
    }
  });
});
