import { describe, expect, it } from "vitest";
import { acceptedIncentiveTerms, calculateIncentive, INDIVIDUAL_INCENTIVE_BASIS } from "@/server/domain/incentive";
import { finalPayableMinor } from "@/server/domain/work-payable";
import { parseAttributionRows } from "@/server/performance/attribution";

const HEADER = "transaction_id,attribution_code,occurred_at,amount,currency";

describe("individual target and fixed bonus", () => {
  it("earns the bonus only at or above the target, and repeats exactly", () => {
    expect(calculateIncentive(64_999, 65_000, 2_500)).toMatchObject({ earned: false, earnedAmountMinor: 0 });
    expect(calculateIncentive(65_000, 65_000, 2_500)).toMatchObject({ earned: true, earnedAmountMinor: 2_500 });
    expect(calculateIncentive(900_000, 65_000, 2_500).earnedAmountMinor).toBe(2_500);
    expect(calculateIncentive(0, 65_000, 2_500).earnedAmountMinor).toBe(0);
    for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(() => calculateIncentive(bad, 65_000, 2_500)).toThrow();
    expect(calculateIncentive(70_000, 65_000, 2_500)).toEqual(calculateIncentive(70_000, 65_000, 2_500));
  });
  it("adds base and incentive; unknown adds nothing, and overflow is refused", () => {
    expect(finalPayableMinor({ baseAmountMinor: 9_600, incentiveAmountMinor: 2_500 })).toBe(12_100);
    expect(finalPayableMinor({ baseAmountMinor: 9_600, incentiveAmountMinor: 0 })).toBe(9_600);
    expect(finalPayableMinor({ baseAmountMinor: 9_600, incentiveAmountMinor: null })).toBe(9_600);
    expect(() => finalPayableMinor({ baseAmountMinor: Number.MAX_SAFE_INTEGER, incentiveAmountMinor: 1 })).toThrow();
  });
  it("reads incentive terms only from a snapshot that accepted them", () => {
    const window = { currencyCode: "GBP", startsAt: "2026-01-19T09:00:00.000Z", endsAt: "2026-01-19T17:00:00.000Z" };
    expect(acceptedIncentiveTerms({ ...window, incentiveTargetMinor: 65_000, incentiveAmountMinor: 2_500 })).toBeNull(); // The seeded team demo, and older snapshots.
    expect(acceptedIncentiveTerms(null)).toBeNull();
    expect(acceptedIncentiveTerms({ ...window, incentiveBasis: INDIVIDUAL_INCENTIVE_BASIS, incentiveTargetMinor: 65_000, incentiveAmountMinor: 2_500 })).toMatchObject({ targetMinor: 65_000, bonusMinor: 2_500, currencyCode: "GBP" });
    expect(() => acceptedIncentiveTerms({ ...window, incentiveBasis: INDIVIDUAL_INCENTIVE_BASIS, incentiveTargetMinor: 0, incentiveAmountMinor: 2_500 })).toThrow();
  });
});

describe("attributed sales rows", () => {
  const row = (cells: string) => parseAttributionRows(`${HEADER}\n${cells}`)[0];
  it("reads valid rows and ignores blank lines", () => {
    const rows = parseAttributionRows(`\n${HEADER}\r\nT1,FS-A,2026-01-19T10:00:00+00:00,25.00,GBP\n\nT2,FS-A,2026-01-19T12:00:00Z,0.01,GBP\n`);
    expect(rows).toEqual([expect.objectContaining({ line: 3, invalid: false, transactionId: "T1", amountMinor: 2_500, occurredAt: new Date("2026-01-19T10:00:00Z") }), expect.objectContaining({ line: 5, amountMinor: 1 })]);
  });
  it("marks unusable rows invalid: negative, zero, unrounded, unzoned, malformed", () => {
    for (const cells of ["T,FS-A,2026-01-19T10:00:00Z,-5.00,GBP", "T,FS-A,2026-01-19T10:00:00Z,0.00,GBP", "T,FS-A,2026-01-19T10:00:00Z,5,GBP", "T,FS-A,2026-01-19T10:00:00Z,5.005,GBP", "T,FS-A,2026-01-19T10:00:00,5.00,GBP", "T,FS-A,yesterday,5.00,GBP", "T,FS-A,2026-01-19T10:00:00Z,5.00,pounds", ",FS-A,2026-01-19T10:00:00Z,5.00,GBP", "T,FS-A,2026-01-19T10:00:00Z,5.00", "T,FS-A,2026-01-19T10:00:00Z,5.00,GBP,Jane Customer"]) {
      expect(row(cells)).toMatchObject({ invalid: true });
    }
  });
  it("refuses a file without the exact columns, so extra data cannot come in", () => {
    for (const text of ["", "T,FS-A,2026-01-19T10:00:00Z,5.00,GBP", `${HEADER},customer\nT,FS-A,2026-01-19T10:00:00Z,5.00,GBP,Jane`]) expect(() => parseAttributionRows(text)).toThrow(expect.objectContaining({ feedback: "import-format" }));
    expect(() => parseAttributionRows(`${HEADER}\n${"T,FS-A,2026-01-19T10:00:00Z,5.00,GBP\n".repeat(2001)}`)).toThrow(expect.objectContaining({ feedback: "import-format" }));
  });
});
