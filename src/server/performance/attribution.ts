import { randomUUID } from "node:crypto";
import { and, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import { z } from "zod";

import { assertRole, type Scope } from "@/server/auth/access";
import { requireEntitlement } from "@/server/billing/entitlement";
import type { Database, DatabaseSession } from "@/server/db/client";
import { attributedSales, auditEvents, shiftOffers, shifts, workAcceptances, workAllocations, workPayables, workPerformanceResults, workers } from "@/server/db/schema";
import { UserFacingError } from "@/server/domain/errors";
import { acceptedIncentiveTerms, calculateIncentive } from "@/server/domain/incentive";
import { decimalToMinorUnits } from "@/server/domain/money";

// Worker-attributed sales evidence. It arrives only through this location-scoped import,
// is matched on the worker's attribution code, location, accepted shift window and
// currency, and stays unverified: confirming it for payment is a manager's decision about
// completeness, not a provider's verification of the sales.
export const IMPORT_PROVIDER = "FAIRSHIFT_IMPORT";
export const IMPORTED_PROVENANCE = "IMPORTED_NOT_PROVIDER_VERIFIED";
const HEADER = "transaction_id,attribution_code,occurred_at,amount,currency";
const MAX_ROWS = 2000;

export type ImportRejection = "INVALID_ROW" | "IN_THE_FUTURE" | "UNKNOWN_CODE" | "NO_MATCHING_SHIFT" | "WRONG_CURRENCY" | "RESULTS_FINAL" | "TRANSACTION_CHANGED";
export type ImportSummary = { imported: number; duplicates: number; rejected: { line: number; reason: ImportRejection }[] };
type PerformanceScope = Pick<Scope, "organisationId" | "locationId" | "role"> & { userId?: string; workerId?: string | null };

async function authorise(db: DatabaseSession, scope: PerformanceScope) {
  assertRole(scope as Scope, ["OWNER", "MANAGER"]);
  await requireEntitlement(db, scope.organisationId);
}

const rowSchema = z.object({
  transactionId: z.string().regex(/^[\w.:-]{1,120}$/), code: z.string().regex(/^[\w-]{1,80}$/),
  occurredAt: z.iso.datetime({ offset: true }), amount: z.string(), currency: z.string().regex(/^[A-Z]{3}$/),
});

// Only these columns are read, so a file cannot carry customer or product detail in.
// Amounts have exactly two decimals and times an explicit offset: nothing is guessed.
export function parseAttributionRows(text: string) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).map(line => line.trim());
  const first = lines.findIndex(Boolean);
  if (first < 0 || lines[first].toLowerCase() !== HEADER) throw new UserFacingError("import-format", `The first line must be: ${HEADER}`);
  const rows: ({ line: number; invalid: true } | { line: number; invalid: false; transactionId: string; code: string; occurredAt: Date; amountMinor: number; currencyCode: string })[] = [];
  for (let index = first + 1; index < lines.length; index++) {
    if (!lines[index]) continue;
    const line = index + 1, cells = lines[index].split(",").map(cell => cell.trim());
    const parsed = cells.length === 5 ? rowSchema.safeParse({ transactionId: cells[0], code: cells[1], occurredAt: cells[2], amount: cells[3], currency: cells[4] }) : null;
    let amountMinor = 0;
    if (parsed?.success) { try { amountMinor = decimalToMinorUnits(parsed.data.amount); } catch { amountMinor = 0; } }
    rows.push(parsed?.success && amountMinor > 0
      ? { line, invalid: false, transactionId: parsed.data.transactionId, code: parsed.data.code, occurredAt: new Date(parsed.data.occurredAt), amountMinor, currencyCode: parsed.data.currency }
      : { line, invalid: true });
  }
  if (rows.length > MAX_ROWS) throw new UserFacingError("import-format", `An import can have at most ${MAX_ROWS} rows.`);
  return rows;
}

// Allocated work at this location whose accepted terms carry an incentive.
async function incentiveWork(db: DatabaseSession, scope: PerformanceScope, lock: boolean, workerIds?: string[]) {
  const query = db.select({ allocation: workAllocations, snapshot: workAcceptances.snapshot, offerId: shiftOffers.id, workerId: shiftOffers.workerId, shiftId: shifts.id, shiftDate: shifts.shiftDate, roleName: shifts.roleName, startsAt: shifts.startsAt, workerName: workers.displayName })
    .from(workAllocations).innerJoin(workAcceptances, eq(workAcceptances.id, workAllocations.acceptanceId))
    .innerJoin(shiftOffers, eq(shiftOffers.id, workAllocations.offerId)).innerJoin(shifts, eq(shifts.id, shiftOffers.shiftId))
    .innerJoin(workers, eq(workers.id, shiftOffers.workerId))
    .where(and(eq(workAllocations.state, "ALLOCATED"), eq(shifts.outletId, scope.locationId), eq(workers.organisationId, scope.organisationId), eq(workers.locationId, scope.locationId), sql`${workAcceptances.snapshot}->>'incentiveBasis' is not null`,
      workerIds ? inArray(shiftOffers.workerId, workerIds) : undefined));
  // Held until commit, so a concurrent import cannot slip in behind a confirmation.
  const rows = lock ? await query.for("update", { of: workAllocations }) : await query;
  return rows.flatMap(row => { const terms = acceptedIncentiveTerms(row.snapshot); return terms ? [{ ...row, terms }] : []; });
}

