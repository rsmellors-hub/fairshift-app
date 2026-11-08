import { describe, expect, it } from "vitest";
import { labelledMoney, money, rand } from "@/app/components/format";

// Owner decision, 8 November 2026: workers and owners see rand first, written the South African way.
describe("money display", () => {
  it("writes rand as R, as on the price list, never as the ISO code", () => {
    expect(money(13_500, "ZAR")).toBe("R135.00");
    expect(money(114_900, "ZAR")).toBe("R1,149.00");
    expect(money(59_492_900, "ZAR", { whole: true })).toBe("R594,929");
    expect(money(-1_000, "ZAR")).toBe("-R10.00");
    expect(rand(4_500)).toBe("R45.00");
    expect(money(13_500, "ZAR")).not.toMatch(/ZAR/);
  });
  it("leaves other currencies as they were", () => {
    expect(money(1_200, "GBP")).toBe("£12.00");
    expect(money(816, "USD")).toBe("$8.16");
  });
  it("labels the US dollar amount PayPal pays", () => {
    expect(labelledMoney(816, "USD")).toBe("US$8.16");
    expect(labelledMoney(169_475, "USD")).toBe("US$1,694.75");
  });
});
