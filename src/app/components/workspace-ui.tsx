import Link from "next/link";
import { StatePanel, StatusBadge } from "@/app/components/product-ui";
import { money, scheduledHours } from "@/app/components/format";
import type { shifts } from "@/server/db/schema";

export { money, scheduledHours };

// Always the work location's time: there is deliberately no default zone.
export function dateTime(value: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone }).format(value);
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
// state of its PayPal payout. "Paid" appears only once PayPal reports the item paid; a payout
// PayPal refused outright (no batch) is "Not paid" in every view.
type PayoutLabelInput = { status: string; paypalStatus?: string | null; refusal?: { reason: string | null } | null };
export function payableLabel(status?: string | null, payout?: PayoutLabelInput | null) {
  if (payout?.status === "FAILED" && payout.refusal) return "Not paid";
  switch (payout?.status) {
    case "SUBMITTING": return "Processing";
    case "PROCESSING": return payout.paypalStatus === "UNCLAIMED" ? "Processing · awaiting PayPal claim" : payout.paypalStatus === "ONHOLD" ? "Processing · on hold at PayPal" : "Processing";
    case "PAID": return "Paid";
    case "FAILED": return "Needs attention";
    case "RECONCILIATION_REQUIRED": return "Payment status being confirmed";
  }
  return status === "PENDING_REVIEW" ? "Awaiting approval" : status === "APPROVED" ? "Approved" : "Status unavailable";
}

