import { and, desc, eq } from "drizzle-orm";
import { toAllocationSchedule } from "@/app/manager/allocation-model";
import { DEMO_ORGANISATION_ID, DEMO_OUTLET_ID } from "@/server/constants";
import type { DatabaseSession } from "@/server/db/client";
import { outlets, shiftOffers, shifts, workers, workAllocations } from "@/server/db/schema";

export async function getAllocationSchedule(db: DatabaseSession) {
  const rows = await db.select({
    shiftId: shifts.id, offerId: shiftOffers.id, workerId: workers.id, workerName: workers.displayName,
    roleName: shifts.roleName, startsAt: shifts.startsAt, endsAt: shifts.endsAt,
    shiftStatus: shifts.status, offerStatus: shiftOffers.status, allocationStatus: workAllocations.state,
    guaranteedBasePayMinor: shifts.guaranteedBasePayMinor, currencyCode: shifts.currencyCode,
    earningsModel: shifts.earningsModel, commissionBps: shifts.commissionBps,
  }).from(shiftOffers)
    .innerJoin(shifts, eq(shiftOffers.shiftId, shifts.id))
    .innerJoin(workers, eq(shiftOffers.workerId, workers.id))
    .innerJoin(outlets, eq(shifts.outletId, outlets.id))
    .leftJoin(workAllocations, eq(workAllocations.offerId, shiftOffers.id))
    .where(and(eq(outlets.id, DEMO_OUTLET_ID), eq(outlets.organisationId, DEMO_ORGANISATION_ID),
      eq(workers.organisationId, DEMO_ORGANISATION_ID), eq(workers.locationId, DEMO_OUTLET_ID)))
    .orderBy(desc(shifts.startsAt));
  const team = await db.select({ id: workers.id, name: workers.displayName }).from(workers)
    .where(and(eq(workers.locationId, DEMO_OUTLET_ID), eq(workers.organisationId, DEMO_ORGANISATION_ID)));
  return toAllocationSchedule(rows, team);
}
