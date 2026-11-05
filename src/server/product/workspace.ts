import type { Scope } from "@/server/auth/access";
import { and, desc, eq, sql } from "drizzle-orm";

import { DEMO_CASUAL_WORKER_ID, DEMO_ORGANISATION_ID, DEMO_OUTLET_ID } from "@/server/constants";
import type { DatabaseSession } from "@/server/db/client";
import { organisations, outlets, saleTransactions, shiftIncentives, shiftOffers, shifts, workers, workAllocations, workPayables, workPayouts, workPerformanceResults, workerAvailability, departments } from "@/server/db/schema";
import { getDemoWorkerShift } from "@/server/scheduling/demo";
import { wageJurisdiction } from "@/server/domain/statutory-wage";

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

export async function getWorkerWorkspace(db: DatabaseSession, scope:Pick<Scope,"organisationId"|"locationId"|"workerId">) {
  const [profile] = await db.select({ displayName: workers.displayName, paypalPayoutEmail: workers.paypalPayoutEmail, attributionCode: workers.attributionCode })
    .from(workers).where(and(eq(workers.id, scope.workerId ?? "00000000-0000-0000-0000-000000000000"), eq(workers.organisationId, scope.organisationId), eq(workers.locationId, scope.locationId))).limit(1);
  // Deliberately exclude team revenue, transaction data, provider IDs and other workers.
  const assignments = await db.select({
    shift: shifts, offer: shiftOffers, allocation: workAllocations, departmentName: departments.name,
    incentive: {
      id: shiftIncentives.id, status: shiftIncentives.status, earnedAmountMinor: shiftIncentives.earnedAmountMinor,
      approvedAt: shiftIncentives.approvedAt, paidAt: shiftIncentives.paidAt,
    },
    // The worker's own base payable for confirmed work, without internal references.
    payable: {
      id: workPayables.id, status: workPayables.status, baseAmountMinor: workPayables.baseAmountMinor, currencyCode: workPayables.currencyCode,
      earningsModel: workPayables.earningsModel, rateMinor: workPayables.rateMinor, termsVersion: workPayables.termsVersion,
      scheduledStartsAt: workPayables.scheduledStartsAt, scheduledEndsAt: workPayables.scheduledEndsAt, confirmedAt: workPayables.confirmedAt,
      approvedAt: workPayables.approvedAt, incentiveRequired: workPayables.incentiveRequired, incentiveAmountMinor: workPayables.incentiveAmountMinor,
    },
    // The worker's own confirmed sales totals: aggregates only, never transactions.
    performance: {
      salesCount: workPerformanceResults.salesCount, salesMinor: workPerformanceResults.salesMinor, currencyCode: workPerformanceResults.currencyCode,
      targetMinor: workPerformanceResults.targetMinor, bonusMinor: workPerformanceResults.bonusMinor, earnedMinor: workPerformanceResults.earnedMinor, evidenceProvenance: workPerformanceResults.evidenceProvenance,
    },
    // Its payout state, without PayPal identifiers, recipient or error internals.
    payout: {
      id: workPayouts.id, status: workPayouts.status, paypalStatus: workPayouts.paypalStatus, amountMinor: workPayouts.amountMinor,
      currencyCode: workPayouts.currencyCode, submittedAt: workPayouts.submittedAt, paidAt: workPayouts.paidAt,
    },
  }).from(shiftOffers)
    .innerJoin(shifts, eq(shiftOffers.shiftId, shifts.id))
    .leftJoin(workAllocations, eq(workAllocations.offerId, shiftOffers.id))
    .leftJoin(departments, eq(departments.id, shifts.departmentId))
    .innerJoin(workers, eq(shiftOffers.workerId, workers.id))
    .leftJoin(shiftIncentives, and(eq(shiftIncentives.shiftId, shifts.id), eq(shiftIncentives.workerId, workers.id)))
    .leftJoin(workPayables, and(eq(workPayables.allocationId, workAllocations.id), eq(workPayables.workerId, workers.id), eq(workPayables.organisationId, workers.organisationId)))
    .leftJoin(workPayouts, and(eq(workPayouts.payableId, workPayables.id), eq(workPayouts.workerId, workers.id)))
    .leftJoin(workPerformanceResults, and(eq(workPerformanceResults.allocationId, workAllocations.id), eq(workPerformanceResults.workerId, workers.id)))
    .where(and(eq(workers.id, scope.workerId ?? "00000000-0000-0000-0000-000000000000"), eq(workers.organisationId, scope.organisationId), eq(workers.locationId, scope.locationId), eq(shifts.outletId, scope.locationId)))
    .orderBy(desc(shifts.shiftDate), desc(shifts.createdAt));
  const current = assignments.find(row => row.shift.status === "PUBLISHED" && row.offer.status === "ACCEPTED");
  const availability = profile && scope.workerId ? await db.select({ isoWeekday: workerAvailability.isoWeekday, state: workerAvailability.state }).from(workerAvailability).where(eq(workerAvailability.workerId, scope.workerId)) : [];
  const [location] = await db.select({ timezone: outlets.timezone, country: outlets.country, organisationCountry: organisations.country }).from(outlets)
    .innerJoin(organisations, eq(organisations.id, outlets.organisationId)).where(and(eq(outlets.id, scope.locationId), eq(outlets.organisationId, scope.organisationId)));
  // Which statutory wage reference applies to this location: the location's own minimum-wage context, nothing about the worker.
  const wage = location ? wageJurisdiction({ locationCountry: location.country, organisationCountry: location.organisationCountry }) : null;
  return { profile: profile ?? null, assignments, currentShiftId: current?.shift.id ?? null, availability, timezone: location?.timezone ?? null, wageJurisdiction: wage };
}

