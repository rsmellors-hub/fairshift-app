import Link from "next/link";
import { labourHours } from "@/app/components/staffing";
import type { OutletStaffing, StaffingDay } from "@/server/intelligence/staffing";

const STEPS = [["plan", "Forecast"], ["fill", "Fill"], ["allocations", "Allocate"], ["review", "Review"]] as const;
export type JourneyStep = typeof STEPS[number][0];

// The Manager's route through the week: each page is one decision on it.
export function ManagerJourney({ current }: { current: JourneyStep }) {
  return <nav className="manager-journey" aria-label="Manager journey"><ol>{STEPS.map(([area, label], index) => <li key={area}><Link href={`/manager/${area}`} aria-current={area === current ? "step" : undefined}><span aria-hidden="true">{index + 1}</span>{label}</Link></li>)}</ol></nav>;
}

const weekday = (date: string) => new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
const shortDay = (date: string) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));

// The day with the largest known casual gap. A day whose gap is unknown is never chosen.
export function busiestDay(days: readonly StaffingDay[]) {
  return days.reduce<StaffingDay | null>((best, day) => (day.casualGapMinutes ?? 0) > (best?.casualGapMinutes ?? 0) ? day : best, null);
}

export function fillHref(date: string) { return `/manager/fill?date=${date}#add-requirement`; }

// Where the week's cover comes from. Parts of one whole, so a stacked bar; a day with no
// known requirement says so rather than drawing as an empty, zero-looking bar.
function CoverBar({ day, scale, act }: { day: StaffingDay; scale: number; act: boolean }) {
  if (day.requiredMinutes === null || day.casualGapMinutes === null || day.regularMinutes === null) return <div className="cover-row"><span className="cover-day">{shortDay(day.planningDate)}</span><span className="cover-unavailable">Not available</span></div>;
  const parts = [["regular", "Regular staff", day.regularMinutes], ["casual", "Allocated casual", day.allocatedCasualMinutes], ["gap", "Gap to fill", day.casualGapMinutes]] as const;
  return <div className="cover-row">
    <span className="cover-day">{shortDay(day.planningDate)}</span>
    <div className="cover-track" role="img" aria-label={`${shortDay(day.planningDate)}: ${parts.map(([, label, minutes]) => `${label} ${labourHours(minutes)}`).join(", ")}`}>
      {parts.filter(([, , minutes]) => minutes > 0).map(([key, label, minutes]) => <span key={key} className={`cover-part cover-${key}`} style={{ width: `${(minutes / scale) * 100}%` }} title={`${label}: ${labourHours(minutes)}`} />)}
    </div>
    <span className="cover-gap">{day.casualGapMinutes === 0 ? "Covered" : act ? <Link href={fillHref(day.planningDate)}>{labourHours(day.casualGapMinutes)} to fill</Link> : `${labourHours(day.casualGapMinutes)} to fill`}</span>
  </div>;
}

// act: this viewer can go on to fill the gaps from here.
export function WeekCover({ outlet, act = true }: { outlet: OutletStaffing; act?: boolean }) {
  const busiest = busiestDay(outlet.days);
  const scale = Math.max(...outlet.days.map(day => Math.max(day.requiredMinutes ?? 0, (day.regularMinutes ?? 0) + day.allocatedCasualMinutes)), 1);
  return <section className="week-cover" aria-labelledby="week-cover-title">
    {busiest ? <div className="week-cover-headline">
      <h3 id="week-cover-title">{weekday(busiest.planningDate)} needs the most cover</h3>
      <p>{labourHours(busiest.regularMinutes ?? 0)} regular staff{busiest.allocatedCasualMinutes ? ` + ${labourHours(busiest.allocatedCasualMinutes)} allocated casual` : ""} + <strong>{labourHours(busiest.casualGapMinutes ?? 0)} gap to fill</strong></p>
      {act ? <Link className="primary-button button-link" href={fillHref(busiest.planningDate)}>Fill {weekday(busiest.planningDate)} gap</Link> : null}
    </div> : <h3 id="week-cover-title">{outlet.days.some(day => day.casualGapMinutes === 0) ? "No casual gap in the days we can calculate" : "Cover can’t be calculated yet"}</h3>}
    <ul className="cover-legend" aria-label="Chart key"><li><i className="cover-regular" />Regular staff</li><li><i className="cover-casual" />Allocated casual</li><li><i className="cover-gap-key" />Gap to fill</li></ul>
    <div className="cover-chart">{outlet.days.map(day => <CoverBar key={day.planningDate} day={day} scale={scale} act={act} />)}</div>
  </section>;
}

export function DecisionNote() {
  return <p className="decision-note"><strong>You decide.</strong> AI suggests priorities and explains them. It creates nothing and offers nothing. Pay and bonuses come from Owner policy, not AI.</p>;
}
