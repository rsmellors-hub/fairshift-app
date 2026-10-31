"use client";

import { useState } from "react";
import { money, scheduledHours } from "@/app/components/format";
import { localDateTimeToInstant, LocalTimeError } from "@/server/domain/timezone";
import { expectedWorkEarnings, type WorkPolicy } from "@/server/domain/work-terms";

type PolicyOption = { id: string; name: string; earningsModel: string; rateMinor: number | null; commissionBps: number | null; currencyCode: string; incentiveTargetMinor: number | null; incentiveBonusMinor: number | null };

function policyTerms(policy: PolicyOption) {
  if (policy.earningsModel === "COMMISSION") return `${(policy.commissionBps ?? 0) / 100}% of verified attributed sales`;
  const bonus = policy.incentiveTargetMinor && policy.incentiveBonusMinor ? ` · ${money(policy.incentiveBonusMinor, policy.currencyCode)} bonus at ${money(policy.incentiveTargetMinor, policy.currencyCode)} sales` : "";
  return `${money(policy.rateMinor ?? 0, policy.currencyCode)}/${policy.earningsModel === "HOURLY" ? "hour" : "day"}${bonus}`;
}

// Times are typed as wall-clock at the work location. The preview uses the same time
// and earnings rules the server applies, and the server decides again on submit.
export function RequirementForm({ action, departments, policies, timeZone, locationName, defaults, context }: {
  action: (form: FormData) => void | Promise<void>;
  departments: { id: string; name: string }[];
  policies: PolicyOption[];
  timeZone: string;
  locationName: string;
  defaults: { departmentId?: string; startsAt: string; endsAt: string; headcount: number };
  context: React.ReactNode;
}) {
  const [policyId, setPolicyId] = useState(policies[0]?.id ?? "");
  const [startsAt, setStartsAt] = useState(defaults.startsAt);
  const [endsAt, setEndsAt] = useState(defaults.endsAt);
  const policy = policies.find(row => row.id === policyId);
  let preview: string;
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
      }
    }
  } catch (error) {
    preview = error instanceof LocalTimeError ? error.message : error instanceof Error ? error.message : "These terms cannot be calculated.";
  }
  return <form action={action} className="workspace-form form-grid">
    {context}
    <p className="form-span">Location: <strong>{locationName}</strong>. Enter times as they will be at this location ({timeZone}).</p>
    <label>Work<select name="departmentId" defaultValue={defaults.departmentId}>{departments.map(row => <option value={row.id} key={row.id}>{row.name}</option>)}</select></label>
    <label>Pay terms<select name="policyId" value={policyId} onChange={event => setPolicyId(event.target.value)}>{policies.map(row => <option key={row.id} value={row.id}>{row.name} · {policyTerms(row)}</option>)}</select></label>
    <label>Starts<input name="startsAt" type="datetime-local" required value={startsAt} onChange={event => setStartsAt(event.target.value)} /></label>
    <label>Ends<input name="endsAt" type="datetime-local" required value={endsAt} onChange={event => setEndsAt(event.target.value)} /></label>
    <label>Workers needed<input name="headcount" type="number" min="1" max="1000" defaultValue={defaults.headcount} required /></label>
    <p className="form-span" role="status"><strong>{preview}</strong></p>
    <p className="form-span method-note">Pay comes from the Owner&apos;s work policy and cannot be changed here. Creating this does not offer it to anyone yet.</p>
    <button className="primary-button">Create work opportunity</button>
  </form>;
}
