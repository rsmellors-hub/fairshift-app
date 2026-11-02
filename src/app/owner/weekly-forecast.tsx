import Link from "next/link";
import type { SalesSource } from "@/server/intelligence/forecast";
import type { OutletWeeklyForecast, SourceRejection, WeeklyForecast } from "@/server/intelligence/weekly";
import type { WeeklyStaffing } from "@/server/intelligence/staffing";
import { AcceptedContextNote, labourHours, policyDescription, STAFFING_UNAVAILABLE, StaffingDayTable, StaffingMethodNote, transactions, WorkloadSetupNotice } from "@/app/components/staffing";
import { formatClock } from "@/server/intelligence/workload";
import { isSyntheticSource } from "@/server/intelligence/forecast";
import { CommercialByLocation } from "@/app/owner/commerce-labour";

const SOURCE_LABEL: Record<SalesSource, string> = {
  REFERENCE: "Reference sales history",
  DEMO_SEEDED: "Demo / seeded history",
  PAYPAL_SANDBOX: "Verified PayPal Sandbox sales",
  IMPORTED: "Imported sales history",
  ZETTLE: "Earlier connected-account sales",
  SQUARE: "Square Sandbox sales",
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
  const header = <header className="owner-heading"><div><p className="eyebrow">Forecast · next seven days</p><h1>Weekly forecast</h1><p>What sales to expect, how much work that means and when, and where regular cover falls short.</p></div></header>;
  if (!weekly) return <div className="owner-overview owner-forecast">{header}<section className="owner-empty" role="alert"><h2>Forecast could not be loaded</h2><p>No demand has been assumed. Reload to try again.</p></section></div>;
  const c = weekly.consolidated;
  const available = weekly.outlets.filter(outlet => outlet.weeklyTotalMinor !== null);
  const historical = [...new Set(weekly.outlets.flatMap(outlet => outlet.selection.status === "SELECTED" && outlet.selection.kind === "HISTORICAL" && isSyntheticSource(outlet.selection.source) ? [outlet.selection.source] : []))];
  const imported = weekly.outlets.some(outlet => outlet.selection.status === "SELECTED" && outlet.selection.source === "IMPORTED");
  const connected = weekly.outlets.filter(outlet => outlet.selection.status === "SELECTED" && (outlet.selection.source === "ZETTLE" || outlet.selection.source === "SQUARE")).length;
  const columns = c?.days.map(row => row.targetDate) ?? null;
  const maxGap = Math.max(0, ...(staffing?.outlets.flatMap(outlet => outlet.days.map(day => day.casualGapMinutes ?? 0)) ?? []));
  return <div className="owner-overview owner-forecast">
    {header}
    {!weekly.outlets.length ? <section className="owner-empty" role="status"><h2>No locations</h2><p>Add a location to forecast its demand.</p></section> : <>
      <section className="owner-decisions owner-forecast-summary" aria-label="Forecast summary">
        <div><h2>Planning week</h2><strong className="owner-metric-empty">{c ? `${shortDate(c.days[0].targetDate)} – ${shortDate(c.days[6].targetDate)}` : available.length ? "Varies by location" : "Not available"}</strong><p>{c ? `${longDate(c.days[0].targetDate)} – ${longDate(c.days[6].targetDate)}` : available.length ? "Each location plans its next seven local days." : "No location has eligible sales history yet."}</p></div>
        <div><h2>Expected transactions, all locations</h2><OperationalTotal staffing={staffing} /></div>
        <div><h2>Forecast sales, all locations</h2><strong className={c ? "" : "owner-metric-empty"}>{c ? whole(c.totalMinor, c.currency) : available.length ? "Not combined" : "Not available"}</strong><p>{c ? `Sum of ${weekly.outlets.length} location forecasts · ${c.currency}` : available.length ? "Locations use different sources, currencies or dates, or lack history." : "No demand has been assumed."}</p></div>
        <div><h2>Evidence</h2><strong className="owner-metric-empty">{c ? sourceLabel(c.source) : `${available.length} of ${weekly.outlets.length} locations`}</strong><p>{c ? `${historical.length ? "Historical evidence" : "Data"} through ${longDate(c.dataThrough)}${c.dataThroughConsistent ? "" : " (earliest location)"}` : "See each location for its source."}</p></div>
        <StaffingSummary staffing={staffing} />
      </section>
      {staffing ? <WorkloadSetupNotice outlets={staffing.outlets} owner /> : null}
      {staffing ? <AcceptedContextNote outlets={staffing.outlets} /> : null}
      {historical.length ? <p className="owner-forecast-notice"><span className="owner-label">Forecast from historical evidence</span>{`${historical.map(sourceLabel).join(" and ")} ${historical.length > 1 ? "are" : "is"} labelled synthetic input${c ? `, through ${longDate(c.dataThrough)}` : ""}. Comparable weekdays from the last 56 days of that history are mapped onto the planning week; seasonal differences are not modelled. It does not describe current trading or any provider’s sales.`}</p> : null}
      {imported ? <p className="owner-forecast-notice"><span className="owner-label">Forecast from imported history</span>Imported sales history supplied for this business, not verified by a payment provider. Comparable weekdays from the last 56 days of that history are mapped onto the planning week; seasonal differences are not modelled.</p> : null}
      {connected ? <p className="owner-forecast-notice"><span className="owner-label">Forecast from connected commerce</span>{`${connected === weekly.outlets.length ? "Every location forecasts" : `${connected} of ${weekly.outlets.length} locations forecast`} from sales retrieved from a connected account: completed sales through yesterday, refunds not deducted.`}</p> : null}
      <section aria-labelledby="owner-forecast-table-title">
        <div className="owner-section-heading"><div><p className="owner-layer">Commercial</p><h2 id="owner-forecast-table-title">Expected sales by location</h2><p>The value expected each day{columns ? "" : ", on each location’s own dates"}. This is commercial context and doesn’t set staffing. Select a location to open it.</p></div></div>
        <div className="owner-forecast-scroll" role="region" aria-label="Forecast by location table" tabIndex={0}><table className="owner-location-table owner-forecast-table">
          <caption className="owner-sr-only">Seven-day sales forecast by location. Forecasts are estimates, not recorded sales.</caption>
          <thead><tr><th scope="col">Location</th>{columns ? columns.map(date => <th scope="col" key={date}>{shortDate(date)}</th>) : Array.from({ length: 7 }, (_, i) => <th scope="col" key={i}>Day {i + 1}</th>)}<th scope="col">Week</th></tr></thead>
          <tbody>{weekly.outlets.map(outlet => {
            const currency = outlet.selection.status === "SELECTED" ? outlet.selection.currency : null;
            return <tr key={outlet.outletId}><th scope="row"><Link href={`/owner/locations/${outlet.outletId}`}><strong>{outlet.outletName}</strong></Link>{c ? null : <Provenance outlet={outlet} />}</th>
              {outlet.days.length ? outlet.days.map(row => <td key={row.targetDate} data-label={shortDate(row.targetDate)}>{row.forecast && currency ? whole(row.forecast.forecastSalesMinor, currency) : "Not available"}{columns ? null : <small>{shortDate(row.targetDate)}</small>}</td>)
                : <td colSpan={7} data-label="Forecast">No forecast: no eligible sales history. No demand has been assumed.</td>}
              <td data-label="Week"><strong>{outlet.weeklyTotalMinor !== null && currency ? whole(outlet.weeklyTotalMinor, currency) : "Not available"}</strong></td></tr>;
          })}</tbody>
          {c ? <tfoot><tr><th scope="row">All locations</th>{c.days.map(row => <td key={row.targetDate} data-label={shortDate(row.targetDate)}>{whole(row.forecastSalesMinor, c.currency)}</td>)}<td data-label="Week"><strong>{whole(c.totalMinor, c.currency)}</strong></td></tr></tfoot> : null}
        </table></div>
      </section>
      <OperationalByLocation staffing={staffing} />
      <StaffingHeat staffing={staffing} maxGap={maxGap} />
      {assessment}
      <StaffingByLocation staffing={staffing} />
      {staffing?.outlets.length ? <details className="panel disclosure"><summary>What this week means commercially</summary><CommercialByLocation outlets={staffing.outlets} summary={staffing.commercial} /></details> : null}
      <details className="panel disclosure" aria-labelledby="owner-forecast-evidence-title"><summary id="owner-forecast-evidence-title">Ranges and evidence</summary><p className="note">Planning ranges are not calibrated confidence intervals.</p>
        {weekly.outlets.map(outlet => <details className="owner-forecast-detail" key={outlet.outletId}><summary><strong>{outlet.outletName}</strong> <Provenance outlet={outlet} /></summary>
          {outlet.selection.rejected.length ? <p>Not used: {outlet.selection.rejected.map(row => `${sourceLabel(row.source)} (${row.currency}): ${REJECTION[row.reason]}. ${row.detail}`).join(" ")}</p> : null}
          {outlet.days.length ? <table><caption className="owner-sr-only">{outlet.outletName} daily forecast ranges</caption><thead><tr><th scope="col">Date</th><th scope="col">Forecast</th><th scope="col">Planning range</th><th scope="col">Support</th><th scope="col">Comparable days</th></tr></thead>
            <tbody>{outlet.days.map(row => {
              const currency = outlet.selection.status === "SELECTED" ? outlet.selection.currency : null;
              return <tr key={row.targetDate}><th scope="row">{longDate(row.targetDate)}</th>{row.forecast && currency ? <><td>{whole(row.forecast.forecastSalesMinor, currency)}</td><td>{whole(row.forecast.lowerSalesMinor, currency)} – {whole(row.forecast.upperSalesMinor, currency)}</td><td>{row.forecast.support === "MODERATE" ? "Moderate" : "Low"}</td><td>{row.forecast.evidence.length} {row.forecast.basis === "SAME_WEEKDAY" ? "same weekdays" : "recent days"}</td></> : <td colSpan={4}>Not available</td>}</tr>;
            })}</tbody></table> : <p>No eligible sales history, so no forecast was produced.</p>}
        </details>)}
        <p className="owner-note">Method {weekly.methodVersion}: a recency-weighted average of matching weekdays from the 56 days up to the data-through date, with isolated high days capped. Expected transactions use the same method on timed transactions, by hour of the trading day{staffing ? ` (${staffing.workloadMethodVersion})` : ""}. Calendar events and holidays are not modelled. Source rule {weekly.ruleVersion}: provider sales replace other history only with 28 or more recent days, including three of every weekday, in the location’s planning currency, with a connected merchant account first; imported history needs the same depth and comes before reference history. No AI is used in this forecast.</p>
      </details>
    </>}
  </div>;
}