export async function getOwnerWorkspace(db: DatabaseSession, organisationId: string) {
  const locations = await db.select().from(outlets).where(eq(outlets.organisationId, organisationId));
  // Record counts by provenance, aggregated in the database: reference histories hold
  // hundreds of thousands of rows that need not be loaded to be counted.
  const sales = await db.select({ outletId: outlets.id, source: saleTransactions.source, currency: saleTransactions.currencyCode,
    verification: saleTransactions.verificationState, reconciliation: saleTransactions.reconciliationState,
    records: sql<number>`count(*)`.mapWith(Number),
  }).from(saleTransactions).innerJoin(outlets, eq(saleTransactions.outletId, outlets.id))
    .where(eq(outlets.organisationId, organisationId))
    .groupBy(outlets.id, saleTransactions.source, saleTransactions.currencyCode, saleTransactions.verificationState, saleTransactions.reconciliationState);
  const payments = await db.select({ shiftDate: shifts.shiftDate, outletId: outlets.id, currency: shifts.currencyCode, status: shiftIncentives.status, amount: shiftIncentives.earnedAmountMinor })
    .from(shiftIncentives).innerJoin(shifts, eq(shiftIncentives.shiftId, shifts.id))
    .innerJoin(outlets, eq(shifts.outletId, outlets.id)).where(eq(outlets.organisationId, organisationId))
    .orderBy(desc(shifts.shiftDate));
  const workforce = await db.select({ name: workers.displayName, type: workers.workerType, status: workers.status })
    .from(workers).where(eq(workers.organisationId, organisationId));
  // Work earnings across the organisation: approval and payout state only.
  const workPayments = await db.select({
    id: workPayables.id, outletId: workPayables.outletId, workerName: workers.displayName, shiftDate: shifts.shiftDate,
    amountMinor: sql<number>`${workPayables.baseAmountMinor} + coalesce(${workPayables.incentiveAmountMinor}, 0)`.mapWith(Number), currencyCode: workPayables.currencyCode, status: workPayables.status,
    payout: { id: workPayouts.id, status: workPayouts.status, paypalStatus: workPayouts.paypalStatus, paidAt: workPayouts.paidAt },
  }).from(workPayables).innerJoin(workers, eq(workers.id, workPayables.workerId)).innerJoin(shifts, eq(shifts.id, workPayables.shiftId))
    .leftJoin(workPayouts, eq(workPayouts.payableId, workPayables.id))
    .where(eq(workPayables.organisationId, organisationId)).orderBy(desc(workPayables.confirmedAt));
  return { locations, sales, payments, workforce, workPayments };
}
