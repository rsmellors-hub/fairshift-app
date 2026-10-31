import { describe, expect, it } from "vitest";
import { DEFAULT_LOCATION_CURRENCY, currencyForCountry, resolveLocationCurrency } from "@/server/domain/currency";
import { BASE_PAYABLE_METHOD, basePayableFromAcceptedTerms } from "@/server/domain/work-payable";
import { expectedWorkEarnings } from "@/server/domain/work-terms";

const ids = { workerId: "w-1", offerId: "o-1", shiftId: "s-1", locationId: "l-1", termsVersion: 1 };
const startsAt = "2026-10-20T08:00:00.000Z";
const at = (hours: number) => new Date(Date.parse(startsAt) + hours * 3_600_000).toISOString();
// The accepted-terms snapshot shape written by respondToAssignment.
const snapshot = (terms: Record<string, unknown> = {}) => ({
  workerId: ids.workerId, offerId: ids.offerId, assignmentId: ids.shiftId, locationId: ids.locationId, termsVersion: 1,
  startsAt, endsAt: at(6), earningsModel: "HOURLY", currencyCode: "GBP", rateMinor: 1200, expectedEarningsMinor: 7200,
  commissionBps: null, incentiveAmountMinor: 0, acknowledged: true, ...terms,
});

describe("base payable from accepted terms (confirm-as-scheduled)", () => {
  it("pays hourly terms as accepted rate × accepted scheduled duration, in integer minor units", () => {
    expect(BASE_PAYABLE_METHOD).toBe("confirm-as-scheduled-v1");
    expect(basePayableFromAcceptedTerms(snapshot(), ids)).toEqual({ state: "CALCULATED", earningsModel: "HOURLY", currencyCode: "GBP", rateMinor: 1200,
      scheduledStartsAt: new Date(startsAt), scheduledEndsAt: new Date(at(6)), baseAmountMinor: 7200, termsVersion: 1 });
  });
  it("handles fractional scheduled durations exactly, with no floating-point drift", () => {
    for (const [hours, rateMinor, amount] of [[6.25, 1200, 7500], [7.75, 1200, 9300], [0.25, 1201, 300.25], [7.5, 1333, 9997.5]] as const) {
      const terms = snapshot({ endsAt: at(hours), rateMinor, expectedEarningsMinor: Number.isInteger(amount) ? amount : 0 });
      const result = basePayableFromAcceptedTerms(terms, ids);
      if (Number.isInteger(amount)) expect(result).toMatchObject({ state: "CALCULATED", baseAmountMinor: amount });
      // A fractional minor unit has no approved rounding rule: unavailable, never rounded or zero.
      else expect(result).toEqual({ state: "UNAVAILABLE", reason: "NOT_WHOLE_MINOR_UNITS" });
    }
    // 0.1 h steps that drift in floating point stay exact: 3 × 6 minutes at £10.00/hour.
    expect(basePayableFromAcceptedTerms(snapshot({ endsAt: at(0.3), rateMinor: 1000, expectedEarningsMinor: 300 }), ids)).toMatchObject({ baseAmountMinor: 300 });
  });
  it("uses the same arithmetic as the expected earnings shown before acceptance", () => {
    for (const hours of [1, 4.5, 6, 6.25, 8, 11.75]) {
      const expected = expectedWorkEarnings({ earningsModel: "HOURLY", rateMinor: 1200 }, new Date(startsAt), new Date(at(hours)));
      expect(basePayableFromAcceptedTerms(snapshot({ endsAt: at(hours), expectedEarningsMinor: expected }), ids)).toMatchObject({ baseAmountMinor: expected });
    }
    expect(basePayableFromAcceptedTerms(snapshot({ expectedEarningsMinor: 7201 }), ids)).toEqual({ state: "UNAVAILABLE", reason: "EXPECTED_EARNINGS_MISMATCH" });
  });
  it("pays daily terms as the accepted daily amount, whatever the duration", () => {
    for (const hours of [4, 6, 10]) {
      expect(basePayableFromAcceptedTerms(snapshot({ earningsModel: "DAILY", rateMinor: 9600, expectedEarningsMinor: 9600, endsAt: at(hours) }), ids))
        .toMatchObject({ state: "CALCULATED", earningsModel: "DAILY", baseAmountMinor: 9600, currencyCode: "GBP" });
    }
  });
  it("does not make commission payable without verified attribution, and does not convert it to hourly", () => {
    expect(basePayableFromAcceptedTerms(snapshot({ earningsModel: "COMMISSION", rateMinor: null, expectedEarningsMinor: null, commissionBps: 500 }), ids)).toEqual({ state: "ATTRIBUTION_REQUIRED" });
  });
  it("reports missing, malformed or mismatched terms as unavailable, never zero", () => {
    const unavailable = { state: "UNAVAILABLE", reason: "INVALID_ACCEPTED_TERMS" };
    for (const terms of [null, {}, snapshot({ currencyCode: undefined }), snapshot({ currencyCode: "gbp" }), snapshot({ rateMinor: null }), snapshot({ rateMinor: 12.5 }),
      snapshot({ rateMinor: -1 }), snapshot({ endsAt: startsAt }), snapshot({ startsAt: "yesterday" }), snapshot({ earningsModel: "PIECEWORK" })]) {
      expect(basePayableFromAcceptedTerms(terms, ids)).toEqual(unavailable);
    }
    for (const other of [{ workerId: "w-2" }, { offerId: "o-2" }, { shiftId: "s-2" }, { locationId: "l-2" }, { termsVersion: 2 }]) {
      expect(basePayableFromAcceptedTerms(snapshot(), { ...ids, ...other })).toEqual(unavailable);
    }
  });
});

describe("location currency", () => {
  it("resolves the United Kingdom to GBP and keeps the established USD default elsewhere", () => {
    expect(currencyForCountry(" United Kingdom ")).toBe("GBP");
    expect(currencyForCountry("England")).toBe("GBP");
    expect(currencyForCountry("South Africa")).toBeNull();
    expect(DEFAULT_LOCATION_CURRENCY).toBe("USD");
    expect(resolveLocationCurrency({ locationCountry: "Wales" })).toBe("GBP");
    expect(resolveLocationCurrency({ locationCountry: null, organisationCountry: "United Kingdom" })).toBe("GBP");
    expect(resolveLocationCurrency({ locationCountry: " ", organisationCountry: "Scotland" })).toBe("GBP");
    // A location's own country decides; a South African location of a UK company is not paid in GBP.
    expect(resolveLocationCurrency({ locationCountry: "South Africa", organisationCountry: "United Kingdom" })).toBe("USD");
    expect(resolveLocationCurrency({ locationCountry: "England", organisationCountry: "South Africa" })).toBe("GBP");
    expect(resolveLocationCurrency({ locationCountry: "South Africa", organisationCountry: "South Africa" })).toBe("USD");
    expect(resolveLocationCurrency({})).toBe("USD");
  });
});
