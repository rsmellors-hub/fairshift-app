import { and, desc, eq } from "drizzle-orm";
import { toAllocationSchedule } from "@/app/manager/allocation-model";
import { DEMO_CASUAL_WORKER_ID, DEMO_ORGANISATION_ID, DEMO_OUTLET_ID } from "@/server/constants";
import type { DatabaseSession } from "@/server/db/client";
import { outlets, shiftOffers, shifts, workers } from "@/server/db/schema";

// Retain the existing pinned location/worker scope; route inputs cannot widen it.
// Project scheduling terms only, never payout destinations or provider diagnostics.
export async function getAllocationSchedule(db: DatabaseSession) {
  const rows = await db.select({
    shiftId: shifts.id, offerId: shiftOffers.id, workerId: workers.id, workerName: workers.displayName,
    roleName: shifts.roleName, startsAt: shifts.startsAt, endsAt: shifts.endsAt,
    shiftStatus: shifts.status, offerStatus: shiftOffers.status,
    guaranteedBasePayMinor: shifts.guaranteedBasePayMinor, currencyCode: shifts.currencyCode,
  }).from(shiftOffers)
    .innerJoin(shifts, eq(shiftOffers.shiftId, shifts.id))
    .innerJoin(workers, eq(shiftOffers.workerId, workers.id))
    .innerJoin(outlets, eq(shifts.outletId, outlets.id))
    .where(and(eq(outlets.id, DEMO_OUTLET_ID), eq(outlets.organisationId, DEMO_ORGANISATION_ID),
      eq(workers.organisationId, DEMO_ORGANISATION_ID), eq(workers.id, DEMO_CASUAL_WORKER_ID)))
    .orderBy(desc(shifts.startsAt));
  // No location membership table exists: only the established demo worker is in scope.
  const [worker] = await db.select({ id: workers.id, name: workers.displayName }).from(workers)
    .where(and(eq(workers.id, DEMO_CASUAL_WORKER_ID), eq(workers.organisationId, DEMO_ORGANISATION_ID))).limit(1);
  return toAllocationSchedule(rows, worker ?? null);
}
