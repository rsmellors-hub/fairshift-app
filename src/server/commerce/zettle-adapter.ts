import { z } from "zod";
import type { CommerceObservation } from "@/server/commerce/ingestion";
import { ZettleError } from "@/server/integrations/zettle/client";

// Translates a Zettle purchase into a canonical commerce observation. This is the only
// place that knows Zettle's purchase shape, and it reads only identity, time, currency,
// gross amount and the refund marker: staff names, products, card and customer details
// in the payload are never read, so they cannot reach FairShift's records. No field here
// establishes which worker made a sale.
const purchaseSchema = z.object({
  purchaseUUID1: z.string().min(1).max(200).optional(),
  purchaseUUID: z.string().min(1).max(200).optional(),
  amount: z.number().int(),
  currency: z.string(),
  timestamp: z.string(),
  refund: z.boolean().optional(),
});

// Zettle sends offsets without a colon ("+0000"); no other time format is guessed at.
function offsetTimestamp(value: string) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2}):?(\d{2})$/.exec(value);
  return match ? `${match[1]}${match[2]}:${match[3]}` : null;
}

export function normaliseZettlePurchases(purchases: readonly unknown[], outletId: string) {
  const observations: CommerceObservation[] = [];
  let refundsExcluded = 0;
  for (const raw of purchases) {
    const parsed = purchaseSchema.safeParse(raw);
    if (!parsed.success) throw new ZettleError("MALFORMED_RESPONSE");
    const purchase = parsed.data;
    const id = purchase.purchaseUUID1 ?? purchase.purchaseUUID;
    const occurredAt = offsetTimestamp(purchase.timestamp);
    if (!id || !occurredAt) throw new ZettleError("MALFORMED_RESPONSE");
    // Refunds are recorded by Zettle as separate negative purchases. Canonical history
    // holds completed sales only, so they are counted and reported, not netted off.
    if (purchase.refund === true || purchase.amount < 0) { refundsExcluded++; continue; }
    observations.push({ outletId, sourceTransactionId: id, occurredAt, currencyCode: purchase.currency, grossAmountMinor: purchase.amount, status: "COMPLETED" });
  }
  return { observations, refundsExcluded };
}
