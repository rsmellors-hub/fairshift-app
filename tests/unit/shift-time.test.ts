import { afterEach, describe, expect, it } from "vitest";
import { localDateTimeToInstant, LocalTimeError } from "@/server/domain/timezone";
import { availabilityForShift, isOfferable, shiftWeekdays, workerOpportunityState } from "@/server/scheduling/worker-pool";

const iso = (value: string, zone: string) => localDateTimeToInstant(value, zone).toISOString();
const problem = (value: string, zone: string) => { try { localDateTimeToInstant(value, zone); return null; } catch (error) { return error instanceof LocalTimeError ? error.problem : "OTHER"; } };

describe("work location time", () => {
  const originalTz = process.env.TZ;
  afterEach(() => { process.env.TZ = originalTz; });

  it("reads wall-clock time in the location's zone, in winter and summer", () => {
    expect(iso("2026-01-15T10:00", "Europe/London")).toBe("2026-01-15T10:00:00.000Z"); // GMT
    expect(iso("2026-07-15T10:00", "Europe/London")).toBe("2026-07-15T09:00:00.000Z"); // BST
    expect(iso("2026-01-15T10:00", "Africa/Johannesburg")).toBe("2026-01-15T08:00:00.000Z");
    expect(iso("2026-07-15T10:00", "Africa/Johannesburg")).toBe("2026-07-15T08:00:00.000Z");
    expect(iso("2026-07-15T10:00", "America/New_York")).toBe("2026-07-15T14:00:00.000Z");
  });
  it("does not depend on the server's time zone", () => {
    for (const tz of ["Asia/Tokyo", "America/Los_Angeles", "UTC", "Africa/Johannesburg"]) {
      process.env.TZ = tz;
      expect(iso("2026-07-15T10:00", "Europe/London")).toBe("2026-07-15T09:00:00.000Z");
      expect(iso("2026-01-15T22:30", "Africa/Johannesburg")).toBe("2026-01-15T20:30:00.000Z");
    }
  });
  it("handles shifts crossing midnight and each side of a clock change", () => {
    const start = localDateTimeToInstant("2026-07-15T22:00", "Europe/London"), end = localDateTimeToInstant("2026-07-16T06:00", "Europe/London");
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(8);
    expect(iso("2026-03-29T00:30", "Europe/London")).toBe("2026-03-29T00:30:00.000Z"); // before the change
    expect(iso("2026-03-29T02:30", "Europe/London")).toBe("2026-03-29T01:30:00.000Z"); // after it
    // Across the night the clocks go back, ten wall-clock hours are eleven real hours.
    const a = localDateTimeToInstant("2026-10-24T22:00", "Europe/London"), b = localDateTimeToInstant("2026-10-25T08:00", "Europe/London");
    expect((b.getTime() - a.getTime()) / 3_600_000).toBe(11);
  });
  it("refuses times the clocks skip or repeat, rather than guessing", () => {
    expect(problem("2026-03-29T01:30", "Europe/London")).toBe("NONEXISTENT");
    expect(problem("2026-10-25T01:30", "Europe/London")).toBe("AMBIGUOUS");
    expect(problem("2026-03-29T01:30", "Africa/Johannesburg")).toBeNull(); // no clock change there
  });
  it("refuses malformed dates, impossible dates and unknown zones, with no default", () => {
    for (const value of ["", "soon", "2026-07-15", "2026-07-15 10:00", "2026-07-15T10:00:00", "2026-07-15T10:00+02:00", "2026-07-15T10:00Z", "2026-02-31T10:00", "2026-13-01T10:00", "2026-07-15T24:00", "2026-07-15T10:60"]) expect(problem(value, "Europe/London")).toBe("INVALID");
    for (const zone of ["", "Mars/Olympus", "London"]) expect(problem("2026-07-15T10:00", zone)).toBe("UNKNOWN_TIMEZONE");
  });
});

describe("worker pool rule", () => {
  const stated = (entries: [number, string][]) => new Map(entries);
  const shift = (start: string, end: string) => ({ startsAt: new Date(start), endsAt: new Date(end) });

  it("finds the local weekdays a shift touches, in the location's zone", () => {
    expect(shiftWeekdays(shift("2026-07-13T09:00:00Z", "2026-07-13T17:00:00Z"), "Europe/London")).toEqual([1]);
    // 22:00 Monday to 06:00 Tuesday, London time.
    expect(shiftWeekdays(shift("2026-07-13T21:00:00Z", "2026-07-14T05:00:00Z"), "Europe/London")).toEqual([1, 2]);
    // Ending exactly at midnight does not touch the next day.
    expect(shiftWeekdays(shift("2026-07-13T15:00:00Z", "2026-07-13T23:00:00Z"), "Europe/London")).toEqual([1]);
    // The same instant is a different local day elsewhere.
    expect(shiftWeekdays(shift("2026-07-13T23:30:00Z", "2026-07-14T00:30:00Z"), "Africa/Johannesburg")).toEqual([2]);
  });
  it("separates stated available, stated unavailable and not provided", () => {
    expect(availabilityForShift(stated([[1, "AVAILABLE"]]), [1])).toBe("AVAILABLE");
    expect(availabilityForShift(stated([[1, "UNAVAILABLE"]]), [1])).toBe("UNAVAILABLE");
    expect(availabilityForShift(stated([]), [1])).toBe("AVAILABILITY_NOT_PROVIDED");
    expect(availabilityForShift(stated([[2, "AVAILABLE"]]), [1])).toBe("AVAILABILITY_NOT_PROVIDED");
    // A shift across midnight is blocked by either day, and available only if both are.
    expect(availabilityForShift(stated([[1, "AVAILABLE"], [2, "UNAVAILABLE"]]), [1, 2])).toBe("UNAVAILABLE");
    expect(availabilityForShift(stated([[1, "AVAILABLE"]]), [1, 2])).toBe("AVAILABILITY_NOT_PROVIDED");
    expect(availabilityForShift(stated([[1, "AVAILABLE"], [2, "AVAILABLE"]]), [1, 2])).toBe("AVAILABLE");
  });
  it("gives one clear state, and only available or not-provided workers can be offered", () => {
    const base = { active: true, activated: true, conflict: false, availability: "AVAILABLE" as const };
    expect(workerOpportunityState(base)).toBe("AVAILABLE");
    expect(workerOpportunityState({ ...base, availability: "AVAILABILITY_NOT_PROVIDED" })).toBe("AVAILABILITY_NOT_PROVIDED");
    expect(workerOpportunityState({ ...base, availability: "UNAVAILABLE" })).toBe("UNAVAILABLE");
    expect(workerOpportunityState({ ...base, conflict: true })).toBe("ALREADY_WORKING");
    expect(workerOpportunityState({ ...base, activated: false })).toBe("AWAITING_ACTIVATION");
    expect(workerOpportunityState({ ...base, active: false })).toBe("INACTIVE");
    expect((["AVAILABLE", "AVAILABILITY_NOT_PROVIDED", "UNAVAILABLE", "ALREADY_WORKING", "AWAITING_ACTIVATION", "INACTIVE"] as const).filter(isOfferable)).toEqual(["AVAILABLE", "AVAILABILITY_NOT_PROVIDED"]);
  });
});
