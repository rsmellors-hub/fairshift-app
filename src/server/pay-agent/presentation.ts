import { payAgentOutcomeExplanation } from "./policy";

// How Pay Agent state is shown. Workers see only five plain statuses about their own work, never
// an internal code, decision text or model detail. Managers see the agent's status, decision,
// reason, summary, block reason, dry-run outcome and model response ID.

export const WORKER_PAY_STATUSES = ["Shift confirmed", "Earnings recorded", "Pay pending", "Under review", "Paid"] as const;
export type WorkerPayStatus = (typeof WORKER_PAY_STATUSES)[number];

const PAY_PENDING: ReadonlySet<string> = new Set(["DECIDED_SETTLE", "HOLD_RELEASED", "SETTLING", "DRY_RUN_ELIGIBLE", "SETTLEMENT_BLOCKED", "SETTLEMENT_SUBMITTED"]);

// "Paid" only when the payout itself is PAID, which the database allows only after PayPal reported
// the item SUCCESS. A hold or a manager's rejection reads as under review.
export function workerPayStatus(input: { workConfirmed: boolean; hasPayable: boolean; approved?: boolean; payoutStatus?: string | null; agentStatus?: string | null }): WorkerPayStatus | null {
  if (input.payoutStatus === "PAID") return "Paid";
  if (input.agentStatus === "DECIDED_HOLD" || input.agentStatus === "HOLD_REJECTED") return "Under review";
  if (input.payoutStatus || input.approved) return "Pay pending";
  if (input.agentStatus && PAY_PENDING.has(input.agentStatus)) return "Pay pending";
  if (input.hasPayable) return "Earnings recorded";
  if (input.workConfirmed) return "Shift confirmed";
  return null;
}

export const WORKER_PAY_STATUS_NOTE: Record<WorkerPayStatus, string> = {
  "Shift confirmed": "Your manager confirmed this shift.",
  "Earnings recorded": "Your earnings are recorded from the terms you accepted.",
  "Pay pending": "Payment checks are under way. Nothing is paid until PayPal confirms it.",
  "Under review": "The business owner is reviewing this payment. You can query it if something looks wrong.",
  Paid: "PayPal confirmed this payment.",
};

const MANAGER_STATUS: Record<string, string> = {
  PENDING: "Queued", CLAIMED: "Checking the evidence", SKIPPED: "No action needed", BLOCKED: "Waiting for evidence",
  REJECTED_OUTPUT: "Model answer rejected", FAILED_RETRYABLE: "Will retry", FAILED_TERMINAL: "Stopped",
  DECIDED_SETTLE: "Recommended: settle", DECIDED_HOLD: "Held for the Owner", HOLD_RELEASED: "Released by the Owner",
  HOLD_REJECTED: "Rejected by the Owner", SETTLING: "Running payment checks", DRY_RUN_ELIGIBLE: "Demo dry run: all checks passed",
  SETTLEMENT_BLOCKED: "Payment checks blocked", SETTLEMENT_SUBMITTED: "Sent to the payment service",
};
const HOLD_REASON: Record<string, string> = {
  HOURS_MISMATCH: "Hours mismatch", INCOMPLETE_EVIDENCE: "Incomplete evidence", CONFIRMATION_DELAY: "Confirmation delay", CONFLICTING_RECORDS: "Conflicting records", OVERLAPPING_WORK: "Overlapping work",
};

