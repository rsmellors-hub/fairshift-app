import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";

import type { DatabaseSession } from "@/server/db/client";
import { attributedSales, commerceConnections, commercePaymentEvidence, commerceWorkerIdentities, saleTransactions, workPerformanceResults, workers } from "@/server/db/schema";
import { incentiveWork, SQUARE_ATTRIBUTION_PROVIDER } from "@/server/performance/attribution";

// Turns held Square payments into worker-attributed sales, from provider evidence only. A
// payment counts when it completed, carries a team member, that team member is mapped to a
// worker at this location, and it falls inside that worker's allocated shift in the accepted
// currency, before their results were confirmed. Each payment is attributed at most once, and
// the amount is the provider's. Anything else stays unattributed until it qualifies: a mapping
// or an allocation made later can still pick it up, because this runs over everything held.
// Nothing here says who was logged in to a till or who physically made the sale.
export type AttributionOutcome = { attributed: number; noTeamMember: number; unmapped: number; noMatchingShift: number; wrongCurrency: number; resultsFinal: number };

export async function deriveSquareAttribution(tx: DatabaseSession, scope: { organisationId: string; locationId: string }): Promise<AttributionOutcome> {
  const outcome: AttributionOutcome = { attributed: 0, noTeamMember: 0, unmapped: 0, noMatchingShift: 0, wrongCurrency: 0, resultsFinal: 0 };
  const pending = await tx.select({ paymentId: commercePaymentEvidence.providerPaymentId, teamMemberId: commercePaymentEvidence.providerTeamMemberId, merchantId: commerceConnections.providerMerchantId, occurredAt: saleTransactions.occurredAt, amountMinor: saleTransactions.grossAmountMinor, currencyCode: saleTransactions.currencyCode })
    .from(commercePaymentEvidence)
    .innerJoin(commerceConnections, eq(commerceConnections.id, commercePaymentEvidence.connectionId))
    .innerJoin(saleTransactions, eq(saleTransactions.id, commercePaymentEvidence.saleTransactionId))
    .leftJoin(attributedSales, and(eq(attributedSales.outletId, commercePaymentEvidence.outletId), eq(attributedSales.provider, SQUARE_ATTRIBUTION_PROVIDER), eq(attributedSales.providerTransactionId, commercePaymentEvidence.providerPaymentId)))
    .where(and(eq(commercePaymentEvidence.organisationId, scope.organisationId), eq(commercePaymentEvidence.outletId, scope.locationId), isNull(attributedSales.id)));
  if (!pending.length) return outcome;

  const mappings = await tx.select({ workerId: commerceWorkerIdentities.workerId, teamMemberId: commerceWorkerIdentities.providerTeamMemberId, merchantId: commerceWorkerIdentities.providerMerchantId, code: workers.attributionCode })
    .from(commerceWorkerIdentities).innerJoin(workers, eq(workers.id, commerceWorkerIdentities.workerId))
    .where(and(eq(commerceWorkerIdentities.organisationId, scope.organisationId), eq(commerceWorkerIdentities.outletId, scope.locationId), eq(commerceWorkerIdentities.provider, SQUARE_ATTRIBUTION_PROVIDER), eq(commerceWorkerIdentities.status, "ACTIVE"),
      eq(workers.organisationId, scope.organisationId), eq(workers.locationId, scope.locationId)));
  const mapped = new Map(mappings.map(row => [`${row.merchantId}:${row.teamMemberId}`, row]));
  // Allocated work with accepted incentive terms, so cancelled and re-offered shifts never match.
  const work = mappings.length ? await incentiveWork(tx, { ...scope, role: "MANAGER" }, true, mappings.map(row => row.workerId)) : [];
  const finals = new Set(work.length ? (await tx.select({ id: workPerformanceResults.allocationId }).from(workPerformanceResults).where(inArray(workPerformanceResults.allocationId, work.map(item => item.allocation.id)))).map(row => row.id) : []);

  for (const payment of pending) {
    if (!payment.teamMemberId) { outcome.noTeamMember++; continue; }
    const identity = mapped.get(`${payment.merchantId}:${payment.teamMemberId}`);
    if (!identity) { outcome.unmapped++; continue; }
    const occurredAt = payment.occurredAt!;
    const shift = work.find(item => item.workerId === identity.workerId && item.terms.startsAt <= occurredAt && occurredAt < item.terms.endsAt);
    if (!shift) { outcome.noMatchingShift++; continue; }
    if (shift.terms.currencyCode !== payment.currencyCode) { outcome.wrongCurrency++; continue; }
    if (finals.has(shift.allocation.id)) { outcome.resultsFinal++; continue; }
    const created = await tx.insert(attributedSales).values({ id: randomUUID(), provider: SQUARE_ATTRIBUTION_PROVIDER, providerTransactionId: payment.paymentId, attributionCode: identity.code, workerId: identity.workerId, outletId: scope.locationId,
      amountMinor: payment.amountMinor, currencyCode: payment.currencyCode, occurredAt, source: "SQUARE_SYNC", verificationState: "UNVERIFIED" }).onConflictDoNothing().returning({ id: attributedSales.id });
    outcome.attributed += created.length;
  }
  return outcome;
}
