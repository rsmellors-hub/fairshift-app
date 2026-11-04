import { describe, expect, it } from "vitest";
import { allocationState, dropRule, FORECAST_RESOURCE, moveToDay, OPEN_PLACES_RESOURCE, REGULAR_RESOURCE, schedulerConfig, toAllocationSchedule, type PlanningRange } from "@/app/manager/allocation-model";

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

  it("has a valid empty model; the timeline can't create, delete or edit, and holds no server connection of its own", () => {
    expect(toAllocationSchedule([], null)).toEqual({ resources: [], events: [], assignments: [], timeRanges: [] });
    expect(schedulerConfig.enableDeleteKey).toBe(false);
    for (const feature of ["eventDragCreate", "eventEdit", "eventMenu", "scheduleMenu", "eventCopyPaste"] as const) expect(schedulerConfig.features[feature]).toBe(false);
    expect(schedulerConfig.features.resourceTimeRanges).toEqual({ enableMouseEvents: true });
    expect(schedulerConfig).not.toHaveProperty("crudManager");
  });
});

describe("what a drop on the timeline asks for", () => {
  const at = (day: string, from: string, to: string) => ({ startsAt: new Date(`${day}T${from}:00Z`), endsAt: new Date(`${day}T${to}:00Z`) });
  const offer = (over: Record<string, unknown> = {}) => ({ shiftId: "shift-a", offerId: "offer-a", workerId: "alex", workerName: "Alex", roleName: "Service", ...at("2026-11-06", "09", "17"),
    shiftStatus: "PUBLISHED", offerStatus: "OFFERED", guaranteedBasePayMinor: 12_000, currencyCode: "GBP", interaction: "MOVE_WITH_REACCEPTANCE" as const, ...over });
  const gap = (over: Record<string, unknown> = {}) => ({ shiftId: "shift-b", roleName: "Service", ...at("2026-11-05", "09", "17"), places: 1, unoffered: 1, termsVersion: 1, interaction: "MOVE" as const,
    currencyCode: "GBP", guaranteedBasePayMinor: 12_000, earningsModel: "HOURLY", commissionBps: null, bonusLabel: "No bonus on this shift", fillHref: "/manager/fill", ...over });
  const team = [{ id: "alex", name: "Alex" }, { id: "sam", name: "Sam" }];
  const unavailable: PlanningRange = { id: "u", resourceId: "sam", kind: "UNAVAILABLE", startDate: "2026-11-05T00:00:00.000Z", endDate: "2026-11-06T00:00:00.000Z", name: "Unavailable", cls: "range-unavailable", fillHref: null };
  const forecast: PlanningRange = { id: "f", resourceId: FORECAST_RESOURCE.id, kind: "FORECAST_OPEN", startDate: "2026-11-05T12:00:00.000Z", endDate: "2026-11-05T13:00:00.000Z", name: "1 h casual · up to 1", cls: "range-forecast-open", fillHref: "/manager/fill?date=2026-11-05" };

  it("orders FairShift's own rows first and keeps ranges off rows that aren't shown", () => {
    const schedule = toAllocationSchedule([offer()], team, [gap()], { planning: [forecast], unavailable: [unavailable, { ...unavailable, id: "x", resourceId: "someone-else" }] });
    expect(schedule.resources.map(row => row.id)).toEqual([FORECAST_RESOURCE.id, REGULAR_RESOURCE.id, OPEN_PLACES_RESOURCE.id, "alex", "sam"]);
    expect(schedule.timeRanges.map(range => range.id)).toEqual(["f", "u"]);
    expect(schedule.events.every(event => !event.id.startsWith("f") && !event.id.startsWith("u"))).toBe(true);
  });
  it("offers an open place to an available worker, and only that", () => {
    const schedule = toAllocationSchedule([offer()], team, [gap()], { unavailable: [] });
    const place = schedule.events.find(event => event.kind === "GAP")!;
    expect(dropRule(schedule, place, "alex")).toEqual({ action: "OFFER", workerId: "alex" });
    expect(dropRule(schedule, place, OPEN_PLACES_RESOURCE.id)).toEqual({ action: "MOVE" });
    for (const row of [FORECAST_RESOURCE.id, REGULAR_RESOURCE.id]) expect(dropRule(schedule, place, row)).toMatchObject({ action: "REFUSE" });
  });
  it("never moves a worker's shift to someone else", () => {
    const schedule = toAllocationSchedule([offer()], team, [], {});
    const theirs = schedule.events[0];
    expect(dropRule(schedule, theirs, "sam")).toEqual({ action: "REFUSE", message: "A shift can’t be moved to another worker. Each worker accepts their own offer." });
    expect(dropRule(schedule, theirs, "alex")).toEqual({ action: "MOVE" });
    const allocated = toAllocationSchedule([offer({ offerStatus: "ACCEPTED", allocationStatus: "ALLOCATED", interaction: "CHANGE_ONLY" })], team);
    expect(allocated.events[0]).toMatchObject({ draggable: false, timeMovable: false });
    expect(dropRule(allocated, allocated.events[0], "alex")).toMatchObject({ action: "REFUSE" });
  });
  it("refuses unavailable days, overlapping accepted work, a worker already offered and a shift with no unoffered place", () => {
    const schedule = toAllocationSchedule([offer({ shiftId: "shift-b", offerId: "offer-b" }), offer({ workerId: "sam", offerId: "offer-c", shiftId: "shift-c", offerStatus: "ACCEPTED", ...at("2026-11-05", "12", "20") })], team, [gap()], { unavailable: [unavailable] });
    const place = schedule.events.find(event => event.kind === "GAP")!;
    expect(dropRule(schedule, place, "alex")).toMatchObject({ action: "REFUSE", message: "This worker already has an offer for this shift." });
    expect(dropRule(schedule, place, "sam")).toMatchObject({ action: "REFUSE", message: "This worker has marked themselves unavailable for this shift." });
    expect(dropRule({ ...schedule, timeRanges: [] }, place, "sam")).toMatchObject({ action: "REFUSE", message: "This worker has accepted work that overlaps this shift." });
    const full = toAllocationSchedule([], team, [gap({ unoffered: 0 })]);
    expect(dropRule(full, full.events[0], "alex")).toMatchObject({ action: "REFUSE", message: "Every place on this shift already has a live offer." });
    // A shift with live offers can still be offered, but its time isn't dragged here.
    const live = toAllocationSchedule([], team, [gap({ interaction: "MOVE_WITH_REACCEPTANCE", unoffered: 1 })]);
    expect(live.events[0]).toMatchObject({ draggable: true, resizable: false, offerable: true, timeMovable: false });
    expect(dropRule(live, live.events[0], OPEN_PLACES_RESOURCE.id)).toMatchObject({ action: "REFUSE" });
    const closed = toAllocationSchedule([], team, [gap({ interaction: "LOCKED" })]);
    expect(closed.events[0]).toMatchObject({ draggable: false, offerable: false });
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
