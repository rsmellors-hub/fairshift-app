"use client";

import { useState } from "react";
import { money, scheduledHours } from "@/app/components/format";
import { localDateTimeToInstant, LocalTimeError } from "@/server/domain/timezone";
import { expectedWorkEarnings, type WorkPolicy } from "@/server/domain/work-terms";
import { checkWage, termsForWageCheck, wageAllowsOffer, type WageCheck, type WageJurisdiction } from "@/server/domain/statutory-wage";
import { SaWageIndicatorLine, saIndicatorFor, WageCheckLine } from "@/app/components/wage-check";
import type { SaWageIndicator } from "@/server/domain/sa-wage-reference";

// The shift's date at the work location, as the server reads it.
const zonedDate = (instant: Date, timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);

type PolicyOption = { id: string; name: string; earningsModel: string; rateMinor: number | null; commissionBps: number | null; currencyCode: string; incentiveTargetMinor: number | null; incentiveBonusMinor: number | null };

function policyTerms(policy: PolicyOption) {
  if (policy.earningsModel === "COMMISSION") return `${(policy.commissionBps ?? 0) / 100}% of verified attributed sales`;
  const bonus = policy.incentiveTargetMinor && policy.incentiveBonusMinor ? ` · ${money(policy.incentiveBonusMinor, policy.currencyCode)} bonus at ${money(policy.incentiveTargetMinor, policy.currencyCode)} sales` : "";
  return `${money(policy.rateMinor ?? 0, policy.currencyCode)}/${policy.earningsModel === "HOURLY" ? "hour" : "day"}${bonus}`;
}

// Times are typed as wall-clock at the work location. The preview uses the same time
// and earnings rules the server applies, and the server decides again on submit.
export function RequirementForm({ action, departments, policies, timeZone, locationName, defaults, context, wageJurisdiction }: {
  action: (form: FormData) => void | Promise<void>;
  departments: { id: string; name: string }[];
  policies: PolicyOption[];
  timeZone: string;
  locationName: string;
  defaults: { departmentId?: string; startsAt: string; endsAt: string; headcount: number };
  context: React.ReactNode;
  wageJurisdiction: WageJurisdiction;
}) {
  const [policyId, setPolicyId] = useState(policies[0]?.id ?? "");
  const [startsAt, setStartsAt] = useState(defaults.startsAt);
  const [endsAt, setEndsAt] = useState(defaults.endsAt);
  const policy = policies.find(row => row.id === policyId);
  let preview: string;
  let terms: { hours: string; hourly: string; base: number | null; bonus: number | null; currency: string; check: WageCheck | null; sa: SaWageIndicator | null } | null = null;
  try {
    if (!startsAt || !endsAt) preview = "Enter a start and end to see the duration and earnings.";
    else {
      const start = localDateTimeToInstant(startsAt, timeZone), end = localDateTimeToInstant(endsAt, timeZone);
      if (end <= start) preview = "The end must be after the start.";
      else if (!policy) preview = "";
      else {
        const expected = expectedWorkEarnings(policy.earningsModel === "COMMISSION"
          ? { earningsModel: "COMMISSION", commissionBps: policy.commissionBps ?? 0, commissionBasis: "VERIFIED_ATTRIBUTED_SALES" }
          : { earningsModel: policy.earningsModel, rateMinor: policy.rateMinor ?? 0 } as WorkPolicy, start, end);
        preview = `${scheduledHours(start, end)} · ${expected === null ? "earnings depend on verified attributed sales" : `${money(expected, policy.currencyCode)} expected earnings per worker${policy.incentiveBonusMinor ? `, up to ${money(expected + policy.incentiveBonusMinor, policy.currencyCode)} with the sales bonus` : ""}`}`;
        const wageTerms = termsForWageCheck(policy, { startsAt: start, endsAt: end });
        const hourly = policy.earningsModel === "HOURLY" ? `${money(policy.rateMinor ?? 0, policy.currencyCode)} an hour`
          : policy.earningsModel === "DAILY" ? `${money(policy.rateMinor ?? 0, policy.currencyCode)} for the shift · ${money(Math.floor(((policy.rateMinor ?? 0) * 3_600_000) / (end.getTime() - start.getTime())), policy.currencyCode)} an hour`
          : `${(policy.commissionBps ?? 0) / 100}% commission`;
        terms = { hours: scheduledHours(start, end), hourly, base: expected, bonus: policy.incentiveBonusMinor, currency: policy.currencyCode,
          check: checkWage({ jurisdiction: wageJurisdiction, date: zonedDate(start, timeZone), currencyCode: policy.currencyCode, terms: wageTerms ?? { earningsModel: "HOURLY", rateMinor: -1 } }),
          sa: saIndicatorFor(wageJurisdiction, zonedDate(start, timeZone), policy.currencyCode, wageTerms) };
      }
    }
  } catch (error) {
    preview = error instanceof LocalTimeError ? error.message : error instanceof Error ? error.message : "These terms cannot be calculated.";
  }
  return <form action={action} className="workspace-form form-grid" data-demo-write="">
    {context}
    <p className="form-span">Location: <strong>{locationName}</strong>. Enter times as they will be at this location ({timeZone}).</p>
    <label>Department<select name="departmentId" defaultValue={defaults.departmentId}>{departments.map(row => <option value={row.id} key={row.id}>{row.name}</option>)}</select></label>
    <label>Pay terms<select name="policyId" value={policyId} onChange={event => setPolicyId(event.target.value)}>{policies.map(row => <option key={row.id} value={row.id}>{row.name} · {policyTerms(row)}</option>)}</select></label>
    <label>Starts<input name="startsAt" type="datetime-local" required value={startsAt} onChange={event => setStartsAt(event.target.value)} /></label>
    <label>Ends<input name="endsAt" type="datetime-local" required value={endsAt} onChange={event => setEndsAt(event.target.value)} /></label>
    <label>Workers needed<input name="headcount" type="number" min="1" max="1000" defaultValue={defaults.headcount} required /></label>
    <p className="form-span" role="status"><strong>{preview}</strong></p>
    {terms ? <div className="form-span shift-terms-preview" aria-label="Terms workers will see">
      <dl className="shift-terms">
        <div><dt>Hourly wage</dt><dd>{terms.hourly}</dd></div>
        <div><dt>Guaranteed base pay · per worker</dt><dd>{terms.base === null ? "Depends on verified sales" : money(terms.base, terms.currency)}<small> for {terms.hours}</small></dd></div>
        <div><dt>Potential variable earnings</dt><dd>{terms.bonus ? `Up to ${money(terms.bonus, terms.currency)} bonus` : "No incentive"}<small> · tips not included</small></dd></div>
      </dl>
      {terms.sa ? <SaWageIndicatorLine indicator={terms.sa} /> : terms.check ? <WageCheckLine check={terms.check} /> : null}
    </div> : null}
    <p className="form-span note">Pay comes from the Owner&apos;s work policy and can&apos;t be changed here. The bonus is paid only if the worker&apos;s own sales reach the target; FairShift doesn&apos;t allocate tips. Creating this doesn&apos;t offer it to anyone yet.</p>
    <button className="primary-button" disabled={!!terms?.check && !wageAllowsOffer(terms.check)}>Create shift</button>
  </form>;
}
