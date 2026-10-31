import Link from "next/link";
import { StatePanel, StatusBadge } from "@/app/components/product-ui";
import { money, scheduledHours } from "@/app/components/format";
import type { shifts } from "@/server/db/schema";

export { money, scheduledHours };

// Always the work location's time: there is deliberately no default zone.
export function dateTime(value: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-ZA", { dateStyle: "medium", timeStyle: "short", timeZone }).format(value);
}

export function paymentLabel(status?: string | null) {
  switch (status) {
    case "NOT_EARNED": return "Target not met";
    case "EARNED": return "Awaiting approval";
    case "APPROVED": return "Approved";
    case "SUBMITTING": case "SUBMITTED": case "PROCESSING": return "Processing";
    case "PAID": return "Paid";
    case "FAILED": return "Needs attention";
    default: return "Awaiting shift result";
  }
}

// The payment lifecycle of a confirmed work payable: approval on the payable, then the
// state of its PayPal payout. "Paid" appears only once PayPal reports the item paid.
export function payableLabel(status?: string | null, payout?: { status: string; paypalStatus?: string | null } | null) {
  switch (payout?.status) {
    case "SUBMITTING": return "Processing";
    case "PROCESSING": return payout.paypalStatus === "UNCLAIMED" ? "Processing · awaiting PayPal claim" : payout.paypalStatus === "ONHOLD" ? "Processing · on hold at PayPal" : "Processing";
    case "PAID": return "Paid";
    case "FAILED": return "Needs attention";
    case "RECONCILIATION_REQUIRED": return "Payment status being confirmed";
  }
  return status === "PENDING_REVIEW" ? "Awaiting approval" : status === "APPROVED" ? "Approved" : "Status unavailable";
}

export function PayableBadge({ status, payout }: { status?: string | null; payout?: { status: string; paypalStatus?: string | null } | null }) {
  const tone = payout?.status === "PAID" ? "success" : payout?.status === "FAILED" ? "danger" : payout?.status === "RECONCILIATION_REQUIRED" || !["PENDING_REVIEW", "APPROVED"].includes(status ?? "") ? "warning" : "neutral";
  return <StatusBadge tone={tone}>{payableLabel(status, payout)}</StatusBadge>;
}

// Accepted terms a base payable was calculated from, e.g. "£12.00/hour × 6 hours scheduled".
export function payableBasis(payable: { earningsModel: string; rateMinor: number; currencyCode: string; scheduledStartsAt: Date; scheduledEndsAt: Date }) {
  return payable.earningsModel === "HOURLY"
    ? `${money(payable.rateMinor, payable.currencyCode)}/hour × ${scheduledHours(payable.scheduledStartsAt, payable.scheduledEndsAt)} scheduled`
    : `${money(payable.rateMinor, payable.currencyCode)}/day · daily terms`;
}

// Totals per currency; amounts in different currencies are never added together.
export function currencyTotals(rows: readonly { amountMinor: number; currencyCode: string }[]) {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.currencyCode, (totals.get(row.currencyCode) ?? 0) + row.amountMinor);
  return [...totals].map(([currency, amount]) => money(amount, currency)).join(" · ");
}

// What a worker sees: plain states, with no provider codes. A held or unclaimed payout
// needs them to act; neither is paid.
export function workerPaymentLabel(status?: string | null, payout?: { status: string; paypalStatus?: string | null } | null) {
  if (payout?.status === "PROCESSING" && ["ONHOLD", "UNCLAIMED"].includes(payout.paypalStatus ?? "")) return "Action required";
  if (payout?.status === "RECONCILIATION_REQUIRED") return "Being confirmed";
  return payableLabel(status, payout);
}
export function WorkerPaymentBadge({ status, payout }: { status?: string | null; payout?: { status: string; paypalStatus?: string | null } | null }) {
  const label = workerPaymentLabel(status, payout);
  return <StatusBadge tone={label === "Paid" ? "success" : label === "Needs attention" ? "danger" : label === "Action required" || label === "Being confirmed" ? "warning" : "neutral"}>{label}</StatusBadge>;
}

export function PaymentBadge({ status }: { status?: string | null }) {
  return <StatusBadge tone={status === "PAID" ? "success" : status === "FAILED" ? "danger" : "neutral"}>{paymentLabel(status)}</StatusBadge>;
}