// All-or-nothing per row: valid rows are stored and every other row is reported by line.
export async function importAttributedSales(db: Database, scope: PerformanceScope, text: string, now = new Date()): Promise<ImportSummary> {
  await authorise(db, scope);
  const rows = parseAttributionRows(text);
  return db.transaction(async tx => {
    const summary: ImportSummary = { imported: 0, duplicates: 0, rejected: [] };
    const valid = rows.flatMap(row => row.invalid ? [] : [row]);
    const codes = [...new Set(valid.map(row => row.code))];
    const team = codes.length ? await tx.select({ id: workers.id, code: workers.attributionCode }).from(workers)
      .where(and(inArray(workers.attributionCode, codes), eq(workers.organisationId, scope.organisationId), eq(workers.locationId, scope.locationId))) : [];
    const byCode = new Map(team.map(worker => [worker.code, worker.id]));
    const work = team.length ? await incentiveWork(tx, scope, true, team.map(worker => worker.id)) : [];
    const finals = new Set(work.length ? (await tx.select({ id: workPerformanceResults.allocationId }).from(workPerformanceResults).where(inArray(workPerformanceResults.allocationId, work.map(item => item.allocation.id)))).map(row => row.id) : []);
    for (const row of rows) {
      const reject = (reason: ImportRejection) => summary.rejected.push({ line: row.line, reason });
      if (row.invalid) { reject("INVALID_ROW"); continue; }
      const workerId = byCode.get(row.code);
      if (!workerId) { reject("UNKNOWN_CODE"); continue; }
      const [existing] = await tx.select().from(attributedSales).where(and(eq(attributedSales.outletId, scope.locationId), eq(attributedSales.provider, IMPORT_PROVIDER), eq(attributedSales.providerTransactionId, row.transactionId)));
      if (existing) {
        const same = existing.workerId === workerId && existing.amountMinor === row.amountMinor && existing.currencyCode === row.currencyCode && existing.occurredAt.getTime() === row.occurredAt.getTime();
        if (same) summary.duplicates++; else reject("TRANSACTION_CHANGED");
        continue;
      }
      if (row.occurredAt > now) { reject("IN_THE_FUTURE"); continue; }
      const shift = work.find(item => item.workerId === workerId && item.terms.startsAt <= row.occurredAt && row.occurredAt < item.terms.endsAt);
      if (!shift) { reject("NO_MATCHING_SHIFT"); continue; }
      if (shift.terms.currencyCode !== row.currencyCode) { reject("WRONG_CURRENCY"); continue; }
      if (finals.has(shift.allocation.id)) { reject("RESULTS_FINAL"); continue; }
      await tx.insert(attributedSales).values({ id: randomUUID(), provider: IMPORT_PROVIDER, providerTransactionId: row.transactionId, attributionCode: row.code, workerId, outletId: scope.locationId,
        amountMinor: row.amountMinor, currencyCode: row.currencyCode, occurredAt: row.occurredAt, source: "IMPORT", verificationState: "UNVERIFIED" });
      summary.imported++;
    }
    const importId = randomUUID();
    await tx.insert(auditEvents).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: scope.locationId, action: "ATTRIBUTED_SALES_IMPORTED", entityType: "attributed_sales_import", entityId: importId, correlationId: `attribution-import:${importId}`,
      metadata: { actorUserId: scope.userId ?? null, imported: summary.imported, duplicates: summary.duplicates, rejected: summary.rejected.length } });
    return summary;
  });
}

