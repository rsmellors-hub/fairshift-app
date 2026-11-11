import Link from "next/link";
import { money } from "@/app/components/format";
import { StatusBadge } from "@/app/components/product-ui";
import type { WorkerShiftKind } from "@/app/worker/shift-cards";
import type { Cancellation } from "@/server/worker/cancellations";

// Home's 7-day strip, the offer picker and Shifts as Month | List (design, 10 Nov 2026). Every entry is
// one of the worker's own shifts, in the location's time; nothing is drawn that isn't a record.
type Row = { offer: { id: string; status: string }; shift: { id: string; startsAt: Date; endsAt: Date; roleName: string; currencyCode: string; expectedEarningsMinor: number | null; guaranteedBasePayMinor: number; earningsModel: string; status: string };
  departmentName: string | null; payable: { id: string } | null };
const dayKey = (date: Date, timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
const clock = (date: Date, timeZone: string) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(date);
const pay = (row: Row) => row.shift.earningsModel === "COMMISSION" ? "Commission" : money(row.shift.expectedEarningsMinor ?? row.shift.guaranteedBasePayMinor, row.shift.currencyCode);
const LABEL: Record<string, { text: string; tone: "success" | "predictive" | "neutral" | "warning" }> = {
  BOOKED: { text: "Booked", tone: "success" }, OFFER: { text: "Offer", tone: "predictive" }, WORKED: { text: "Worked", tone: "neutral" }, CANCELLED: { text: "Cancelled", tone: "warning" }, WAITING: { text: "Accepted · manager to confirm", tone: "neutral" },
};
export function calendarKind(row: Row, kind: WorkerShiftKind) {
  if (row.shift.status === "CANCELLED") return row.offer.status === "ACCEPTED" ? "CANCELLED" : null;
  if (kind === "OFFER" || kind === "CHANGED") return "OFFER";
  if (kind === "UPCOMING") return "BOOKED";
  if (kind === "ACCEPTED") return "WAITING";
  if (kind === "PAST") return "WORKED";
  return null;
}

export function HomeStrip<R extends Row>({ rows, kindOf, timezone, now }: { rows: R[]; kindOf: (row: R) => WorkerShiftKind; timezone: string; now: Date }) {
  const days = Array.from({ length: 7 }, (_, i) => new Date(now.getTime() + i * 86_400_000));
  return <section className="worker-section" aria-labelledby="week-strip-title"><h2 id="week-strip-title">Next 7 days</h2>
    <ol className="week-strip">{days.map(date => { const key = dayKey(date, timezone); const here = rows.filter(row => dayKey(row.shift.startsAt, timezone) === key && calendarKind(row, kindOf(row)));
      return <li key={key} className={here.length ? "has-shift" : undefined}><span>{new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: timezone }).format(date)}</span><strong>{new Intl.DateTimeFormat("en-GB", { day: "numeric", timeZone: timezone }).format(date)}</strong>
        {here.map(row => { const k = calendarKind(row, kindOf(row))!; return <small key={row.offer.id} className={`strip-${k.toLowerCase()}`}>{LABEL[k].text} {clock(row.shift.startsAt, timezone)}</small>; })}</li>; })}</ol>
  </section>;
}

// Offers as selectable cards: the selected one (the soonest by default) shows its full terms below.
export function OfferPicker({ rows, selected, timezone, basePath }: { rows: Row[]; selected: string; timezone: string; basePath: string }) {
  return <ul className="offer-picker">{rows.map(row => { const on = row.offer.id === selected; const date = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: timezone }).format(row.shift.startsAt);
    return <li key={row.offer.id}><Link href={`${basePath}?offer=${row.offer.id}#offers`} aria-current={on ? "true" : undefined} className={on ? "offer-pick selected" : "offer-pick"}>
      <strong>{date}</strong><span>{clock(row.shift.startsAt, timezone)}–{clock(row.shift.endsAt, timezone)} · {row.departmentName ?? row.shift.roleName}</span><span className="money">{pay(row)}</span></Link></li>; })}</ul>;
}

export function ShiftsList<R extends Row>({ rows, kindOf, timezone, cancellations }: { rows: R[]; kindOf: (row: R) => WorkerShiftKind; timezone: string; cancellations: Map<string, Cancellation> }) {
  const listed = rows.map(row => ({ row, kind: calendarKind(row, kindOf(row)) })).filter(item => item.kind).sort((a, b) => b.row.shift.startsAt.getTime() - a.row.shift.startsAt.getTime());
  if (!listed.length) return <p className="note">No shifts yet.</p>;
  return <ul className="shift-list">{listed.map(({ row, kind }) => { const c = kind === "CANCELLED" ? cancellations.get(row.shift.id) : undefined;
    return <li key={row.offer.id}><div><strong>{new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: timezone }).format(row.shift.startsAt)} · {clock(row.shift.startsAt, timezone)}–{clock(row.shift.endsAt, timezone)}</strong>
      <span>{row.departmentName ?? row.shift.roleName} · {pay(row)}</span>
      {kind === "CANCELLED" ? <small>{c ? `Cancelled by ${c.by} on ${new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: timezone }).format(c.at)}${c.percent !== null && c.windowMinutes !== null ? ` · rule: ${c.percent}% within ${Math.round(c.windowMinutes / 60)} h of the start` : " · no cancellation-pay rule on this shift"}${c.dueMinor !== null && c.currencyCode ? ` · cancellation pay due ${money(c.dueMinor, c.currencyCode)}` : ""}` : "Cancelled"}</small> : null}
      {kind === "WORKED" && row.payable ? <Link href={`/worker/pay/${row.payable.id}`}>See this shift’s pay →</Link> : null}</div>
      <StatusBadge tone={LABEL[kind!].tone}>{LABEL[kind!].text}</StatusBadge></li>; })}</ul>;
}

export function ShiftsMonth<R extends Row>({ rows, kindOf, timezone, now }: { rows: R[]; kindOf: (row: R) => WorkerShiftKind; timezone: string; now: Date }) {
  const [year, month] = dayKey(now, timezone).split("-").map(Number);
  const first = new Date(Date.UTC(year, month - 1, 1)), days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7;
  const cells = [...Array.from({ length: lead }, () => null), ...Array.from({ length: days }, (_, i) => i + 1)];
  return <div className="month-view"><h3>{new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(first)}</h3>
    <div className="month-grid" role="grid">{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(name => <span key={name} className="month-head" role="columnheader">{name}</span>)}
      {cells.map((date, i) => { if (!date) return <span key={`b${i}`} />; const key = `${year}-${String(month).padStart(2, "0")}-${String(date).padStart(2, "0")}`;
        const here = rows.filter(row => dayKey(row.shift.startsAt, timezone) === key).map(row => ({ row, kind: calendarKind(row, kindOf(row)) })).filter(item => item.kind);
        return <span key={key} role="gridcell" className={here.length ? "month-day has-shift" : "month-day"}><b>{date}</b>{here.map(({ row, kind }) => <small key={row.offer.id} className={`strip-${kind!.toLowerCase()}`}>{LABEL[kind!].text} {clock(row.shift.startsAt, timezone)}</small>)}</span>; })}</div></div>;
}
