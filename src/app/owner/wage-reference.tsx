import { money } from "@/app/components/format";
import { StatePanel } from "@/app/components/product-ui";
import { DemoFloorPolicy, longDay, WageRates, WageSource, WageStatusBadge, wageExplanation } from "@/app/components/wage-check";
import { checkWage, minutesCovered, nextRateChange, ratesInForce, type WageJurisdiction } from "@/server/domain/statutory-wage";
import { SA_MINIMUM_WAGE_SOURCE } from "@/server/domain/sa-wage-reference";
import { acknowledgeWageNotCheckedAction } from "@/app/operations-actions";
import { WAGE_NOT_CHECKED_STATEMENT, type WageAcknowledgement } from "@/server/scheduling/wage-acknowledgement";

// Day 6, Step 3a: where no wage rule is held for the country or a date, shifts are offered only after the
// Owner acknowledges, once per location, that FairShift doesn't check the minimum wage there (audited).
function WageNotCheckedAcknowledgement({ acknowledgement, scopeNote }: { acknowledgement: WageAcknowledgement | null; scopeNote: string }) {
  return <div className="wage-acknowledgement" id="wage-acknowledgement">
    <p><span className="status-badge status-badge-warning">Minimum wage not checked</span> {scopeNote}</p>
    {acknowledgement ? <p className="note">Acknowledged by the Owner on {longDay(acknowledgement.at.toISOString().slice(0, 10))}{acknowledgement.country ? ` for ${acknowledgement.country}` : ""}: “{WAGE_NOT_CHECKED_STATEMENT}” Recorded in the audit log.</p>
      : <form action={acknowledgeWageNotCheckedAction} className="workspace-form" data-demo-write="">
        <label className="acceptance-check"><input type="checkbox" name="confirmed" value="yes" required /> {WAGE_NOT_CHECKED_STATEMENT}</label>
        <button className="secondary-button" type="submit">Acknowledge and allow offers</button>
        <p className="note">Until you do, shifts here whose minimum wage isn’t checked can’t be created or offered. Your acknowledgement is recorded in the audit log with your name and the time.</p>
      </form>}
  </div>;
}

