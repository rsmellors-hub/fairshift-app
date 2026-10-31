import Link from "next/link";
import type { SalesSource } from "@/server/intelligence/forecast";
import type { OutletWeeklyForecast, SourceRejection, WeeklyForecast } from "@/server/intelligence/weekly";
import type { WeeklyStaffing } from "@/server/intelligence/staffing";
import { labourHours, policyDescription, STAFFING_UNAVAILABLE, StaffingDayTable, StaffingMethodNote } from "@/app/components/staffing";
import { isSyntheticSource } from "@/server/intelligence/forecast";

const SOURCE_LABEL: Record<SalesSource, string> = {
  REFERENCE: "Reference sales history",
  DEMO_SEEDED: "Demo / seeded history",
  PAYPAL_SANDBOX: "Verified PayPal Sandbox sales",
  IMPORTED: "Imported sales history",
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

// staffing: null = failed to load (never zero coverage or zero gap).
// assessment: the AI interpretation panel, rendered after the calculated staffing figures it interprets.
export function OwnerWeeklyForecast({ weekly, staffing, assessment }: { weekly: WeeklyForecast | null; staffing?: WeeklyStaffing | null; assessment?: React.ReactNode }) {
  const header = <header className="owner-heading"><div><p className="owner-eyebrow">Demand forecast</p><h1>Weekly forecast</h1><p>Expected sales, required labour and casual labour gaps for the next seven days at each location.</p></div><Link className="owner-link" href="/owner">Back to Overview <span aria-hidden="true">→</span></Link></header>;
  if (!weekly) return <div className="owner-overview owner-forecast">{header}<section className="owner-empty" role="alert"><h2>Forecast could not be loaded</h2><p>No demand has been assumed. Reload to try again.</p></section></div>;
  const c = weekly.consolidated;
  const available = weekly.outlets.filter(outlet => outlet.weeklyTotalMinor !== null);
  const historical = [...new Set(weekly.outlets.flatMap(outlet => outlet.selection.status === "SELECTED" && outlet.selection.kind === "HISTORICAL" && isSyntheticSource(outlet.selection.source) ? [outlet.selection.source] : []))];
  const imported = weekly.outlets.some(outlet => outlet.selection.status === "SELECTED" && outlet.selection.source === "IMPORTED");
  const columns = c?.days.map(row => row.targetDate) ?? null;
  return <div className="owner-overview owner-forecast">
    {header}
    {!weekly.outlets.length ? <section className="owner-empty" role="status"><h2>No locations</h2><p>Add a location to forecast its demand.</p></section> : <>
      <section className="owner-decisions owner-forecast-summary" aria-label="Forecast summary">
        <div><h2>Planning week</h2><strong className="owner-metric-empty">{c ? `${shortDate(c.days[0].targetDate)} – ${shortDate(c.days[6].targetDate)}` : available.length ? "Varies by location" : "Not available"}</strong><p>{c ? `${longDate(c.days[0].targetDate)} – ${longDate(c.days[6].targetDate)}` : available.length ? "Each location plans its next seven local days." : "No location has eligible sales history yet."}</p></div>
        <div><h2>Forecast sales, all locations</h2><strong className={c ? "" : "owner-metric-empty"}>{c ? whole(c.totalMinor, c.currency) : available.length ? "Not combined" : "Not available"}</strong><p>{c ? `Sum of ${weekly.outlets.length} location forecasts · ${c.currency}` : available.length ? "Locations use different sources, currencies or dates, or lack history." : "No demand has been assumed."}</p></div>
        <div><h2>Evidence</h2><strong className="owner-metric-empty">{c ? sourceLabel(c.source) : `${available.length} of ${weekly.outlets.length} locations`}</strong><p>{c ? `${historical.length ? "Historical evidence" : "Data"} through ${longDate(c.dataThrough)}${c.dataThroughConsistent ? "" : " (earliest location)"}` : "See each location for its source."}</p></div>
        <StaffingSummary staffing={staffing} />
      </section>
      {historical.length ? <p className="owner-forecast-notice"><span className="owner-label">Forecast from historical evidence</span>{`${historical.map(sourceLabel).join(" and ")} ${historical.length > 1 ? "are" : "is"} labelled synthetic input${c ? `, through ${longDate(c.dataThrough)}` : ""}. Comparable weekdays from the last 56 days of that history are mapped onto the planning week; seasonal differences are not modelled. It does not describe current trading or any provider’s sales.`}</p> : null}
      {imported ? <p className="owner-forecast-notice"><span className="owner-label">Forecast from imported history</span>Imported sales history supplied for this business, not verified by a payment provider. Comparable weekdays from the last 56 days of that history are mapped onto the planning week; seasonal differences are not modelled.</p> : null}
      <section aria-labelledby="owner-forecast-table-title">
        <div className="owner-section-heading"><div><h2 id="owner-forecast-table-title">Forecast by location</h2><p>Expected sales per day{columns ? "" : ", with each location’s own forecast dates"}. Ranges and evidence are under each location.</p></div></div>
        <div className="owner-forecast-scroll" role="region" aria-label="Forecast by location table" tabIndex={0}><table className="owner-location-table owner-forecast-table">
          <caption className="owner-sr-only">Seven-day sales forecast by location. Forecasts are estimates, not recorded sales.</caption>
          <thead><tr><th scope="col">Location</th>{columns ? columns.map(date => <th scope="col" key={date}>{shortDate(date)}</th>) : Array.from({ length: 7 }, (_, i) => <th scope="col" key={i}>Day {i + 1}</th>)}<th scope="col">Week</th></tr></thead>
          <tbody>{weekly.outlets.map(outlet => {
            const currency = outlet.selection.status === "SELECTED" ? outlet.selection.currency : null;
            return <tr key={outlet.outletId}><th scope="row"><strong>{outlet.outletName}</strong>{c ? null : <Provenance outlet={outlet} />}</th>
              {outlet.days.length ? outlet.days.map(row => <td key={row.targetDate} data-label={shortDate(row.targetDate)}>{row.forecast && currency ? whole(row.forecast.forecastSalesMinor, currency) : "Not available"}{columns ? null : <small>{shortDate(row.targetDate)}</small>}</td>)
                : <td colSpan={7} data-label="Forecast">No forecast: no eligible sales history. No demand has been assumed.</td>}
              <td data-label="Week"><strong>{outlet.weeklyTotalMinor !== null && currency ? whole(outlet.weeklyTotalMinor, currency) : "Not available"}</strong></td></tr>;
          })}</tbody>
          {c ? <tfoot><tr><th scope="row">All locations</th>{c.days.map(row => <td key={row.targetDate} data-label={shortDate(row.targetDate)}>{whole(row.forecastSalesMinor, c.currency)}</td>)}<td data-label="Week"><strong>{whole(c.totalMinor, c.currency)}</strong></td></tr></tfoot> : null}
        </table></div>
      </section>
      <StaffingByLocation staffing={staffing} />
      {assessment}
      <section className="owner-attention" aria-labelledby="owner-forecast-evidence-title">
        <div className="owner-section-heading"><div><h2 id="owner-forecast-evidence-title">Ranges and evidence</h2><p>Planning ranges are not calibrated confidence intervals.</p></div></div>
        {weekly.outlets.map(outlet => <details className="owner-forecast-detail" key={outlet.outletId}><summary><strong>{outlet.outletName}</strong> <Provenance outlet={outlet} /></summary>
          {outlet.selection.rejected.length ? <p>Not used: {outlet.selection.rejected.map(row => `${sourceLabel(row.source)} (${row.currency}): ${REJECTION[row.reason]}. ${row.detail}`).join(" ")}</p> : null}
          {outlet.days.length ? <table><caption className="owner-sr-only">{outlet.outletName} daily forecast ranges</caption><thead><tr><th scope="col">Date</th><th scope="col">Forecast</th><th scope="col">Planning range</th><th scope="col">Support</th><th scope="col">Comparable days</th></tr></thead>
            <tbody>{outlet.days.map(row => {
              const currency = outlet.selection.status === "SELECTED" ? outlet.selection.currency : null;
              return <tr key={row.targetDate}><th scope="row">{longDate(row.targetDate)}</th>{row.forecast && currency ? <><td>{whole(row.forecast.forecastSalesMinor, currency)}</td><td>{whole(row.forecast.lowerSalesMinor, currency)} – {whole(row.forecast.upperSalesMinor, currency)}</td><td>{row.forecast.support === "MODERATE" ? "Moderate" : "Low"}</td><td>{row.forecast.evidence.length} {row.forecast.basis === "SAME_WEEKDAY" ? "same weekdays" : "recent days"}</td></> : <td colSpan={4}>Not available</td>}</tr>;
            })}</tbody></table> : <p>No eligible sales history, so no forecast was produced.</p>}
        </details>)}
        <p className="owner-note">Method {weekly.methodVersion}: a recency-weighted average of matching weekdays from the 56 days up to the data-through date, with isolated high days capped. Calendar events and holidays are not modelled. Source rule {weekly.ruleVersion}: provider sales replace other history only with 28 or more recent days, including three of every weekday, in the location’s planning currency; imported history needs the same depth and comes before reference history. No AI is used in this forecast.</p>
      </section>
    </>}
  </div>;
}

function StaffingSummary({ staffing }: { staffing?: WeeklyStaffing | null }) {
  const c = staffing?.consolidated;
  const located = staffing?.outlets.filter(outlet => outlet.totals).length ?? 0;
  return <div><h2>Casual labour gap</h2><strong className={c ? "" : "owner-metric-empty"}>{c ? labourHours(c.totals.casualGapMinutes) : staffing === null ? "Unavailable" : located ? "By location" : "Not available"}</strong>
    <p>{c ? `Required ${labourHours(c.totals.requiredMinutes)} · existing coverage ${labourHours(c.totals.coverageMinutes)} · approx. ${c.totals.indicativeShifts} shifts to fill`
      : staffing === null ? "Coverage could not be loaded. No gap has been assumed." : located ? `${located} of ${staffing!.outlets.length} locations have a complete staffing week.` : "No location has both a forecast and regular coverage."}</p></div>;
}

function StaffingByLocation({ staffing }: { staffing?: WeeklyStaffing | null }) {
  if (staffing === undefined) return null;
  const heading = <div className="owner-section-heading"><div><h2 id="owner-staffing-title">Staffing by location</h2><p>Demand → coverage → gap. Casual labour gap per planning day, after regular and allocated casual coverage.</p></div></div>;
  if (staffing === null) return <section aria-labelledby="owner-staffing-title" className="owner-staffing">{heading}<div className="owner-empty" role="alert"><h3>Staffing could not be loaded</h3><p>Coverage was not read, so no labour gap is shown. The forecast above is unaffected. Reload to try again.</p></div></section>;
  const dates = staffing.outlets[0]?.days.map(day => day.planningDate) ?? [];
  const aligned = staffing.outlets.every(outlet => outlet.days[0]?.planningDate === dates[0]);
  return <section aria-labelledby="owner-staffing-title" className="owner-staffing">
    {heading}
    <div className="owner-forecast-scroll" role="region" aria-label="Casual labour gap by location table" tabIndex={0}><table className="owner-location-table owner-forecast-table">
      <caption className="owner-sr-only">Casual labour gap in hours by location and planning day. Derived from forecasts and coverage; no shifts have been created.</caption>
      <thead><tr><th scope="col">Location</th>{aligned ? dates.map(date => <th scope="col" key={date}>{shortDate(date)}</th>) : Array.from({ length: 7 }, (_, i) => <th scope="col" key={i}>Day {i + 1}</th>)}<th scope="col">Week</th></tr></thead>
      <tbody>{staffing.outlets.map(outlet => <tr key={outlet.outletId}><th scope="row"><strong>{outlet.outletName}</strong>{outlet.totals ? <small>{`Required ${labourHours(outlet.totals.requiredMinutes)} · covered ${labourHours(outlet.totals.coverageMinutes)}`}</small> : null}</th>
        {outlet.days.map(day => <td key={day.planningDate} data-label={shortDate(day.planningDate)}>{day.casualGapMinutes === null ? "Unavailable" : labourHours(day.casualGapMinutes)}</td>)}
        <td data-label="Week"><strong>{outlet.totals ? labourHours(outlet.totals.casualGapMinutes) : "Unavailable"}</strong>{outlet.totals ? <small>{`approx. ${outlet.totals.indicativeShifts} shifts`}</small> : null}</td></tr>)}</tbody>
      {staffing.consolidated ? <tfoot><tr><th scope="row">All locations</th>{dates.map((date, i) => <td key={date} data-label={shortDate(date)}>{labourHours(staffing.outlets.reduce((sum, outlet) => sum + outlet.days[i].casualGapMinutes!, 0))}</td>)}<td data-label="Week"><strong>{labourHours(staffing.consolidated.totals.casualGapMinutes)}</strong></td></tr></tfoot> : null}
    </table></div>
    <div className="owner-staffing-detail">
      {staffing.outlets.map(outlet => <details className="owner-forecast-detail" key={outlet.outletId}><summary><strong>{outlet.outletName}</strong> <small>{outlet.totals ? `Casual labour gap ${labourHours(outlet.totals.casualGapMinutes)} this week` : outlet.days.find(day => day.unavailable) ? STAFFING_UNAVAILABLE[outlet.days.find(day => day.unavailable)!.unavailable!] : ""}</small></summary>
        <div className="owner-forecast-scroll-inner" role="region" aria-label={`${outlet.outletName} staffing by day`} tabIndex={0}><StaffingDayTable outlet={outlet} /></div>
        <p>{outlet.regularCoverage === "REFERENCE" ? "Regular coverage: the reference company’s standing rota (synthetic input)." : outlet.regularCoverage === "CONFIGURED" ? "Regular coverage: the rota configured for this location." : "No regular-staff coverage has been set for this location, so its casual gap is not calculated."}</p>
        <p>{outlet.policy ? `Staffing assumption: ${policyDescription(outlet.policy)}.` : "No labour policy applies to this location’s sales, so required labour is unavailable. This does not mean no labour is needed."}</p>
      </details>)}
    </div>
    <p className="owner-note"><StaffingMethodNote policy={staffing.consolidated?.policy ?? null} varied={!staffing.consolidated && staffing.outlets.some(outlet => outlet.policy)} /> Method {staffing.methodVersion}. No AI is used in these figures.</p>
  </section>;
}
