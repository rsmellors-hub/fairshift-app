// Plain-language explanations of every outcome the Pay Agent journal can record, for managers.
// Workers never see these codes; they see the five statuses in presentation.ts. Unknown codes
// fall back to a neutral sentence that claims nothing about payment.
const OUTCOME_EXPLANATIONS: Record<string, string> = {
  // Before any model call.
  PAYOUT_EXISTS: "A payment for this work already exists, so the Pay Agent took no action. Its status is shown with the payment.",
  NOTHING_PAYABLE: "There is nothing to pay for this work.",
  MANAGER_REJECTED: "A manager rejected this payment. It stays unpaid.",
  PERFORMANCE_REQUIRED: "The sales result for this shift must be confirmed before payment checks can run.",
  COMPLETION_REQUIRED: "A recorded manager confirmation of this completed work is required.",
  INDEPENDENT_CONFIRMATION_REQUIRED: "Work must be confirmed, and a hold released, by a manager other than the worker.",
  ALLOCATION_REQUIRED: "This work is no longer allocated on its accepted terms.",
  ACCEPTANCE_REQUIRED: "The worker's acceptance of this offer is required.",
  TERMS_REQUIRED: "The worker's acceptance must be of the same terms as this payable.",
  WORKER_NOT_ELIGIBLE: "The worker is not active at this location.",
  EVIDENCE_INVALID: "A record this work depends on is missing.",
  EVIDENCE_UNAVAILABLE: "The work evidence could not be read. Nothing was paid; try again shortly.",
  EVIDENCE_STALE: "The work evidence changed after this check was queued. Retry to check the current evidence.",
  EVIDENCE_CHANGED: "The work evidence changed while the Pay Agent was deciding, so its recommendation was not used.",
  // The model.
  MODEL_NOT_CONFIGURED: "The Pay Agent model is not available here. Nothing was paid; the earnings stay recorded.",
  MODEL_FAILED: "The Pay Agent model could not give a recommendation. Nothing was paid.",
  OUTPUT_REJECTED: "The Pay Agent's answer was outside its allowed actions, so it was rejected. Nothing was paid.",
  ATTEMPTS_EXHAUSTED: "The Pay Agent stopped after repeated failures. Nothing was paid.",
  // The settlement gates.
  DRY_RUN_ELIGIBLE: "Demo dry run: every payment check passed, and nothing was sent to PayPal: no PayPal call was made and no money moved.",
  COMPENSATION_UNVERIFIED: "This payable was not calculated from accepted terms, so it cannot be paid automatically.",
  COMPENSATION_MISMATCH: "The approved amount does not match the deterministic payable, so nothing was sent.",
  SETTLEMENT_CHECK_FAILED: "A payment check could not be completed. Nothing was sent.",
  SETTLEMENT_UNAVAILABLE: "Settlement could not be completed and no payment was reserved. Nothing was sent.",
  PAYOUT_RESERVED: "The payment was reserved and sent through FairShift's payment service. Its PayPal status is shown with the payment.",
  "sandbox-isolation-required": "Sandbox payments are unavailable in this environment or account.",
  "provider-fx-rate-unavailable": "No ECB reference rate from the last three business days is recorded, so this payout cannot be prepared. The earnings stay recorded as unpaid.",
  "provider-amount-zero": "The converted payout amount rounds down to zero, so it cannot be paid.",
  "provider-currency-unsupported": "There is no supported payout currency for these earnings.",
  "payout-route-unverified": "A PayPal payout route for this business or location isn't verified yet, so nothing was sent.",
  "payout-currency-unverified": "PayPal payouts in this currency aren't verified for FairShift yet, so nothing was sent.",
  "payout-currency-unsupported": "This payout currency is not supported.",
  "payment-details-required": "The worker has not saved payment details yet.",
  "paypal-not-connected": "Connect your PayPal to pay your team. Nothing was sent; the earnings stay recorded as unpaid.",
  "paypal-connection-unavailable": "The PayPal account this payment was sent from can't be reached right now, so nothing was changed.",
  "performance-required": "The sales result for this shift must be confirmed first.",
};

export function payAgentOutcomeExplanation(code: string | null | undefined): string | null {
  if (!code) return null;
  return OUTCOME_EXPLANATIONS[code] ?? "The Pay Agent recorded an outcome for this work. Nothing is paid until PayPal confirms it.";
}
