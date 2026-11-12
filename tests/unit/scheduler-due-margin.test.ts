import { describe, expect, it } from "vitest";
import { DUE_MARGIN_MS, isDue, JOBS } from "@/server/scheduler/feeds";

// 12 Nov 2026: payouts:refresh (every 10 minutes) last succeeded at 12:17:41 after starting at 12:17:40;
// the next tick at 12:27:40 found it 9 min 59 s old, not due, so it ran every 20 minutes. A job is now
// due within a minute of its interval, still measured from its last success; a failure's retry pause is
// unchanged.
const MINUTE = 60_000;
const refresh = JOBS.find(job => job.key === "payouts:refresh")!;
const success = new Date("2026-11-12T10:17:41Z");
const row = (over: Record<string, unknown> = {}) => ({ job: "payouts:refresh", leaseUntil: null, lastStartedAt: new Date("2026-11-12T10:17:40Z"), lastFinishedAt: success, lastSuccessAt: success, lastFailureCode: null, lastResult: {}, ...over });

describe("interval jobs are due at the next 10-minute tick", () => {
  it("runs a 10-minute job at the tick one second short of its interval", () => {
    expect(refresh.intervalMs).toBe(10 * MINUTE);
    expect(isDue(refresh, row(), new Date("2026-11-12T10:27:40Z"))).toBe(true);
  });
  it("is still not due earlier than the margin", () => {
    expect(isDue(refresh, row(), new Date(success.getTime() + 10 * MINUTE - DUE_MARGIN_MS - 1_000))).toBe(false);
    expect(isDue(refresh, row(), new Date(success.getTime() + 5 * MINUTE))).toBe(false);
  });
  it("keeps a failed job's retry pause, margin or not", () => {
    const failed = row({ lastFailureCode: "SOME_READS_FAILED", lastFinishedAt: success, lastSuccessAt: new Date(success.getTime() - 60 * MINUTE) });
    expect(isDue(refresh, failed, new Date(success.getTime() + refresh.retryMs - 1_000))).toBe(false);
    expect(isDue(refresh, failed, new Date(success.getTime() + refresh.retryMs))).toBe(true);
  });
});
