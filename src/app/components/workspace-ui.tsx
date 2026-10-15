import Link from "next/link";
import { StatePanel, StatusBadge } from "@/app/components/product-ui";
import type { shifts } from "@/server/db/schema";

export function money(value: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value / 100);
}

export function dateTime(value: Date) {
  return new Intl.DateTimeFormat("en-ZA", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Johannesburg" }).format(value);
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

export function PaymentBadge({ status }: { status?: string | null }) {
  return <StatusBadge tone={status === "PAID" ? "success" : status === "FAILED" ? "danger" : "neutral"}>{paymentLabel(status)}</StatusBadge>;
}

export function ShiftTerms({ shift }: { shift: Pick<typeof shifts.$inferSelect, "startsAt" | "endsAt" | "guaranteedBasePayMinor" | "incentiveAmountMinor" | "currencyCode"> }) {
  return <dl className="shift-terms">
    <div><dt>Starts · Johannesburg time</dt><dd>{dateTime(shift.startsAt)}</dd></div>
    <div><dt>Ends · Johannesburg time</dt><dd>{dateTime(shift.endsAt)}</dd></div>
    <div><dt>Guaranteed base pay</dt><dd>{money(shift.guaranteedBasePayMinor, shift.currencyCode)}</dd></div>
    <div><dt>Optional incentive</dt><dd>{money(shift.incentiveAmountMinor, shift.currencyCode)}</dd></div>
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
