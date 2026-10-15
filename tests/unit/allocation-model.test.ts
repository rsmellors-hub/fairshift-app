import { describe, expect, it } from "vitest";
import { allocationState, readOnlySchedulerConfig, toAllocationSchedule } from "@/app/manager/allocation-model";

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

  it("has a valid empty model and explicitly disables all scheduling mutation features", () => {
    expect(toAllocationSchedule([], null)).toEqual({ resources: [], events: [], assignments: [] });
    expect(readOnlySchedulerConfig.readOnly).toBe(true);
    expect(readOnlySchedulerConfig.enableDeleteKey).toBe(false);
    for (const feature of ["eventDrag", "eventResize", "eventDragCreate", "eventEdit", "eventMenu", "scheduleMenu"] as const) {
      expect(readOnlySchedulerConfig.features[feature]).toBe(false);
    }
    expect(readOnlySchedulerConfig).not.toHaveProperty("crudManager");
  });
});
