import { describe, expect, it } from "vitest";
import { allocationState, moveToDay, schedulerConfig, toAllocationSchedule } from "@/app/manager/allocation-model";

describe("Scheduler presentation contract", () => {
  it("maps persisted identities, times, terms and offer relationships without inventing allocations", () => {
    const schedule = toAllocationSchedule([{
      shiftId: "shift", offerId: "offer", workerId: "worker", workerName: "Alex",
      roleName: "Service", startsAt: new Date("2026-10-16T06:00:00Z"), endsAt: new Date("2026-10-16T14:00:00Z"),
      shiftStatus: "PUBLISHED", offerStatus: "OFFERED", guaranteedBasePayMinor: 12000, currencyCode: "USD",
    }], { id: "worker", name: "Alex" });
    expect(schedule.resources).toEqual([{ id: "worker", name: "Alex" }]);
    expect(schedule.events[0]).toMatchObject({ id: "offer", startDate: "2026-10-16T06:00:00.000Z", endDate: "2026-10-16T14:00:00.000Z", state: "Offered · awaiting response", guaranteedBasePayMinor: 12000 });
    expect(schedule.assignments).toEqual([{ id: "offer", eventId: "offer", resourceId: "worker" }]);
    expect(JSON.parse(JSON.stringify(schedule))).toEqual(schedule);
  });

  it("distinguishes offer, acceptance, completion, decline and cancellation", () => {
    expect(allocationState("PUBLISHED", "OFFERED")).toBe("Offered · awaiting response");
    expect(allocationState("PUBLISHED", "ACCEPTED")).toBe("Accepted · awaiting allocation");
    expect(allocationState("COMPLETED", "ACCEPTED")).toBe("Completed work");
    expect(allocationState("PUBLISHED", "DECLINED")).toBe("Declined");
    expect(allocationState("CANCELLED", "ACCEPTED")).toBe("Cancelled");
  });

  it("has a valid empty model; the timeline can't create, delete, edit or reassign, and holds no server connection of its own", () => {
    expect(toAllocationSchedule([], null)).toEqual({ resources: [], events: [], assignments: [] });
    expect(schedulerConfig.enableDeleteKey).toBe(false);
    expect(schedulerConfig.features.eventDrag.constrainDragToResource).toBe(true);
    for (const feature of ["eventDragCreate", "eventEdit", "eventMenu", "scheduleMenu", "eventCopyPaste"] as const) expect(schedulerConfig.features[feature]).toBe(false);
    expect(schedulerConfig).not.toHaveProperty("crudManager");
  });
});

describe("moving a shift to another day in the week view", () => {
  const shift = { startDate: "2026-11-05T09:00:00.000Z", endDate: "2026-11-05T17:00:00.000Z" };
  it("keeps the shift's own hours, not the midnight the timeline snapped to", () => {
    expect(moveToDay(shift, "2026-11-06", "Europe/London")).toEqual({ startsAt: "2026-11-06T09:00", endsAt: "2026-11-06T17:00" });
  });
  it("reads the hours at the location, whatever the browser's time zone", () => {
    expect(moveToDay(shift, "2026-11-06", "Africa/Johannesburg")).toEqual({ startsAt: "2026-11-06T11:00", endsAt: "2026-11-06T19:00" });
  });
  it("keeps the same wall-clock hours across a clock change", () => {
    expect(moveToDay({ startDate: "2027-03-27T09:00:00.000Z", endDate: "2027-03-27T17:00:00.000Z" }, "2027-03-29", "Europe/London")).toEqual({ startsAt: "2027-03-29T09:00", endsAt: "2027-03-29T17:00" });
  });
  it("keeps an overnight shift overnight, across a month end", () => {
    expect(moveToDay({ startDate: "2026-11-05T22:00:00.000Z", endDate: "2026-11-06T04:00:00.000Z" }, "2026-11-30", "Europe/London")).toEqual({ startsAt: "2026-11-30T22:00", endsAt: "2026-12-01T04:00" });
  });
});
