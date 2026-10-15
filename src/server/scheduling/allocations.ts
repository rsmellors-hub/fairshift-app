import type { Scope } from "@/server/auth/access";
import { and, desc, eq } from "drizzle-orm";
import { toAllocationSchedule } from "@/app/manager/allocation-model";
import { DEMO_ORGANISATION_ID, DEMO_OUTLET_ID } from "@/server/constants";
import type { DatabaseSession } from "@/server/db/client";
import { outlets, shiftOffers, shifts, workers, workAllocations } from "@/server/db/schema";

export async function getAllocationSchedule(db: DatabaseSession, scope:Pick<Scope,"organisationId"|"locationId"> = {organisationId:DEMO_ORGANISATION_ID,locationId:DEMO_OUTLET_ID}) {
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
    .where(and(eq(outlets.id, scope.locationId), eq(outlets.organisationId, scope.organisationId),
      eq(workers.organisationId, scope.organisationId), eq(workers.locationId, scope.locationId)))
    .orderBy(desc(shifts.startsAt));
  const team = await db.select({ id: workers.id, name: workers.displayName }).from(workers)
    .where(and(eq(workers.locationId, scope.locationId), eq(workers.organisationId, scope.organisationId)));
  return toAllocationSchedule(rows, team);
}