export function ShiftTerms({ shift, locationName, timeZone }: { locationName: string; timeZone: string; shift: Pick<typeof shifts.$inferSelect, "startsAt" | "endsAt" | "guaranteedBasePayMinor" | "incentiveAmountMinor" | "currencyCode"> & Partial<Pick<typeof shifts.$inferSelect, "incentiveTargetMinor" | "incentiveBasis" | "earningsModel" | "rateMinor" | "commissionBps" | "expectedEarningsMinor">> }) {
  const model = shift.earningsModel ?? "DAILY";
  return <dl className="shift-terms">
    <div><dt>Location</dt><dd>{locationName}</dd></div>
    <div><dt>Starts · {timeZone}</dt><dd>{dateTime(shift.startsAt, timeZone)}</dd></div>
    <div><dt>Ends · {timeZone}</dt><dd>{dateTime(shift.endsAt, timeZone)}</dd></div>
    <div><dt>Earnings model</dt><dd>{model === "COMMISSION" ? "Commission" : model === "HOURLY" ? "Hourly" : "Daily"}</dd></div>
    {model === "COMMISSION" ? <><div><dt>Commission rate</dt><dd>{(shift.commissionBps ?? 0) / 100}%</dd></div><div><dt>Basis</dt><dd>Verified attributed sales</dd></div></> : <><div><dt>Rate</dt><dd>{money(shift.rateMinor ?? shift.guaranteedBasePayMinor, shift.currencyCode)}{model === "HOURLY" ? "/hour" : "/day"}</dd></div>{model === "HOURLY" ? <div><dt>Scheduled duration</dt><dd>{scheduledHours(shift.startsAt, shift.endsAt)}</dd></div> : null}<div><dt>Expected work earnings</dt><dd>{money(shift.expectedEarningsMinor ?? shift.guaranteedBasePayMinor, shift.currencyCode)}</dd></div></>}
    {shift.incentiveAmountMinor > 0 ? <div><dt>Potential incentive</dt><dd>{money(shift.incentiveAmountMinor, shift.currencyCode)}</dd></div> : null}
    {shift.incentiveBasis ? <><div><dt>Individual sales target</dt><dd>{money(shift.incentiveTargetMinor ?? 0, shift.currencyCode)}</dd></div><div><dt>Potential total</dt><dd>{money((shift.expectedEarningsMinor ?? shift.guaranteedBasePayMinor) + shift.incentiveAmountMinor, shift.currencyCode)}</dd></div></> : null}
  </dl>;
}

export function WorkspaceUnavailable() {
  return <StatePanel title="Workspace information is unavailable" tone="warning"><p>Your information could not be loaded. Please try again shortly.</p></StatePanel>;
}

export function TaskLink({ href, title, children }: { href: string; title: string; children: React.ReactNode }) {
  return <Link className="task-link" href={href}><strong>{title}</strong><span>{children}</span></Link>;
}

const FEEDBACK: Record<string, string> = {
  "commerce-not-configured": "Commerce connections are not configured in this environment.",
  "commerce-location": "That location is not available.",
  "commerce-not-connected": "This location has no Zettle connection.",
  "commerce-sync-running": "A sync is already running for this location.",
  "zettle-credentials-rejected": "Zettle did not accept that client ID and API key. Nothing was connected.",
  "zettle-scope-missing": "That API key cannot read purchases. Create one with the purchase permission. Nothing was connected.",
  "zettle-unavailable": "Zettle could not be reached, so the connection could not be checked. Nothing was connected.",
  "zettle-already-connected": "This location or Zettle account already has a connection.",
  "zettle-sync-failed": "The sync did not complete. Existing sales history is unchanged. See the location below.",
  "time-invalid": "Enter a valid date and time.",
  "time-nonexistent": "That time does not exist at this location, because the clocks go forward then. Choose another time.",
  "time-ambiguous": "That time happens twice at this location, because the clocks go back then. Choose another time.",
  "time-unknown_timezone": "This location has no valid time zone, so shift times cannot be set. Ask the business owner to check it.",
  "invalid-duration": "The end must be after the start.",
  "earnings-not-whole": "These hours and this rate do not come to a whole amount. Adjust the times.",
  "policy-currency": "This work policy is not in this location’s currency.",
  "policy-rate": "This work policy has no pay rate.",
  "worker-unavailable": "This person has marked themselves unavailable for this shift.",
  "worker-working": "This person is already working at that time.",
  "worker-not-activated": "This person has not activated their FairShift account yet, so they cannot see an offer.",
  "already-offered": "This person already has an offer for this shift.",
  "shift-ended": "This shift has already finished, so it can no longer be accepted.",
  "policy-incentive": "A sales target and bonus must both be set, as amounts above zero, on hourly or daily terms.",
  "performance-required": "Confirm this shift’s sales results before approving its payment.",
  "sales-changed": "Sales for this shift changed after you opened this page. Check the new figures and confirm again.",
  "work-not-confirmed": "Confirm the work before its sales results.",
  "import-format": "The first line must be: transaction_id,attribution_code,occurred_at,amount,currency. An import can have at most 2,000 rows.",
  "terms-changed": "The details of this work changed. Check the new details before responding.",
};

export function ActionFeedback({ status }: { status?: string }) {
  if (!status) return null;
  return <StatePanel title={status === "saved" ? "Changes saved" : "Action could not be completed"} tone={status === "saved" ? "success" : "warning"}>
    {status !== "saved" ? <p>{FEEDBACK[status] ?? "Reload this page and check the current state before trying again. No payment confirmation is implied."}</p> : null}
  </StatePanel>;
}
