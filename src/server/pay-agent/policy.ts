import type { PayAgentCode, PayAgentResult, PayAgentStatus, SettlementEvidence } from "./contract";

const explanations: Record<PayAgentCode, string> = {
  READY: "Persisted evidence is ready for an orchestration proposal. No payment has been initiated.",
  INVALID_TRIGGER: "The completion trigger is outside the allowed event contract.",
  UNAUTHORISED: "An authenticated Pay Agent service identity scoped to this work is required.",
  IDENTITY_UNAVAILABLE: "The service identity could not be verified. No payment action was taken.",
  EVIDENCE_UNAVAILABLE: "Confirmed work evidence could not be read. Existing financial state is preserved.",
  EVIDENCE_INVALID: "The persisted evidence projection is incomplete or inconsistent.",
  EVIDENCE_CHANGED: "Persisted work or financial evidence changed during orchestration. The proposal was refused.",
  COMPLETION_REQUIRED: "Persisted manager confirmation of completed work is required.",
  TERMS_REQUIRED: "Persisted preauthorised compensation terms are required.",
  ACCEPTANCE_REQUIRED: "Persisted worker acceptance of those terms is required.",
  PERFORMANCE_REQUIRED: "Verified performance and deterministic earnings evidence are required.",
  AUTHORITY_REQUIRED: "Persisted payment authority under the accepted terms is required.",
  FUNDING_REQUIRED: "A verified funding arrangement for this employer is required.",
  RECIPIENT_REQUIRED: "A verified payment destination for this worker is required.",
  PROVIDER_ELIGIBILITY_REQUIRED: "Persisted eligibility for this sender, recipient, category and currency is required.",
  CURRENCY_UNSUPPORTED: "This operating currency has no enabled payout route here. No conversion or fallback currency is permitted.",
  FINANCIAL_FACTS_REQUIRED: "Complete server-resolved financial facts are required.",
  PAYOUT_PROCESSING: "The shared settlement record shows payment processing. No new submission is permitted.",
  PAYOUT_UNCERTAIN: "The original payment needs reconciliation. No new submission is permitted.",
  PAYOUT_COMPLETED: "The shared settlement record confirms this payment is paid.",
  PAYOUT_FAILED: "The shared settlement record shows a failed payment. Automatic resubmission is disabled.",
  PAYOUT_NOT_SENT: "The shared settlement record shows payment was not sent. Recovery belongs to the existing settlement service.",
  MODEL_NOT_CONFIGURED: "No model provider is configured. The payment obligation is preserved.",
  MODEL_FAILED: "The model proposal failed. No settlement action was invoked; the payment obligation is preserved.",
  TOOL_REFUSED: "The model action or its arguments were outside the allowlisted payable contract.",
  TRIGGER_PROCESSING: "This payable evidence already has an orchestration attempt in progress.",
  JOURNAL_UNAVAILABLE: "Orchestration could not be durably recorded. No settlement action is enabled; inspect the existing attempt before retrying.",
  EXECUTION_DISABLED: "The model proposed the allowed action, but automatic settlement is disabled pending the authenticated shared-settlement integration.",
};

export function payAgentResult(code: PayAgentCode, status: PayAgentStatus = "blocked", evidence?: SettlementEvidence): PayAgentResult {
  return {
    status, code, explanation: explanations[code], executionEnabled: false,
    evidenceReferences: evidence ? [...new Set([
      ...Object.values(evidence.references), evidence.payout.reference,
    ].filter((value): value is string => value !== null))] : [],
  };
}

// An orchestration preflight, not a second financial/settlement engine. Definitive
// payment authorisation must be revalidated inside the shared engine at reservation.
export function evaluateConfirmedWork(evidence: SettlementEvidence): PayAgentResult {
  if ((evidence.payout.status === "NONE") !== (evidence.payout.reference === null)) return payAgentResult("EVIDENCE_INVALID", "blocked", evidence);
  switch (evidence.payout.status) {
    case "PAID": return payAgentResult("PAYOUT_COMPLETED", "completed", evidence);
    case "SUBMITTING": case "PROCESSING": return payAgentResult("PAYOUT_PROCESSING", "processing", evidence);
    case "RECONCILIATION_REQUIRED": return payAgentResult("PAYOUT_UNCERTAIN", "uncertain", evidence);
    case "FAILED": return payAgentResult("PAYOUT_FAILED", "blocked", evidence);
    case "NOT_SENT": return payAgentResult("PAYOUT_NOT_SENT", "blocked", evidence);
  }
  const required = [
    ["managerCompletion", "COMPLETION_REQUIRED"], ["preauthorisedTerms", "TERMS_REQUIRED"],
    ["acceptance", "ACCEPTANCE_REQUIRED"], ["performance", "PERFORMANCE_REQUIRED"],
    ["paymentAuthority", "AUTHORITY_REQUIRED"],
  ] as const;
  for (const [field, code] of required) if (!evidence.references[field]) return payAgentResult(code, "blocked", evidence);
  // The known GBP/USD evidence is not proof of eligibility for an arbitrary tenant.
  // ZAR is ALWAYS refused, even if a faulty resolver labels a ZAR route eligible.
  if (!evidence.currencyCode || !["GBP", "USD"].includes(evidence.currencyCode)) return payAgentResult("CURRENCY_UNSUPPORTED", "blocked", evidence);
  if (!evidence.amountMinor) return payAgentResult("FINANCIAL_FACTS_REQUIRED", "blocked", evidence);
  if (!evidence.references.funding || !evidence.merchantId) return payAgentResult("FUNDING_REQUIRED", "blocked", evidence);
  if (!evidence.references.recipient || !evidence.recipientId) return payAgentResult("RECIPIENT_REQUIRED", "blocked", evidence);
  if (!evidence.references.providerEligibility) return payAgentResult("PROVIDER_ELIGIBILITY_REQUIRED", "blocked", evidence);
  return payAgentResult("READY", "ready", evidence);
}
