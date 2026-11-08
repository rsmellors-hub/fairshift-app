// A payout PayPal refused outright: it answered the create request with a 4xx refusal,
// so no payout batch exists and nothing was sent. This differs from a payout PayPal
// accepted and later failed, which has a batch.
export type PayoutRefusal = { reason: string | null };

type RecordedPayout = { status: string; paypalBatchId: string | null; lastError: unknown };

export function payoutRefusal(payout: RecordedPayout | null | undefined): PayoutRefusal | null {
  if (!payout || payout.status !== "FAILED" || payout.paypalBatchId) return null;
  const error = typeof payout.lastError === "object" && payout.lastError !== null ? payout.lastError as { outcome?: unknown; httpStatus?: unknown; reason?: unknown } : null;
  if (error?.outcome !== "REJECTED") return null;
  if (typeof error.httpStatus === "number" && (error.httpStatus < 400 || error.httpStatus > 499)) return null;
  return { reason: typeof error.reason === "string" && error.reason.trim() ? error.reason : null };
}

// PayPal's short description of a refusal, from its structured error details (for example
// "Currency is not supported"). Bounded, and stripped of anything shaped like an address.
export function refusalReason(details?: ReadonlyArray<{ issue?: string }>) {
  const issue = details?.find((detail) => detail.issue?.trim())?.issue;
  if (!issue) return null;
  const text = issue.replace(/[^\s@]+@[^\s@]+/g, "[address]").replace(/\s+/g, " ").trim().slice(0, 160);
  return text || null;
}

export function refusalText(refusal: PayoutRefusal) {
  return refusal.reason ? `Refused by PayPal: ${refusal.reason.replace(/[.\s]+$/, "")}` : "Refused by PayPal";
}
