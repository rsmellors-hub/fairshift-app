import Link from "next/link";
import type { OpportunityDemand } from "@/server/intelligence/opportunity";
import { outletOpportunities, windowParam } from "@/server/intelligence/opportunity";
import type { OutletStaffing, ServicePeriod, StaffingDay, StaffingUnavailableReason, WorkloadPolicy } from "@/server/intelligence/staffing";
import { formatClock, transactionCount } from "@/server/intelligence/workload";

const locale = (currency: string) => currency === "GBP" ? "en-GB" : "en-US";
export const wholeMoney = (minor: number, currency: string) => new Intl.NumberFormat(locale(currency), { style: "currency", currency, maximumFractionDigits: 0 }).format(minor / 100);
// Staff time is held in integer minutes; hours are shown with up to two decimals.
export const labourHours = (minutes: number) => `${new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(minutes / 60)} h`;
export const transactions = (milli: number | null) => milli === null ? "Not available" : new Intl.NumberFormat("en-GB").format(transactionCount(milli));
export const longDate = (date: string) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
const planningDay = (date: string) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));

export const STAFFING_UNAVAILABLE: Record<StaffingUnavailableReason, string> = {
  NO_FORECAST: "No forecast, so no staff requirement",
  NO_TIMED_HISTORY: "This history has no transaction times, so demand can’t be placed in the day",
  TRADING_HOURS_NOT_SET: "Trading hours not set",
  NO_WORKLOAD_POLICY: "Service capacity not set, so required staff is unavailable",
  REGULAR_COVERAGE_NOT_SET: "Regular coverage not set",
};

export function policySummary(policy: Pick<WorkloadPolicy, "transactionsPerStaffHour" | "minimumStaffWhileOpen">) {
  return `${policy.transactionsPerStaffHour} transactions per staff hour, at least ${policy.minimumStaffWhileOpen} staff while open`;
}
export function policyDescription(policy: WorkloadPolicy) {
  const owner = policy.source === "REFERENCE" ? "the reference company’s configured policy" : policy.level === "LOCATION" ? "this location’s configured policy" : "this business’s configured policy";
  return `${policySummary(policy)}, ${owner}`;
}

export function StaffingMethodNote({ policy }: { policy: WorkloadPolicy | null }) {
  return <>{policy ? `Staff capacity comes from expected transactions and ${policyDescription(policy)}. It’s the business’s own policy, not a benchmark or an AI-derived rate. ` : "Service capacity isn’t set here, so no staff requirement is calculated. "}
    Sales value isn’t part of the calculation. Coverage is regular staff by time of day plus allocated casual shifts, counted only where they overlap trading hours; offers and accepted shifts awaiting allocation aren’t counted. Spare cover at one time doesn’t offset a shortage at another. No shifts have been created or offered.</>;
}

// What's missing before staffing can be calculated. Never reads as "no staff needed".
export function WorkloadSetupNotice({ outlets, owner }: { outlets: readonly OutletStaffing[]; owner: boolean }) {
  const reasons = new Set(outlets.flatMap(outlet => outlet.days.flatMap(day => day.unavailable ? [day.unavailable] : [])));
  const missing = [outlets.some(outlet => !outlet.policy) ? "service capacity and minimum cover" : null, outlets.some(outlet => !outlet.tradingHours) || reasons.has("TRADING_HOURS_NOT_SET") ? "trading hours" : null, outlets.some(outlet => !outlet.regularCoverage) || reasons.has("REGULAR_COVERAGE_NOT_SET") ? "regular coverage" : null].filter(Boolean);
  if (!missing.length) return null;
  return <div className="setup-notice" role="status"><strong>Configuration required</strong>
    <p>FairShift can’t work out the casual requirement until {missing.join(", ").replace(/, ([^,]*)$/, " and $1")} {missing.length === 1 && missing[0] !== "service capacity and minimum cover" ? "is" : "are"} set. This doesn’t mean no staff are needed, and FairShift doesn’t assume a value. {owner ? "" : "Ask the business owner to set this."}</p>
    {owner ? <Link className="text-link" href="/owner/policies#workload-policy">Set up staffing inputs <span aria-hidden="true">→</span></Link> : null}</div>;
}

