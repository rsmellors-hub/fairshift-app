// Plain-language reasons for PayPal Payouts outcomes FairShift records (lastError.code or the item's
// error name), for managers and owners. Each says what happened and what to do; none claims a
// payment. Codes follow PayPal's documented Payouts errors and Sandbox test values.
const REASONS: Record<string, string> = {
  INSUFFICIENT_FUNDS: "The business's PayPal balance can't cover this payout. Add funds to the PayPal account, then contact your platform operator.",
  SENDER_RESTRICTED: "PayPal has restricted the paying account, so it can't send payouts. Resolve this with PayPal.",
  AUTHORIZATION_ERROR: "PayPal didn't authorise FairShift to send payouts from this account. Check the PayPal app's Payouts permission.",
  NON_HOLDING_CURRENCY: "The paying PayPal account doesn't hold this payout's currency. Add the currency in PayPal.",
  CURRENCY_NOT_SUPPORTED_FOR_RECEIVER: "The worker's PayPal account can't receive this currency. Ask them to check their PayPal account.",
  RECEIVER_COUNTRY_NOT_ALLOWED: "PayPal doesn't allow payouts to the worker's country. This payment can't be completed through PayPal.",
  RECEIVER_UNREGISTERED: "The worker's email isn't registered with PayPal yet. PayPal holds the payment until they register.",
  RECEIVING_LIMIT_EXCEEDED: "The worker's PayPal account has reached its receiving limit. Ask them to check their PayPal account.",
  RISK_DECLINE: "PayPal's risk checks declined this payment. Nothing was paid; resolve it with PayPal.",
  RATE_LIMIT_REACHED: "PayPal asked FairShift to slow down. Nothing was paid; try again in a minute.",
  RATE_LIMIT_VALIDATION: "PayPal asked FairShift to slow down. Nothing was paid; try again in a minute.",
  INTERNAL_ERROR: "PayPal reported an internal error, so this payment is unconfirmed. Check its status; it is never sent as a second payment.",
  REQUEST_TIMEOUT_EXCEEDED: "PayPal didn't finish in time, so this payment is unconfirmed. Check its status; it is never sent as a second payment.",
  PREVIOUS_REQUEST_IN_PROGRESS: "PayPal is still processing this payment's earlier request. Check its status again shortly.",
  DUPLICATE_ITEM: "PayPal already has this payment, so no second payment was made. Check its status.",
  // Transport outcomes the client records itself (e.g. the Sandbox's ERRPYO036 504 has no JSON body).
  MALFORMED_RESPONSE: "PayPal's answer couldn't be read, so this payment is unconfirmed. Check its status; it is never sent as a second payment.",
  TIMEOUT: "PayPal didn't answer in time, so this payment is unconfirmed. Check its status; it is never sent as a second payment.",
  NETWORK_ERROR: "FairShift couldn't reach PayPal, so this payment is unconfirmed. Check its status; it is never sent as a second payment.",
};

export function payoutPlainReason(code: string | null | undefined): string | null {
  return code ? REASONS[code] ?? null : null;
}
export const PAYOUT_REASON_CODES = Object.keys(REASONS);
