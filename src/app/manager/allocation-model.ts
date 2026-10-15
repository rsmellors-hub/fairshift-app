export type AllocationRow = {
  shiftId: string; offerId: string; workerId: string; workerName: string;
  roleName: string; startsAt: Date; endsAt: Date; shiftStatus: string; offerStatus: string;
  allocationStatus?: string | null; earningsModel?: string; commissionBps?: number | null;
  guaranteedBasePayMinor: number; currencyCode: string;
};

export function allocationState(shiftStatus: string, offerStatus: string, allocationStatus?: string | null) {
  if (shiftStatus === "CANCELLED" || offerStatus === "CANCELLED") return "Cancelled";
  if (offerStatus === "DECLINED") return "Declined";
  if (offerStatus === "ACCEPTED") return shiftStatus === "COMPLETED" ? "Completed work" : allocationStatus === "ALLOCATED" ? "Allocated" : "Accepted · awaiting allocation";
  return "Offered · awaiting response";
}

export function toAllocationSchedule(rows: AllocationRow[], worker: { id: string; name: string } | { id: string; name: string }[] | null) {
  return {
    resources: Array.isArray(worker) ? worker : worker ? [worker] : [],
    events: rows.map((row) => ({
      id: row.offerId, name: `${row.roleName} · ${allocationState(row.shiftStatus, row.offerStatus, row.allocationStatus)}`,
      startDate: row.startsAt.toISOString(), endDate: row.endsAt.toISOString(),
      state: allocationState(row.shiftStatus, row.offerStatus, row.allocationStatus),
      eventColor: row.offerStatus === "ACCEPTED" ? row.shiftStatus === "COMPLETED" ? "gray" : "green" : "orange",
      roleName: row.roleName, workerName: row.workerName,
      earningsModel: row.earningsModel ?? "DAILY", commissionBps: row.commissionBps ?? null, guaranteedBasePayMinor: row.guaranteedBasePayMinor, currencyCode: row.currencyCode,
    })),
    // Offered relationships are shown for planning, not presented as accepted allocations.
    assignments: rows.map((row) => ({ id: row.offerId, eventId: row.offerId, resourceId: row.workerId })),
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
