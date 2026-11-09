"use client";

import { useActionState, useState } from "react";
import type { WageExplanationResult } from "@/server/intelligence/wage-explanation";
import { money } from "@/app/components/format";
import { longDay, WageCheckLine } from "@/app/components/wage-check";
import { checkWage, minutesCovered, nextRateChange, ratesInForce, type WageJurisdiction } from "@/server/domain/statutory-wage";

const AMOUNT = /^\d{1,10}(\.\d{1,2})?$/;
const toMinor = (text: string) => { const [whole, fraction = ""] = text.split("."); return Number(whole) * 100 + Number(fraction.padEnd(2, "0")); };
const duration = (minutes: number) => `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;

// New work terms for one location. Where a verified statutory reference applies, the hourly rate
// starts at the 21-and-over rate: a benchmark the Owner can raise or replace, never a rate FairShift
// sets. The check below is the same one the server applies when a shift is created or offered.
const UNAVAILABLE: Record<Extract<WageExplanationResult, { state: "UNAVAILABLE" }>["reason"], string> = {
  NOT_CONFIGURED: "AI explanations aren’t set up in this environment. The check above is complete without one.",
  PROVIDER_FAILED: "The AI explanation couldn’t be generated. The check above is unchanged.",
  REJECTED_OUTPUT: "The AI’s answer didn’t meet FairShift’s rules (for example, it stated a figure), so it isn’t shown. The check above is unchanged.",
  INVALID_RATE: "Enter a valid hourly rate first.",
  DEMO: "Simulated in the public demo: no AI request is made.",
};

// Words only: the model explains FairShift's check and can't state a figure or change anything.
function WageExplanation({ action, rate }: { action: (state: WageExplanationResult | null, form: FormData) => Promise<WageExplanationResult>; rate: string }) {
  const [result, explain, pending] = useActionState(action, null);
  return <form action={explain} className="wage-explain">
    <input type="hidden" name="rate" value={rate} />
    <button className="secondary-button" disabled={pending}>{pending ? "Explaining…" : "Explain this rate with AI"}</button>
    {result?.state === "GENERATED" ? <div className="ai-explanation" role="status"><p className="provenance">AI explanation · words only. Figures and the status come from FairShift’s check.</p><p>{result.explanation}</p></div>
      : result ? <p className="note" role="status">{UNAVAILABLE[result.reason]}</p> : null}
  </form>;
}

export function PolicyForm({ action, currency, jurisdiction, today, explainAction = null }: { action: (form: FormData) => void | Promise<void>; currency: string; jurisdiction: WageJurisdiction; today: string; explainAction?: ((state: WageExplanationResult | null, form: FormData) => Promise<WageExplanationResult>) | null }) {
  const period = jurisdiction.jurisdiction === "ENGLAND" && currency === "GBP" ? ratesInForce(today) : null;
  const benchmark = period?.rates.find(row => row.category === "AGE_21_AND_OVER")?.rateMinor ?? null;
  const [model, setModel] = useState(benchmark ? "HOURLY" : "DAILY");
  const [rate, setRate] = useState(benchmark ? (benchmark / 100).toFixed(2) : "");
  const valid = AMOUNT.test(rate), minor = valid ? toMinor(rate) : null;
  const next = period ? nextRateChange(today) : null;
  let feedback: React.ReactNode = null;
  if (minor !== null && model === "HOURLY") {
    const now = checkWage({ jurisdiction, date: today, currencyCode: currency, terms: { earningsModel: "HOURLY", rateMinor: minor } });
    const later = next ? checkWage({ jurisdiction, date: next.validFrom, currencyCode: currency, terms: { earningsModel: "HOURLY", rateMinor: minor } }) : null;
    feedback = <>
      <WageCheckLine check={now} />
      {later && later.status !== now.status ? <p className="note">From {longDay(later.date)} the demo minimum becomes {money(later.floorMinor!, "GBP")} an hour (the published 21-and-over rate, not yet in force). Shifts from that date on these terms {later.status === "RATE_CHECKED" ? "will be checked" : "can’t be created or offered"}.</p> : null}
    </>;
  } else if (minor !== null && model === "DAILY" && benchmark) {
    const covered = minutesCovered(minor, benchmark);
    feedback = <p className="note" role="status">Checked for each shift against its length. {covered ? <>{money(minor, currency)} covers a shift of up to <strong>{duration(covered)}</strong> at the {money(benchmark, "GBP")} 21-and-over rate.</> : null}</p>;
  }
  return <><form action={action} className="workspace-form form-grid">
    <label>Name<input name="name" maxLength={100} required /></label>
    <label>Pay basis<select name="earningsModel" value={model} onChange={event => setModel(event.target.value)}><option value="HOURLY">Hourly</option><option value="DAILY">Daily, fixed for the shift</option></select></label>
    <label>Rate ({currency}){model === "HOURLY" ? " per hour" : " per shift"}<input type="number" name="rate" min="0" step="0.01" required value={rate} onChange={event => setRate(event.target.value)} /></label>
    <label>Sales target ({currency}, optional)<input type="number" name="incentiveTarget" min="0.01" step="0.01" /></label>
    <label>Fixed bonus ({currency}, optional)<input type="number" name="incentiveBonus" min="0.01" step="0.01" /></label>
    {benchmark && model === "HOURLY" ? <p className="form-span note">Prefilled with the {money(benchmark, "GBP")} National Living Wage for workers aged 21 and over, the FairShift demo minimum today. You can offer more, not less.</p> : null}
    <div className="form-span">{feedback}</div>
    <p className="form-span note">A worker earns the bonus if their own attributed sales for the shift reach the target. Set both or neither.</p>
    <button className="primary-button">Create work policy</button>
  </form>
  {explainAction && period && model === "HOURLY" && valid ? <WageExplanation action={explainAction} rate={rate} /> : null}</>;
}