// How strong a day's shading is: its gap against the week's largest. The figure is always in the cell too.
function heatLevel(gap: number, max: number) { return gap === 0 || max === 0 ? 0 : gap / max > 2 / 3 ? 3 : gap / max > 1 / 3 ? 2 : 1; }

function OperationalTotal({ staffing }: { staffing?: WeeklyStaffing | null }) {
  const rows = staffing?.outlets.flatMap(outlet => outlet.days.map(day => day.expectedMilliTransactions)) ?? [];
  const known = rows.length > 0 && rows.every(value => value !== null);
  return <><strong className={known ? "" : "owner-metric-empty"}>{known ? transactions(rows.reduce<number>((sum, value) => sum + value!, 0)) : staffing === null ? "Unavailable" : "Not available"}</strong><p>{known ? "Bills expected inside trading hours. This sets the staff capacity needed." : "Needs timed sales history and trading hours at every location."}</p></>;
}

// Expected workload by location and day, with each location's busiest hour of the week.
function OperationalByLocation({ staffing }: { staffing?: WeeklyStaffing | null }) {
  if (!staffing?.outlets.length) return null;
  const dates = staffing.outlets[0].days.map(row => row.planningDate);
  const aligned = staffing.outlets.every(outlet => outlet.days[0]?.planningDate === dates[0]);
  return <section aria-labelledby="owner-operational-title"><div className="owner-section-heading"><div><p className="owner-layer">Operational</p><h2 id="owner-operational-title">Expected transactions by location</h2><p>How much work to expect and when. Open a location to see each day by time.</p></div></div>
    <div className="owner-forecast-scroll" role="region" aria-label="Expected transactions by location table" tabIndex={0}><table className="owner-location-table owner-forecast-table">
      <caption className="owner-sr-only">Expected transactions by location and planning day. Forecasts, not recorded sales.</caption>
      <thead><tr><th scope="col">Location</th>{aligned ? dates.map(date => <th scope="col" key={date}>{shortDate(date)}</th>) : Array.from({ length: 7 }, (_, i) => <th scope="col" key={i}>Day {i + 1}</th>)}<th scope="col">Week</th></tr></thead>
      <tbody>{staffing.outlets.map(outlet => {
        const blocks = outlet.days.flatMap(row => row.blocks.map(block => ({ date: row.planningDate, block })));
        const busiest = blocks.reduce<(typeof blocks)[number] | null>((best, row) => (row.block.expectedMilliTransactions ?? 0) > (best?.block.expectedMilliTransactions ?? 0) ? row : best, null);
        const week = outlet.days.every(row => row.expectedMilliTransactions !== null) ? outlet.days.reduce((sum, row) => sum + row.expectedMilliTransactions!, 0) : null;
        return <tr key={outlet.outletId}><th scope="row"><Link href={`/owner/locations/${outlet.outletId}`}><strong>{outlet.outletName}</strong></Link>{busiest ? <small>{`Busiest ${shortDate(busiest.date)} ${formatClock(busiest.block.start)}`}</small> : null}</th>
          {outlet.days.map(row => <td key={row.planningDate} data-label={shortDate(row.planningDate)}>{row.closed ? "Closed" : row.closed === null ? "Not available" : transactions(row.expectedMilliTransactions)}</td>)}
          <td data-label="Week"><strong>{week === null ? "Not available" : transactions(week)}</strong></td></tr>;
      })}</tbody>
    </table></div></section>;
}

