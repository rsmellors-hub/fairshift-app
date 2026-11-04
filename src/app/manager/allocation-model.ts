import type { ShiftInteraction } from "@/server/domain/shift-change";

export type AllocationRow = {
  shiftId: string; offerId: string; workerId: string; workerName: string;
  roleName: string; startsAt: Date; endsAt: Date; shiftStatus: string; offerStatus: string;
  allocationStatus?: string | null; earningsModel?: string; commissionBps?: number | null;
  guaranteedBasePayMinor: number; currencyCode: string;
  termsVersion?: number; interaction?: ShiftInteraction;
  bonusLabel?: string; performanceLabel?: string; paymentLabel?: string;
};
export type ShiftGap = { shiftId: string; roleName: string; startsAt: Date; endsAt: Date; places: number; unoffered?: number; termsVersion: number; interaction: ShiftInteraction; currencyCode: string; guaranteedBasePayMinor: number; earningsModel: string; commissionBps: number | null; bonusLabel: string; fillHref: string };

// A row for capacity no worker holds yet. It is FairShift's own, not a worker.
export const OPEN_PLACES_RESOURCE = { id: "open-places", name: "Places to fill" };
// Rows for the planning week's calculated staffing: what the forecast asks for beyond regular
// cover, and the regular cover itself. They hold background ranges only, never a shift.
export const FORECAST_RESOURCE = { id: "forecast-need", name: "Forecast casual need" };
export const REGULAR_RESOURCE = { id: "regular-cover", name: "Regular staff" };
const PLANNING_ROWS = new Set([FORECAST_RESOURCE.id, REGULAR_RESOURCE.id, OPEN_PLACES_RESOURCE.id]);

// A background range on one row, drawn by Bryntum's resource time ranges. It is never an event,
// so it can't be dragged, resized or allocated: it shows what FairShift calculated or was told.
export type PlanningRange = {
  id: string; resourceId: string; startDate: string; endDate: string; name: string; cls: string;
  kind: "FORECAST_OPEN" | "FORECAST_FILLED" | "REGULAR" | "UNAVAILABLE";
  // An open forecast window links to the existing Fill flow, which re-reads the window on the server.
  fillHref: string | null;
};

export function allocationState(shiftStatus: string, offerStatus: string, allocationStatus?: string | null) {
  if (shiftStatus === "CANCELLED" || offerStatus === "CANCELLED") return "Cancelled";
  if (offerStatus === "DECLINED") return "Declined";
  if (offerStatus === "ACCEPTED") return shiftStatus === "COMPLETED" ? "Completed work" : allocationStatus === "ALLOCATED" ? "Allocated" : "Accepted · awaiting allocation";
  return allocationStatus === "REACCEPTANCE_REQUIRED" ? "Changed · awaiting new acceptance" : "Offered · awaiting response";
}

const colour = (state: string) => state === "Allocated" ? "green" : state === "Completed work" || state === "Declined" || state === "Cancelled" ? "gray" : state.startsWith("Accepted") ? "blue" : "orange";

export function toAllocationSchedule(rows: AllocationRow[], worker: { id: string; name: string } | { id: string; name: string }[] | null, gaps: ShiftGap[] = [], ranges: { planning?: PlanningRange[]; unavailable?: PlanningRange[] } = {}) {
  const team = Array.isArray(worker) ? worker : worker ? [worker] : [];
  const planning = ranges.planning ?? [];
  const workerEvents = rows.map((row) => {
    const state = allocationState(row.shiftStatus, row.offerStatus, row.allocationStatus);
    // Only live offers can be moved from a worker's row; the server decides again on every change.
    const live = row.offerStatus === "OFFERED" || row.offerStatus === "ACCEPTED";
    const movable = live && (row.interaction === "MOVE" || row.interaction === "MOVE_WITH_REACCEPTANCE");
    return {
      id: row.offerId, shiftId: row.shiftId, kind: "OFFER" as const, rowId: row.workerId, name: `${row.roleName} · ${state}`,
      startDate: row.startsAt.toISOString(), endDate: row.endsAt.toISOString(),
      state, eventColor: colour(state), draggable: movable, resizable: movable, timeMovable: movable, offerable: false,
      roleName: row.roleName, workerName: row.workerName,
      earningsModel: row.earningsModel ?? "DAILY", commissionBps: row.commissionBps ?? null, guaranteedBasePayMinor: row.guaranteedBasePayMinor, currencyCode: row.currencyCode,
      termsVersion: row.termsVersion ?? 1, interaction: (live ? row.interaction ?? "LOCKED" : "LOCKED") as ShiftInteraction,
      bonusLabel: row.bonusLabel ?? "No bonus on this shift", performanceLabel: row.performanceLabel ?? "Not applicable", paymentLabel: row.paymentLabel ?? "Not yet payable", fillHref: null as string | null,
    };
  });
  const gapEvents = gaps.map((gap) => {
    const movable = gap.interaction === "MOVE";
    // Dragging an open place onto a worker sends that worker an offer, never an allocation.
    // Only places nobody holds a live offer for can be offered, as on Fill shifts.
    const offerable = gap.interaction !== "LOCKED" && (gap.unoffered ?? 0) > 0;
    const state = `${gap.places} ${gap.places === 1 ? "place" : "places"} to fill`;
    return {
      id: `gap:${gap.shiftId}`, shiftId: gap.shiftId, kind: "GAP" as const, rowId: OPEN_PLACES_RESOURCE.id, name: `${gap.roleName} · ${state}`,
      startDate: gap.startsAt.toISOString(), endDate: gap.endsAt.toISOString(),
      state, eventColor: "red", draggable: movable || offerable, resizable: movable, timeMovable: movable, offerable,
      roleName: gap.roleName, workerName: "Not yet filled",
      earningsModel: gap.earningsModel, commissionBps: gap.commissionBps, guaranteedBasePayMinor: gap.guaranteedBasePayMinor, currencyCode: gap.currencyCode,
      termsVersion: gap.termsVersion, interaction: gap.interaction,
      bonusLabel: gap.bonusLabel, performanceLabel: "Not applicable", paymentLabel: "Not yet payable", fillHref: gap.fillHref as string | null,
    };
  });
  const teamIds = new Set(team.map(row => row.id));
  return {
    resources: [...(planning.length ? [FORECAST_RESOURCE, REGULAR_RESOURCE] : []), ...(gapEvents.length ? [OPEN_PLACES_RESOURCE] : []), ...team],
    events: [...workerEvents, ...gapEvents],
    // Offered relationships are shown for planning, not presented as accepted allocations.
    assignments: [
      ...rows.map((row) => ({ id: row.offerId, eventId: row.offerId, resourceId: row.workerId })),
      ...gapEvents.map((event) => ({ id: event.id, eventId: event.id, resourceId: OPEN_PLACES_RESOURCE.id })),
    ],
    // Background ranges: forecast need and regular cover on their own rows, and each worker's
    // stated unavailability on their row. A range for a row that isn't shown is dropped.
    timeRanges: [...planning, ...(ranges.unavailable ?? []).filter(range => teamIds.has(range.resourceId))],
  };
}

