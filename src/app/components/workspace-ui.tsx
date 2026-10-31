import Link from "next/link";
import { StatePanel, StatusBadge } from "@/app/components/product-ui";
import type { shifts } from "@/server/db/schema";

export function money(value: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value / 100);
}

export function dateTime(value: Date, timeZone = "Africa/Johannesburg") {
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

// Base payables of confirmed work. Only the review state exists: nothing has been approved or paid.
export function payableLabel(status?: string | null) {
  return status === "PENDING_REVIEW" ? "Awaiting approval" : "Status unavailable";
}

export function PayableBadge({ status }: { status?: string | null }) {
  return <StatusBadge tone={status === "PENDING_REVIEW" ? "neutral" : "warning"}>{payableLabel(status)}</StatusBadge>;
}

export function scheduledHours(startsAt: Date, endsAt: Date) {
  const hours = (endsAt.getTime() - startsAt.getTime()) / 3_600_000;
  return `${new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(hours)} ${hours === 1 ? "hour" : "hours"}`;
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

export function PaymentBadge({ status }: { status?: string | null }) {
  return <StatusBadge tone={status === "PAID" ? "success" : status === "FAILED" ? "danger" : "neutral"}>{paymentLabel(status)}</StatusBadge>;
}

export function ShiftTerms({ shift, locationName = "Rosebank Kitchen" }: { locationName?: string; shift: Pick<typeof shifts.$inferSelect, "startsAt" | "endsAt" | "guaranteedBasePayMinor" | "incentiveAmountMinor" | "currencyCode"> & Partial<Pick<typeof shifts.$inferSelect, "earningsModel" | "rateMinor" | "commissionBps" | "expectedEarningsMinor">> }) {
  const model = shift.earningsModel ?? "DAILY";
  return <dl className="shift-terms">
    <div><dt>Location</dt><dd>{locationName}</dd></div>
    <div><dt>Starts · Johannesburg time</dt><dd>{dateTime(shift.startsAt)}</dd></div>
    <div><dt>Ends · Johannesburg time</dt><dd>{dateTime(shift.endsAt)}</dd></div>
    <div><dt>Earnings model</dt><dd>{model === "COMMISSION" ? "Commission" : model === "HOURLY" ? "Hourly" : "Daily"}</dd></div>
    {model === "COMMISSION" ? <><div><dt>Commission rate</dt><dd>{(shift.commissionBps ?? 0) / 100}%</dd></div><div><dt>Basis</dt><dd>Verified attributed sales</dd></div></> : <><div><dt>Rate</dt><dd>{money(shift.rateMinor ?? shift.guaranteedBasePayMinor, shift.currencyCode)}{model === "HOURLY" ? "/hour" : "/day"}</dd></div>{model === "HOURLY" ? <div><dt>Scheduled duration</dt><dd>{scheduledHours(shift.startsAt, shift.endsAt)}</dd></div> : null}<div><dt>Expected work earnings</dt><dd>{money(shift.expectedEarningsMinor ?? shift.guaranteedBasePayMinor, shift.currencyCode)}</dd></div></>}
    <div><dt>Potential incentive</dt><dd>{money(shift.incentiveAmountMinor, shift.currencyCode)}</dd></div>
  </dl>;
}

export function WorkspaceUnavailable() {
  return <StatePanel title="Workspace information is unavailable" tone="warning"><p>Your information could not be loaded. Please try again shortly.</p></StatePanel>;
}

export function TaskLink({ href, title, children }: { href: string; title: string; children: React.ReactNode }) {
  return <Link className="task-link" href={href}><strong>{title}</strong><span>{children}</span></Link>;
}

export function ActionFeedback({ status }: { status?: string }) {
  if (!status) return null;
  return <StatePanel title={status === "saved" ? "Changes saved" : "Action could not be completed"} tone={status === "saved" ? "success" : "warning"}>
    {status !== "saved" ? <p>Reload this page and check the current state before trying again. No payment confirmation is implied.</p> : null}
  </StatePanel>;
}