// Where casual work is needed, by location and day.
function StaffingHeat({ staffing, maxGap }: { staffing?: WeeklyStaffing | null; maxGap: number }) {
  if (!staffing?.outlets.length) return null;
  const dates = staffing.outlets[0].days.map(row => row.planningDate);
  const aligned = staffing.outlets.every(outlet => outlet.days[0]?.planningDate === dates[0]);
  return <section aria-labelledby="owner-opportunity-title"><div className="owner-section-heading"><div><p className="owner-layer">Staffing and opportunity</p><h2 id="owner-opportunity-title">Casual requirement by location</h2><p>Capacity your policy requires, less regular and allocated casual cover, worked out by time of day. Spare cover at one time doesn’t offset a shortage at another.</p></div></div>
    <div className="owner-forecast-scroll" role="region" aria-label="Casual requirement by location table" tabIndex={0}><table className="owner-location-table owner-forecast-table">
      <caption className="owner-sr-only">Casual requirement by location and planning day. Derived from expected transactions and coverage; no shifts have been created.</caption>
      <thead><tr><th scope="col">Location</th>{aligned ? dates.map(date => <th scope="col" key={date}>{shortDate(date)}</th>) : Array.from({ length: 7 }, (_, i) => <th scope="col" key={i}>Day {i + 1}</th>)}<th scope="col">Week</th></tr></thead>
      <tbody>{staffing.outlets.map(outlet => <tr key={outlet.outletId}><th scope="row"><Link href={`/owner/locations/${outlet.outletId}`}><strong>{outlet.outletName}</strong></Link></th>
        {outlet.days.map(row => <td key={row.planningDate} data-label={shortDate(row.planningDate)} data-heat={row.casualGapMinutes === null ? undefined : heatLevel(row.casualGapMinutes, maxGap)}>{row.closed ? "Closed" : row.casualGapMinutes === null ? <small>Not set up</small> : row.casualGapMinutes === 0 ? <small className="heat-gap">Covered</small> : <strong className="heat-gap">{labourHours(row.casualGapMinutes)}</strong>}</td>)}
        <td data-label="Week"><strong>{outlet.totals ? labourHours(outlet.totals.casualGapMinutes) : "Not available"}</strong></td></tr>)}</tbody>
    </table></div></section>;
}

