import { StatusBadge } from "@/app/components/product-ui";
import { money } from "@/app/components/format";
import { UK_MINIMUM_WAGE_SOURCE, WAGE_CATEGORY_LABEL, WAGE_REFERENCE_VERSION, WAGE_STATUS_LABEL, wageCheckExplanation, type RatePeriod, type WageCheck, type WageJurisdiction, type WageTerms } from "@/server/domain/statutory-wage";
import { isSouthAfricanJurisdiction, SA_MINIMUM_WAGE_SOURCE, SA_WAGE_STATUS_LABEL, saWageIndicator, saWageIndicatorExplanation, type SaWageIndicator } from "@/server/domain/sa-wage-reference";

// Shared presentation of the deterministic wage check (FS-WAGE-INTEL-DEC-001, -DEC-002).
// Plain components with no server dependencies, used by Owner, Manager and Worker pages alike.

const TONE = { RATE_CHECKED: "success", BELOW_DEMO_MINIMUM: "danger", REFERENCE_UNAVAILABLE: "warning", NOT_CHECKABLE: "warning", OUTSIDE_DEMO_SCOPE: "neutral" } as const;
export function WageStatusBadge({ check }: { check: WageCheck }) {
  return <StatusBadge tone={TONE[check.status]}>{WAGE_STATUS_LABEL[check.status]}</StatusBadge>;
}

export const longDay = (date: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));

export function wageExplanation(check: WageCheck) {
  return wageCheckExplanation({ ...check, date: longDay(check.date) }, minor => money(minor, check.floorCurrency ?? "GBP"));
}

// One line saying what was checked and why, with its status.
export function WageCheckLine({ check, compact = false }: { check: WageCheck; compact?: boolean }) {
  return <p className={`wage-check wage-check-${check.status.toLowerCase().replaceAll("_", "-")}`} role="status">
    <WageStatusBadge check={check} /> <span>{compact && check.status === "RATE_CHECKED" ? `At or above the ${check.jurisdiction.jurisdiction === "SOUTH_AFRICA" ? check.floorName : "FairShift demo minimum (the 21-and-over rate)"} for ${longDay(check.date)}.` : wageExplanation(check)}</span>
  </p>;
}

export function WageRates({ period, highlight }: { period: RatePeriod; highlight?: readonly string[] }) {
  return <dl className="wage-rates">
    {period.rates.map(row => <div key={row.category} data-applies={highlight?.includes(row.category) ? "" : undefined}>
      <dt>{WAGE_CATEGORY_LABEL[row.category]}{row.category === "AGE_21_AND_OVER" ? <small>National Living Wage</small> : null}</dt>
      <dd>{money(row.rateMinor, "GBP")}<small>an hour</small></dd>
    </div>)}
  </dl>;
}

export function WageSource({ period }: { period?: RatePeriod | null }) {
  return <p className="note wage-source"><span className="provenance">Statutory reference · {UK_MINIMUM_WAGE_SOURCE.publisher}</span>{" "}
    {period ? `In force ${longDay(period.validFrom)} to ${longDay(period.validTo)}. ` : ""}Source: <a href={UK_MINIMUM_WAGE_SOURCE.url} target="_blank" rel="noreferrer">{UK_MINIMUM_WAGE_SOURCE.title}</a>, checked {longDay(UK_MINIMUM_WAGE_SOURCE.retrievedOn)} (reference {WAGE_REFERENCE_VERSION}).</p>;
}

// South African minimum wage reference: an indicator beside the terms, never a gate.
const SA_TONE = { ABOVE_REFERENCE: "success", EQUAL_TO_REFERENCE: "success", BELOW_REFERENCE: "warning", NOT_COMPARED: "neutral" } as const;
export function saIndicatorFor(jurisdiction: WageJurisdiction | null | undefined, date: string, currencyCode: string, terms: WageTerms | null) {
  return isSouthAfricanJurisdiction(jurisdiction) ? saWageIndicator({ country: jurisdiction!.country, date, currencyCode, terms }) : null;
}
export function SaWageIndicatorLine({ indicator }: { indicator: SaWageIndicator }) {
  return <p className={`wage-check wage-check-sa-${indicator.status.toLowerCase().replaceAll("_", "-")}`} role="status">
    <StatusBadge tone={SA_TONE[indicator.status]}>{SA_WAGE_STATUS_LABEL[indicator.status]}</StatusBadge>{" "}
    <span>{saWageIndicatorExplanation(indicator, minor => money(minor, "ZAR"))} Source: <a href={SA_MINIMUM_WAGE_SOURCE.url} target="_blank" rel="noreferrer">South African Government, {longDay(SA_MINIMUM_WAGE_SOURCE.publishedOn)}</a>.</span>
  </p>;
}

// The same indicator folded to its chip, with the full wording one click away (design: compact cards).
export function SaWageIndicatorFold({ indicator }: { indicator: SaWageIndicator }) {
  return <details className="disclosure-inline wage-fold"><summary><StatusBadge tone={SA_TONE[indicator.status]}>{SA_WAGE_STATUS_LABEL[indicator.status]}</StatusBadge></summary>
    <p className="note">{saWageIndicatorExplanation(indicator, minor => money(minor, "ZAR"))} Source: <a href={SA_MINIMUM_WAGE_SOURCE.url} target="_blank" rel="noreferrer">South African Government, {longDay(SA_MINIMUM_WAGE_SOURCE.publishedOn)}</a>.</p></details>;
}

// The competition policy, said plainly wherever the enforced floor appears (FS-WAGE-INTEL-DEC-002).
export function DemoFloorPolicy() {
  return <p className="note demo-floor-policy"><span className="provenance">FairShift competition policy</span> Every shift must pay at least the 21-and-over rate for its date. Younger workers and apprentices can have lower statutory minimums; FairShift holds no age or apprenticeship records and doesn’t apply them in this demo.</p>;
}
