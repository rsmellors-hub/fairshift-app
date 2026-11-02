import Link from "next/link";
import type { CommercialContext, CommercialSummary } from "@/server/intelligence/commerce-labour";
import type { OutletStaffing } from "@/server/intelligence/staffing";
import { labourHours, longDate, wholeMoney } from "@/app/components/staffing";

const percent = (bps: number) => `${new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 }).format(bps / 100)}%`;
const signed = (minor: number, currency: string) => `${minor > 0 ? "+" : minor < 0 ? "−" : ""}${wholeMoney(Math.abs(minor), currency)}`;
export const COST_UNAVAILABLE = { GAP_UNAVAILABLE: "Needs a complete casual labour gap", NO_WORK_POLICY: "No hourly or daily work policy in this currency" } as const;
export const costRange = (cost: { lowMinor: number; highMinor: number }, currency: string) => cost.lowMinor === cost.highMinor ? wholeMoney(cost.lowMinor, currency) : `${wholeMoney(cost.lowMinor, currency)} – ${wholeMoney(cost.highMinor, currency)}`;
export const costShare = (cost: { lowBpsOfForecast: number | null; highBpsOfForecast: number | null }) => cost.highBpsOfForecast === null || cost.lowBpsOfForecast === null ? null : cost.lowBpsOfForecast === cost.highBpsOfForecast ? percent(cost.highBpsOfForecast) : `${percent(cost.lowBpsOfForecast)} – ${percent(cost.highBpsOfForecast)}`;
export const forecastAgainst = (comparable: { deltaMinor: number; deltaBps: number | null }, currency: string) => `${signed(comparable.deltaMinor, currency)}${comparable.deltaBps === null ? "" : ` (${comparable.deltaBps > 0 ? "+" : comparable.deltaBps < 0 ? "−" : ""}${percent(Math.abs(comparable.deltaBps))})`}`;

// One location's week, from commerce through to money. Each row names what kind of
// figure it is, so a fact, a forecast and a calculation never read as one thing.
export function CommercialChain({ context, currency, outlet }: { context?: CommercialContext; currency: string | null; outlet: OutletStaffing }) {
  const money = (minor: number) => currency ? wholeMoney(minor, currency) : "Not available";
  const totals = outlet.totals;
  const rows: { kind: string; label: string; value: string; note?: string }[] = [
    { kind: "Recorded", label: "Latest seven days’ sales", value: context?.recent ? money(context.recent.salesMinor) : "Not available", note: context?.recent ? `${context.recent.transactions} transactions · ${context.recent.observedDays} of 7 days with records${context.recent.averageTransactionMinor !== null ? ` · ${money(context.recent.averageTransactionMinor)} average` : ""}` : "No eligible history" },
    { kind: "Forecast", label: "Expected sales, planning week", value: context?.forecast ? money(context.forecast.totalMinor) : "Not available", note: context?.forecast ? `Planning range ${money(context.forecast.lowerMinor)} – ${money(context.forecast.upperMinor)}` : "No forecast" },
    { kind: "Calculated", label: "Forecast against comparable days", value: context?.comparable && currency ? forecastAgainst(context.comparable, currency) : "Not available", note: context?.comparable ? `Comparable: ${money(context.comparable.salesMinor)}, the latest observed matching weekdays` : "A matching recent weekday is missing" },
    { kind: "Calculated", label: "Required staff capacity", value: totals ? labourHours(totals.requiredMinutes) : "Not available", note: outlet.policy ? `From expected transactions at ${outlet.policy.transactionsPerStaffHour} per staff hour, at least ${outlet.policy.minimumStaffWhileOpen} staff while open. Sales value isn’t used` : "Service capacity not set" },
    { kind: "Configured", label: "Regular coverage", value: totals ? labourHours(totals.regularMinutes) : "Not available", note: outlet.regularCoverage ? undefined : "Regular coverage not set" },
    { kind: "Recorded", label: "Allocated casual coverage", value: totals ? labourHours(totals.allocatedCasualMinutes) : "Not available", note: context?.casual ? `Of ${labourHours(context.casual.needMinutes)} casual need before allocations` : undefined },
    { kind: "Calculated", label: "Casual labour gap", value: totals ? labourHours(totals.casualGapMinutes) : "Not available", note: totals ? `Approx. ${totals.indicativeShifts} ${totals.indicativeShifts === 1 ? "shift" : "shifts"} to fill · none created` : undefined },
    { kind: "Estimate", label: "Estimated cost to fill the gap", value: context?.cost && currency ? costRange(context.cost, currency) : "Not available", note: context?.cost ? `Priced on ${context.cost.policies} work ${context.cost.policies === 1 ? "policy" : "policies"} at this location${costShare(context.cost) ? ` · ${costShare(context.cost)} of forecast sales` : ""}` : context?.costUnavailable ? COST_UNAVAILABLE[context.costUnavailable] : undefined },
    { kind: "Calculated", label: "Forecast sales per planned labour hour", value: context?.plannedSalesPerHourMinor != null ? money(context.plannedSalesPerHourMinor) : "Not available", note: context?.plannedSalesPerHourMinor != null ? "Current coverage only, before filling the gap. A plan, not a measurement" : "Needs coverage and a forecast" },
    { kind: "Backtest", label: "Forecast against what happened", value: context?.backtest ? `${percent(context.backtest.errorBps)} typical error` : "Not available", note: context?.backtest ? `${context.backtest.days} days to ${longDate(context.backtest.to)}, each forecast from earlier days of this evidence · ${percent(Math.abs(context.backtest.biasBps))} ${context.backtest.biasBps >= 0 ? "over" : "under"}-forecast overall` : "Too few comparable days to test" },
  ];
  return <div className="owner-forecast-scroll-inner" role="region" aria-label={`${outlet.outletName} commerce to labour`} tabIndex={0}><table className="owner-location-table owner-chain">
    <caption className="owner-sr-only">{outlet.outletName}: from recorded sales through forecast, labour and estimated cost</caption>
    <thead><tr><th scope="col">Kind</th><th scope="col">Measure</th><th scope="col">Value</th><th scope="col">Basis</th></tr></thead>
    <tbody>{rows.map(row => <tr key={row.label}><td data-label="Kind"><span className="owner-status">{row.kind}</span></td><th scope="row">{row.label}</th><td data-label="Value"><strong>{row.value}</strong></td><td data-label="Basis">{row.note ?? "—"}</td></tr>)}</tbody>
  </table></div>;
}