// A Manager accepted this policy assumption. It is never shown as a measured effect.
const contextAssumption = (bps: number) => bps === 0 ? "0%" : `${bps > 0 ? "+" : "−"}${Math.abs(bps) / 100}%`;
// Says plainly when a total includes a scenario a Manager accepted, and what the baseline was.
export function AcceptedContextNote({ outlets }: { outlets: readonly OutletStaffing[] }) {
  const rows = outlets.filter(outlet => outlet.baselineTotals && outlet.totals);
  if (!rows.length) return null;
  return <p className="note context-week-note" role="status">Includes contextual scenarios accepted by a Manager, as planning assumptions rather than measured effects: {rows.map(outlet => `${outlet.outletName}, casual requirement ${labourHours(outlet.totals!.casualGapMinutes)} against ${labourHours(outlet.baselineTotals!.casualGapMinutes)} on the baseline`).join("; ")}.</p>;
}
const cell = (day: StaffingDay, value: number | null, render: (value: number) => string) => value === null ? (day.unavailable ? "Unavailable" : "—") : render(value);

// One location's planning week: demand, then coverage, then what remains.
// planHref: where this viewer can act on a day's casual requirement, if anywhere.
export function StaffingDayTable({ outlet, className, planHref }: { outlet: OutletStaffing; className?: string; planHref?: (date: string) => string }) {
  return <table className={className}>
    <caption className="owner-sr-only">{outlet.outletName}: expected transactions, required staff capacity, existing coverage and casual requirement by planning day, with expected sales as commercial context</caption>
    <thead><tr><th scope="col">Planning day</th><th scope="col">Expected transactions</th><th scope="col">Required staff capacity</th><th scope="col">Regular coverage</th><th scope="col">Allocated casual coverage</th><th scope="col">Casual requirement</th><th scope="col">Expected sales</th></tr></thead>
    <tbody>{outlet.days.map(day => <tr key={day.planningDate}>
      <th scope="row">{planningDay(day.planningDate)}{day.closed ? <small>Closed</small> : day.unavailable ? <small>{STAFFING_UNAVAILABLE[day.unavailable]}</small> : null}{day.context ? <small>Includes accepted scenario {contextAssumption(day.context.adjustmentBps)}</small> : null}</th>
      <td data-label="Expected transactions">{day.closed === null ? "Not available" : transactions(day.expectedMilliTransactions)}</td>
      <td data-label="Required staff capacity">{cell(day, day.requiredMinutes, labourHours)}</td>
      <td data-label="Regular coverage">{day.regularMinutes === null ? "Not set" : labourHours(day.regularMinutes)}</td>
      <td data-label="Allocated casual coverage">{labourHours(day.allocatedCasualMinutes)}</td>
      <td data-label="Casual requirement"><strong>{cell(day, day.casualGapMinutes, labourHours)}</strong>{planHref && (day.casualGapMinutes ?? 0) > 0 ? <Link className="staffing-fill-link" href={planHref(day.planningDate)}>Fill shifts</Link> : null}</td>
      <td data-label="Expected sales">{day.forecastSalesMinor === null || !outlet.currency ? "Not available" : wholeMoney(day.forecastSalesMinor, outlet.currency)}</td>
    </tr>)}</tbody>
  </table>;
}

// Reference-company display names for a stretch of the day, only where one name fits.
// Hospitality wording stays out of the calculation: windows are just start and end times.
function periodName(period: Pick<ServicePeriod, "start" | "end">) {
  if (period.end - period.start > 300) return null;
  const middle = (period.start + period.end) / 2;
  return middle < 690 ? "Morning" : middle < 900 ? "Lunch" : middle < 1020 ? "Afternoon" : "Evening";
}
const STATE: Record<ServicePeriod["state"], string> = { COVERED: "Covered", OPEN: "Needs cover", FILLED: "Filled by casual work" };

