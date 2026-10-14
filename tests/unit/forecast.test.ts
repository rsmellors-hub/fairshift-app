import { describe, expect, it } from "vitest";

import { DEMO_OUTLET } from "@/server/constants";
import { DEMO_AS_OF, DEMO_TARGET_DATE } from "@/server/intelligence/demo";
import { forecastDemand, forecastResultSchema, recommendStaffing, shiftDate, STAFFING_POLICY, type Observation } from "@/server/intelligence/forecast";

function sale(date: string, amount = 400_000, overrides: Partial<Observation> = {}): Observation {
  return {
    id: "40000000-0000-4000-8000-000000000001", outletId: DEMO_OUTLET.id,
    source: "DEMO_SEEDED", currencyCode: "USD", grossAmountMinor: amount,
    verificationState: "PENDING", reconciliationState: "NOT_RECONCILED", providerStatus: "DEMO_SEEDED",
    paypalCaptureId: null, providerCreatedAt: null, createdAt: new Date(`${date}T10:00:00Z`), ...overrides,
  };
}
function forecast(sales: Observation[], source: "DEMO_SEEDED" | "PAYPAL_SANDBOX" = "DEMO_SEEDED") {
  return forecastDemand({ sales, outlet: DEMO_OUTLET, source, targetDate: DEMO_TARGET_DATE, asOf: DEMO_AS_OF });
}
function thursdays(amounts: number[]) {
  return amounts.map((amount, i) => sale(shiftDate("2026-08-20", i * 7), amount));
}

