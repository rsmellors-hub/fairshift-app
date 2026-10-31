import Link from "next/link";
import { DataLabel } from "@/app/components/product-ui";
import { labourHours, longDate, wholeMoney } from "@/app/components/staffing";
import { evidenceValue, type EvidenceMetric } from "@/server/intelligence/ai-staffing-contract";
import type { AssessmentView } from "@/server/intelligence/ai-staffing";

const CATEGORY: Record<string, string> = {
  CASUAL_GAP: "Casual labour gap", CONCENTRATED_DEMAND: "Concentrated demand", MISSING_REGULAR_COVERAGE: "Regular coverage missing",
  STALE_EVIDENCE: "Older evidence", LOW_SIGNAL: "Weak signal", ADEQUATELY_COVERED: "Already covered",
};
const ACTION: Record<string, string> = {
  FILL_SHIFTS: "Fill shifts", REVIEW_REGULAR_COVERAGE: "Review regular coverage", REVIEW_FORECAST_EVIDENCE: "Review forecast evidence", MONITOR: "Monitor", NO_ACTION: "No action needed",
};
const CONSTRAINT: Record<string, string> = {
  STALE_EVIDENCE: "Older evidence", SYNTHETIC_REFERENCE_DATA: "Synthetic reference history", MISSING_REGULAR_COVERAGE: "Regular coverage missing",
  HIGH_CASUAL_REQUIREMENT: "High casual requirement", CONCENTRATED_DEMAND: "Concentrated demand", ADEQUATELY_COVERED: "Already covered", FORECAST_UNAVAILABLE: "Forecast unavailable",
};
const METRIC: Record<EvidenceMetric, string> = {
  forecastSalesMinor: "Forecast sales", requiredMinutes: "Required labour", regularMinutes: "Regular coverage", allocatedCasualMinutes: "Allocated casual",
  coverageMinutes: "Existing coverage", casualGapMinutes: "Casual labour gap", indicativeShifts: "Indicative shifts", evidenceAgeDays: "Evidence age",
};
const FAILURE: Record<string, string> = {
  TIMEOUT: "the AI service did not respond in time", NETWORK_ERROR: "the AI service could not be reached", REFUSAL: "the AI service declined the request",
  INCOMPLETE: "the AI response was incomplete", MALFORMED_RESPONSE: "the AI response could not be read",
};
const failureText = (code: string | null) => !code ? "it could not be completed"
  : code.startsWith("VALIDATION_") ? "its output did not match the calculated evidence, so it was rejected"
  : code.startsWith("HTTP_") ? "the AI service returned an error" : FAILURE[code] ?? "it could not be completed";
const generated = (date: Date, timeZone: string) => new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone }).format(date);

// Location keys in AI text become location names; the model never sees the names.
function Prose({ text, names }: { text: string; names: Record<string, string> }) {
  return <>{text.split(/(\[\[L\d+\]\])/g).map((part, i) => { const key = /^\[\[(L\d+)\]\]$/.exec(part)?.[1]; return key ? <strong key={i}>{names[key] ?? "a location"}</strong> : part; })}</>;
}

export type AiPanelProps = {
  view: AssessmentView | null;
  names: Record<string, string>;
  configured: boolean;
  action: () => Promise<void>;
  // Where a manager plans shifts for a location and date, if this viewer can.
  planHref?: (outletId: string, date: string | null) => string | null;
  notice?: string;
  timeZone?: string;
};