// Each hour of one day: expected transactions over who is there and what's missing.
function HourStrip({ day }: { day: StaffingDay }) {
  const scale = Math.max(1, ...day.blocks.map(block => Math.max(block.requiredMinutes ?? 0, (block.regularMinutes ?? 0) + block.allocatedCasualMinutes)));
  const hasCapacity = day.blocks.some(block => block.requiredMinutes !== null);
  const volume = Math.max(1, ...day.blocks.map(block => block.expectedMilliTransactions ?? 0));
  return <ol className="hour-strip" aria-label="Expected transactions and cover by hour">{day.blocks.map(block => {
    const heights = hasCapacity ? [["regular", block.regularMinutes ?? 0], ["casual", block.allocatedCasualMinutes], ["gap", block.remainingMinutes ?? 0]] as const : [["demand", block.expectedMilliTransactions ?? 0]] as const;
    return <li key={block.start} title={`${formatClock(block.start)}–${formatClock(block.end)}: ${transactions(block.expectedMilliTransactions)} expected transactions`}>
      <span className="hour-count">{transactions(block.expectedMilliTransactions)}</span>
      <span className="hour-bar">{heights.map(([key, value]) => value > 0 ? <i key={key} className={`hour-${key}`} style={{ height: `${value / (hasCapacity ? scale : volume) * 100}%` }} /> : null)}</span>
      <span className="hour-label">{formatClock(block.start).slice(0, 2)}</span>
    </li>;
  })}</ol>;
}

// One day by time: the periods the manager reads, or the hourly demand while they can't be worked out yet.
function ServiceDay({ outlet, day, act }: { outlet: OutletStaffing; day: StaffingDay; act: boolean }) {
  const named = outlet.evidence?.source === "REFERENCE";
  if (day.closed === null) return <p>{day.unavailable ? STAFFING_UNAVAILABLE[day.unavailable] : "Not available"}. No demand has been placed in this day.</p>;
  if (day.closed) return <p>Closed on this day.</p>;
  return <>
    <HourStrip day={day} />
    {day.outsideHoursMilliTransactions && day.outsideHoursMilliTransactions >= 1000 ? <p className="note">History shows about {transactions(day.outsideHoursMilliTransactions)} transactions outside these trading hours. They aren’t in these figures, so check the hours are right.</p> : null}
    {day.periods.length ? <div className="table-scroll" role="region" aria-label={`${planningDay(day.planningDate)} by service period`} tabIndex={0}><table className="data-table service-table">
      <caption className="owner-sr-only">{outlet.outletName}, {planningDay(day.planningDate)}: demand and cover for each period of the day</caption>
      <thead><tr><th scope="col">Time</th><th scope="col">Expected transactions</th><th scope="col">Required staff capacity</th><th scope="col">Regular coverage</th><th scope="col">Allocated casual</th><th scope="col">Casual requirement</th></tr></thead>
      <tbody>{day.periods.map(period => { const window = `${formatClock(period.start)}–${formatClock(period.end)}`; const name = named ? periodName(period) : null; return <tr key={period.start} data-state={period.state}>
        <th scope="row">{name ? `${name} · ` : ""}{window}<small className={`period-state period-${period.state.toLowerCase()}`}>{STATE[period.state]}</small></th>
        <td data-label="Expected transactions">{transactions(period.expectedMilliTransactions)}<small>Range {transactions(period.lowerMilliTransactions)}–{transactions(period.upperMilliTransactions)}</small></td>
        <td data-label="Required staff capacity">{labourHours(period.requiredMinutes)}</td>
        <td data-label="Regular coverage">{labourHours(period.regularMinutes)}</td>
        <td data-label="Allocated casual">{labourHours(period.allocatedCasualMinutes)}</td>
        <td data-label="Casual requirement"><strong>{period.remainingMinutes ? labourHours(period.remainingMinutes) : "None"}</strong>{act && period.state === "OPEN" ? <Link className="staffing-fill-link" href={`/manager/fill?date=${day.planningDate}&window=${formatClock(period.start)}-${formatClock(period.end)}#add-requirement`}>Fill shifts</Link> : null}</td>
      </tr>; })}</tbody></table></div>
    : <div className="table-scroll" role="region" aria-label={`${planningDay(day.planningDate)} by hour`} tabIndex={0}><table className="data-table service-table">
      <caption className="owner-sr-only">{outlet.outletName}, {planningDay(day.planningDate)}: expected transactions and regular coverage by hour</caption>
      <thead><tr><th scope="col">Time</th><th scope="col">Expected transactions</th><th scope="col">Regular coverage</th><th scope="col">Casual requirement</th></tr></thead>
      <tbody>{day.blocks.map(block => <tr key={block.start}><th scope="row">{formatClock(block.start)}–{formatClock(block.end)}</th><td data-label="Expected transactions">{transactions(block.expectedMilliTransactions)}</td><td data-label="Regular coverage">{block.regularMinutes === null ? "Not set" : labourHours(block.regularMinutes)}</td><td data-label="Casual requirement">Configuration required</td></tr>)}</tbody></table></div>}
  </>;
}

