import Link from "next/link";
import { money } from "@/app/components/format";
import { StatusBadge } from "@/app/components/product-ui";
import { labourHours, wholeMoney } from "@/app/components/staffing";
import { selectLocationAction } from "@/app/auth-actions";
import type { OwnerForecastSummary, OwnerStaffingSummary } from "@/server/product/owner-overview";
import type { TodayNeeds } from "@/server/product/owner-today";

// Owner · Today (design, 10 Nov 2026): what needs the Owner, each linked to the one place it's resolved;
// the week's figures; and where each location is short, with a way straight into Fill shifts. Local
// signals sit in their own section with inline decisions (the same state Plan uses).
const day = (date: Date, timezone: string) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: timezone }).format(date);
const clock = (date: Date, timezone: string) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: timezone }).format(date);

export function TodayHeader({ name, date, timezone, addPersonHref }: { name: string; date: Date; timezone: string; addPersonHref: string }) {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: timezone }).format(date));
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return <header className="owner-heading"><div><p className="eyebrow">{new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: timezone }).format(date)}</p><h1>{greeting}{name ? `, ${name}` : ""}</h1></div>
    <Link className="secondary-button button-link" href={addPersonHref}>Add person</Link></header>;
}

export function NeedsYou({ needs, timezone, teamHref }: { needs: TodayNeeds; timezone: string; teamHref: string }) {
  const items = [
    needs.suggestions.count ? { href: "/manager/fill", at: null as string | null, title: `${needs.suggestions.count} suggested ${needs.suggestions.count === 1 ? "shift" : "shifts"} ready to send`, detail: needs.suggestions.locations.join(", "), ai: true } : null,
    needs.held ? { href: "/manager/review#needs-you", at: needs.heldAt, title: `${needs.held} ${needs.held === 1 ? "payment" : "payments"} held for your decision`, detail: "The Pay Agent found something to check", ai: true } : null,
    needs.unconfirmed.count ? { href: "/manager/review#needs-you", at: needs.unconfirmed.at, title: `${needs.unconfirmed.count} ${needs.unconfirmed.count === 1 ? "shift" : "shifts"} to confirm for pay`, detail: needs.unconfirmed.currency ? money(needs.unconfirmed.amountMinor, needs.unconfirmed.currency) : "", ai: false } : null,
    needs.queries ? { href: "/manager/review#pay-queries", at: needs.queriesAt, title: `${needs.queries} ${needs.queries === 1 ? "question" : "questions"} about pay from workers`, detail: "The Pay Agent has set out what’s recorded; you answer", ai: false } : null,
    needs.failedPayouts ? { href: "/manager/review#payouts", at: needs.failedAt, title: `${needs.failedPayouts} ${needs.failedPayouts === 1 ? "payout" : "payouts"} not paid`, detail: "PayPal didn’t complete them", ai: false } : null,
    needs.invitations.count ? { href: teamHref, at: null, title: `${needs.invitations.count} ${needs.invitations.count === 1 ? "invitation" : "invitations"} not accepted yet`, detail: needs.invitations.firstSent && needs.invitations.firstExpiry ? `Sent ${day(needs.invitations.firstSent, timezone)} · links expire ${day(needs.invitations.firstExpiry, timezone)}` : "", ai: false } : null,
  ].filter((item): item is NonNullable<typeof item> => !!item);
  return <section className="panel" id="needs-you" aria-labelledby="needs-you-title"><h2 id="needs-you-title">Needs you</h2>
    {items.length ? <ul className="needs-list">{items.map(item => { const body = <><strong>{item.title}</strong>{item.ai ? <> <StatusBadge tone="predictive">AI</StatusBadge></> : null}<small>{item.detail}</small><span aria-hidden="true"> →</span></>;
      // Pay works at one location: an item at a known location opens Pay there.
      return <li key={item.title}>{item.at ? <form action={selectLocationAction}><input type="hidden" name="locationId" value={item.at} /><input type="hidden" name="next" value={item.href} /><button className="needs-link">{body}</button></form> : <Link href={item.href}>{body}</Link>}</li>; })}</ul>
      : <p>Nothing needs you right now.</p>}
  </section>;
}

export function TodayTiles({ staffing, forecast, needs, timezone }: { staffing: OwnerStaffingSummary | null; forecast: OwnerForecastSummary | null; needs: TodayNeeds; timezone: string }) {
  const gap = staffing?.consolidated?.casualGapMinutes ?? null, shifts = staffing?.consolidated?.indicativeShifts ?? null;
  const tiles = [
    { label: "Staff hours still needed", value: gap === null ? "Not available" : labourHours(gap), small: shifts !== null ? `≈ ${shifts} shifts · ${staffing?.outlets.length ?? 0} locations` : "Needs sales history and staffing inputs" },
    { label: "Forecast sales", value: forecast?.consolidated ? wholeMoney(forecast.consolidated.totalMinor, forecast.consolidated.currency) : "Not available", small: "Next 7 days" },
    { label: "Shifts on offer", value: String(needs.offers.open + needs.offers.accepted), small: `${needs.offers.accepted} accepted${needs.offers.nextClose ? ` · round closes ${clock(needs.offers.nextClose, timezone)}` : ""}` },
    // The amount when the page has it; otherwise the shift count is the figure, never a bare dash.
    (() => { const shifts = `${needs.unconfirmed.count} ${needs.unconfirmed.count === 1 ? "shift" : "shifts"}`, failed = `${needs.failedPayouts} ${needs.failedPayouts === 1 ? "payout" : "payouts"} failed`;
      return needs.unconfirmed.currency ? { label: "Pay to confirm", value: money(needs.unconfirmed.amountMinor, needs.unconfirmed.currency), small: `${shifts} · ${failed}` } : { label: "Pay to confirm", value: shifts, small: failed }; })(),
  ];
  return <section className="kpi-tiles" aria-label="This week">{tiles.map(tile => <div className="panel kpi-tile" key={tile.label}><span className="eyebrow">{tile.label}</span><strong className="money">{tile.value}</strong><small>{tile.small}</small></div>)}</section>;
}

export function WhereShort({ staffing, names }: { staffing: OwnerStaffingSummary | null; names: Map<string, string> }) {
  const rows = (staffing?.outlets ?? []).filter(row => (row.casualGapMinutes ?? 0) > 0).sort((a, b) => (b.casualGapMinutes ?? 0) - (a.casualGapMinutes ?? 0));
  return <section className="panel" id="where-short" aria-labelledby="where-short-title"><div className="panel-head"><h2 id="where-short-title">Where you’re short next week</h2><Link className="text-link" href="/manager/plan">Open the plan <span aria-hidden="true">→</span></Link></div>
    {rows.length ? <ul className="short-list">{rows.map(row => <li key={row.id}><span>{names.get(row.id) ?? "Location"}</span><strong>{labourHours(row.casualGapMinutes!)}</strong>
      <form action={selectLocationAction}><input type="hidden" name="locationId" value={row.id} /><input type="hidden" name="next" value="/manager/fill" /><button className="link-button">Fill →</button></form></li>)}</ul>
      : <p>No location is short of casual cover next week, or the figures aren’t available yet.</p>}
  </section>;
}
