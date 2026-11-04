import { z } from "zod";
import type { CommerceObservation } from "@/server/commerce/ingestion";
import { SquareError } from "@/server/integrations/square/client";

// Translates Square payments and refunds into FairShift's terms. This is the only place that
// knows their shape, and it reads only identity, location, time, money, status, the team
// member on a payment and a refund's link to its payment. Card, customer, note, reference and
// metadata fields are never read, so they cannot reach FairShift or stand in for an identity.
const money = z.object({ amount: z.number().int().nonnegative(), currency: z.string() });
const paymentSchema = z.object({ id: z.string().min(1).max(200), status: z.string().min(1), location_id: z.string().min(1), created_at: z.iso.datetime({ offset: true }), amount_money: money, tip_money: money.optional(), total_money: money.optional(), team_member_id: z.string().min(1).max(200).optional() });
const refundSchema = z.object({ id: z.string().min(1).max(200), status: z.string().min(1), location_id: z.string().min(1), payment_id: z.string().min(1).max(200), created_at: z.iso.datetime({ offset: true }), amount_money: money });

// tipAmountMinor is Square's tip on the payment, kept apart from the sale. null means the tip
// was not established by this read, never that there was none.
export type SquarePaymentEvidence = { providerPaymentId: string; providerLocationId: string; providerStatus: "COMPLETED"; providerTeamMemberId: string | null; tipAmountMinor: number | null };
export type SquareRefundEvidence = { providerRefundId: string; providerPaymentId: string; providerStatus: string; amountMinor: number; currencyCode: string; occurredAt: Date };

function read<T>(schema: z.ZodType<T>, raw: unknown, locationId: string, locationOf: (value: T) => string) {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new SquareError("MALFORMED_RESPONSE");
  // Filtered by location in the request, so another location's record here is a fault, not a sale.
  if (locationOf(parsed.data) !== locationId) throw new SquareError("MALFORMED_RESPONSE");
  return parsed.data;
}

// Square documents amount_money as excluding tip_money, and total_money as amount_money plus
// tip_money. A tip in another currency, or a total that doesn't add up, is a contradiction, so
// the whole read is refused. Square omits tip_money when there is no tip: with a total equal to
// the amount, that is Square's own report of a zero tip. Without either field nothing is known,
// and the tip stays unknown rather than becoming zero. Tips can't change once a payment is
// COMPLETED (Square allows tip edits only while it is APPROVED), and only COMPLETED payments reach here.
function tipOf(payment: z.infer<typeof paymentSchema>) {
  const { amount_money: amount, tip_money: tip, total_money: total } = payment;
  if (tip && tip.currency !== amount.currency) throw new SquareError("MALFORMED_RESPONSE");
  if (total && (total.currency !== amount.currency || total.amount !== amount.amount + (tip?.amount ?? 0))) throw new SquareError("MALFORMED_RESPONSE");
  return tip ? tip.amount : total ? 0 : null;
}

// Normalised as a whole, so one unreadable record stores nothing. Only COMPLETED payments are
// sales: Square's other states (APPROVED, PENDING, CANCELED, FAILED) are counted and left out,
// and a payment that completes later is picked up by a later overlapping sync. The sale time is
// created_at, which a refund does not move, and the value is amount_money, excluding tips. The
// tip is payment evidence only: it never enters the sale, so sales history, forecasts and a
// worker's attributed sales can't absorb it.
export function normaliseSquarePayments(payments: readonly unknown[], outletId: string, locationId: string) {
  const observations: CommerceObservation[] = [];
  const evidence: SquarePaymentEvidence[] = [];
  let notCompleted = 0;
  for (const raw of payments) {
    const payment = read(paymentSchema, raw, locationId, value => value.location_id);
    if (payment.status !== "COMPLETED") { notCompleted++; continue; }
    const tipAmountMinor = tipOf(payment);
    observations.push({ outletId, sourceTransactionId: payment.id, occurredAt: payment.created_at, currencyCode: payment.amount_money.currency, grossAmountMinor: payment.amount_money.amount, status: "COMPLETED" });
    evidence.push({ providerPaymentId: payment.id, providerLocationId: payment.location_id, providerStatus: "COMPLETED", providerTeamMemberId: payment.team_member_id ?? null, tipAmountMinor });
  }
  return { observations, evidence, notCompleted };
}

export function normaliseSquareRefunds(refunds: readonly unknown[], locationId: string): SquareRefundEvidence[] {
  return refunds.map(raw => {
    const refund = read(refundSchema, raw, locationId, value => value.location_id);
    return { providerRefundId: refund.id, providerPaymentId: refund.payment_id, providerStatus: refund.status, amountMinor: refund.amount_money.amount, currencyCode: refund.amount_money.currency, occurredAt: new Date(refund.created_at) };
  });
}