// The week, day by day, in disclosures. Days with a casual requirement say so before they open.
export function ServiceDays({ outlet, act = false }: { outlet: OutletStaffing; act?: boolean }) {
  return <div className="service-days">{outlet.days.map(day => {
    const open = day.periods.filter(period => period.state === "OPEN").map(period => `${formatClock(period.start)}–${formatClock(period.end)}`);
    return <details className="owner-forecast-detail" key={day.planningDate}><summary><strong>{planningDay(day.planningDate)}</strong> <small>{day.closed ? "Closed" : day.unavailable ? `${transactions(day.expectedMilliTransactions)} expected transactions · ${STAFFING_UNAVAILABLE[day.unavailable]}` : open.length ? `Needs cover ${open.join(", ")}` : "Covered through the day"}</small></summary><ServiceDay outlet={outlet} day={day} act={act} /></details>;
  })}</div>;
}

// Where casual work is needed this week, in date order, each ready to carry into Fill Shifts.
export function OpportunityList({ outlet, act }: { outlet: OutletStaffing; act: boolean }) {
  const open = outletOpportunities(outlet).filter(row => row.state === "OPEN");
  if (!open.length) return null;
  return <section className="opportunity-list" aria-labelledby="opportunity-title"><h3 id="opportunity-title">Where casual cover is needed</h3><ul>{open.map(row => <li key={`${row.localDate}-${row.windowStart}`}>
    <span className="opportunity-when"><strong>{planningDay(row.localDate)}</strong> {row.windowStart}–{row.windowEnd}</span>
    <span className="opportunity-figures">{row.expectedTransactions} expected transactions · {labourHours(row.requiredMinutes)} needed · {labourHours(row.regularMinutes + row.allocatedCasualMinutes)} covered{row.acceptedContext ? ` · includes accepted scenario ${contextAssumption(row.acceptedContext.adjustmentBps)}` : ""}</span>
    <strong className="opportunity-gap">{labourHours(row.remainingCasualMinutes)} to fill</strong>
    {act ? <Link className="secondary-button button-link" href={`/manager/fill?date=${row.localDate}&window=${windowParam(row)}#add-requirement`}>Fill shifts</Link> : null}
  </li>)}</ul></section>;
}

// The frozen reason a shift was created. Never a live figure, and pay doesn't read it.
export function WhyThisShift({ evidence }: { evidence: OpportunityDemand }) {
  return <details className="disclosure-inline why-shift"><summary>Why this shift was created</summary><p>Created for {longDate(evidence.localDate)} {evidence.windowStart}–{evidence.windowEnd}: {evidence.expectedTransactions} expected transactions needed {labourHours(evidence.requiredMinutes)} of staff capacity, with {labourHours(evidence.regularMinutes)} regular and {labourHours(evidence.allocatedCasualMinutes)} allocated casual cover, leaving {labourHours(evidence.remainingCasualMinutes)} to fill.{evidence.acceptedContext ? ` Those figures include a contextual scenario a Manager accepted (${contextAssumption(evidence.acceptedContext.adjustmentBps)}, a planning assumption).` : ""}</p><p className="note">Figures as they stood when the shift was created. Policy {evidence.workloadPolicyVersion} · method {evidence.workloadMethodVersion}{evidence.provenance ? ` · ${evidence.provenance.synthetic ? "synthetic reference history" : "recorded sales history"} through ${longDate(evidence.provenance.dataThrough)}` : ""}. These figures don’t affect pay.</p></details>;
}
