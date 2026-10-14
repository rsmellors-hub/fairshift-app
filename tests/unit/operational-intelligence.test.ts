import { describe, expect, it, vi } from "vitest";

import {
  buildAiEvidence,
  getAiOperationalAssessment,
} from "@/server/integrations/openai/operational-intelligence";
import { forecastResultSchema, type ForecastResult } from "@/server/intelligence/forecast";

function availableForecast(): ForecastResult {
  return forecastResultSchema.parse({
    status: "AVAILABLE",
    methodVersion: "comparable-days-recency-v1",
    organisationId: "10000000-0000-4000-8000-000000000001",
    outletId: "20000000-0000-4000-8000-000000000001",
    outletName: "FairShift Demo Outlet",
    timezone: "Africa/Johannesburg",
    targetDate: "2026-10-15",
    currency: "USD",
    source: "DEMO_SEEDED",
    dataAsOf: "2026-10-14T08:00:00.000Z",
    generatedAt: "2026-10-14T08:00:00.000Z",
    forecastSalesMinor: 528160,
    lowerSalesMinor: 396120,
    upperSalesMinor: 660200,
    support: "MODERATE",
    basis: "SAME_WEEKDAY",
    lookbackDays: 56,
    eligibleDays: 56,
    eligibleTransactions: 3704,
    evidence: [
      {
        date: "2026-10-08",
        salesMinor: 520000,
        transactions: 65,
        usedSalesMinor: 520000,
        weight: 1,
      },
    ],
    staffing: {
      policy: {
        version: "revenue-capacity-v1",
        salesMinorPerLabourHour: 10000,
        tradingHours: 8,
        minimumWorkers: 2,
        comparisonWorkers: 5,
      },
      workers: 7,
      workerDelta: 2,
      labourHours: 52.816,
    },
    drivers: [
      "Historical comparable-day evidence.",
      "No external context signals are included.",
    ],
    action: "Review 7 workers. Manager judgement required.",
  });
}

function unavailableForecast(): ForecastResult {
  return forecastResultSchema.parse({
    status: "UNAVAILABLE",
    methodVersion: "comparable-days-recency-v1",
    organisationId: "10000000-0000-4000-8000-000000000001",
    outletId: "20000000-0000-4000-8000-000000000001",
    outletName: "FairShift Demo Outlet",
    timezone: "Africa/Johannesburg",
    targetDate: "2026-10-15",
    currency: "USD",
    source: "DEMO_SEEDED",
    dataAsOf: "2026-10-14T08:00:00.000Z",
    generatedAt: "2026-10-14T08:00:00.000Z",
    reason: "NO_ELIGIBLE_HISTORY",
  });
}

function openAiResponse(payload: unknown) {
  return new Response(JSON.stringify({
    output: [
      {
        content: [
          {
            type: "output_text",
            text: JSON.stringify(payload),
          },
        ],
      },
    ],
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("OpenAI operational intelligence", () => {
  it("builds minimized aggregated evidence without transaction-level PayPal identifiers", () => {
    const evidence = buildAiEvidence(availableForecast());

    expect(evidence).toMatchObject({
      source: "DEMO_SEEDED",
      forecastSalesMinor: 528160,
      deterministicRecommendedWorkers: 7,
      deterministicWorkerDelta: 2,
      eligibleTransactions: 3704,
    });

    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("paypalCaptureId");
    expect(serialized).not.toContain("paypalCustomId");
    expect(serialized).not.toContain("providerCreatedAt");
  });

  it("does not call OpenAI without an eligible deterministic forecast", async () => {
    const fetchImpl = vi.fn();

    const result = await getAiOperationalAssessment(unavailableForecast(), {
      apiKey: "test-key",
      fetchImpl,
    });

    expect(result.status).toBe("UNAVAILABLE");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not call OpenAI when the API key is not configured", async () => {
    const fetchImpl = vi.fn();

    const result = await getAiOperationalAssessment(availableForecast(), {
      apiKey: "",
      fetchImpl,
    });

    expect(result.status).toBe("NOT_CONFIGURED");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts a valid structured OpenAI assessment without replacing deterministic staffing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(openAiResponse({
      demandOutlook: "ABOVE_BASELINE",
      signalQuality: "MODERATE",
      staffingAssessment: "BASELINE_REASONABLE",
      summary: "The deterministic baseline is supported by the supplied comparable-day evidence.",
      managerAction: "Review the seven-worker baseline against actual availability before publishing shifts.",
    }));

    const forecast = availableForecast();
    const result = await getAiOperationalAssessment(forecast, {
      apiKey: "test-key",
      model: "test-model",
      fetchImpl,
    });

    expect(result).toMatchObject({
      status: "AVAILABLE",
      provider: "OPENAI",
      model: "test-model",
      assessment: {
        demandOutlook: "ABOVE_BASELINE",
        signalQuality: "MODERATE",
        staffingAssessment: "BASELINE_REASONABLE",
      },
    });

    expect(forecast.status).toBe("AVAILABLE");
    if (forecast.status === "AVAILABLE") {
      expect(forecast.staffing.workers).toBe(7);
    }

    const request = fetchImpl.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body));

    expect(body.input).toContain('"deterministicRecommendedWorkers":7');
    expect(body.input).not.toContain("paypalCaptureId");
    expect(body.input).not.toContain("paypalCustomId");
  });

  it("rejects malformed or expanded model output safely", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(openAiResponse({
      demandOutlook: "ABOVE_BASELINE",
      signalQuality: "MODERATE",
      staffingAssessment: "BASELINE_REASONABLE",
      summary: "Assessment.",
      managerAction: "Review.",
      recommendedWorkers: 99,
    }));

    const result = await getAiOperationalAssessment(availableForecast(), {
      apiKey: "test-key",
      fetchImpl,
    });

    expect(result.status).toBe("UNAVAILABLE");
  });

  it("degrades safely when the provider fails", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("provider unavailable"));

    const result = await getAiOperationalAssessment(availableForecast(), {
      apiKey: "test-key",
      fetchImpl,
    });

    expect(result.status).toBe("UNAVAILABLE");
  });
});