export type AllocationSchedule = ReturnType<typeof toAllocationSchedule>;
export type ScheduleEvent = AllocationSchedule["events"][number];

// Times can move along a row. Rows are never swapped: each worker accepts their own offer.
// The one move between rows is an open place dropped on a worker, which asks the server to
// send that worker an offer; see dropRule. Nothing is created or deleted from the timeline.
export const schedulerConfig = {
  enableDeleteKey: false,
  features: {
    eventDrag: { constrainDragToResource: false }, eventResize: true, eventDragCreate: false, eventEdit: false,
    eventMenu: false, scheduleMenu: false, eventTooltip: false, eventCopyPaste: false,
    resourceTimeRanges: { enableMouseEvents: true },
  },
} as const;

export type DropDecision = { action: "MOVE" } | { action: "OFFER"; workerId: string } | { action: "REFUSE"; message: string };
const overlaps = (a: { startDate: string; endDate: string }, b: { startDate: string; endDate: string }) => Date.parse(a.startDate) < Date.parse(b.endDate) && Date.parse(a.endDate) > Date.parse(b.startDate);

// What a drop on the timeline asks for. It only chooses which server request to make, and
// gives early feedback from what the page already shows: the server checks everything again,
// including pay terms and the worker's account, and its answer replaces the timeline.
export function dropRule(schedule: Pick<AllocationSchedule, "events" | "timeRanges">, event: ScheduleEvent, toRowId: string): DropDecision {
  if (toRowId === event.rowId) return event.timeMovable ? { action: "MOVE" } : { action: "REFUSE", message: event.kind === "GAP" ? "Offers are live on this shift, so its time can’t be dragged here. Use Change shift." : "This shift’s time can’t be dragged." };
  if (event.kind !== "GAP") return { action: "REFUSE", message: "A shift can’t be moved to another worker. Each worker accepts their own offer." };
  if (PLANNING_ROWS.has(toRowId)) return { action: "REFUSE", message: "Drop an open place on a worker to offer it to them." };
  if (!event.offerable) return { action: "REFUSE", message: "Every place on this shift already has a live offer." };
  const theirs = schedule.events.filter(row => row.kind === "OFFER" && row.rowId === toRowId);
  if (theirs.some(row => row.shiftId === event.shiftId)) return { action: "REFUSE", message: "This worker already has an offer for this shift." };
  if (schedule.timeRanges.some(range => range.kind === "UNAVAILABLE" && range.resourceId === toRowId && overlaps(range, event))) return { action: "REFUSE", message: "This worker has marked themselves unavailable for this shift." };
  if (theirs.some(row => (row.state.startsWith("Accepted") || row.state === "Allocated") && overlaps(row, event))) return { action: "REFUSE", message: "This worker has accepted work that overlaps this shift." };
  return { action: "OFFER", workerId: toRowId };
}

const wallClockParts = (iso: string, timeZone: string) => Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso)).map(part => [part.type, part.value]));
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000;
const dayFromNumber = (value: number) => new Date(value * 86_400_000).toISOString().slice(0, 10);

// A week view can only show which day a shift landed on: its pixels are too coarse to set a
// time, and the timeline snaps to midnight. So moving by day keeps the shift's own clock
// times at the location, whatever the clocks do that day, and an overnight shift stays one.
export function moveToDay(event: { startDate: string; endDate: string }, day: string, timeZone: string) {
  const start = wallClockParts(event.startDate, timeZone), end = wallClockParts(event.endDate, timeZone);
  const span = dayNumber(`${end.year}-${end.month}-${end.day}`) - dayNumber(`${start.year}-${start.month}-${start.day}`);
  return { startsAt: `${day}T${start.hour}:${start.minute}`, endsAt: `${dayFromNumber(dayNumber(day) + span)}T${end.hour}:${end.minute}` };
}
