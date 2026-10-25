"use client";

import { useState } from "react";
import Link from "next/link";
import type { OwnerForecastSummary, OwnerOverviewData, SalesSeries } from "@/server/product/owner-overview";

const money = (minor: number, currency: string) => new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(minor / 100);
const dateLabel = (date: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
const sourceLabel = (series: SalesSeries) => ({ REFERENCE: "Reference sales history", DEMO_SEEDED: "Demo / seeded history", PAYPAL_SANDBOX: "Actual · PayPal Sandbox" })[series.source];
const shortDate = (date: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
const wholeMoney = (minor: number, currency: string) => new Intl.NumberFormat("en-GB", { style: "currency", currency, maximumFractionDigits: 0 }).format(minor / 100);
const evidenceLabel = { REFERENCE: "reference history", DEMO_SEEDED: "demo history", PAYPAL_SANDBOX: "verified PayPal Sandbox sales" } as const;
const sourceNote = (series: SalesSeries) => ({
  REFERENCE: "Labelled synthetic reference history for a fictional retailer, not Zettle, PayPal or other provider sales.",
  DEMO_SEEDED: "Synthetic demo sales, not provider-verified commerce.",
  PAYPAL_SANDBOX: "Completed, verified and reconciled PayPal Sandbox sales only.",
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

// forecast: undefined = not requested, null = failed to load (never zero demand).
export function OwnerOverview({ data, forecast }: { data: OwnerOverviewData; forecast?: OwnerForecastSummary | null }) {
  const week = forecast?.consolidated;
  const forecastByLocation = new Map(forecast?.outlets.map(row => [row.id, row]) ?? []);
  const forecastedLocations = forecast?.outlets.filter(row => row.weeklyTotalMinor !== null).length ?? 0;
  const [selected, setSelected] = useState(data.series[0]?.key ?? "");
  const series = data.series.find(row => row.key === selected) ?? data.series[0];
  const failed = data.attention?.filter(row => row.status === "FAILED").length ?? 0;
  const earned = data.attention?.filter(row => row.status === "EARNED").length ?? 0;
  return <div className="owner-overview">
    <header className="owner-heading"><div><p className="owner-eyebrow">Business performance & planning</p><h1>Overview</h1><p>{data.locations.length > 1 ? "All Locations" : data.locations[0]?.name ?? "Organisation overview"} · {series ? `${dateLabel(series.start)} – ${dateLabel(series.end)}` : "No sales period available"}</p></div><Link className="owner-link" href="/owner/forecast">View forecast <span aria-hidden="true">↗</span></Link></header>
    {data.series.length > 1 ? <div className="owner-source"><label htmlFor="owner-sales-source">Sales source & currency</label><select id="owner-sales-source" value={series.key} onChange={event => setSelected(event.target.value)}>{data.series.map(row => <option key={row.key} value={row.key}>{sourceLabel(row)} · {row.currency}</option>)}</select></div> : null}
    <section className="owner-decisions" aria-label="Business decisions">
      <div><h2>Latest recorded sales</h2><strong className={series ? "" : "owner-metric-empty"}>{series ? money(series.totalMinor, series.currency) : data.salesUnavailable ? "Unavailable" : "No sales data"}</strong><p>{series ? `${sourceLabel(series)} · 7 days to ${dateLabel(series.end)}` : "Sales will appear when eligible history is available."}</p></div>
      <div><h2>Forecast sales</h2><strong className={week ? "" : "owner-metric-empty"}>{week ? wholeMoney(week.totalMinor, week.currency) : forecast === null ? "Unavailable" : forecastedLocations ? "By location" : "Not available"}</strong><p>{week ? `Forecast · ${shortDate(week.firstTarget)} – ${dateLabel(week.lastTarget)} · from ${evidenceLabel[week.source]} through ${dateLabel(week.dataThrough)}` : forecast === null ? "The weekly forecast could not be loaded. No demand has been assumed." : forecast === undefined ? "The weekly forecast is not available." : forecastedLocations ? `${forecastedLocations} of ${forecast.outlets.length} locations forecast separately; they cannot be combined.` : "No location has enough eligible sales history for a forecast."}</p><Link href="/owner/forecast">View forecast <span aria-hidden="true">→</span></Link></div>
      <div><h2>Staffing gaps</h2><strong className="owner-metric-empty">Not calculated</strong><p>Weekly coverage and casual workers needed are not calculated yet.</p></div>
      <div><h2>Approvals & payment issues</h2><strong className={data.attention === null ? "owner-metric-empty" : ""}>{data.attention === null ? "Unavailable" : data.attention.length}</strong><p>{data.attention === null ? "Attention items could not be loaded." : `${earned} awaiting manager approval · ${failed} failed payments`}</p><Link href="/owner/payments">Review payments <span aria-hidden="true">→</span></Link></div>
    </section>
    <section className="owner-sales" aria-labelledby="owner-sales-title"><div className="owner-section-heading"><div><h2 id="owner-sales-title">Latest recorded sales week</h2><p>Where recorded demand stands before planning the next week.</p></div><Link className="owner-link" href="/owner/reporting">View sales <span aria-hidden="true">→</span></Link></div>
      <div className="owner-outlook-grid"><div className="owner-history">{series ? <><SalesChart series={series} /><p className="owner-note">{sourceNote(series)} Data through {dateLabel(series.end)}. Dates use each location’s time zone. Missing days are unknown; recorded amounts may not cover a full trading day.</p></> : <div className="owner-empty" role={data.salesUnavailable ? "alert" : "status"}><h3>{data.salesUnavailable ? "Sales could not be loaded" : "No sales history available"}</h3><p>{data.salesUnavailable ? "Other sections remain available. Reload to try sales again." : "Eligible sales history is needed to show business performance. No revenue has been assumed."}</p>{data.salesUnavailable ? <OwnerReload /> : null}</div>}</div>
        <aside className="owner-outlook" aria-labelledby="owner-outlook-title"><span className="owner-label">Forecast · next step</span><h3 id="owner-outlook-title">From demand to staffing</h3><p>{week ? `Demand is forecast for ${shortDate(week.firstTarget)} – ${dateLabel(week.lastTarget)}.` : "A company weekly forecast is not available."} Coverage gaps and casual requirements will follow when weekly staffing is calculated.</p><div className="owner-planning-path"><span>Sales history</span><span aria-hidden="true">↓</span><span>Weekly forecast</span><span aria-hidden="true">↓</span><span>Staffing requirement</span></div><Link href="/owner/forecast">View weekly forecast <span aria-hidden="true">→</span></Link><p className="owner-note">Forecasts are estimates from historical sales, shown separately from recorded sales. They do not establish a coverage gap.</p></aside>
      </div>
    </section>
    <section className="owner-attention" aria-labelledby="owner-attention-title"><div className="owner-section-heading"><div><h2 id="owner-attention-title">Needs attention</h2><p>Recorded incentive approvals and failed payments across your locations.</p></div></div>
      {data.attention === null ? <p role="alert">Payment attention could not be loaded. <Link href="/owner/payments">Review payments</Link> or reload Overview.</p> : data.attention.length ? <><ul>{data.attention.slice(0, 5).map(item => <li key={item.id}><Link href="/owner/payments"><span><strong>{item.status === "FAILED" ? "Incentive payment failed" : "Incentive awaiting manager approval"}</strong><span>{item.locationName} · {dateLabel(item.date)}</span></span><span className="owner-attention-action">Review payments <span aria-hidden="true">→</span></span></Link></li>)}</ul>{data.attention.length > 5 ? <Link href="/owner/payments">View all {data.attention.length} items</Link> : null}</> : <p className="owner-quiet">No incentive approvals or failed payments recorded. Staffing gaps have not been calculated.</p>}
    </section>
    <section className="owner-pulse" aria-labelledby="owner-pulse-title"><div className="owner-section-heading"><div><h2 id="owner-pulse-title">Location pulse</h2><p>{series ? `${sourceLabel(series)} · ${series.currency} · same period as the chart` : "Sales and planning availability by location"}</p></div></div>
      {data.locations.length ? <table className="owner-location-table"><caption className="owner-sr-only">Location sales and weekly planning availability. No location drill-down is available.</caption><thead><tr><th scope="col">Location</th><th scope="col">Recorded sales</th><th scope="col">Weekly forecast</th><th scope="col">Coverage gap</th><th scope="col">Sales status</th></tr></thead><tbody>{data.locations.map(location => {
        const sales = series?.locations.find(row => row.id === location.id);
        return <tr key={location.id}><th scope="row"><strong>{location.name}</strong><small>{location.timezone}{!location.active ? " · Inactive location" : ""}</small></th><td data-label="Recorded sales"><strong>{sales?.amountMinor != null && series ? money(sales.amountMinor, series.currency) : data.salesUnavailable ? "Unavailable" : "No data"}</strong>{sales?.amountMinor != null ? <small>{sales.observedDays} of 7 days with records</small> : null}</td><td data-label="Weekly forecast">{(() => { const row = forecastByLocation.get(location.id); return row?.weeklyTotalMinor != null && row.currency ? <><strong>{wholeMoney(row.weeklyTotalMinor, row.currency)}</strong><small>Forecast · week from {shortDate(row.firstTarget!)}</small></> : forecast === null ? "Unavailable" : "Not available"; })()}</td><td data-label="Coverage gap">Not calculated</td><td data-label="Sales status"><span className="owner-status">{data.salesUnavailable ? "Sales unavailable" : sales?.amountMinor == null ? "No history in period" : series?.source === "REFERENCE" ? "Reference history" : series?.source === "DEMO_SEEDED" ? "Demo history only" : "Sandbox history"}</span></td></tr>;
      })}</tbody></table> : <p>No locations available in this organisation.</p>}
    </section>
  </div>;
}
