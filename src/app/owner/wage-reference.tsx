import { money } from "@/app/components/format";
import { StatePanel } from "@/app/components/product-ui";
import { DemoFloorPolicy, longDay, WageRates, WageSource, WageStatusBadge, wageExplanation } from "@/app/components/wage-check";
import { checkWage, minutesCovered, nextRateChange, ratesInForce, type WageJurisdiction } from "@/server/domain/statutory-wage";

const duration = (minutes: number) => `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;

// The statutory benchmark for one location: which reference applies, the rates in force today, the
// next published change, and the source. FairShift checks against it; the Owner sets the rate.
export function WageReferencePanel({ jurisdiction, today, locationName, currency }: { jurisdiction: WageJurisdiction; today: string; locationName: string; currency: string }) {
  const period = jurisdiction.jurisdiction === "ENGLAND" ? ratesInForce(today) : null;
  if (!period) {
    const reason = jurisdiction.jurisdiction === null ? jurisdiction.reason === "COUNTRY_NOT_STATED" ? `${locationName} has no country recorded, so FairShift can’t tell which minimum wage applies.`
      : jurisdiction.reason === "NATION_NOT_VERIFIED" ? "FairShift’s UK reference hasn’t been verified for Northern Ireland."
      : jurisdiction.reason === "OUTSIDE_DEMO_JURISDICTION" ? `FairShift’s demo minimum applies to England, the demonstration jurisdiction, and ${locationName} is in ${jurisdiction.country}.`
      : `FairShift holds a verified minimum wage reference for the UK only, and ${locationName} is in ${jurisdiction.country}.` : `FairShift’s reference has no verified rates for ${longDay(today)}.`;
    return <section className="panel wage-reference" id="wage-reference"><div className="panel-head"><h2>Minimum wage reference · {locationName}</h2><span className={`status-badge status-badge-${jurisdiction.jurisdiction === null && jurisdiction.reason === "OUTSIDE_DEMO_JURISDICTION" ? "neutral" : "warning"}`}>{jurisdiction.jurisdiction === null && jurisdiction.reason === "OUTSIDE_DEMO_JURISDICTION" ? "Outside demo jurisdiction" : "Statutory reference unavailable"}</span></div>
      <p>{reason} {jurisdiction.jurisdiction === "ENGLAND" ? "No minimum can be confirmed, so shifts for such dates can’t be offered." : "Pay here isn’t checked against a statutory minimum. Check the rules that apply to this location yourself."}</p></section>;
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
        <li><strong>Statutory reference unavailable</strong> means FairShift has no verified rate for that date, so nothing is shown as checked and no shift is offered.</li>
        <li>Daily terms are checked per shift, as pay divided by scheduled hours. Commission can’t be checked, so it isn’t offered here.{currency === "GBP" ? "" : ` This location’s terms are in ${currency}, so they can’t be compared.`} This is a focused check, not legal advice.</li>
      </ul>
    </details>
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
