import { describe, expect, it } from "vitest";

import { decimalToMinorUnits, minorUnitsToDecimal } from "@/server/domain/money";

describe("money conversion", () => {
  it.each([
    ["0.00", 0],
    ["5.00", 500],
    ["19.95", 1995],
    ["1000.01", 100001],
  ])("converts %s to integer minor units", (decimal, minor) => {
    expect(decimalToMinorUnits(decimal)).toBe(minor);
    expect(minorUnitsToDecimal(minor)).toBe(decimal);
  });

  it.each(["5", "5.0", "-1.00", "01.00", "1.001", "abc"])("rejects invalid money %s", (value) => {
    expect(() => decimalToMinorUnits(value)).toThrow();
  });
});
