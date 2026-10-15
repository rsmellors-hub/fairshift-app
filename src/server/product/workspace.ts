import type { Scope } from "@/server/auth/access";
import { and, desc, eq } from "drizzle-orm";

import { DEMO_CASUAL_WORKER_ID, DEMO_ORGANISATION_ID, DEMO_OUTLET_ID } from "@/server/constants";
import type { DatabaseSession } from "@/server/db/client";
import { outlets, saleTransactions, shiftIncentives, shiftOffers, shifts, workers, workAllocations, departments } from "@/server/db/schema";
import { getDemoWorkerShift } from "@/server/scheduling/demo";

// These workspaces retain the existing server-pinned environment scope.
// Client route parameters select presentation only, never an organisation or worker.
export async function getLocationWorkspace(db: DatabaseSession) {
  const current = await getDemoWorkerShift(db);
  const assignments = await db.select({ shift: shifts, offer: shiftOffers, incentive: shiftIncentives, workerName: workers.displayName })
    .from(shiftOffers)
    .innerJoin(shifts, eq(shiftOffers.shiftId, shifts.id))
    .innerJoin(workers, eq(shiftOffers.workerId, workers.id))
    .leftJoin(shiftIncentives, and(eq(shiftIncentives.shiftId, shifts.id), eq(shiftIncentives.workerId, workers.id)))
    .where(and(eq(shifts.outletId, DEMO_OUTLET_ID), eq(workers.organisationId, DEMO_ORGANISATION_ID), eq(workers.locationId, DEMO_OUTLET_ID)))
    .orderBy(desc(shifts.shiftDate), desc(shifts.createdAt));
  const [worker] = await db.select().from(workers).where(and(
    eq(workers.id, DEMO_CASUAL_WORKER_ID), eq(workers.organisationId, DEMO_ORGANISATION_ID),
  )).limit(1);
  return { current, assignments, worker: worker ?? null };
}

export async function getWorkerWorkspace(db: DatabaseSession, scope:Pick<Scope,"organisationId"|"locationId"|"workerId"> = {organisationId:DEMO_ORGANISATION_ID,locationId:DEMO_OUTLET_ID,workerId:DEMO_CASUAL_WORKER_ID}) {
  const [profile] = await db.select({ displayName: workers.displayName, paypalPayoutEmail: workers.paypalPayoutEmail, attributionCode: workers.attributionCode })
    .from(workers).where(and(eq(workers.id, scope.workerId ?? "00000000-0000-0000-0000-000000000000"), eq(workers.organisationId, scope.organisationId))).limit(1);
  // Deliberately exclude team revenue, transaction data, provider IDs and other workers.
  const assignments = await db.select({
    shift: shifts, offer: shiftOffers, allocation: workAllocations, departmentName: departments.name,
    incentive: {
      id: shiftIncentives.id, status: shiftIncentives.status, earnedAmountMinor: shiftIncentives.earnedAmountMinor,
      approvedAt: shiftIncentives.approvedAt, paidAt: shiftIncentives.paidAt,
    },
  }).from(shiftOffers)
    .innerJoin(shifts, eq(shiftOffers.shiftId, shifts.id))
    .leftJoin(workAllocations, eq(workAllocations.offerId, shiftOffers.id))
    .leftJoin(departments, eq(departments.id, shifts.departmentId))
    .innerJoin(workers, eq(shiftOffers.workerId, workers.id))
    .leftJoin(shiftIncentives, and(eq(shiftIncentives.shiftId, shifts.id), eq(shiftIncentives.workerId, workers.id)))
    .where(and(eq(workers.id, scope.workerId ?? "00000000-0000-0000-0000-000000000000"), eq(workers.organisationId, scope.organisationId), eq(shifts.outletId, scope.locationId)))
    .orderBy(desc(shifts.shiftDate), desc(shifts.createdAt));
  const current = scope.workerId === DEMO_CASUAL_WORKER_ID ? await getDemoWorkerShift(db) : null;
  return { profile: profile ?? null, assignments, currentShiftId: current?.shift.id ?? null };
}

export async function getOwnerWorkspace(db: DatabaseSession, organisationId = DEMO_ORGANISATION_ID) {
  const locations = await db.select().from(outlets).where(eq(outlets.organisationId, organisationId));
  const sales = await db.select({ outletId: outlets.id, source: saleTransactions.source, currency: saleTransactions.currencyCode,
    amount: saleTransactions.grossAmountMinor, verification: saleTransactions.verificationState, reconciliation: saleTransactions.reconciliationState,
  }).from(saleTransactions).innerJoin(outlets, eq(saleTransactions.outletId, outlets.id))
    .where(eq(outlets.organisationId, organisationId));
  const payments = await db.select({ shiftDate: shifts.shiftDate, outletId: outlets.id, currency: shifts.currencyCode, status: shiftIncentives.status, amount: shiftIncentives.earnedAmountMinor })
    .from(shiftIncentives).innerJoin(shifts, eq(shiftIncentives.shiftId, shifts.id))
    .innerJoin(outlets, eq(shifts.outletId, outlets.id)).where(eq(outlets.organisationId, organisationId))
    .orderBy(desc(shifts.shiftDate));
  const workforce = await db.select({ name: workers.displayName, type: workers.workerType, status: workers.status })
    .from(workers).where(eq(workers.organisationId, organisationId));
  return { locations, sales, payments, workforce };
}