// The company's week across locations, shown only where FairShift can support each figure.
export function CommercialByLocation({ outlets, summary }: { outlets: readonly OutletStaffing[]; summary: CommercialSummary | null }) {
  return <section aria-labelledby="owner-economics-title" className="owner-staffing">
    <p className="note" id="owner-economics-title">Expected demand against comparable days, and what the remaining casual gap would cost to fill.</p>
    <div className="owner-forecast-scroll" role="region" aria-label="Commercial implication by location" tabIndex={0}><table className="owner-location-table owner-forecast-table">
      <caption className="owner-sr-only">Forecast sales, comparable sales, casual labour gap and estimated casual cost by location. Estimates, not recorded outcomes.</caption>
      <thead><tr><th scope="col">Location</th><th scope="col">Forecast sales</th><th scope="col">Against comparable</th><th scope="col">Casual gap</th><th scope="col">Estimated casual cost</th><th scope="col">Cost / forecast sales</th></tr></thead>
      <tbody>{outlets.map(outlet => { const c = outlet.commercial, currency = outlet.currency; return <tr key={outlet.outletId}>
        <th scope="row"><Link href={`/owner/locations/${outlet.outletId}`}><strong>{outlet.outletName}</strong></Link></th>
        <td data-label="Forecast sales">{c?.forecast && currency ? wholeMoney(c.forecast.totalMinor, currency) : "Not available"}</td>
        <td data-label="Against comparable">{c?.comparable && currency ? forecastAgainst(c.comparable, currency) : "Not available"}</td>
        <td data-label="Casual gap">{outlet.totals ? labourHours(outlet.totals.casualGapMinutes) : "Unavailable"}</td>
        <td data-label="Estimated casual cost">{c?.cost && currency ? costRange(c.cost, currency) : <small>{c?.costUnavailable ? COST_UNAVAILABLE[c.costUnavailable] : "Not available"}</small>}</td>
        <td data-label="Cost / forecast sales">{c?.cost ? costShare(c.cost) ?? "Not available" : "Not available"}</td>
      </tr>; })}</tbody>
      {summary?.forecast ? <tfoot><tr><th scope="row">All locations</th><td data-label="Forecast sales">{wholeMoney(summary.forecast.totalMinor, summary.currency)}</td><td data-label="Against comparable">{summary.comparable ? forecastAgainst(summary.comparable, summary.currency) : "Not available"}</td><td data-label="Casual gap">{outlets.every(outlet => outlet.totals) ? labourHours(outlets.reduce((sum, outlet) => sum + outlet.totals!.casualGapMinutes, 0)) : "Unavailable"}</td><td data-label="Estimated casual cost">{summary.cost ? costRange(summary.cost, summary.currency) : "Not available"}</td><td data-label="Cost / forecast sales">{summary.cost ? costShare(summary.cost) ?? "Not available" : "Not available"}</td></tr></tfoot> : null}
    </table></div>
    <p className="owner-note">Estimated casual cost prices only the remaining casual gap on each location’s own hourly or daily work policies. Regular staff wages are not held by FairShift, so it is not total labour cost, and it is not a saving or a measured return. Comparable sales use the latest observed matching weekdays in the same evidence.</p>
  </section>;
}
