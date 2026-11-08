import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PayAgentPanel } from "@/app/manager/pay-agent-panel";
import { discoveryUnavailableLine, lastSuccessfulRun } from "@/app/manager/local-intelligence";
import { OwnerLiveFeeds } from "@/app/owner/live-feeds";
import type { OutletLocalIntelligence, RunView } from "@/server/intelligence/local-intelligence-service";
import type { WeeklyStaffing } from "@/server/intelligence/staffing";
import { AI_UNAVAILABLE_MESSAGE, aiCheckUnavailable, managerPayAgentView, workerPayStatus, WORKER_PAY_STATUS_NOTE, type PayAgentEventView } from "@/server/pay-agent/presentation";

vi.mock("@/app/operations-actions", () => ({ rejectPayAgentHoldAction: vi.fn(), releasePayAgentHoldAction: vi.fn(), retryPayAgentAction: vi.fn() }));
vi.mock("@/app/local-intelligence-actions", () => ({ decideLocalAdjustmentsAction: vi.fn(), sendEarlyNoticeAction: vi.fn() }));

// What a judge sees when the AI service is unavailable (for example OpenAI answering HTTP 429 for an
// exhausted quota): the Pay Agent fails closed and says so plainly; discovery shows its last success.
const event = (over: Partial<PayAgentEventView> = {}): PayAgentEventView => ({
  id: "evt-1", status: "FAILED_RETRYABLE", outcomeCode: "MODEL_FAILED", errorClass: "HTTP_429", decision: null, reasonCode: null, summary: null,
  dryRun: null, configuredModel: "gpt-6-luna", responseModel: null, responseId: null, resolution: null, resolutionNote: null, resolvedAt: null, attemptCount: 1, updatedAt: new Date("2026-11-08T12:35:37Z"), ...over,
});

describe("Pay Agent when the AI service is unavailable", () => {
  it("says the payment is held and nothing is lost, for a quota, rate limit, outage, timeout or network failure", () => {
    for (const errorClass of ["HTTP_429", "HTTP_500", "HTTP_503", "TIMEOUT", "NETWORK_ERROR"]) {
      const view = managerPayAgentView(event({ errorClass }));
      expect(view).toMatchObject({ status: "AI check unavailable", explanation: AI_UNAVAILABLE_MESSAGE, canRetry: true });
    }
    expect(managerPayAgentView(event({ status: "FAILED_TERMINAL", outcomeCode: "ATTEMPTS_EXHAUSTED" }))).toMatchObject({ status: "AI check unavailable", explanation: AI_UNAVAILABLE_MESSAGE, canRetry: true });
    expect(AI_UNAVAILABLE_MESSAGE).toBe("AI check unavailable — payment held, nothing lost; retry later.");
  });
  it("keeps other outcomes as they were: an unusable answer is not an outage", () => {
    expect(aiCheckUnavailable(event({ status: "REJECTED_OUTPUT", outcomeCode: "OUTPUT_REJECTED", errorClass: null }))).toBe(false);
    expect(aiCheckUnavailable(event({ errorClass: "INPUT_TOO_LARGE" }))).toBe(false);
    expect(managerPayAgentView(event({ status: "DECIDED_HOLD", outcomeCode: null, errorClass: null })).status).toBe("Held for your review");
  });
  it("shows a judge the plain message, never a provider code, and shows the worker a plain status", () => {
    const html = renderToStaticMarkup(PayAgentPanel({ event: event(), payableId: "pay-1", demo: true, timezone: "Africa/Johannesburg" }));
    expect(html).toContain("AI check unavailable");
    expect(html).toContain(AI_UNAVAILABLE_MESSAGE);
    expect(html).not.toMatch(/429|quota|insufficient|credit/i);
    const worker = workerPayStatus({ workConfirmed: true, hasPayable: true, agentStatus: "FAILED_RETRYABLE" });
    expect(worker).toBe("Earnings recorded");
    expect(WORKER_PAY_STATUS_NOTE[worker!]).not.toMatch(/429|quota|error/i);
  });
});

const TZ = "Africa/Johannesburg";
const run = (over: Partial<RunView>): RunView => ({ id: "run", kind: "DAILY", status: "COMPLETED", failureCode: null, responseId: "resp_ok", model: "gpt-6-luna", responseModel: "gpt-6-luna",
  createdAt: new Date("2026-11-08T03:00:00Z"), completedAt: new Date("2026-11-08T03:01:00Z"), coverage: [], searches: [], counts: {}, rejected: [], ...over } as RunView);
const local = (runs: RunView[], lastAttempt: RunView | null): OutletLocalIntelligence => ({ status: "AVAILABLE", runs, lastAttempt, signals: [], days: [], accepted: new Map(), alerts: [], trackRecord: [] });
const failed = run({ id: "failed", kind: "DISRUPTIONS", status: "FAILED", failureCode: "HTTP_429", responseId: null, createdAt: new Date("2026-11-08T15:00:00Z"), completedAt: new Date("2026-11-08T15:00:02Z") });

describe("AI discovery when the AI service is unavailable", () => {
  it("shows the last successful search with its time", () => {
    const line = discoveryUnavailableLine(local([run({})], failed), TZ)!;
    expect(line).toContain("AI search unavailable at");
    expect(line).toContain("nothing was lost");
    expect(line).toContain("Showing the last successful search: Searched");
    expect(line).toContain("resp_ok");
    expect(line).not.toMatch(/429|quota/i);
    expect(lastSuccessfulRun(local([run({ id: "older", completedAt: new Date("2026-11-07T03:01:00Z") }), run({ id: "newer" })], failed))?.id).toBe("newer");
  });
  it("says plainly when no search has completed yet", () => {
    expect(discoveryUnavailableLine(local([], failed), TZ)).toContain("no search has completed yet");
  });
  it("adds nothing when the latest search succeeded or failed for another reason", () => {
    expect(discoveryUnavailableLine(local([run({})], run({})), TZ)).toBeNull();
    expect(discoveryUnavailableLine(local([run({})], { ...failed, failureCode: "VALIDATION_SCHEMA" }), TZ)).toBeNull();
  });
  it("keeps the Owner's AI discovery row current from the last success during an outage", () => {
    const staffing = { outlets: [{ outletId: "o-1", outletName: "Rosebank", timezone: TZ, localIntelligence: local([run({})], failed) }] } as unknown as WeeklyStaffing;
    const html = renderToStaticMarkup(OwnerLiveFeeds({ staffing, feeds: null, timeZone: TZ, eventsConfigured: false, now: new Date("2026-11-08T15:05:00Z") }));
    expect(html).toContain("AI search unavailable at");
    expect(html).toContain("Showing the last successful search");
    expect(html).toContain("Current");
  });
});