describe("deterministic demand forecast", () => {
  it("aggregates a normal same-weekday history with an explainable range and staffing result", () => {
    const result = forecast([...thursdays(Array(8).fill(400_000)), sale("2026-10-12", 9_000_000)]);
    expect(result).toMatchObject({
      status: "AVAILABLE", forecastSalesMinor: 400_000, lowerSalesMinor: 300_000, upperSalesMinor: 500_000,
      basis: "SAME_WEEKDAY", support: "MODERATE", eligibleDays: 9,
      staffing: { workers: 5, workerDelta: 0 }, source: "DEMO_SEEDED", methodVersion: "comparable-days-recency-v1",
    });
    if (result.status !== "AVAILABLE") throw new Error("Expected forecast");
    expect(result.evidence).toHaveLength(8);
    expect(forecastResultSchema.safeParse(result).success).toBe(true);
  });

  it("aggregates multiple receipts in the outlet's local day", () => {
    const result = forecast([sale("2026-10-12", 10000), sale("2026-10-12", 20000)]);
    expect(result).toMatchObject({ forecastSalesMinor: 30000, eligibleTransactions: 2, evidence: [{ transactions: 2, salesMinor: 30000 }] });
  });

  it("uses a wider low-support fallback with sparse history", () => {
    expect(forecast([sale("2026-10-12", 100000)])).toMatchObject({
      status: "AVAILABLE", basis: "RECENT_OBSERVED_DAYS", support: "LOW",
      forecastSalesMinor: 100000, lowerSalesMinor: 50000, upperSalesMinor: 150000,
      staffing: { workers: 2, workerDelta: -3 },
    });
  });

  it("does not invent a forecast or a staffing recommendation without eligible history", () => {
    const result = forecast([]);
    expect(result).toMatchObject({ status: "UNAVAILABLE", reason: "NO_ELIGIBLE_HISTORY" });
    expect(result).not.toHaveProperty("staffing");
    expect(result).not.toHaveProperty("forecastSalesMinor");
  });

  it("responds deterministically to rising and falling demand through recency weights", () => {
    const amounts = [100000, 200000, 300000, 400000, 500000, 600000, 700000, 800000];
    expect(forecast(thursdays(amounts))).toMatchObject({ forecastSalesMinor: 566667 });
    expect(forecast(thursdays([...amounts].reverse()))).toMatchObject({ forecastSalesMinor: 333333 });
    expect(forecast(thursdays(amounts))).toEqual(forecast(thursdays(amounts)));
  });

  it("limits a high outlier while preserving the original historical evidence", () => {
    const result = forecast(thursdays([100000, 100000, 100000, 100000, 100000, 100000, 100000, 10000000]));
    expect(result).toMatchObject({ forecastSalesMinor: 122222 });
    if (result.status !== "AVAILABLE") throw new Error("Expected forecast");
    expect(result.evidence[7]).toMatchObject({ salesMinor: 10000000, usedSalesMinor: 200000 });
    expect(result.drivers.join(" ")).toContain("1 high day(s) capped");
  });

  it("excludes foreign outlet, currency, incomplete days and stale history", () => {
    expect(forecast([
      sale("2026-10-12", 1000, { currencyCode: "EUR" }),
      sale("2026-10-12", 1000, { outletId: "50000000-0000-4000-8000-000000000001" }),
      sale("2026-08-18"), sale("2026-10-14"), sale("2026-10-15"),
      sale("2026-10-13", 1000, { createdAt: new Date("2026-10-13T23:30:00Z") }),
    ])).toMatchObject({ status: "UNAVAILABLE" });
  });

  it("keeps provenance separate and uses the provider timestamp for verified transactions", () => {
    const real = sale("2026-10-14", 80000, {
      source: "PAYPAL_SANDBOX", providerStatus: "COMPLETED", verificationState: "VERIFIED",
      reconciliationState: "RECONCILED", paypalCaptureId: "TEST-CAPTURE",
      providerCreatedAt: new Date("2026-10-13T10:00:00Z"),
    });
    const input = [real, sale("2026-10-13", 900000)];
    expect(forecast(input, "PAYPAL_SANDBOX")).toMatchObject({ forecastSalesMinor: 80000, eligibleTransactions: 1, source: "PAYPAL_SANDBOX" });
    expect(forecast(input)).toMatchObject({ forecastSalesMinor: 900000, eligibleTransactions: 1, source: "DEMO_SEEDED" });
    for (const invalid of [
      { verificationState: "PENDING" }, { reconciliationState: "ERROR" }, { providerStatus: "REFUNDED" },
      { paypalCaptureId: null }, { providerCreatedAt: null },
    ]) expect(forecast([{ ...real, ...invalid }], "PAYPAL_SANDBOX")).toMatchObject({ status: "UNAVAILABLE" });
  });

  it("rejects malformed financial inputs and incomplete structured output", () => {
    expect(() => forecast([sale("2026-10-12", -1)])).toThrow();
    expect(() => forecast([sale("2026-10-12", Number.MAX_SAFE_INTEGER + 1)])).toThrow();
    const result = forecast([sale("2026-10-12")]);
    expect(forecastResultSchema.safeParse({ ...result, source: undefined }).success).toBe(false);
    expect(forecastResultSchema.safeParse({ ...result, methodVersion: "unknown" }).success).toBe(false);
    expect(forecastResultSchema.safeParse({ ...result, lowerSalesMinor: 900000 }).success).toBe(false);
  });
});

describe("explicit staffing policy", () => {
  it.each([
    [0, 2, -3], [80000, 2, -3], [160000, 2, -3], [160001, 3, -2],
    [400000, 5, 0], [400001, 6, 1], [1600000, 20, 15],
  ])("converts %i minor units to %i workers and delta %i", (amount, workers, workerDelta) => {
    expect(recommendStaffing(amount)).toMatchObject({ workers, workerDelta });
  });

  it("validates policy and amount boundaries", () => {
    expect(() => recommendStaffing(-1)).toThrow();
    expect(() => recommendStaffing(1.5)).toThrow();
    expect(() => recommendStaffing(100, { ...STAFFING_POLICY, tradingHours: 0 })).toThrow();
    expect(() => recommendStaffing(100, { ...STAFFING_POLICY, salesMinorPerLabourHour: 0 })).toThrow();
  });
});
