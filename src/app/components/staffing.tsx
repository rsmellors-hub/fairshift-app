import type { LabourPolicy, OutletStaffing, StaffingDay, StaffingUnavailableReason } from "@/server/intelligence/staffing";

const locale = (currency: string) => currency === "GBP" ? "en-GB" : "en-US";
export const wholeMoney = (minor: number, currency: string) => new Intl.NumberFormat(locale(currency), { style: "currency", currency, maximumFractionDigits: 0 }).format(minor / 100);
// Labour is held in integer minutes; hours are shown with up to two decimals (15-minute steps).
export const labourHours = (minutes: number) => `${new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(minutes / 60)} h`;
export const longDate = (date: string) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
const planningDay = (date: string) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));

export const STAFFING_UNAVAILABLE: Record<StaffingUnavailableReason, string> = {
  NO_FORECAST: "No forecast, so no labour requirement",
  NO_LABOUR_ASSUMPTION: "No staffing assumption for this currency",
  REGULAR_COVERAGE_NOT_SET: "Regular coverage not set",
};

export function staffingAssumption(policy: LabourPolicy) {
  return `${wholeMoney(policy.salesMinorPerLabourHour, policy.currency)} forecast sales per labour hour`;
}

export function StaffingMethodNote({ policy }: { policy: LabourPolicy | null }) {
  return <>{policy ? `Reference staffing assumption: ${staffingAssumption(policy)}, rounded up to ${policy.planningIncrementMinutes} minutes. It is a planning assumption for the reference retailer, not a measured or AI-derived rate. ` : "No staffing assumption applies to this location’s currency, so no labour requirement is calculated. "}
    Existing coverage is the location’s regular-staff rota plus allocated casual shifts; offers and accepted shifts awaiting allocation are not counted.
    {policy ? ` Indicative shifts divide the casual labour gap into ${policy.indicativeShiftMinutes / 60}-hour shifts. No shifts have been created or offered.` : null}</>;
}

const cell = (day: StaffingDay, value: number | null, render: (value: number) => string) => value === null ? (day.unavailable ? "Unavailable" : "—") : render(value);

// Demand → coverage → gap for one location's planning week.
export function StaffingDayTable({ outlet, className }: { outlet: OutletStaffing; className?: string }) {
  const currency = outlet.currency ?? "GBP";
  return <table className={className}>
    <caption className="owner-sr-only">{outlet.outletName}: forecast demand, required labour, existing coverage and casual labour gap by planning day</caption>
    <thead><tr><th scope="col">Planning day</th><th scope="col">Forecast demand</th><th scope="col">Required labour</th><th scope="col">Regular coverage</th><th scope="col">Allocated casual coverage</th><th scope="col">Casual labour gap</th><th scope="col">Indicative shifts</th></tr></thead>
    <tbody>{outlet.days.map(day => <tr key={day.planningDate}>
      <th scope="row">{planningDay(day.planningDate)}{day.unavailable ? <small>{STAFFING_UNAVAILABLE[day.unavailable]}</small> : null}</th>
      <td data-label="Forecast demand">{day.forecastSalesMinor === null ? "Not available" : wholeMoney(day.forecastSalesMinor, currency)}</td>
      <td data-label="Required labour">{cell(day, day.requiredMinutes, labourHours)}</td>
      <td data-label="Regular coverage">{day.regularMinutes === null ? "Not set" : labourHours(day.regularMinutes)}</td>
      <td data-label="Allocated casual coverage">{labourHours(day.allocatedCasualMinutes)}</td>
      <td data-label="Casual labour gap"><strong>{cell(day, day.casualGapMinutes, labourHours)}</strong></td>
      <td data-label="Indicative shifts">{cell(day, day.indicativeShifts, String)}</td>
    </tr>)}</tbody>
  </table>;
}
