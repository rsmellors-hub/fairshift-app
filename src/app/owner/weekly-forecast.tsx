import Link from "next/link";
import type { SalesSource } from "@/server/intelligence/forecast";
import type { OutletWeeklyForecast, SourceRejection, WeeklyForecast } from "@/server/intelligence/weekly";

const SOURCE_LABEL: Record<SalesSource, string> = {
  REFERENCE: "Reference sales history",
  DEMO_SEEDED: "Demo / seeded history",
  PAYPAL_SANDBOX: "Verified PayPal Sandbox sales",
};
const REJECTION: Record<SourceRejection["reason"], string> = {
  CURRENCY_MISMATCH: "different currency", STALE: "not recent enough", INSUFFICIENT_DAYS: "too few days",
  INCOMPLETE_WEEKDAYS: "some weekdays too sparse", AMBIGUOUS: "more than one currency",
};
const locale = (currency: string) => currency === "GBP" ? "en-GB" : "en-US";
const whole = (minor: number, currency: string) => new Intl.NumberFormat(locale(currency), { style: "currency", currency, maximumFractionDigits: 0 }).format(minor / 100);
const day = (date: string, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
export const longDate = (date: string) => day(date, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const shortDate = (date: string) => day(date, { weekday: "short", day: "numeric", month: "short" });
export const sourceLabel = (source: SalesSource) => SOURCE_LABEL[source];

function Provenance({ outlet }: { outlet: OutletWeeklyForecast }) {
  const s = outlet.selection;
  if (s.status === "NONE") return <small>No eligible sales history</small>;
  return <small>{`${sourceLabel(s.source)} · ${s.currency} · data through ${longDate(s.dataThrough)}`}</small>;
}

export function OwnerWeeklyForecast({ weekly }: { weekly: WeeklyForecast | null }) {
  const header = <header className="owner-heading"><div><p className="owner-eyebrow">Demand forecast</p><h1>Weekly forecast</h1><p>Expected sales for the seven days after each location’s latest eligible sales data.</p></div><Link className="owner-link" href="/owner">Back to Overview <span aria-hidden="true">→</span></Link></header>;
  if (!weekly) return <div className="owner-overview owner-forecast">{header}<section className="owner-empty" role="alert"><h2>Forecast could not be loaded</h2><p>No demand has been assumed. Reload to try again.</p></section></div>;
  const c = weekly.consolidated;
  const available = weekly.outlets.filter(outlet => outlet.weeklyTotalMinor !== null);
  const historical = [...new Set(weekly.outlets.flatMap(outlet => outlet.selection.status === "SELECTED" && outlet.selection.kind === "HISTORICAL" ? [outlet.selection.source] : []))];
  const columns = c?.days.map(row => row.targetDate) ?? null;
  return <div className="owner-overview owner-forecast">
    {header}
    {!weekly.outlets.length ? <section className="owner-empty" role="status"><h2>No locations</h2><p>Add a location to forecast its demand.</p></section> : <>
      <section className="owner-decisions owner-forecast-summary" aria-label="Forecast summary">
        <div><h2>Forecast week</h2><strong className="owner-metric-empty">{c ? `${shortDate(c.days[0].targetDate)} – ${shortDate(c.days[6].targetDate)}` : available.length ? "Varies by location" : "Not available"}</strong><p>{c ? `${longDate(c.days[0].targetDate)} – ${longDate(c.days[6].targetDate)}` : available.length ? "Each location forecasts the week after its own data." : "No location has eligible sales history yet."}</p></div>
        <div><h2>Forecast sales, all locations</h2><strong className={c ? "" : "owner-metric-empty"}>{c ? whole(c.totalMinor, c.currency) : available.length ? "Not combined" : "Not available"}</strong><p>{c ? `Sum of ${weekly.outlets.length} location forecasts · ${c.currency}` : available.length ? "Locations use different sources, currencies or dates, or lack history." : "No demand has been assumed."}</p></div>
        <div><h2>Evidence</h2><strong className="owner-metric-empty">{c ? sourceLabel(c.source) : `${available.length} of ${weekly.outlets.length} locations`}</strong><p>{c ? `Data through ${longDate(c.dataThrough)}${c.dataThroughConsistent ? "" : " (earliest location)"}` : "See each location for its source."}</p></div>
        <div><h2>Staffing</h2><strong className="owner-metric-empty">Not calculated</strong><p>Weekly staffing requirements are not calculated from this forecast yet.</p></div>
      </section>
      {historical.length ? <p className="owner-forecast-notice"><span className="owner-label">Forecast from historical evidence</span>{`${historical.map(sourceLabel).join(" and ")} ${historical.length > 1 ? "are" : "is"} labelled synthetic input. The forecast week follows the end of that history, so it does not describe current trading or any provider’s sales.`}</p> : null}
      <section aria-labelledby="owner-forecast-table-title">
        <div className="owner-section-heading"><div><h2 id="owner-forecast-table-title">Forecast by location</h2><p>Expected sales per day{columns ? "" : ", with each location’s own forecast dates"}. Ranges and evidence are under each location.</p></div></div>
        <div className="owner-forecast-scroll" role="region" aria-label="Forecast by location table" tabIndex={0}><table className="owner-location-table owner-forecast-table">
          <caption className="owner-sr-only">Seven-day sales forecast by location. Forecasts are estimates, not recorded sales.</caption>
          <thead><tr><th scope="col">Location</th>{columns ? columns.map(date => <th scope="col" key={date}>{shortDate(date)}</th>) : Array.from({ length: 7 }, (_, i) => <th scope="col" key={i}>Day {i + 1}</th>)}<th scope="col">Week</th></tr></thead>
          <tbody>{weekly.outlets.map(outlet => {
            const currency = outlet.selection.status === "SELECTED" ? outlet.selection.currency : "GBP";
            return <tr key={outlet.outletId}><th scope="row"><strong>{outlet.outletName}</strong>{c ? null : <Provenance outlet={outlet} />}</th>
              {outlet.days.length ? outlet.days.map(row => <td key={row.targetDate} data-label={shortDate(row.targetDate)}>{row.forecast ? whole(row.forecast.forecastSalesMinor, currency) : "Not available"}{columns ? null : <small>{shortDate(row.targetDate)}</small>}</td>)
                : <td colSpan={7} data-label="Forecast">No forecast: no eligible sales history. No demand has been assumed.</td>}
              <td data-label="Week"><strong>{outlet.weeklyTotalMinor !== null ? whole(outlet.weeklyTotalMinor, currency) : "Not available"}</strong></td></tr>;
          })}</tbody>
          {c ? <tfoot><tr><th scope="row">All locations</th>{c.days.map(row => <td key={row.targetDate} data-label={shortDate(row.targetDate)}>{whole(row.forecastSalesMinor, c.currency)}</td>)}<td data-label="Week"><strong>{whole(c.totalMinor, c.currency)}</strong></td></tr></tfoot> : null}
        </table></div>
      </section>
      <section className="owner-attention" aria-labelledby="owner-forecast-evidence-title">
        <div className="owner-section-heading"><div><h2 id="owner-forecast-evidence-title">Ranges and evidence</h2><p>Planning ranges are not calibrated confidence intervals.</p></div></div>
        {weekly.outlets.map(outlet => <details className="owner-forecast-detail" key={outlet.outletId}><summary><strong>{outlet.outletName}</strong> <Provenance outlet={outlet} /></summary>
          {outlet.selection.rejected.length ? <p>Not used: {outlet.selection.rejected.map(row => `${sourceLabel(row.source)} (${row.currency}): ${REJECTION[row.reason]}. ${row.detail}`).join(" ")}</p> : null}
          {outlet.days.length ? <table><caption className="owner-sr-only">{outlet.outletName} daily forecast ranges</caption><thead><tr><th scope="col">Date</th><th scope="col">Forecast</th><th scope="col">Planning range</th><th scope="col">Support</th><th scope="col">Comparable days</th></tr></thead>
            <tbody>{outlet.days.map(row => {
              const currency = outlet.selection.status === "SELECTED" ? outlet.selection.currency : "GBP";
              return <tr key={row.targetDate}><th scope="row">{longDate(row.targetDate)}</th>{row.forecast ? <><td>{whole(row.forecast.forecastSalesMinor, currency)}</td><td>{whole(row.forecast.lowerSalesMinor, currency)} – {whole(row.forecast.upperSalesMinor, currency)}</td><td>{row.forecast.support === "MODERATE" ? "Moderate" : "Low"}</td><td>{row.forecast.evidence.length} {row.forecast.basis === "SAME_WEEKDAY" ? "same weekdays" : "recent days"}</td></> : <td colSpan={4}>Not available</td>}</tr>;
            })}</tbody></table> : <p>No eligible sales history, so no forecast was produced.</p>}
        </details>)}
        <p className="owner-note">Method {weekly.methodVersion}: a recency-weighted average of matching weekdays from the 56 days up to the data-through date, with isolated high days capped. Calendar events and holidays are not modelled. Source rule {weekly.ruleVersion}: provider sales replace historical evidence only with 28 or more recent days, including three of every weekday, in the location’s planning currency. No AI is used in this forecast.</p>
      </section>
    </>}
  </div>;
}
