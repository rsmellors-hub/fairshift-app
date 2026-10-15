export type AllocationRow = {
  shiftId: string; offerId: string; workerId: string; workerName: string;
  roleName: string; startsAt: Date; endsAt: Date; shiftStatus: string; offerStatus: string;
  guaranteedBasePayMinor: number; currencyCode: string;
};

export function allocationState(shiftStatus: string, offerStatus: string) {
  if (shiftStatus === "CANCELLED" || offerStatus === "CANCELLED") return "Cancelled";
  if (offerStatus === "DECLINED") return "Declined";
  if (offerStatus === "ACCEPTED") return shiftStatus === "COMPLETED" ? "Completed work" : "Accepted allocation";
  return "Offered · awaiting response";
}

export function toAllocationSchedule(rows: AllocationRow[], worker: { id: string; name: string } | null) {
  return {
    resources: worker ? [worker] : [],
    events: rows.map((row) => ({
      id: row.shiftId, name: `${row.roleName} · ${allocationState(row.shiftStatus, row.offerStatus)}`,
      startDate: row.startsAt.toISOString(), endDate: row.endsAt.toISOString(),
      state: allocationState(row.shiftStatus, row.offerStatus),
      eventColor: row.offerStatus === "ACCEPTED" ? row.shiftStatus === "COMPLETED" ? "gray" : "green" : "orange",
      roleName: row.roleName, workerName: row.workerName,
      guaranteedBasePayMinor: row.guaranteedBasePayMinor, currencyCode: row.currencyCode,
    })),
    // Offered relationships are shown for planning, not presented as accepted allocations.
    assignments: rows.map((row) => ({ id: row.offerId, eventId: row.shiftId, resourceId: row.workerId })),
  };
}

export type AllocationSchedule = ReturnType<typeof toAllocationSchedule>;

export const readOnlySchedulerConfig = {
  readOnly: true,
  enableDeleteKey: false,
  features: {
    eventDrag: false, eventResize: false, eventDragCreate: false, eventEdit: false,
    eventMenu: false, scheduleMenu: false, eventTooltip: false,
  },
} as const;