// The worker's own sales in the accepted shift window, at this location, in the accepted currency.
async function attributedTotals(db: DatabaseSession, input: { workerId: string; outletId: string; currencyCode: string; startsAt: Date; endsAt: Date }) {
  const [totals] = await db.select({ count: sql<number>`count(*)::int`.mapWith(Number), minor: sql<number>`coalesce(sum(${attributedSales.amountMinor}), 0)`.mapWith(Number) }).from(attributedSales)
    .where(and(eq(attributedSales.workerId, input.workerId), eq(attributedSales.outletId, input.outletId), eq(attributedSales.currencyCode, input.currencyCode), gte(attributedSales.occurredAt, input.startsAt), lt(attributedSales.occurredAt, input.endsAt), ne(attributedSales.verificationState, "FAILED")));
  if (!Number.isSafeInteger(totals.minor)) throw new Error("Attributed sales exceed the supported range.");
  return totals;
}

// Aggregates only, for the manager's review: never transactions or customers.
export async function getLocationPerformance(db: DatabaseSession, scope: PerformanceScope) {
  await authorise(db, scope);
  const work = await incentiveWork(db, scope, false);
  const results = work.length ? await db.select().from(workPerformanceResults).where(inArray(workPerformanceResults.allocationId, work.map(item => item.allocation.id))) : [];
  return Promise.all(work.map(async item => ({
    allocationId: item.allocation.id, confirmedAt: item.allocation.confirmedAt, workerName: item.workerName, shiftDate: item.shiftDate, roleName: item.roleName, startsAt: item.startsAt, terms: item.terms,
    attributed: await attributedTotals(db, { workerId: item.workerId, outletId: scope.locationId, currencyCode: item.terms.currencyCode, startsAt: item.terms.startsAt, endsAt: item.terms.endsAt }),
    result: results.find(result => result.allocationId === item.allocation.id) ?? null,
  })));
}

// The manager states the sales evidence for one shift is complete. The figures and the
// incentive are FairShift's own; what the manager saw is only compared, so a late import
// cannot be confirmed unseen. Idempotent: a confirmed result is returned, never recalculated.
export async function confirmWorkPerformance(db: Database, scope: PerformanceScope, allocationId: string, seen: { count: number; minor: number }) {
  await authorise(db, scope);
  z.uuid().parse(allocationId);
  return db.transaction(async tx => {
    const [work] = (await incentiveWork(tx, scope, true)).filter(item => item.allocation.id === allocationId);
    if (!work) throw new Error("Work unavailable.");
    if (scope.workerId && scope.workerId === work.workerId) throw new Error("A worker cannot confirm their own results.");
    const [existing] = await tx.select().from(workPerformanceResults).where(eq(workPerformanceResults.allocationId, allocationId));
    if (existing) return existing;
    if (!work.allocation.confirmedAt) throw new UserFacingError("work-not-confirmed", "Confirm the work before its sales results.");
    const [payable] = await tx.select().from(workPayables).where(and(eq(workPayables.allocationId, allocationId), eq(workPayables.organisationId, scope.organisationId), eq(workPayables.outletId, scope.locationId))).for("update");
    if (!payable || !payable.incentiveRequired) throw new UserFacingError("work-not-confirmed", "Confirm the work before its sales results.");
    const totals = await attributedTotals(tx, { workerId: work.workerId, outletId: scope.locationId, currencyCode: work.terms.currencyCode, startsAt: work.terms.startsAt, endsAt: work.terms.endsAt });
    if (totals.count !== seen.count || totals.minor !== seen.minor) throw new UserFacingError("sales-changed", "These sales changed since you opened this page.");
    const { earnedAmountMinor } = calculateIncentive(totals.minor, work.terms.targetMinor, work.terms.bonusMinor);
    const [result] = await tx.insert(workPerformanceResults).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: scope.locationId, shiftId: work.shiftId, workerId: work.workerId, allocationId, acceptanceId: work.allocation.acceptanceId,
      salesCount: totals.count, salesMinor: totals.minor, currencyCode: work.terms.currencyCode, targetMinor: work.terms.targetMinor, bonusMinor: work.terms.bonusMinor, earnedMinor: earnedAmountMinor,
      evidenceProvenance: IMPORTED_PROVENANCE, confirmedAt: new Date(), confirmedBy: scope.userId ?? null }).returning();
    await tx.update(workPayables).set({ incentiveAmountMinor: earnedAmountMinor, performanceResultId: result.id, updatedAt: new Date() }).where(eq(workPayables.id, payable.id));
    await tx.insert(auditEvents).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: scope.locationId, action: "WORK_PERFORMANCE_CONFIRMED", entityType: "work_performance_result", entityId: result.id, correlationId: `payable:${payable.id}`,
      metadata: { actorUserId: scope.userId ?? null, salesCount: totals.count, salesMinor: totals.minor, targetMinor: work.terms.targetMinor, bonusMinor: work.terms.bonusMinor, earnedMinor: earnedAmountMinor, provenance: IMPORTED_PROVENANCE } });
    return result;
  });
}