// AI-assisted interpretation of the calculated staffing week, kept visibly separate
// from the calculated figures. Every value shown here comes from the deterministic
// input the assessment was validated against, never from the model's text.
export function AiStaffingAssessment({ view, names, configured, action, planHref, notice, timeZone = "Europe/London" }: AiPanelProps) {
  const button = (label: string) => configured && view?.prepared.hasEvidence ? <form action={action}><button className="secondary-button">{label}</button></form> : null;
  const keyNames = Object.fromEntries(Object.entries(view?.prepared.locationKeys ?? {}).map(([key, outletId]) => [key, names[outletId] ?? "a location"]));
  const header = <><DataLabel kind="predictive">AI-assisted interpretation</DataLabel><h2 id="ai-assessment-title">What to staff first</h2></>;
  const notices: Record<string, string> = { failed: "The AI assessment attempt failed; see below.", error: "The AI assessment could not be requested. The calculated figures are unaffected.", "not-configured": "AI assessment is not configured in this environment." };
  const banner = notice && notices[notice] ? <p role="status" className="method-note">{notices[notice]}</p> : null;
  if (!view) return <section className="panel ai-assessment" aria-labelledby="ai-assessment-title">{header}<p>AI assessment is unavailable because the staffing evidence could not be loaded. No AI interpretation is shown.</p></section>;
  if (view.state !== "CURRENT" || !view.assessment) {
    return <section className="panel ai-assessment" aria-labelledby="ai-assessment-title">{header}{banner}
      {!view.prepared.hasEvidence ? <p>There is no forecast staffing evidence to interpret, so no AI assessment is available.</p>
        : view.state === "FAILED" ? <p>The latest AI assessment of this planning evidence failed: {failureText(view.record?.failureCode ?? null)}. No AI interpretation is shown. The calculated figures remain available.</p>
        : view.state === "STALE" ? <p>The planning evidence or assessment method has changed since the last AI assessment ({generated(view.record!.createdAt, timeZone)}), so it is not shown. Generate a new assessment for the current figures.</p>
        : <p>No AI assessment has been generated for the current planning evidence.</p>}
      {!configured && view.prepared.hasEvidence ? <p className="method-note">AI assessment is not configured in this environment. The calculated forecast and staffing figures are complete without it.</p> : null}
      {button(view.state === "FAILED" ? "Try the AI assessment again" : "Generate AI assessment")}
    </section>;
  }
  const a = view.assessment;
  const locations = new Map(view.prepared.input.locations.map(location => [location.key, location]));
  // Calculated, not AI: days with a gap that the assessment did not single out.
  const listed = new Set(a.priorities.map(p => `${p.locationKey}:${p.date}`));
  const unlisted = view.prepared.input.locations.reduce((sum, location) => sum + location.days.filter(day => (day.casualGapMinutes ?? 0) > 0 && !listed.has(`${location.key}:${day.date}`)).length, 0);
  const format = (metric: EvidenceMetric, value: number, currency: string | null) =>
    metric === "forecastSalesMinor" ? wholeMoney(value, currency ?? "GBP") : metric === "indicativeShifts" ? `${value}` : metric === "evidenceAgeDays" ? `${value} days` : labourHours(value);
  return <section className="panel ai-assessment" aria-labelledby="ai-assessment-title">
    {header}{banner}
    <p className="method-note">Generated {generated(view.record!.createdAt, timeZone)} by {view.record!.provider === "OPENAI" ? "OpenAI" : view.record!.provider} {view.record!.responseModel} from the calculated figures shown on this page. The AI interprets those figures; it does not change them, create shifts or approve pay.</p>
    <p><Prose text={a.summary} names={keyNames} /></p>
    {a.priorities.length ? <ol className="ai-priorities">{a.priorities.map(p => {
      const location = locations.get(p.locationKey)!;
      const href = p.action === "FILL_SHIFTS" ? planHref?.(view.prepared.locationKeys[p.locationKey], p.date) ?? null : null;
      return <li key={p.rank} className="ai-priority">
        <p className="ai-priority-heading"><span className={`ai-severity ai-severity-${p.severity.toLowerCase()}`}>{p.severity === "HIGH" ? "High" : p.severity === "MEDIUM" ? "Medium" : "Low"} priority</span> <strong>{keyNames[p.locationKey]}</strong> · {p.date ? longDate(p.date) : "whole week"} · {CATEGORY[p.category]}</p>
        <p><Prose text={p.reason} names={keyNames} /></p>
        <dl className="ai-evidence" aria-label="Calculated evidence">{p.evidence.map(item => { const value = evidenceValue(location, p.date, item.metric)!; return <div key={item.metric}><dt>{METRIC[item.metric]}</dt><dd>{format(item.metric, value, location.currency)}</dd></div>; })}</dl>
        <p><strong>Recommended: {ACTION[p.action]}.</strong> <Prose text={p.actionNote} names={keyNames} />{href ? <> <Link href={href}>Plan shifts{p.date ? ` for ${longDate(p.date)}` : ""} →</Link></> : null}</p>
      </li>;
    })}</ol> : <p>The assessment identified no staffing priorities.</p>}
    {a.constraints.length ? <><h3>Evidence limits</h3><ul className="ai-constraints">{a.constraints.map((c, i) => <li key={i}><strong>{CONSTRAINT[c.type]}{c.locationKey ? ` · ${keyNames[c.locationKey]}` : ""}:</strong> <Prose text={c.note} names={keyNames} /></li>)}</ul></> : null}
    <h3>Signal quality</h3><p><Prose text={a.signalCommentary} names={keyNames} /></p>
    {unlisted ? <p className="method-note">{unlisted} other planning {unlisted === 1 ? "day also has" : "days also have"} a casual labour gap not listed above. See the calculated staffing figures.</p> : null}
    <p className="method-note">Evidence values are the calculated figures for that location and day (or week), checked against the AI output before it was stored. The order of dated casual gaps is calculated. The AI&apos;s wording is its interpretation and is not checked beyond those figures and references. Managers decide what to staff.</p>
  </section>;
}
