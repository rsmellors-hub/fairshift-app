// How a payment is going, in words anyone can follow. Each step is reached only on the
// provider state that proves it: a request sent to PayPal is not a payment made, so only
// PayPal's own success marks Paid, and a held or failed payment stops where it is.
import { refusalText, type PayoutRefusal } from "@/server/domain/payout-refusal";

type Payout = { status: string; paypalStatus?: string | null; refusal?: PayoutRefusal | null } | null | undefined;
type StepState = "done" | "current" | "todo" | "problem";

const row = (labels: readonly string[], reached: number, problem = false) => labels.map((label, index) => ({ label, state: (index < reached ? "done" : index === reached ? problem ? "problem" : "current" : "todo") as StepState }));

export function payoutProgress(status: string | null | undefined, payout: Payout) {
  // The last step reads "Paid" only once it is true.
  const labels = ["Approved", "Sent to PayPal", "Processing", "PayPal confirms payment"] as const;
  switch (payout?.status) {
    case "PAID": return { steps: [...labels.slice(0, 3), "Paid"].map(label => ({ label, state: "done" as StepState })), note: null };
    // Refused outright (no batch): nothing was sent, so "Sent to PayPal" is never ticked.
    case "FAILED": return payout.refusal
      ? { steps: row(["Approved", "Refused by PayPal", "Processing", "PayPal confirms payment"], 1, true), note: `${refusalText(payout.refusal)}. Nothing has been paid.` }
      : { steps: row(labels, 2, true), note: "PayPal did not complete this payment. Nothing has been paid." };
    case "RECONCILIATION_REQUIRED": return { steps: row(labels, 1, true), note: "PayPal’s answer wasn’t received, so this payment is unconfirmed." };
    case "SUBMITTING": return { steps: row(labels, 1), note: null };
    case "PROCESSING": return { steps: row(labels, 2, ["ONHOLD", "UNCLAIMED"].includes(payout.paypalStatus ?? "")), note: payout.paypalStatus === "ONHOLD" ? "Held at PayPal. Nothing is paid until PayPal reports success." : payout.paypalStatus === "UNCLAIMED" ? "Waiting to be claimed at PayPal. Nothing is paid until PayPal reports success." : null };
  }
  return status === "APPROVED" ? { steps: row(labels, 0).map((step, index) => index === 0 ? { ...step, state: "done" as StepState } : step), note: payout?.status === "NOT_SENT" ? "PayPal did not receive the last request, so nothing was paid." : null } : { steps: row(labels, -1), note: null };
}

export function PayoutProgress({ status, payout }: { status?: string | null; payout?: Payout }) {
  const { steps, note } = payoutProgress(status, payout);
  return <div className="payout-progress"><ol aria-label="Payment progress">{steps.map(step => <li key={step.label} data-state={step.state} aria-current={step.state === "current" || step.state === "problem" ? "step" : undefined}>{step.label}</li>)}</ol>{note ? <p className="note">{note}</p> : null}</div>;
}

// The Manager's four decisions on finished work, with how many are waiting at each.
export function ReviewStages({ stages }: { stages: readonly { label: string; waiting: number; href: string }[] }) {
  return <ol className="review-stages" aria-label="Review steps">{stages.map(stage => <li key={stage.label}><a href={stage.href}><strong>{stage.label}</strong><span>{stage.waiting === 0 ? "Nothing waiting" : `${stage.waiting} waiting`}</span></a></li>)}</ol>;
}