// The Pay Agent's checklist (Day 6, Step 1g), in plain words for the manager, the Owner and the worker:
// its verdict on each check. A concern on a held payment reads "held for the Owner".
const CHECK_TEXT: Record<string, [string, string]> = {
  hours: ["Hours match the accepted shift", "Hours don't match the accepted shift"],
  overlap: ["No overlapping confirmed work", "Overlaps other confirmed work at the same time"],
  timing: ["Confirmed in normal time after the shift", "Confirmed unusually long after the shift"],
  records: ["Records agree and nothing is missing", "Records disagree or something is missing"],
};
export function payAgentChecklist(event: Pick<PayAgentEventView, "checks" | "status">) {
  const checks = event.checks && typeof event.checks === "object" ? event.checks as Record<string, string> : null;
  if (!checks) return [];
  const held = event.status === "DECIDED_HOLD";
  return Object.entries(CHECK_TEXT).filter(([key]) => checks[key]).map(([key, [ok, concern]]) => checks[key] === "OK" ? { ok: true, text: ok } : { ok: false, text: held ? `${concern}: held for the Owner` : concern });
}
const RETRY: ReadonlySet<string> = new Set(["PENDING", "CLAIMED", "BLOCKED", "FAILED_RETRYABLE", "REJECTED_OUTPUT", "FAILED_TERMINAL", "DECIDED_SETTLE", "HOLD_RELEASED", "SETTLING", "DRY_RUN_ELIGIBLE", "SETTLEMENT_BLOCKED"]);

export type PayAgentEventView = {
  id: string; status: string; outcomeCode: string | null; errorClass: string | null; decision: string | null; reasonCode: string | null; summary: string | null; checks?: unknown;
  dryRun: boolean | null; configuredModel: string | null; responseModel: string | null; responseId: string | null;
  resolution: string | null; resolutionNote: string | null; resolvedAt: Date | null; attemptCount: number; updatedAt: Date;
};

// The AI service wasn't available (quota or rate limit, outage, timeout, no network, not set up), as
// opposed to an answer the agent couldn't use. Nothing was approved, reserved or sent, so the payment is
// held exactly as it was and checking again later is safe. Said plainly, never as a provider code.
export const AI_UNAVAILABLE_MESSAGE = "AI check unavailable — payment held, nothing lost; retry later.";
const AI_UNAVAILABLE_CLASSES: ReadonlySet<string> = new Set(["HTTP_429", "TIMEOUT", "NETWORK_ERROR", "NOT_CONFIGURED"]);
export function aiCheckUnavailable(event: Pick<PayAgentEventView, "status" | "outcomeCode" | "errorClass">) {
  return (event.status === "FAILED_RETRYABLE" || event.status === "FAILED_TERMINAL")
    && ["MODEL_FAILED", "MODEL_NOT_CONFIGURED", "ATTEMPTS_EXHAUSTED"].includes(event.outcomeCode ?? "")
    && !!event.errorClass && (AI_UNAVAILABLE_CLASSES.has(event.errorClass) || /^HTTP_5\d\d$/.test(event.errorClass));
}

// Only what a manager's screen needs: never the claim token, lease or evidence version.
export function toPayAgentEventView(event: PayAgentEventView): PayAgentEventView {
  const { id, status, outcomeCode, errorClass, decision, reasonCode, summary, checks, dryRun, configuredModel, responseModel, responseId, resolution, resolutionNote, resolvedAt, attemptCount, updatedAt } = event;
  return { id, status, outcomeCode, errorClass, decision, reasonCode, summary, checks: checks ?? null, dryRun, configuredModel, responseModel, responseId, resolution, resolutionNote, resolvedAt, attemptCount, updatedAt };
}

export function managerPayAgentView(event: PayAgentEventView) {
  const unavailable = aiCheckUnavailable(event);
  return {
    status: unavailable ? "AI check unavailable" : MANAGER_STATUS[event.status] ?? "Recorded",
    decision: event.decision === "SETTLE" ? "Settle" : event.decision === "HOLD" ? "Hold for the Owner" : null,
    reason: event.reasonCode ? HOLD_REASON[event.reasonCode] ?? event.reasonCode : null,
    summary: event.summary,
    explanation: unavailable ? AI_UNAVAILABLE_MESSAGE : payAgentOutcomeExplanation(event.outcomeCode),
    dryRun: event.dryRun === true,
    model: event.responseModel ?? event.configuredModel,
    responseId: event.responseId,
    canRetry: RETRY.has(event.status),
    canResolve: event.status === "DECIDED_HOLD",
    checklist: payAgentChecklist(event),
  };
}