const duration = (minutes: number) => `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;

// The statutory benchmark for one location: which reference applies, the rates in force today, the
// next published change, and the source. FairShift checks against it; the Owner sets the rate.
export function WageReferencePanel({ jurisdiction, today, locationName, currency, acknowledgement = null }: { jurisdiction: WageJurisdiction; today: string; locationName: string; currency: string; acknowledgement?: WageAcknowledgement | null }) {
  // Day 6, Step 3a: South Africa's own rule, enforced: the national minimum wage per ordinary hour.
  if (jurisdiction.jurisdiction === "SOUTH_AFRICA") {
    const today_ = checkWage({ jurisdiction, date: today, currencyCode: "ZAR", terms: { earningsModel: "HOURLY", rateMinor: 0 } });
    return <section className="panel wage-reference" id="wage-reference" aria-labelledby="wage-reference-title">
      <div className="panel-head"><h2 id="wage-reference-title">Minimum wage reference · {locationName}</h2><span className="status-badge status-badge-fact">Country rule · {jurisdiction.country}</span></div>
      {today_.floorMinor !== null ? <div className="demo-floor"><span>{today_.floorName} · today</span><strong>{money(today_.floorMinor, "ZAR")} an hour</strong><small>Per ordinary hour, from 1 March 2026. Pay below it is refused when terms are set and when shifts are created or offered.</small></div>
        : <p>FairShift holds no verified South African minimum wage for {longDay(today)}, so no minimum can be confirmed and shifts for such dates can’t be offered.</p>}
      <WageNotCheckedAcknowledgement acknowledgement={acknowledgement} scopeNote="FairShift holds no verified South African rate before 1 March 2026 or from 1 March 2027, so shifts on those dates aren’t checked. Commission terms can’t be set." />
      <p className="note wage-source"><span className="provenance">Statutory reference · {SA_MINIMUM_WAGE_SOURCE.publisher}</span> Source: <a href={SA_MINIMUM_WAGE_SOURCE.url} target="_blank" rel="noreferrer">{SA_MINIMUM_WAGE_SOURCE.title}</a>, published {longDay(SA_MINIMUM_WAGE_SOURCE.publishedOn)}. A focused check, not a compliance system{currency === "ZAR" ? "" : `; this location’s terms are in ${currency}, so they can’t be compared`}.</p>
    </section>;
  }
  const period = jurisdiction.jurisdiction === "ENGLAND" ? ratesInForce(today) : null;
  if (!period) {
    const reason = jurisdiction.jurisdiction === null ? jurisdiction.reason === "COUNTRY_NOT_STATED" ? `${locationName} has no country recorded, so FairShift can’t tell which minimum wage applies.`
      : jurisdiction.reason === "NATION_NOT_VERIFIED" ? "FairShift’s UK reference hasn’t been verified for Northern Ireland."
      : jurisdiction.reason === "OUTSIDE_DEMO_JURISDICTION" ? `FairShift’s demo minimum applies to England, the demonstration jurisdiction, and ${locationName} is in ${jurisdiction.country}.`
      : `FairShift holds no minimum wage rule for ${jurisdiction.country}, where ${locationName} is.` : `FairShift’s reference has no verified rates for ${longDay(today)}.`;
    return <section className="panel wage-reference" id="wage-reference"><div className="panel-head"><h2>Minimum wage reference · {locationName}</h2><span className="status-badge status-badge-warning">Minimum wage not checked</span></div>
      <p>{reason} Pay here isn’t checked against a statutory minimum. Check the rules that apply to this location yourself.</p>
      <WageNotCheckedAcknowledgement acknowledgement={acknowledgement} scopeNote="Shifts here are offered only after you acknowledge this. Commission terms can’t be set." /></section>;
  }
  const next = nextRateChange(today), nlw = period.rates[0].rateMinor;
  // FS-WAGE-INTEL-DEC-002: the enforced floor is the 21-and-over rate.
  return <section className="panel wage-reference" id="wage-reference" aria-labelledby="wage-reference-title">
    <div className="panel-head"><h2 id="wage-reference-title">Minimum wage reference · {locationName}</h2><span className="status-badge status-badge-fact">England demo jurisdiction · {jurisdiction.country}</span></div>
    <div className="demo-floor"><span>FairShift demo minimum · today</span><strong>{money(nlw, "GBP")} an hour</strong><small>The 21-and-over National Living Wage, in force {longDay(period.validFrom)} to {longDay(period.validTo)}. Each shift is checked against the rate for its own date.</small></div>
    <DemoFloorPolicy />
    <p className="panel-lede">All UK National Minimum Wage rates in force today, {longDay(today)}, for reference:</p>
    <WageRates period={period} />
    {next ? <p className="wage-next"><strong>From {longDay(next.validFrom)}</strong> the 21-and-over rate, and so the demo minimum, rises to {money(next.rates[0].rateMinor, "GBP")} an hour{next.rates[0].rateMinor > nlw ? ` (+${money(next.rates[0].rateMinor - nlw, "GBP")})` : ""}. It isn’t in force yet. Shifts from that date need at least this rate.</p> : null}
    <details className="disclosure-inline"><summary>How FairShift uses these rates</summary>
      <ul className="wage-rules">
        <li><strong>You set the rate.</strong> FairShift prefills new hourly terms with the 21-and-over rate and never changes a rate you’ve set.</li>
        <li><strong>Rate checked</strong> means pay per hour is at or above the 21-and-over rate in force on the shift’s date.</li>
        <li><strong>Below FairShift demo minimum</strong> means pay per hour is under that rate. The server refuses to create or offer shifts on those terms.</li>
        <li><strong>Minimum wage not checked</strong> means FairShift has no verified rate for that date. Nothing is shown as checked, and such shifts are offered only after your acknowledgement below.</li>
        <li>Daily terms are checked per shift, as pay divided by scheduled hours. Commission can’t be checked, so commission terms can’t be set or offered.{currency === "GBP" ? "" : ` This location’s terms are in ${currency}, so they can’t be compared.`} This is a focused check, not legal advice.</li>
      </ul>
    </details>
    <WageNotCheckedAcknowledgement acknowledgement={acknowledgement} scopeNote="FairShift holds verified UK rates from 1 April 2024 to 31 March 2028; shifts on other dates aren’t checked." />
    <WageSource period={period} />
  </section>;
}

// The wage check for one existing policy, from its stored terms. Read-only: nothing here changes a rate.
export function PolicyWageCell({ policy, jurisdiction, today }: { policy: { earningsModel: string; rateMinor: number | null; currencyCode: string }; jurisdiction: WageJurisdiction; today: string }) {
  if (policy.earningsModel === "DAILY" && policy.rateMinor !== null) {
    const period = jurisdiction.jurisdiction === "ENGLAND" && policy.currencyCode === "GBP" ? ratesInForce(today) : null;
    const covered = period ? minutesCovered(policy.rateMinor, period.rates[0].rateMinor) : null;
    return <>Checked for each shift{covered !== null ? <small>Covers up to {duration(covered)} at {money(period!.rates[0].rateMinor, "GBP")}/hour</small> : null}</>;
  }
  const check = checkWage({ jurisdiction, date: today, currencyCode: policy.currencyCode, terms: policy.earningsModel === "HOURLY" && policy.rateMinor !== null ? { earningsModel: "HOURLY", rateMinor: policy.rateMinor } : { earningsModel: "COMMISSION" } });
  // Read-only: an existing rate below the minimum is flagged, never raised.
  return <><WageStatusBadge check={check} /><small>{wageExplanation(check)}</small></>;
}

export function WageBelowNotice({ count }: { count: number }) {
  return count ? <StatePanel title={count === 1 ? "One set of terms is below the FairShift demo minimum" : `${count} sets of terms are below the FairShift demo minimum`} tone="warning"><p>Your rates are kept as you set them, but shifts can’t be created or offered on them. Create new terms at or above the 21-and-over rate.</p></StatePanel> : null;
}
