import { and, desc, eq, inArray } from "drizzle-orm";

import type { Scope } from "@/server/auth/access";
import type { DatabaseSession } from "@/server/db/client";
import { staffDestinationEvents, tipAgentEvents, tipAllocationLines, tipAllocations, tipBlockRoster, tipEvidenceRows, tipImports, workers, workPayouts } from "@/server/db/schema";
import { holdHistory } from "./agent";
import { activeBlocks, assertTipOwner, tipSettingsFor } from "./service";

// Everything the Owner sees about one location's tips: settings, blocks, roster, imports,
// allocations per block with their lines and rows, the Pay Agent's decisions, holds and their
// permanent decision history, release status and Sandbox payout identifiers. Owner only.
export async function getOwnerTipView(db: DatabaseSession, scope: Pick<Scope, "organisationId" | "locationId" | "role" | "demo" | "userId">) {
  assertTipOwner(scope);
  const settings = await tipSettingsFor(db, scope);
  const blocks = await activeBlocks(db, scope);
  const staff = await db.select({ id: workers.id, name: workers.displayName, email: workers.email, paypal: workers.paypalPayoutEmail, status: workers.status, code: workers.attributionCode, type: workers.workerType })
    .from(workers).where(and(eq(workers.organisationId, scope.organisationId), eq(workers.locationId, scope.locationId))).orderBy(workers.displayName);
  const permanent = staff.filter(person => person.type === "REGULAR");
  const destinations = permanent.length ? await db.select().from(staffDestinationEvents).where(inArray(staffDestinationEvents.workerId, permanent.map(person => person.id))).orderBy(desc(staffDestinationEvents.createdAt)) : [];
  const roster = await db.select().from(tipBlockRoster).where(eq(tipBlockRoster.outletId, scope.locationId));
  const imports = await db.select().from(tipImports).where(and(eq(tipImports.outletId, scope.locationId), eq(tipImports.organisationId, scope.organisationId))).orderBy(desc(tipImports.importedAt)).limit(10);
  const importIds = imports.map(row => row.id);
  const allocations = importIds.length ? await db.select().from(tipAllocations).where(inArray(tipAllocations.importId, importIds)).orderBy(desc(tipAllocations.localDate), tipAllocations.blockStartMinute) : [];
  const allocationIds = allocations.map(row => row.id);
  const lines = allocationIds.length ? await db.select({ line: tipAllocationLines, payout: workPayouts }).from(tipAllocationLines).leftJoin(workPayouts, eq(workPayouts.tipLineId, tipAllocationLines.id))
    .where(inArray(tipAllocationLines.allocationId, allocationIds)) : [];
  const rows = importIds.length ? await db.select().from(tipEvidenceRows).where(inArray(tipEvidenceRows.importId, importIds)).orderBy(tipEvidenceRows.transactionAt) : [];
  const events = allocationIds.length ? await db.select().from(tipAgentEvents).where(inArray(tipAgentEvents.allocationId, allocationIds)).orderBy(desc(tipAgentEvents.createdAt)) : [];
  const holds = await holdHistory(db, scope, allocationIds);
  const nameOf = (id: string | null) => staff.find(person => person.id === id)?.name ?? null;
  const typeOf = (id: string | null) => staff.find(person => person.id === id)?.type ?? null;
  return {
    settings, blocks,
    staff: permanent.map(person => {
      const latest = destinations.find(event => event.workerId === person.id && event.kind !== "RECORDED");
      return { ...person, destinationState: latest ? latest.kind : "AWAITING_CONFIRMATION", destinationChangedAt: latest?.kind === "CHANGED" ? latest.createdAt : null,
        roster: roster.filter(entry => entry.workerId === person.id).map(entry => ({ isoWeekday: entry.isoWeekday, blockId: entry.blockId })) };
    }),
    imports: imports.map(row => ({ ...row, unallocated: rows.filter(evidence => evidence.importId === row.id && !evidence.allocationId).map(evidence => ({ ...evidence, staffName: nameOf(evidence.workerId) })) })),
    allocations: allocations.map(allocation => ({
      ...allocation,
      lines: lines.filter(row => row.line.allocationId === allocation.id).map(row => ({ ...row.line, name: nameOf(row.line.workerId), payout: row.payout })),
      rows: rows.filter(row => row.allocationId === allocation.id).map(row => ({ ...row, staffName: nameOf(row.workerId), staffType: typeOf(row.workerId) })),
      event: events.find(event => event.allocationId === allocation.id) ?? null,
      holds: holds.filter(hold => hold.allocationId === allocation.id),
    })),
  };
}
export type OwnerTipView = Awaited<ReturnType<typeof getOwnerTipView>>;

// A casual worker's own tip lines: pooled shares from SHIFT_POOL blocks (paid through the pool) and
// DIRECT POS tips recorded for shift pay (not paid by FairShift yet). Never anyone else's share,
// the pool's members or the venue's tip totals.
export async function getWorkerTips(db: DatabaseSession, scope: Pick<Scope, "organisationId" | "locationId" | "workerId">) {
  if (!scope.workerId) return { pooled: [], shiftPayMinor: 0, currencyCode: null as string | null };
  const pooled = await db.select({ localDate: tipAllocations.localDate, blockName: tipAllocations.blockName, blockStartMinute: tipAllocations.blockStartMinute, blockEndMinute: tipAllocations.blockEndMinute,
    shareMinor: tipAllocationLines.shareMinor, currencyCode: tipAllocationLines.currencyCode, gateOutcome: tipAllocationLines.gateOutcome, payoutStatus: workPayouts.status })
    .from(tipAllocationLines).innerJoin(tipAllocations, eq(tipAllocations.id, tipAllocationLines.allocationId)).leftJoin(workPayouts, eq(workPayouts.tipLineId, tipAllocationLines.id))
    .where(and(eq(tipAllocationLines.workerId, scope.workerId), eq(tipAllocationLines.organisationId, scope.organisationId), eq(tipAllocationLines.outletId, scope.locationId)))
    .orderBy(desc(tipAllocations.localDate), tipAllocations.blockStartMinute);
  const recorded = await db.select({ tipMinor: tipEvidenceRows.tipMinor, currencyCode: tipEvidenceRows.currencyCode }).from(tipEvidenceRows)
    .where(and(eq(tipEvidenceRows.workerId, scope.workerId), eq(tipEvidenceRows.organisationId, scope.organisationId), eq(tipEvidenceRows.disposition, "CASUAL_SHIFT_PAY")));
  return { pooled, shiftPayMinor: recorded.reduce((sum, row) => sum + row.tipMinor, 0), currencyCode: recorded[0]?.currencyCode ?? pooled[0]?.currencyCode ?? null };
}
