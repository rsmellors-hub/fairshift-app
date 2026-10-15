import { describe, expect, it } from "vitest";
import { expectedWorkEarnings, commissionEarnings, policyInput } from "@/server/domain/work-terms";
const starts = new Date("2026-10-16T08:00:00Z"), ends = new Date("2026-10-16T14:00:00Z");
describe("exact work terms", () => {
  it("calculates hourly expected earnings in minor units", () => {
    expect(expectedWorkEarnings({ earningsModel: "HOURLY", rateMinor: 2000 }, starts, ends)).toBe(12000);
    expect(() => expectedWorkEarnings({ earningsModel: "HOURLY", rateMinor: 1 }, starts, new Date(starts.getTime()+1))).toThrow(/whole cents/);
    expect(() => expectedWorkEarnings({ earningsModel: "HOURLY", rateMinor: Number.MAX_SAFE_INTEGER }, starts, ends)).toThrow(/range/);
  });
  it("preserves daily terms regardless of scheduled duration", () => {
    expect(expectedWorkEarnings({ earningsModel: "DAILY", rateMinor: 15000 }, starts, ends)).toBe(15000);
    expect(expectedWorkEarnings({ earningsModel: "DAILY", rateMinor: 15000 }, starts, new Date(starts.getTime()+3600000))).toBe(15000);
  });
  it("keeps commission terms separate and never fabricates fixed earnings", () => {
    expect(expectedWorkEarnings({ earningsModel: "COMMISSION", commissionBps: 500, commissionBasis: "VERIFIED_ATTRIBUTED_SALES" }, starts, ends)).toBeNull();
    expect(policyInput.safeParse({ earningsModel: "COMMISSION", commissionBps: 500, commissionBasis: "STORE_SALES" }).success).toBe(false);
    expect(commissionEarnings(null, 500, "VERIFIED").amountMinor).toBeNull();
    expect(commissionEarnings(10000, 500, "DEMO_SEEDED").amountMinor).toBeNull();
    expect(commissionEarnings(10000, 500, "VERIFIED")).toEqual({state: "CALCULATED", amountMinor: 500});
    expect(commissionEarnings(1, 500, "VERIFIED")).toEqual({state: "ROUNDING_POLICY_REQUIRED", amountMinor: null});
  });
});
