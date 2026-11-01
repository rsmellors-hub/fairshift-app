import type { ShiftInteraction } from "@/server/domain/shift-change";

export type AllocationRow = {
  shiftId: string; offerId: string; workerId: string; workerName: string;
  roleName: string; startsAt: Date; endsAt: Date; shiftStatus: string; offerStatus: string;
  allocationStatus?: string | null; earningsModel?: string; commissionBps?: number | null;
  guaranteedBasePayMinor: number; currencyCode: string;
  termsVersion?: number; interaction?: ShiftInteraction;
  bonusLabel?: string; performanceLabel?: string; paymentLabel?: string;
};
export type ShiftGap = { shiftId: string; roleName: string; startsAt: Date; endsAt: Date; places: number; termsVersion: number; interaction: ShiftInteraction; currencyCode: string; guaranteedBasePayMinor: number; earningsModel: string; commissionBps: number | null; bonusLabel: string; fillHref: string };

// A row for capacity no worker holds yet. It is FairShift's own, not a worker.
export const OPEN_PLACES_RESOURCE = { id: "open-places", name: "Places to fill" };

export function allocationState(shiftStatus: string, offerStatus: string, allocationStatus?: string | null) {
  if (shiftStatus === "CANCELLED" || offerStatus === "CANCELLED") return "Cancelled";
  if (offerStatus === "DECLINED") return "Declined";
  if (offerStatus === "ACCEPTED") return shiftStatus === "COMPLETED" ? "Completed work" : allocationStatus === "ALLOCATED" ? "Allocated" : "Accepted · awaiting allocation";
  return allocationStatus === "REACCEPTANCE_REQUIRED" ? "Changed · awaiting new acceptance" : "Offered · awaiting response";
}

const colour = (state: string) => state === "Allocated" ? "green" : state === "Completed work" || state === "Declined" || state === "Cancelled" ? "gray" : state.startsWith("Accepted") ? "blue" : "orange";

export function toAllocationSchedule(rows: AllocationRow[], worker: { id: string; name: string } | { id: string; name: string }[] | null, gaps: ShiftGap[] = []) {
  const team = Array.isArray(worker) ? worker : worker ? [worker] : [];
  const workerEvents = rows.map((row) => {
    const state = allocationState(row.shiftStatus, row.offerStatus, row.allocationStatus);
    // Only live offers can be moved from a worker's row; the server decides again on every change.
    const live = row.offerStatus === "OFFERED" || row.offerStatus === "ACCEPTED";
    const movable = live && (row.interaction === "MOVE" || row.interaction === "MOVE_WITH_REACCEPTANCE");
    return {
      id: row.offerId, shiftId: row.shiftId, kind: "OFFER" as const, name: `${row.roleName} · ${state}`,
      startDate: row.startsAt.toISOString(), endDate: row.endsAt.toISOString(),
      state, eventColor: colour(state), draggable: movable, resizable: movable,
      roleName: row.roleName, workerName: row.workerName,
      earningsModel: row.earningsModel ?? "DAILY", commissionBps: row.commissionBps ?? null, guaranteedBasePayMinor: row.guaranteedBasePayMinor, currencyCode: row.currencyCode,
      termsVersion: row.termsVersion ?? 1, interaction: (live ? row.interaction ?? "LOCKED" : "LOCKED") as ShiftInteraction,
      bonusLabel: row.bonusLabel ?? "No bonus on this shift", performanceLabel: row.performanceLabel ?? "Not applicable", paymentLabel: row.paymentLabel ?? "Not yet payable", fillHref: null as string | null,
    };
  });
  const gapEvents = gaps.map((gap) => {
    const movable = gap.interaction === "MOVE";
    const state = `${gap.places} ${gap.places === 1 ? "place" : "places"} to fill`;
    return {
      id: `gap:${gap.shiftId}`, shiftId: gap.shiftId, kind: "GAP" as const, name: `${gap.roleName} · ${state}`,
      startDate: gap.startsAt.toISOString(), endDate: gap.endsAt.toISOString(),
      state, eventColor: "red", draggable: movable, resizable: movable,
      roleName: gap.roleName, workerName: "Not yet filled",
      earningsModel: gap.earningsModel, commissionBps: gap.commissionBps, guaranteedBasePayMinor: gap.guaranteedBasePayMinor, currencyCode: gap.currencyCode,
      termsVersion: gap.termsVersion, interaction: gap.interaction,
      bonusLabel: gap.bonusLabel, performanceLabel: "Not applicable", paymentLabel: "Not yet payable", fillHref: gap.fillHref as string | null,
    };
  });
  return {
    resources: gapEvents.length ? [OPEN_PLACES_RESOURCE, ...team] : team,
    events: [...workerEvents, ...gapEvents],
    // Offered relationships are shown for planning, not presented as accepted allocations.
    assignments: [
      ...rows.map((row) => ({ id: row.offerId, eventId: row.offerId, resourceId: row.workerId })),
      ...gapEvents.map((event) => ({ id: event.id, eventId: event.id, resourceId: OPEN_PLACES_RESOURCE.id })),
    ],
  };
}

export type AllocationSchedule = ReturnType<typeof toAllocationSchedule>;
export type ScheduleEvent = AllocationSchedule["events"][number];

// Times can move along a row. A worker can't be swapped by dragging, because each worker
// accepts their own offer, and nothing is created or deleted from the timeline.
export const schedulerConfig = {
  enableDeleteKey: false,
  features: {
    eventDrag: { constrainDragToResource: true }, eventResize: true, eventDragCreate: false, eventEdit: false,
    eventMenu: false, scheduleMenu: false, eventTooltip: false, eventCopyPaste: false,
  },
} as const;

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