export function PayableBadge({ status, payout }: { status?: string | null; payout?: PayoutLabelInput | null }) {
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
export function workerPaymentLabel(status?: string | null, payout?: PayoutLabelInput | null) {
  if (payout?.status === "PROCESSING" && ["ONHOLD", "UNCLAIMED"].includes(payout.paypalStatus ?? "")) return "Action required";
  if (payout?.status === "RECONCILIATION_REQUIRED") return "Being confirmed";
  return payableLabel(status, payout);
}
export function WorkerPaymentBadge({ status, payout }: { status?: string | null; payout?: PayoutLabelInput | null }) {
  const label = workerPaymentLabel(status, payout);
  return <StatusBadge tone={label === "Paid" ? "success" : label === "Needs attention" || label === "Not paid" ? "danger" : label === "Action required" || label === "Being confirmed" ? "warning" : "neutral"}>{label}</StatusBadge>;
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

// Outcomes that succeeded and still have something to explain.
const DONE: Record<string, string> = { "square-sale-recorded": "Sandbox payment created", "square-demo-shift-created": "Demo shift offered", "early-notice-sent": "Early notice sent" };
const FEEDBACK: Record<string, string> = {
  "commerce-not-configured": "Commerce connections are not configured in this environment.",
  "commerce-location": "That location is not available.",
  "commerce-not-connected": "This location has no sales connection.",
  "square-not-configured": "Square Sandbox is not configured in this environment.",
  "square-credentials-rejected": "Square did not accept the configured Sandbox credentials. Nothing was connected.",
  "square-unavailable": "Square could not be reached. Nothing was changed.",
  "square-location-choice": "The Square Sandbox seller must have exactly one active location to connect. Nothing was connected.",
  "square-location-currency": "That Square location trades in a different currency from this location. Nothing was connected.",
  "square-already-connected": "This location or Square seller already has a connection. One Square location connects to one FairShift location.",
  "square-sync-failed": "The sync did not complete. Existing sales history is unchanged. See the location below.",
  "square-mapping-worker": "That worker is not available at this location.",
  "square-mapping-identity": "Square does not list that team member at this location, so nothing was mapped.",
  "square-mapping-duplicate": "That worker or Square team member is already mapped.",
  "square-mapping-unavailable": "That mapping is not available.",
  "square-demo-disabled": "Sandbox demo tools are not available here.",
  "square-demo-amount": "Enter an amount such as 12.50, up to the Sandbox limit.",
  "square-demo-unmapped": "Map this worker to a Square team member first.",
  "square-demo-refused": "Square did not create this Sandbox payment. Nothing was recorded.",
  "square-demo-shift": "That demo shift could not be offered. Check the worker and the time.",
  "demo-reset": "The prepared demonstration state is back. Earlier completed evidence was not changed.",
  "square-sale-recorded": "Square created the Sandbox payment. It counts once FairShift has read it back from Square, within about 30 seconds.",
  "square-demo-shift-created": "Demo shift offered. The worker accepts it on their Shifts page, then you finalise it in Allocations.",
  "sales-evidence-incomplete": "Square hasn’t been checked since this shift ended, so these sales may be incomplete. Try again shortly.",
  "import-closed-connected": "This location’s sales come from Square, so they can’t be imported.",
  "commerce-sync-running": "A sync is already running for this location.",
  "time-invalid": "Enter a valid date and time.",
  "time-nonexistent": "That time does not exist at this location, because the clocks go forward then. Choose another time.",
  "time-ambiguous": "That time happens twice at this location, because the clocks go back then. Choose another time.",
  "time-unknown_timezone": "This location has no valid time zone, so shift times cannot be set. Ask the business owner to check it.",
  "invalid-duration": "The end must be after the start.",
  "earnings-not-whole": "These hours and this rate do not come to a whole amount. Adjust the times.",
  "policy-currency": "This work policy is not in this location’s currency.",
  "policy-rate": "This work policy has no pay rate.",
  "wage-below-minimum": "This pay is below the FairShift demo minimum, the 21-and-over rate for the shift's date, so it can't be offered. Ask the business owner to set at least that rate under Compensation.",
  "wage-reference-unavailable": "FairShift has no verified minimum wage rate for the shift's date, so it can't be offered. Nothing was created or sent.",
  "wage-not-checkable": "This pay can't be checked against the FairShift demo minimum (for example commission, or another currency), so it can't be offered here.",
  "worker-unavailable": "This person has marked themselves unavailable for this shift.",
  "worker-working": "This person is already working at that time.",
  "worker-not-activated": "This person has not activated their FairShift account yet, so they cannot see an offer.",
  "already-offered": "This person already has an offer for this shift.",
  "shift-ended": "This shift has already finished, so it can no longer be accepted.",
  "policy-incentive": "A sales target and bonus must both be set, as amounts above zero, on hourly or daily terms.",
  "sandbox-isolation-required": "Sandbox payments are unavailable in this environment or account.",
  "payout-investigation-required": "This payment is still unconfirmed. It cannot be safely resent. Investigate the original payout with PayPal before taking further payment action.",
  "payout-already-sent": "This payment has already gone to PayPal, so no second payment was made. Its status is below.",
  "payout-route-unverified": "A PayPal payout route for this South African business or location isn’t verified yet, so nothing was sent. The earnings stay recorded as unpaid.",
  "payout-currency-unverified": "PayPal payouts in this currency aren’t verified for FairShift yet, so nothing was sent. The earnings stay recorded as unpaid.",
  "provider-fx-rate-unavailable": "No ECB reference rate from the last three business days is recorded, so this payout can’t be prepared. The earnings stay recorded as unpaid.",
  "fx-rate-invalid": "Enter the ECB reference date and the EUR/ZAR and EUR/USD rates exactly as published. Nothing was recorded.",
  "fx-rate-exists": "A reference rate for that date is already recorded. Recorded rates can’t be changed.",
  "performance-required": "Confirm this shift’s sales results before approving its payment.",
  "pay-agent-hold": "The Pay Agent is holding this payment for review. Release or reject the hold first.",
  "pay-agent-rejected": "A manager rejected this payment, so it stays unpaid.",
  "pay-agent-hold-pending": "The Pay Agent is holding this payment for review. Release or reject the hold instead of retrying.",
  "pay-agent-hold-unavailable": "This hold has already been resolved or isn’t available. The current state is below.",
  "pay-agent-own-work": "A hold on your own work must be released by someone else.",
  "pay-agent-owner-decides": "A held payment is decided by the business owner.",
  "pay-agent-release-reason": "Give a reason for releasing this payment, in up to 500 characters.",
  "shift-filled": "This shift has been filled.", "suggestion-approved": "That suggested shift was already approved.",
  "pay-agent-reject-reason": "Give a reason for rejecting this payment, in up to 500 characters.",
  "pay-agent-nothing-to-retry": "There is nothing for the Pay Agent to retry for this payment. Its current state is below.",
  "pay-agent-unavailable": "This payment isn’t available here.",
  "sales-changed": "Sales for this shift changed after you opened this page. Check the new figures and confirm again.",
  "work-not-confirmed": "Confirm the work before its sales results.",
  "import-format": "The first line must be: transaction_id,attribution_code,occurred_at,amount,currency. An import can have at most 2,000 rows.",
  "terms-changed": "The details of this work changed. Check the new details before responding.",
  "opportunity-changed": "This casual requirement has changed since you opened it. No shift was created. Check the latest figures on Forecast & staffing.",
  "opportunity-outside-window": "This shift doesn’t overlap the time it’s meant to cover. No shift was created. Adjust the times, or create it without this requirement.",
  "service-capacity-invalid": "Service capacity must be a whole number of transactions from 1 to 1000. Nothing was saved.",
  "minimum-cover-invalid": "Minimum cover must be a whole number of staff from 0 to 100. Nothing was saved.",
  "early-notice-unavailable": "That alert is no longer current, so no notice was sent.",
  "early-notice-none": "Everyone this affects has already had the early notice. Nothing more was sent.",
  "demo-simulated": "Simulated in the public demo: nothing was sent.",
  "location-profile-invalid": "The location profile couldn’t be saved. Describe the area, the venue and its customers in a few words each, with no names, contact details or links. Nothing was saved.",
  "trading-hours-invalid": "Trading hours couldn’t be saved. Use 09:00-17:00 on quarter hours, separate times with commas, don’t overlap them, and write “closed” for a closed day. Nothing was saved.",
  "regular-coverage-invalid": "Regular coverage couldn’t be saved. Use 07:00-12:00 x3, separate times with commas, don’t overlap them, and write “none” for no regular staff. Nothing was saved.",
  "demo-read-only": "This part of the public demo can’t be changed. Provider actions and account settings are turned off here.",
  "demo-protected": "This is prepared demonstration evidence, so it can’t be changed.",
  "demo-full": "The demo schedule is full. Use Reset demo to restore the prepared state.",
  "demo-limit": "The demo is busy. Wait a few minutes and try again.",
  "demo-unavailable": "The demo isn’t available right now.",
};

export function ActionFeedback({ status, saved = "Changes saved" }: { status?: string; saved?: string }) {
  if (!status) return null;
  const done = status === "saved" ? saved : status === "demo-reset" ? "Demo restored" : DONE[status];
  return <StatePanel title={done ?? "Action could not be completed"} tone={done ? "success" : "warning"}>
    {status !== "saved" ? <p>{FEEDBACK[status] ?? "Reload this page and check the current state before trying again. No payment confirmation is implied."}</p> : null}
  </StatePanel>;
}
