import { describe, expect, it } from "vitest";
import type { scheduledJobs } from "@/server/db/schema";
import { isDue, JOBS, latestSlotStart } from "@/server/scheduler/feeds";

// AI discovery cadence (Owner decision, 8 November 2026): about 05:00 and about 17:00 South African
// time. South Africa keeps UTC+2 all year, so 05:00 SAST is 03:00 UTC and 17:00 SAST is 15:00 UTC.
const sast = (local: string) => new Date(`${local}+02:00`);
const daily = JOBS.find(job => job.key === "intel:daily")!;
const evening = JOBS.find(job => job.key === "intel:disruptions")!;
const row = (fields: Partial<typeof scheduledJobs.$inferSelect>): typeof scheduledJobs.$inferSelect =>
  ({ job: "intel:daily", leaseUntil: null, lastStartedAt: null, lastFinishedAt: null, lastSuccessAt: null, lastFailureCode: null, lastResult: {}, ...fields });

describe("AI discovery slots", () => {
  it("sets the full search at 05:00 and the short-notice check at 17:00, Johannesburg time", () => {
    expect(daily.slot).toMatchObject({ minute: 5 * 60, timeZone: "Africa/Johannesburg" });
    expect(evening.slot).toMatchObject({ minute: 17 * 60, timeZone: "Africa/Johannesburg" });
    expect(latestSlotStart(new Date("2026-11-09T03:00:00Z"), daily.slot!).toISOString()).toBe("2026-11-09T03:00:00.000Z");
    expect(latestSlotStart(new Date("2026-11-09T15:00:00Z"), evening.slot!).toISOString()).toBe("2026-11-09T15:00:00.000Z");
    expect(latestSlotStart(sast("2026-11-09T04:59:59"), daily.slot!)).toEqual(sast("2026-11-08T05:00:00"));
    expect(latestSlotStart(sast("2026-11-10T00:30:00"), evening.slot!)).toEqual(sast("2026-11-09T17:00:00"));
    // The weather, holiday and ECB feeds keep their own intervals.
    expect(JOBS.filter(job => job.slot).map(job => job.key)).toEqual(["intel:daily", "intel:disruptions"]);
  });

  it("runs a slot once, resumes a pass the server stopped, and lets a slot go after three hours", () => {
    expect(isDue(daily, undefined, sast("2026-11-09T05:00:00"))).toBe(true);
    expect(isDue(daily, undefined, sast("2026-11-09T08:00:00"))).toBe(true);
    expect(isDue(daily, undefined, sast("2026-11-09T08:00:01"))).toBe(false);
    expect(isDue(daily, undefined, sast("2026-11-09T04:59:00"))).toBe(false);

    const done = row({ lastStartedAt: sast("2026-11-09T05:00:05"), lastFinishedAt: sast("2026-11-09T05:04:00"), lastSuccessAt: sast("2026-11-09T05:04:00"), lastResult: { COMPLETED: 5, complete: true } });
    expect(isDue(daily, done, sast("2026-11-09T05:10:00"))).toBe(false);
    expect(isDue(daily, done, sast("2026-11-09T07:59:00"))).toBe(false);
    expect(isDue(daily, done, sast("2026-11-10T05:00:00"))).toBe(true);
    // Failed calls had their one retry inside the pass: the slot is still done.
    const failedCalls = row({ lastStartedAt: sast("2026-11-09T05:00:05"), lastFinishedAt: sast("2026-11-09T05:09:00"), lastFailureCode: "SOME_RUNS_FAILED", lastResult: { FAILED: 1, COMPLETED: 4, RETRIED: 1, complete: true } });
    expect(isDue(daily, failedCalls, sast("2026-11-09T06:00:00"))).toBe(false);
    // Started in this slot and never finished: the server stopped. Due again; the lease decides when.
    const stopped = row({ lastStartedAt: sast("2026-11-09T05:00:05"), lastFinishedAt: sast("2026-11-08T05:04:00") });
    expect(isDue(daily, stopped, sast("2026-11-09T05:30:00"))).toBe(true);
    // Cut short by an error: resumes after half an hour.
    const cutShort = row({ lastStartedAt: sast("2026-11-09T05:00:05"), lastFinishedAt: sast("2026-11-09T05:01:00"), lastFailureCode: "ERROR", lastResult: {} });
    expect(isDue(daily, cutShort, sast("2026-11-09T05:20:00"))).toBe(false);
    expect(isDue(daily, cutShort, sast("2026-11-09T05:31:00"))).toBe(true);
  });
});