function StaffingSummary({ staffing }: { staffing?: WeeklyStaffing | null }) {
  const c = staffing?.consolidated;
  const located = staffing?.outlets.filter(outlet => outlet.totals).length ?? 0;
  return <div><h2>Casual requirement</h2><strong className={c ? "" : "owner-metric-empty"}>{c ? labourHours(c.totals.casualGapMinutes) : staffing === null ? "Unavailable" : located ? "By location" : "Configuration required"}</strong>
    <p>{c ? `Required ${labourHours(c.totals.requiredMinutes)} · existing coverage ${labourHours(c.totals.coverageMinutes)} · approx. ${c.totals.indicativeShifts} ${c.totals.indicativeShifts === 1 ? "shift" : "shifts"} to fill`
      : staffing === null ? "Coverage could not be loaded. No gap has been assumed." : located ? `${located} of ${staffing!.outlets.length} locations have a complete staffing week.` : "Needs a forecast, service capacity, trading hours and regular coverage."}</p></div>;
}

function StaffingByLocation({ staffing }: { staffing?: WeeklyStaffing | null }) {
  if (staffing === undefined) return null;
  const heading = <div className="owner-section-heading"><div><h2 id="owner-staffing-title">Staffing by location</h2><p>Demand, then coverage, then what remains. Open a location for its full day-by-day working.</p></div></div>;
  if (staffing === null) return <section aria-labelledby="owner-staffing-title" className="owner-staffing">{heading}<div className="owner-empty" role="alert"><h3>Staffing could not be loaded</h3><p>Coverage was not read, so no casual requirement is shown. The forecast above is unaffected. Reload to try again.</p></div></section>;
  const dates = staffing.outlets[0]?.days.map(day => day.planningDate) ?? [];
  const aligned = staffing.outlets.every(outlet => outlet.days[0]?.planningDate === dates[0]);
  return <details className="panel disclosure">
    <summary id="owner-staffing-title">Staffing working by location</summary>
    <p className="note">Demand, then coverage, then what remains. Open a location for its full day-by-day working.</p>
    <div className="owner-forecast-scroll" role="region" aria-label="Casual hours by location table" tabIndex={0}><table className="owner-location-table owner-forecast-table">
      <caption className="owner-sr-only">Casual requirement in hours by location and planning day. Derived from forecasts and coverage; no shifts have been created.</caption>
      <thead><tr><th scope="col">Location</th>{aligned ? dates.map(date => <th scope="col" key={date}>{shortDate(date)}</th>) : Array.from({ length: 7 }, (_, i) => <th scope="col" key={i}>Day {i + 1}</th>)}<th scope="col">Week</th></tr></thead>
      <tbody>{staffing.outlets.map(outlet => <tr key={outlet.outletId}><th scope="row"><strong>{outlet.outletName}</strong>{outlet.totals ? <small>{`Required ${labourHours(outlet.totals.requiredMinutes)} · covered ${labourHours(outlet.totals.coverageMinutes)}`}</small> : null}</th>
        {outlet.days.map(day => <td key={day.planningDate} data-label={shortDate(day.planningDate)}>{day.casualGapMinutes === null ? "Unavailable" : labourHours(day.casualGapMinutes)}</td>)}
        <td data-label="Week"><strong>{outlet.totals ? labourHours(outlet.totals.casualGapMinutes) : "Unavailable"}</strong>{outlet.totals ? <small>{`approx. ${outlet.totals.indicativeShifts} ${outlet.totals.indicativeShifts === 1 ? "shift" : "shifts"}`}</small> : null}</td></tr>)}</tbody>
      {staffing.consolidated ? <tfoot><tr><th scope="row">All locations</th>{dates.map((date, i) => <td key={date} data-label={shortDate(date)}>{labourHours(staffing.outlets.reduce((sum, outlet) => sum + outlet.days[i].casualGapMinutes!, 0))}</td>)}<td data-label="Week"><strong>{labourHours(staffing.consolidated.totals.casualGapMinutes)}</strong></td></tr></tfoot> : null}
    </table></div>
    <div className="owner-staffing-detail">
      {staffing.outlets.map(outlet => <details className="owner-forecast-detail" key={outlet.outletId}><summary><strong>{outlet.outletName}</strong> <small>{outlet.totals ? `Casual requirement ${labourHours(outlet.totals.casualGapMinutes)} this week` : outlet.days.find(day => day.unavailable) ? STAFFING_UNAVAILABLE[outlet.days.find(day => day.unavailable)!.unavailable!] : ""}</small></summary>
        <div className="owner-forecast-scroll-inner" role="region" aria-label={`${outlet.outletName} staffing by day`} tabIndex={0}><StaffingDayTable outlet={outlet} /></div>
        <p>{outlet.regularCoverage === "REFERENCE" ? "Regular coverage: the reference company’s standing cover (synthetic input)." : outlet.regularCoverage === "CONFIGURED" ? "Regular coverage: as configured for this location." : "No regular-staff coverage has been set for this location, so its casual requirement is not calculated."}</p>
        <p>{outlet.policy ? `Workload policy: ${policyDescription(outlet.policy)}.` : "Service capacity isn’t set for this location, so required staff is unavailable. This does not mean no staff are needed."}</p>
      </details>)}
    </div>
    <p className="owner-note"><StaffingMethodNote policy={staffing.outlets.find(outlet => outlet.policy)?.policy ?? null} /> Method {staffing.methodVersion}. No AI is used in these figures.</p>
  </details>;
}
