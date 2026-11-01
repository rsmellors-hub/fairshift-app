"use client";

import { useState } from "react";
import Link from "next/link";
import type { OwnerForecastSummary, OwnerOverviewData, OwnerStaffingSummary, SalesSeries } from "@/server/product/owner-overview";

const money = (minor: number, currency: string) => new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(minor / 100);
const dateLabel = (date: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
const sourceLabel = (series: SalesSeries) => ({ REFERENCE: "Reference sales history", DEMO_SEEDED: "Demo / seeded history", PAYPAL_SANDBOX: "Actual · PayPal Sandbox", IMPORTED: "Imported sales history", ZETTLE: "Earlier connected-account sales", SQUARE: "Square Sandbox sales" })[series.source];
const shortDate = (date: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
const hours = (minutes: number) => `${new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(minutes / 60)} h`;
const wholeMoney = (minor: number, currency: string) => new Intl.NumberFormat("en-GB", { style: "currency", currency, maximumFractionDigits: 0 }).format(minor / 100);
const evidenceLabel = { REFERENCE: "reference history", DEMO_SEEDED: "demo history", PAYPAL_SANDBOX: "verified PayPal Sandbox sales", IMPORTED: "imported history", ZETTLE: "earlier connected-account sales", SQUARE: "Square Sandbox sales" } as const;
const sourceNote = (series: SalesSeries) => ({
  REFERENCE: "Labelled synthetic reference history for a fictional retailer, not Square, PayPal or other provider sales.",
  DEMO_SEEDED: "Synthetic demo sales, not provider-verified commerce.",
  PAYPAL_SANDBOX: "Completed, verified and reconciled PayPal Sandbox sales only.",
  IMPORTED: "Imported sales history supplied for this business, not verified by a payment provider.",
  ZETTLE: "Completed sales retrieved from a previously connected account. Refunds are not deducted.",
  SQUARE: "Completed payments retrieved from a connected Square Sandbox seller, gross of refunds. Test money, not trading.",
})[series.source];

export function OwnerReload() {
  return <button type="button" className="owner-reload" onClick={() => window.location.reload()}>Reload Overview</button>;
}

function SalesChart({ series }: { series: SalesSeries }) {
  const max = Math.max(...series.days.map(day => day.amountMinor ?? 0), 1);
  return <figure className="owner-sales-figure">
    <figcaption>{sourceLabel(series)} · {series.currency}</figcaption>
    <svg viewBox="0 0 700 240" role="img" aria-labelledby="owner-chart-title owner-chart-description">
      <title id="owner-chart-title">Recorded sales by day</title>
      <desc id="owner-chart-description">{dateLabel(series.start)} to {dateLabel(series.end)}. Recorded total {money(series.totalMinor, series.currency)}. Missing days are unknown. Exact daily values follow in the data table.</desc>
      <text x="4" y="18" className="owner-chart-label">{money(max, series.currency)}</text>
      <line x1="0" x2="700" y1="28" y2="28" className="owner-chart-grid" />
      <line x1="0" x2="700" y1="200" y2="200" className="owner-chart-grid" />
      {series.days.map((day, i) => {
        const height = day.amountMinor === null ? 0 : day.amountMinor / max * 160;
        return <g key={day.date}>
          {day.amountMinor === null ? <text x={50 + i * 100} y="185" textAnchor="middle" className="owner-chart-label">—</text> :
            <rect x={24 + i * 100} y={200 - Math.max(height, 2)} width="52" height={Math.max(height, 2)} rx="3" className="owner-chart-bar"><title>{`${dateLabel(day.date)}: ${money(day.amountMinor, series.currency)}`}</title></rect>}
          <text x={50 + i * 100} y="225" textAnchor="middle" className="owner-chart-label">{day.date.slice(8)} {new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" }).format(new Date(`${day.date}T12:00:00Z`))}</text>
        </g>;
      })}
    </svg>
    <ul className="owner-mobile-series" aria-label="Recorded daily sales">{series.days.map(day => <li key={day.date}><span>{dateLabel(day.date).replace(/ \d{4}$/, "")}</span><span className="owner-mobile-bar" aria-hidden="true"><span style={{ width: `${day.amountMinor === null ? 0 : day.amountMinor / max * 100}%` }} /></span><strong>{day.amountMinor === null ? "No data" : money(day.amountMinor, series.currency)}</strong></li>)}</ul>
    <details className="owner-chart-data"><summary>Daily sales values</summary><table><caption>{sourceLabel(series)} · {series.currency}</caption><thead><tr><th scope="col">Date</th><th scope="col">Recorded sales</th></tr></thead><tbody>{series.days.map(day => <tr key={day.date}><th scope="row">{dateLabel(day.date)}</th><td>{day.amountMinor === null ? "No recorded sales data" : money(day.amountMinor, series.currency)}</td></tr>)}</tbody></table></details>
  </figure>;
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
  const percent = (value: number) => `${new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 }).format(value / 100)}%`;
  const costLabel = (cost: { lowMinor: number; highMinor: number }, currency: string) => cost.lowMinor === cost.highMinor ? wholeMoney(cost.lowMinor, currency) : `${wholeMoney(cost.lowMinor, currency)} – ${wholeMoney(cost.highMinor, currency)}`;
  const attentionCount = data.attention === null ? null : data.attention.length + (payables ? payables.awaitingApproval + payables.needsAttention : 0);
  const blockedText = { NO_FORECAST: "No forecast: not enough eligible sales history", NO_LABOUR_POLICY: "No labour policy, so required labour is unavailable", LABOUR_POLICY_CURRENCY_MISMATCH: "Labour policy is in another currency", REGULAR_COVERAGE_NOT_SET: "Regular coverage not set, so the gap is unavailable" } as const;
  return <div className="owner-overview">
    <header className="owner-heading"><div><p className="owner-eyebrow">Business performance & planning</p><h1>Overview</h1><p>{data.locations.length > 1 ? "All Locations" : data.locations[0]?.name ?? "Organisation overview"} · {series ? `${dateLabel(series.start)} – ${dateLabel(series.end)}` : "No sales period available"}</p></div><Link className="owner-link" href="/owner/forecast">View forecast <span aria-hidden="true">↗</span></Link></header>
    {data.series.length > 1 ? <div className="owner-source"><label htmlFor="owner-sales-source">Sales source & currency</label><select id="owner-sales-source" value={series.key} onChange={event => setSelected(event.target.value)}>{data.series.map(row => <option key={row.key} value={row.key}>{sourceLabel(row)} · {row.currency}</option>)}</select></div> : null}
    <section className="owner-decisions owner-decisions-six" aria-label="Business decisions">
      <div><h2>Latest recorded sales</h2><strong className={series ? "" : "owner-metric-empty"}>{series ? money(series.totalMinor, series.currency) : data.salesUnavailable ? "Unavailable" : "No sales data"}</strong><p>{series ? `${sourceLabel(series)} · 7 days to ${dateLabel(series.end)}` : "Sales will appear when eligible history is available."}</p></div>
      <div><h2>Forecast sales</h2><strong className={week ? "" : "owner-metric-empty"}>{week ? wholeMoney(week.totalMinor, week.currency) : forecast === null ? "Unavailable" : forecastedLocations ? "By location" : "Not available"}</strong><p>{week ? `Forecast · ${shortDate(week.firstTarget)} – ${dateLabel(week.lastTarget)} · from ${evidenceLabel[week.source]} through ${dateLabel(week.dataThrough)}` : forecast === null ? "The weekly forecast could not be loaded. No demand has been assumed." : forecast === undefined ? "The weekly forecast is not available." : forecastedLocations ? `${forecastedLocations} of ${forecast.outlets.length} locations forecast separately; they cannot be combined.` : "No location has enough eligible sales history for a forecast."}</p><Link href="/owner/forecast">View forecast <span aria-hidden="true">→</span></Link></div>
      <div><h2>Labour required</h2><strong className={gap ? "" : "owner-metric-empty"}>{gap ? hours(gap.requiredMinutes) : staffing === null ? "Unavailable" : "Not available"}</strong><p>{gap ? `To serve forecast demand · existing coverage ${hours(gap.coverageMinutes)}${economics?.comparable ? ` · forecast ${economics.comparable.deltaMinor >= 0 ? "+" : "−"}${wholeMoney(Math.abs(economics.comparable.deltaMinor), economics.currency)} against comparable days` : ""}` : "Needs a forecast, a labour policy and regular coverage at every location."}</p></div>
      <div><h2>Casual labour gap</h2><strong className={gap ? "" : "owner-metric-empty"}>{gap ? hours(gap.casualGapMinutes) : staffing === null ? "Unavailable" : staffing?.outlets.some(row => row.casualGapMinutes !== null) ? "By location" : "Not available"}</strong><p>{gap ? `Planning week ${shortDate(gap.firstDate)} – ${dateLabel(gap.lastDate)} · required ${hours(gap.requiredMinutes)}, existing coverage ${hours(gap.coverageMinutes)} · approx. ${gap.indicativeShifts} shifts to fill` : staffing === null ? "Coverage could not be loaded. No gap has been assumed." : "A company staffing week needs a forecast and regular coverage at every location."}</p><Link href="/owner/forecast">View staffing <span aria-hidden="true">→</span></Link></div>
      <div><h2>Estimated cost to fill</h2><strong className={economics?.cost ? "" : "owner-metric-empty"}>{economics?.cost ? costLabel(economics.cost, economics.currency) : staffing === null ? "Unavailable" : "Not available"}</strong><p>{economics?.cost ? `Estimate · remaining casual gap on each location’s work policies${economics.cost.highBpsOfForecast !== null ? ` · up to ${percent(economics.cost.highBpsOfForecast)} of forecast sales` : ""}. Casual labour only.` : "Needs a complete labour gap and a work policy at every location. No cost has been assumed."}</p></div>
      <div><h2>Approvals & payment issues</h2><strong className={attentionCount === null ? "owner-metric-empty" : ""}>{attentionCount === null ? "Unavailable" : attentionCount}</strong><p>{data.attention === null ? "Attention items could not be loaded." : `${earned + (payables?.awaitingApproval ?? 0)} awaiting manager approval · ${failed + (payables?.needsAttention ?? 0)} failed payments`}</p><Link href="/owner/payments">Review payments <span aria-hidden="true">→</span></Link></div>
    </section>
    <section className="owner-attention" aria-labelledby="owner-attention-title"><div className="owner-section-heading"><div><h2 id="owner-attention-title">Needs attention</h2><p>Missing planning inputs, the largest casual gaps, and approvals and failed payments across your locations.</p></div></div>
      {staffing && (staffing.blocked.length || staffing.largestGaps.length) ? <ul>{staffing.blocked.map(item => <li key={item.id}><Link href={`/owner/locations/${item.id}`}><span><strong>{blockedText[item.reason]}</strong><span>{item.name}</span></span><span className="owner-attention-action">Open location <span aria-hidden="true">→</span></span></Link></li>)}{staffing.largestGaps.map(item => <li key={`${item.id}-${item.date}`}><Link href={`/owner/locations/${item.id}`}><span><strong>{hours(item.minutes)} casual labour gap</strong><span>{item.name} · {dateLabel(item.date)}</span></span><span className="owner-attention-action">Open location <span aria-hidden="true">→</span></span></Link></li>)}</ul> : null}
      {staffing && staffing.gapDays > staffing.largestGaps.length ? <p className="owner-note">{staffing.gapDays - staffing.largestGaps.length} other planning days also have a casual labour gap. <Link href="/owner/forecast">See the planning week</Link>.</p> : null}
      {payables && payables.awaitingApproval + payables.needsAttention ? <ul><li><Link href="/owner/payments"><span><strong>{payables.awaitingApproval} confirmed work awaiting approval · {payables.needsAttention} payouts need attention</strong><span>Across your locations</span></span><span className="owner-attention-action">Review payments <span aria-hidden="true">→</span></span></Link></li></ul> : null}
      {data.attention === null ? <p role="alert">Payment attention could not be loaded. <Link href="/owner/payments">Review payments</Link> or reload Overview.</p> : data.attention.length ? <><ul>{data.attention.slice(0, 5).map(item => <li key={item.id}><Link href="/owner/payments"><span><strong>{item.status === "FAILED" ? "Incentive payment failed" : "Incentive awaiting manager approval"}</strong><span>{item.locationName} · {dateLabel(item.date)}</span></span><span className="owner-attention-action">Review payments <span aria-hidden="true">→</span></span></Link></li>)}</ul>{data.attention.length > 5 ? <Link href="/owner/payments">View all {data.attention.length} items</Link> : null}</> : <p className="owner-quiet">No incentive approvals or failed payments recorded.</p>}
    </section>
    <section className="owner-sales" aria-labelledby="owner-sales-title"><div className="owner-section-heading"><div><h2 id="owner-sales-title">Latest recorded sales week</h2><p>Where recorded demand stands before planning the next week.</p></div><Link className="owner-link" href="/owner/reporting">View sales <span aria-hidden="true">→</span></Link></div>
      <div className="owner-outlook-grid"><div className="owner-history">{series ? <><SalesChart series={series} /><p className="owner-note">{sourceNote(series)} Data through {dateLabel(series.end)}. Dates use each location’s time zone. Missing days are unknown; recorded amounts may not cover a full trading day.</p></> : <div className="owner-empty" role={data.salesUnavailable ? "alert" : "status"}><h3>{data.salesUnavailable ? "Sales could not be loaded" : "No sales history available"}</h3><p>{data.salesUnavailable ? "Other sections remain available. Reload to try sales again." : "Eligible sales history is needed to show business performance. No revenue has been assumed."}</p>{data.salesUnavailable ? <OwnerReload /> : null}</div>}</div>
        <aside className="owner-outlook" aria-labelledby="owner-outlook-title"><span className="owner-label">Forecast · next step</span><h3 id="owner-outlook-title">From demand to staffing</h3><p>{week ? `Demand is forecast for ${shortDate(week.firstTarget)} – ${dateLabel(week.lastTarget)}.` : "A company weekly forecast is not available."}{gap ? ` After regular and allocated casual coverage, ${hours(gap.casualGapMinutes)} of casual labour remains to plan.` : ""}</p><div className="owner-planning-path"><span>Sales history</span><span aria-hidden="true">↓</span><span>Weekly forecast</span><span aria-hidden="true">↓</span><span>Staffing requirement</span></div><Link href="/owner/forecast">View weekly forecast <span aria-hidden="true">→</span></Link><p className="owner-note">Forecasts are estimates from historical sales, shown separately from recorded sales. Labour gaps are derived from them and are planning estimates, not created shifts.</p></aside>
      </div>
    </section>
    <section className="owner-pulse" aria-labelledby="owner-pulse-title"><div className="owner-section-heading"><div><h2 id="owner-pulse-title">Location pulse</h2><p>{series ? `${sourceLabel(series)} · ${series.currency} · same period as the chart` : "Sales and planning availability by location"}</p></div></div>
      {data.locations.length ? <table className="owner-location-table"><caption className="owner-sr-only">Location sales and weekly planning availability. Select a location to open it.</caption><thead><tr><th scope="col">Location</th><th scope="col">Recorded sales</th><th scope="col">Weekly forecast</th><th scope="col">Casual labour gap</th><th scope="col">Estimated cost to fill</th><th scope="col">Sales status</th></tr></thead><tbody>{data.locations.map(location => {
        const sales = series?.locations.find(row => row.id === location.id);
        return <tr key={location.id}><th scope="row"><Link href={`/owner/locations/${location.id}`}><strong>{location.name}</strong></Link><small>{location.timezone}{!location.active ? " · Inactive location" : ""}</small></th><td data-label="Recorded sales"><strong>{sales?.amountMinor != null && series ? money(sales.amountMinor, series.currency) : data.salesUnavailable ? "Unavailable" : "No data"}</strong>{sales?.amountMinor != null ? <small>{sales.observedDays} of 7 days with records</small> : null}</td><td data-label="Weekly forecast">{(() => { const row = forecastByLocation.get(location.id); return row?.weeklyTotalMinor != null && row.currency ? <><strong>{wholeMoney(row.weeklyTotalMinor, row.currency)}</strong><small>Forecast · week from {shortDate(row.firstTarget!)}</small></> : forecast === null ? "Unavailable" : "Not available"; })()}</td><td data-label="Casual labour gap">{(() => { const row = gapByLocation.get(location.id); return row?.casualGapMinutes != null ? <><strong>{hours(row.casualGapMinutes)}</strong><small>Planning week · approx. {row.indicativeShifts} shifts</small></> : staffing === null ? "Unavailable" : "Not available"; })()}</td><td data-label="Estimated cost to fill">{(() => { const row = gapByLocation.get(location.id); return row?.cost && row.currency ? <strong>{costLabel(row.cost, row.currency)}</strong> : "Not available"; })()}</td><td data-label="Sales status"><span className="owner-status">{data.salesUnavailable ? "Sales unavailable" : sales?.amountMinor == null ? "No history in period" : series?.source === "REFERENCE" ? "Reference history" : series?.source === "DEMO_SEEDED" ? "Demo history only" : series?.source === "SQUARE" ? "Square Sandbox" : series?.source === "ZETTLE" ? "Earlier connected account" : series?.source === "IMPORTED" ? "Imported history" : "Sandbox history"}</span></td></tr>;
      })}</tbody></table> : <p>No locations available in this organisation.</p>}
    </section>
  </div>;
}
