import { and, desc, eq } from "drizzle-orm";
import { assertRole, type Scope } from "@/server/auth/access";
import type { DatabaseSession } from "@/server/db/client";
import { outlets, payAgentEvents, payQueries, shifts, tipAllocationLines, tipAllocations, workPayables, workPayouts } from "@/server/db/schema";
import { payAgentChecklist } from "@/server/pay-agent/presentation";

// One shift's pay for the worker who did it (design: worker Pay · shift page). Only the worker's own
// records: the payable from the accepted terms, its payout as PayPal Sandbox reported it (with the frozen
// ECB rate and the batch reference), card tips for that day at that location, the Pay Agent's checks and
// the worker's questions. Null when the payable isn't this worker's.
export async function workerShiftPay(db: DatabaseSession, scope: Scope, payableId: string) {
  assertRole(scope, ["TEAM_MEMBER"]);
  if (!scope.workerId || !/^[0-9a-f-]{36}$/i.test(payableId)) return null;
  const [row] = await db.select({ payable: workPayables, shift: shifts, place: { name: outlets.name, timezone: outlets.timezone } }).from(workPayables)
    .innerJoin(shifts, eq(shifts.id, workPayables.shiftId)).innerJoin(outlets, eq(outlets.id, workPayables.outletId))
    .where(and(eq(workPayables.id, payableId), eq(workPayables.workerId, scope.workerId), eq(workPayables.organisationId, scope.organisationId)));
  if (!row) return null;
  const [[payout], tips, [event], queries] = await Promise.all([
    db.select({ status: workPayouts.status, amountMinor: workPayouts.amountMinor, currencyCode: workPayouts.currencyCode, providerAmountMinor: workPayouts.providerAmountMinor, providerCurrency: workPayouts.providerCurrency,
      fxRateMicros: workPayouts.fxRateMicros, fxRateSource: workPayouts.fxRateSource, paypalBatchId: workPayouts.paypalBatchId, paidAt: workPayouts.paidAt, paypalStatus: workPayouts.paypalStatus })
      .from(workPayouts).where(and(eq(workPayouts.payableId, payableId), eq(workPayouts.workerId, scope.workerId))).orderBy(desc(workPayouts.createdAt)).limit(1),
    db.select({ shareMinor: tipAllocationLines.shareMinor, currencyCode: tipAllocationLines.currencyCode, block: tipAllocations.blockName, payoutStatus: workPayouts.status, providerAmountMinor: workPayouts.providerAmountMinor, providerCurrency: workPayouts.providerCurrency, fxRateMicros: workPayouts.fxRateMicros, paypalBatchId: workPayouts.paypalBatchId })
      .from(tipAllocationLines).innerJoin(tipAllocations, eq(tipAllocations.id, tipAllocationLines.allocationId)).leftJoin(workPayouts, eq(workPayouts.tipLineId, tipAllocationLines.id))
      .where(and(eq(tipAllocationLines.workerId, scope.workerId), eq(tipAllocationLines.outletId, row.payable.outletId), eq(tipAllocationLines.localDate, row.shift.shiftDate))),
    db.select().from(payAgentEvents).where(eq(payAgentEvents.payableId, payableId)).orderBy(desc(payAgentEvents.createdAt)).limit(1),
    db.select({ id: payQueries.id, topic: payQueries.topic, message: payQueries.message, status: payQueries.status, answer: payQueries.answer, answeredAt: payQueries.answeredAt, createdAt: payQueries.createdAt })
      .from(payQueries).where(and(eq(payQueries.payableId, payableId), eq(payQueries.workerId, scope.workerId))).orderBy(desc(payQueries.createdAt)),
  ]);
  return { ...row, payout: payout ?? null, tips, checks: event ? payAgentChecklist(event) : [], queries };
}
