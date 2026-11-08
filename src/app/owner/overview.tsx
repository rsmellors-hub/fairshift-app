"use client";

import { rand } from "@/app/components/format";
import { useState } from "react";
import Link from "next/link";
import type { OwnerForecastSummary, OwnerOverviewData, OwnerStaffingSummary, SalesSeries } from "@/server/product/owner-overview";

// Rand as "R…" (format.ts); other currencies as before.
const money = (minor: number, currency: string) => currency === "ZAR" ? rand(minor) : new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(minor / 100);
const dateLabel = (date: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
const sourceLabel = (series: SalesSeries) => ({ REFERENCE: "Reference sales history", DEMO_SEEDED: "Demo / seeded history", PAYPAL_SANDBOX: "Actual · PayPal Sandbox", IMPORTED: "Imported sales history", ZETTLE: "Earlier connected-account sales", SQUARE: "Square Sandbox sales" })[series.source];
const shortDate = (date: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
const hours = (minutes: number) => `${new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(minutes / 60)} h`;
const wholeMoney = (minor: number, currency: string) => currency === "ZAR" ? rand(minor, { whole: true }) : new Intl.NumberFormat("en-GB", { style: "currency", currency, maximumFractionDigits: 0 }).format(minor / 100);
const evidenceLabel = { REFERENCE: "reference history", DEMO_SEEDED: "demo history", PAYPAL_SANDBOX: "verified PayPal Sandbox sales", IMPORTED: "imported history", ZETTLE: "earlier connected-account sales", SQUARE: "Square Sandbox sales" } as const;
const sourceNote = (series: SalesSeries) => ({
  REFERENCE: "Labelled synthetic reference history for a fictional hospitality group, not Square, PayPal or other provider sales.",
  DEMO_SEEDED: "Synthetic demo sales, not provider-verified commerce.",
  PAYPAL_SANDBOX: "Completed, verified and reconciled PayPal Sandbox sales only.",
  IMPORTED: "Imported sales history supplied for this business, not verified by a payment provider.",
  ZETTLE: "Completed sales retrieved from a previously connected account. Refunds are not deducted.",
  SQUARE: "Completed payments retrieved from a connected Square Sandbox seller, gross of refunds. Test money, not trading.",
})[series.source];

export function OwnerReload() {
  return <button type="button" className="secondary-button" onClick={() => window.location.reload()}>Reload Overview</button>;
}

function SalesChart({ series }: { series: SalesSeries }) {
  const max = Math.max(...series.days.map(day => day.amountMinor ?? 0), 1);
  return <figure className="owner-sales-figure">
    <figcaption>{sourceLabel(series)} · {series.currency}</figcaption>
    <ol className="day-bars" aria-label={`Recorded sales by day. ${dateLabel(series.start)} to ${dateLabel(series.end)}. Recorded total ${money(series.totalMinor, series.currency)}. Missing days are unknown.`}>
      {series.days.map(day => <li key={day.date} title={day.amountMinor === null ? `${dateLabel(day.date)}: no recorded sales data` : `${dateLabel(day.date)}: ${money(day.amountMinor, series.currency)}`}>
        <span className="day-bar-value">{day.amountMinor === null ? "No data" : wholeMoney(day.amountMinor, series.currency)}</span>
        <span className="day-bar-track" aria-hidden="true">{day.amountMinor === null ? null : <span style={{ height: `${Math.max(day.amountMinor / max * 100, 2)}%` }} />}</span>
        <span className="day-bar-label">{shortDate(day.date)}</span>
      </li>)}
    </ol>
  </figure>;
}

// How each location's casual gap compares. Rows the week can't be calculated for say so.
function GapByLocation({ data, staffing }: { data: OwnerOverviewData; staffing: OwnerStaffingSummary }) {
  const rows = data.locations.filter(location => location.active).map(location => ({ location, row: staffing.outlets.find(item => item.id === location.id) }));
  const max = Math.max(...rows.map(({ row }) => row?.casualGapMinutes ?? 0), 1);
  return <ul className="gap-bars">{rows.map(({ location, row }) => <li key={location.id}>
    <Link href={`/owner/locations/${location.id}`}>{location.name}</Link>
    <span className="gap-bar-track" aria-hidden="true">{row?.casualGapMinutes ? <span style={{ width: `${row.casualGapMinutes / max * 100}%` }} /> : null}</span>
    <strong>{row?.casualGapMinutes == null ? "Not available" : hours(row.casualGapMinutes)}</strong>
  </li>)}</ul>;
}

// forecast/staffing: undefined = not requested, null = failed to load (never zero demand or zero gap).
export function OwnerOverview({ data, forecast, staffing }: { data: OwnerOverviewData; forecast?: OwnerForecastSummary | null; staffing?: OwnerStaffingSummary | null }) {
  const gap = staffing?.consolidated;
  const gapByLocation = new Map(staffing?.outlets.map(row => [row.id, row]) ?? []);
  const week = forecast?.consolidated;
  const forecastByLocation = new Map(forecast?.outlets.map(row => [row.id, row]) ?? []);
  const forecastedLocations = forecast?.outlets.filter(row => row.weeklyTotalMinor !== null).length ?? 0;
  // The history driving the forecast leads, when there is one; the rest stay selectable.
  const defaultSeries = data.series.find(row => row.source === week?.source && row.currency === week?.currency) ?? data.series[0];
  const [selected, setSelected] = useState(defaultSeries?.key ?? "");
  const series = data.series.find(row => row.key === selected) ?? data.series[0];
  const failed = data.attention?.filter(row => row.status === "FAILED").length ?? 0;
  const earned = data.attention?.filter(row => row.status === "EARNED").length ?? 0;
  const payables = data.payables;
  const economics = staffing?.commercial;
  const costLabel = (cost: { lowMinor: number; highMinor: number }, currency: string) => cost.lowMinor === cost.highMinor ? wholeMoney(cost.lowMinor, currency) : `${wholeMoney(cost.lowMinor, currency)} – ${wholeMoney(cost.highMinor, currency)}`;
  const attentionCount = data.attention === null ? null : data.attention.length + (payables ? payables.awaitingApproval + payables.needsAttention : 0);
  const blockedText = { NO_FORECAST: "No forecast: not enough eligible sales history", NO_TIMED_HISTORY: "Sales history has no transaction times", TRADING_HOURS_NOT_SET: "Trading hours not set, so the gap is unavailable", NO_WORKLOAD_POLICY: "Service capacity not set, so required staff is unavailable", REGULAR_COVERAGE_NOT_SET: "Regular coverage not set, so the gap is unavailable" } as const;
  return <div className="owner-overview">
    <header className="owner-heading"><div><p className="eyebrow">{data.locations.length > 1 ? "All Locations" : data.locations[0]?.name ?? "Your business"}{gap ? ` · Planning week ${shortDate(gap.firstDate)} – ${dateLabel(gap.lastDate)}` : ""}</p><h1>Overview</h1></div><Link className="primary-button button-link" href="/owner/forecast">See the staffing gap</Link></header>
    <section className="owner-decisions" aria-label="Business decisions">
      <div><h2>Latest recorded sales</h2><strong className={series ? "" : "owner-metric-empty"}>{series ? wholeMoney(series.totalMinor, series.currency) : data.salesUnavailable ? "Unavailable" : "No sales data"}</strong><p>{series ? `${sourceLabel(series)} · 7 days to ${dateLabel(series.end)}` : "Sales will appear when eligible history is available."}</p></div>
      <div><h2>Forecast sales</h2><strong className={week ? "" : "owner-metric-empty"}>{week ? wholeMoney(week.totalMinor, week.currency) : forecast === null ? "Unavailable" : forecastedLocations ? "By location" : "Not available"}</strong><p>{week ? `Next 7 days · from ${evidenceLabel[week.source]} through ${dateLabel(week.dataThrough)}` : forecast === null ? "The weekly forecast could not be loaded. No demand has been assumed." : forecast === undefined ? "The weekly forecast is not available." : forecastedLocations ? `${forecastedLocations} of ${forecast.outlets.length} locations forecast separately; they cannot be combined.` : "No location has enough eligible sales history for a forecast."}</p><Link href="/owner/forecast">View forecast <span aria-hidden="true">→</span></Link></div>
      <div className="metric-gap"><h2>Casual labour gap</h2><strong className={gap ? "" : "owner-metric-empty"}>{gap ? hours(gap.casualGapMinutes) : staffing === null ? "Unavailable" : staffing?.outlets.some(row => row.casualGapMinutes !== null) ? "By location" : "Not available"}</strong><p>{gap ? `Required ${hours(gap.requiredMinutes)}, covered ${hours(gap.coverageMinutes)} · approx. ${gap.indicativeShifts} shifts to fill${economics?.cost ? ` · est. ${costLabel(economics.cost, economics.currency)}` : ""}` : staffing === null ? "Coverage could not be loaded. No gap has been assumed." : "A company staffing week needs a forecast, service capacity, trading hours and regular coverage at every location."}</p></div>
      <div><h2>Approvals & payment issues</h2><strong className={attentionCount === null ? "owner-metric-empty" : ""}>{attentionCount === null ? "Unavailable" : attentionCount}</strong><p>{data.attention === null ? "Attention items could not be loaded." : `${earned + (payables?.awaitingApproval ?? 0)} awaiting manager approval · ${failed + (payables?.needsAttention ?? 0)} failed payments`}</p><Link href="/owner/payments">Review payments <span aria-hidden="true">→</span></Link></div>
    </section>
    <div className="overview-columns">
      <section aria-labelledby="owner-gap-title" className="panel"><h2 id="owner-gap-title">Where are we short next week?</h2>
        <p className="panel-lede">Hours of casual cover needed beyond regular staff and allocated shifts.</p>
        {staffing ? <GapByLocation data={data} staffing={staffing} /> : <p>{staffing === null ? "Coverage could not be loaded. No gap has been assumed." : "Not available"}</p>}
        <p><Link className="text-link" href="/owner/forecast">Open forecast by day <span aria-hidden="true">→</span></Link></p>
      </section>
      <section className="panel owner-attention" aria-labelledby="owner-attention-title"><h2 id="owner-attention-title">Needs attention</h2>
        {staffing && (staffing.blocked.length || staffing.largestGaps.length) ? <ul>{staffing.blocked.map(item => <li key={item.id}><Link href={`/owner/locations/${item.id}`}><strong>{blockedText[item.reason]}</strong><span>{item.name}</span></Link></li>)}{staffing.largestGaps.map(item => <li key={`${item.id}-${item.date}`}><Link href={`/owner/locations/${item.id}`}><strong>{hours(item.minutes)} casual labour gap</strong><span>{item.name} · {dateLabel(item.date)}</span></Link></li>)}</ul> : null}
        {staffing && staffing.gapDays > staffing.largestGaps.length ? <p className="note">{staffing.gapDays - staffing.largestGaps.length} other planning days also have a casual labour gap.</p> : null}
        {payables && payables.awaitingApproval + payables.needsAttention ? <ul><li><Link href="/owner/payments"><strong>{payables.awaitingApproval} confirmed work awaiting approval · {payables.needsAttention} payouts need attention</strong><span>Across your locations</span></Link></li></ul> : null}
        {data.attention === null ? <p role="alert">Payment attention could not be loaded. <Link href="/owner/payments">Review payments</Link> or reload Overview.</p> : data.attention.length ? <><ul>{data.attention.slice(0, 5).map(item => <li key={item.id}><Link href="/owner/payments"><strong>{item.status === "FAILED" ? "Incentive payment failed" : "Incentive awaiting manager approval"}</strong><span>{item.locationName} · {dateLabel(item.date)}</span></Link></li>)}</ul>{data.attention.length > 5 ? <Link href="/owner/payments">View all {data.attention.length} items</Link> : null}</> : <p className="note">No incentive approvals or failed payments recorded.</p>}
      </section>
    </div>
    <section className="panel owner-sales" aria-labelledby="owner-sales-title"><div className="panel-head"><h2 id="owner-sales-title">Latest recorded sales week</h2><Link className="text-link" href="/owner/reporting">View sales <span aria-hidden="true">→</span></Link></div>
      {data.series.length > 1 ? <div className="owner-source"><label htmlFor="owner-sales-source">Sales source & currency</label><select id="owner-sales-source" value={series.key} onChange={event => setSelected(event.target.value)}>{data.series.map(row => <option key={row.key} value={row.key}>{sourceLabel(row)} · {row.currency}</option>)}</select></div> : null}
      {series ? <><SalesChart series={series} /><p className="note">{sourceNote(series)} Data through {dateLabel(series.end)}. Missing days are unknown, not zero.</p></> : <div className="owner-empty" role={data.salesUnavailable ? "alert" : "status"}><h3>{data.salesUnavailable ? "Sales could not be loaded" : "No sales history available"}</h3><p>{data.salesUnavailable ? "Other sections remain available. Reload to try sales again." : "Eligible sales history is needed to show business performance. No revenue has been assumed."}</p>{data.salesUnavailable ? <OwnerReload /> : null}</div>}
    </section>
    <section className="owner-pulse" aria-labelledby="owner-pulse-title"><h2 id="owner-pulse-title">Location comparison</h2>
      {data.locations.length ? <div className="table-frame"><table className="data-table"><caption className="visually-hidden">Location sales and weekly planning availability. Select a location to open it.</caption><thead><tr><th scope="col">Location</th><th scope="col">Recorded sales</th><th scope="col">Weekly forecast</th><th scope="col">Casual labour gap</th><th scope="col">Estimated cost to fill</th><th scope="col">Sales source</th></tr></thead><tbody>{data.locations.map(location => {
        const sales = series?.locations.find(row => row.id === location.id);
        return <tr key={location.id}><th scope="row"><Link href={`/owner/locations/${location.id}`}><strong>{location.name}</strong></Link>{!location.active ? <small>Inactive location</small> : null}</th><td data-label="Recorded sales"><strong>{sales?.amountMinor != null && series ? wholeMoney(sales.amountMinor, series.currency) : data.salesUnavailable ? "Unavailable" : "No data"}</strong>{sales?.amountMinor != null ? <small>{sales.observedDays} of 7 days with records</small> : null}</td><td data-label="Weekly forecast">{(() => { const row = forecastByLocation.get(location.id); return row?.weeklyTotalMinor != null && row.currency ? <strong>{wholeMoney(row.weeklyTotalMinor, row.currency)}</strong> : forecast === null ? "Unavailable" : "Not available"; })()}</td><td data-label="Casual labour gap">{(() => { const row = gapByLocation.get(location.id); return row?.casualGapMinutes != null ? <><strong>{hours(row.casualGapMinutes)}</strong><small>approx. {row.indicativeShifts} shifts</small></> : staffing === null ? "Unavailable" : "Not available"; })()}</td><td data-label="Estimated cost to fill">{(() => { const row = gapByLocation.get(location.id); return row?.cost && row.currency ? costLabel(row.cost, row.currency) : "Not available"; })()}</td><td data-label="Sales source">{data.salesUnavailable ? "Sales unavailable" : sales?.amountMinor == null ? "No history in period" : series?.source === "REFERENCE" ? "Reference data" : series?.source === "DEMO_SEEDED" ? "Demo history only" : series?.source === "SQUARE" ? "Square Sandbox" : series?.source === "ZETTLE" ? "Earlier connected account" : series?.source === "IMPORTED" ? "Imported history" : "Sandbox history"}</td></tr>;
      })}</tbody></table></div> : <p>No locations available in this organisation.</p>}
    </section>
  </div>;
}
