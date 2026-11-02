import Link from "next/link";
import { DataLabel, StatusBadge } from "@/app/components/product-ui";
import { labourHours, longDate, transactions } from "@/app/components/staffing";
import { addManagerSignalAction, decideDemandContextAction, proposeDemandContextAction, withdrawManagerSignalAction } from "@/app/demand-context-actions";
import { fillHref } from "@/app/manager/plan-week";
import type { ContextDay } from "@/server/intelligence/demand-context";
import type { DemandScenario } from "@/server/intelligence/demand-context-policy";
import type { ContextSignal } from "@/server/intelligence/demand-signals";
import type { OutletStaffing, StaffingDay } from "@/server/intelligence/staffing";

const SCENARIO: Record<DemandScenario, string> = { NONE: "No change", MINOR_UP: "Minor increase", MODERATE_UP: "Moderate increase", MINOR_DOWN: "Minor decrease", MODERATE_DOWN: "Moderate decrease" };
const assumption = (bps: number) => bps === 0 ? "0%" : `${bps > 0 ? "+" : "−"}${Math.abs(bps) / 100}%`;
export const scenarioLabel = (scenario: string, bps: number) => `${SCENARIO[scenario as DemandScenario] ?? "Scenario"} (${assumption(bps)})`;
const shortDay = (date: string) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
const stamp = (date: Date, timeZone: string) => new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone }).format(date);

const PROVENANCE: Record<ContextSignal["provenance"], { label: string; kind: "fact" | "demo" | "predictive" }> = {
  DETERMINISTIC_CALCULATION: { label: "Calculated from sales history, not AI", kind: "fact" },
  MANAGER_ENTERED: { label: "Manager-entered context, not independently verified", kind: "demo" },
  OFFICIAL_SNAPSHOT: { label: "Official GOV.UK dates, stored snapshot", kind: "fact" },
};
const DIRECTION: Record<ContextSignal["direction"], string> = { UP: "Points to more demand", DOWN: "Points to less demand", FLAT: "About level", UNSPECIFIED: "No expected direction stated" };
const NOTICE: Record<string, string> = {
  "signal-saved": "Your context is saved. It changes nothing until you accept a scenario.", "signal-withdrawn": "Context withdrawn.",
  proposed: "AI has proposed a scenario. Nothing changes unless you accept it.", failed: "The AI proposal failed or was rejected. The calculated baseline is unaffected.",
  accepted: "Scenario accepted. The figures below and in Fill shifts now include it.", dismissed: "Scenario dismissed. This day stays on its baseline.", withdrawn: "Decision withdrawn. This day is back on its baseline.",
  "not-configured": "AI isn’t configured in this environment. The calculated baseline is complete without it.", error: "That couldn’t be completed. The calculated baseline is unaffected.",
  "context-changed": "The evidence has changed since this was proposed, so it can’t be decided on. Ask for a new proposal.", "context-not-found": "That is no longer available.",
  "context-no-signal": "There’s no context for that day, so there’s nothing to weigh against the baseline.", "context-no-baseline": "There’s no demand baseline for that day.",
  "context-signal-invalid": "Enter the dates, a short description and what you expect.", "context-signal-dates": "Choose dates from today onwards, up to two weeks long.",
};
const FAILURE = (code: string | null) => !code ? "it could not be completed"
  : code.startsWith("VALIDATION_") ? "its answer broke FairShift’s rules, so it was rejected" : code === "TIMEOUT" ? "the AI service did not respond in time" : code === "NETWORK_ERROR" ? "the AI service could not be reached" : code === "REFUSAL" ? "the AI service declined the request" : code.startsWith("HTTP_") ? "the AI service returned an error" : "the AI service returned an unusable response";
const HOLIDAY = { NATION_NOT_STATED: "Bank holidays: unknown, because this location’s record doesn’t state its UK nation.", NO_HOLIDAY_ON_DATE: "No bank holiday on this date (GOV.UK snapshot).", HOLIDAY_ON_DATE: null } as const;

function Signal({ signal, date, timeZone }: { signal: ContextSignal; date: string; timeZone: string }) {
  const source = PROVENANCE[signal.provenance];
  return <li className="context-signal">
    <p><DataLabel kind={source.kind}>{source.label}</DataLabel></p>
    <p>{signal.summary}</p>
    <p className="note">{DIRECTION[signal.direction]} · {signal.validFrom === signal.validTo ? longDate(signal.validFrom) : `${longDate(signal.validFrom)} to ${longDate(signal.validTo)}`}{signal.provenance === "MANAGER_ENTERED" && signal.createdAt ? ` · Entered ${stamp(signal.createdAt, timeZone)}` : ""}{signal.provenance !== "MANAGER_ENTERED" ? ` · ${signal.sourceLabel}` : ""}</p>
    {signal.provenance === "MANAGER_ENTERED" ? <form action={withdrawManagerSignalAction}><input type="hidden" name="signalId" value={signal.id} /><input type="hidden" name="date" value={date} /><button className="secondary-button">Withdraw this context</button></form> : null}
  </li>;
}

function Decide({ date, proposalId, decision, label, primary }: { date: string; proposalId: string; decision: string; label: string; primary?: boolean }) {
  return <form action={decideDemandContextAction}><input type="hidden" name="date" value={date} /><input type="hidden" name="proposalId" value={proposalId} /><input type="hidden" name="decision" value={decision} /><button className={primary ? "primary-button" : "secondary-button"}>{label}</button></form>;
}

// Baseline beside what the scenario gives. Both come from the same calculation.
function Comparison({ baseline, adjusted, caption, adjustedLabel }: { baseline: Pick<StaffingDay, "expectedMilliTransactions" | "requiredMinutes" | "casualGapMinutes">; adjusted: { expectedMilliTransactions: number | null; requiredMinutes: number | null; casualGapMinutes: number | null }; caption: string; adjustedLabel: string }) {
  const hours = (value: number | null) => value === null ? "Unavailable" : labourHours(value);
  return <div className="table-scroll" role="region" aria-label={caption} tabIndex={0}><table className="data-table context-compare"><caption className="visually-hidden">{caption}</caption>
    <thead><tr><th scope="col">For this day</th><th scope="col">Baseline</th><th scope="col">{adjustedLabel}</th></tr></thead>
    <tbody>
      <tr><th scope="row">Expected transactions</th><td data-label="Baseline">{transactions(baseline.expectedMilliTransactions)}</td><td data-label={adjustedLabel}>{transactions(adjusted.expectedMilliTransactions)}</td></tr>
      <tr><th scope="row">Required staff capacity</th><td data-label="Baseline">{hours(baseline.requiredMinutes)}</td><td data-label={adjustedLabel}>{hours(adjusted.requiredMinutes)}</td></tr>
      <tr><th scope="row">Casual requirement</th><td data-label="Baseline">{hours(baseline.casualGapMinutes)}</td><td data-label={adjustedLabel}><strong>{hours(adjusted.casualGapMinutes)}</strong></td></tr>
    </tbody></table></div>;
}

// Which day opens first: one with something to decide or a Manager's note, else the first open day.
export function defaultContextDate(outlet: OutletStaffing) {
  const days = outlet.demandContext?.days ?? [];
  return (days.find(day => day.state === "PROPOSED" || day.state === "STALE_ACCEPTANCE") ?? days.find(day => day.state === "ACCEPTED") ?? days.find(day => day.signals.some(signal => signal.type === "MANAGER_ENTERED")) ?? days.find(day => day.input))?.date ?? null;
}

// History's prediction, what FairShift knows, what AI proposes, and what changes only if the
// Manager accepts: in that order, so the baseline is never out of sight.
export function DemandContextPanel({ outlet, selectedDate, notice, aiConfigured }: { outlet: OutletStaffing; selectedDate?: string | null; notice?: string; aiConfigured: boolean }) {
  const context = outlet.demandContext;
  const banner = notice && NOTICE[notice] ? <p role="status" className="note context-notice">{NOTICE[notice]}</p> : null;
  const head = <><DataLabel kind="predictive">Contextual demand</DataLabel><h2 id="demand-context-title">Is there anything history doesn’t know?</h2></>;
  if (!context || context.status === "UNAVAILABLE") return <section className="panel demand-context" id="demand-context" aria-labelledby="demand-context-title">{head}{banner}<p>Contextual demand can’t be loaded right now. Everything on this page is the calculated baseline, and Fill shifts works from it as usual.</p></section>;
  const days = context.days;
  const date = days.some(day => day.date === selectedDate) ? selectedDate! : defaultContextDate(outlet);
  const selected: ContextDay | null = days.find(day => day.date === date) ?? null;
  const day = outlet.days.find(row => row.planningDate === date);
  if (!selected || !day) return <section className="panel demand-context" id="demand-context" aria-labelledby="demand-context-title">{head}{banner}<p>There’s no planning day with a demand baseline, so there’s nothing to add context to.</p></section>;
  const baseline = day.context?.baseline ?? day;
  const proposal = selected.proposal;
  const cited = (ids: readonly string[]) => selected.signals.filter(signal => ids.includes(signal.id));
  const accepted = selected.state === "ACCEPTED";
  const status = (row: ContextDay) => row.state === "ACCEPTED" ? "Accepted" : row.state === "PROPOSED" ? "To decide" : row.state === "DISMISSED" ? "Dismissed" : row.state === "STALE_ACCEPTANCE" ? "Needs review" : row.signals.some(signal => signal.type !== "MOMENTUM") ? "Has context" : "";
  return <section className="panel demand-context" id="demand-context" aria-labelledby="demand-context-title">
    {head}
    <p className="panel-lede">The figures above come from history and your business’s policy. Add what you know about a day. AI can propose a small, fixed scenario, and nothing changes unless you accept it.</p>
    {banner}
    <nav className="context-days" aria-label="Planning day for context">{days.map(row => <Link key={row.date} href={`/manager/plan?date=${row.date}#demand-context`} aria-current={row.date === date ? "true" : undefined}><strong>{shortDay(row.date)}</strong><small>{status(row) || " "}</small></Link>)}</nav>

    <h3>1. What history predicts for {longDate(date!)}</h3>
    <p><DataLabel kind="fact">Calculated baseline, no AI</DataLabel></p>
    {day.closed ? <p>Closed on this day.</p> : <dl className="context-baseline">
      <div><dt>Expected transactions</dt><dd>{transactions(baseline.expectedMilliTransactions)}</dd><small>Range {transactions(baseline.lowerMilliTransactions)}–{transactions(baseline.upperMilliTransactions)}</small></div>
      <div><dt>Required staff capacity</dt><dd>{baseline.requiredMinutes === null ? "Unavailable" : labourHours(baseline.requiredMinutes)}</dd></div>
      <div><dt>Existing coverage</dt><dd>{baseline.coverageMinutes === null ? "Not set" : labourHours(baseline.coverageMinutes)}</dd></div>
      <div><dt>Casual requirement</dt><dd>{baseline.casualGapMinutes === null ? "Unavailable" : labourHours(baseline.casualGapMinutes)}</dd></div>
    </dl>}

    <h3>2. What FairShift knows about this day</h3>
    {selected.signals.length ? <ul className="context-signals">{selected.signals.map(signal => <Signal key={signal.id} signal={signal} date={date!} timeZone={outlet.timezone} />)}</ul> : <p>No context is available for this day. That means unknown, not normal.</p>}
    <p className="note">{HOLIDAY[selected.holidayStatus] ? `${HOLIDAY[selected.holidayStatus]} ` : ""}Weather, local events and bookings aren’t checked by FairShift, so anything not listed here is unknown, not normal.</p>
    <details className="disclosure-inline"><summary>Add what you know about a day</summary>
      <form action={addManagerSignalAction} className="workspace-form form-grid"><input type="hidden" name="date" value={date!} />
        <label>From<input type="date" name="validFrom" defaultValue={date!} required /></label>
        <label>To<input type="date" name="validTo" defaultValue={date!} required /></label>
        <label className="form-span">What’s happening?<input name="summary" minLength={3} maxLength={200} required placeholder="For example, road closed outside until 2pm" /></label>
        <label>What do you expect?<select name="direction" defaultValue="UNSPECIFIED"><option value="UP">More customers</option><option value="DOWN">Fewer customers</option><option value="UNSPECIFIED">Not sure</option></select></label>
        <p className="form-span note">This is recorded as your own note, and FairShift doesn’t verify it. It’s sent to the AI service when you ask for a proposal, so don’t include anyone’s name or personal details.</p>
        <button className="secondary-button">Save context</button>
      </form></details>

    <h3>3. What AI proposes</h3>
    {proposal ? <div className="context-proposal">
      <p><DataLabel kind="predictive">AI proposal</DataLabel> <strong>{scenarioLabel(proposal.scenario, proposal.adjustmentBps)}</strong></p>
      <p>{proposal.reason}</p>
      {proposal.citedSignalIds.length ? <><p className="note">Cites:</p><ul className="context-cited">{cited(proposal.citedSignalIds).map(signal => <li key={signal.id}>{signal.summary}</li>)}</ul></> : <p className="note">Cites no signal.</p>}
      <p className="note">Proposed {stamp(proposal.createdAt, outlet.timezone)} by {proposal.provider === "OPENAI" ? "OpenAI" : proposal.provider} {proposal.responseModel ?? proposal.model}. AI chooses only the scenario. {assumption(proposal.adjustmentBps)} is FairShift’s fixed planning assumption, not a measured effect.</p>
    </div>
    : selected.state === "FAILED" ? <><p>The last AI proposal for this evidence failed: {FAILURE(selected.failureCode)}. Nothing changed, and the baseline stands.</p>{aiConfigured ? <form action={proposeDemandContextAction}><input type="hidden" name="date" value={date!} /><button className="secondary-button">Try again</button></form> : null}</>
    : !selected.signals.length ? <p>With no context, there’s nothing for AI to weigh, so nothing is proposed.</p>
    : !aiConfigured ? <p>AI isn’t configured in this environment. The calculated baseline is complete without it.</p>
    : <><p>No proposal yet for this evidence.</p><form action={proposeDemandContextAction}><input type="hidden" name="date" value={date!} /><button className="secondary-button">Ask AI for a scenario</button></form></>}

    {selected.state === "STALE_ACCEPTANCE" && selected.staleDecision ? <div className="setup-notice" role="status"><strong>An accepted scenario no longer applies</strong><p>You accepted {scenarioLabel(selected.staleDecision.scenario, selected.staleDecision.adjustmentBps)} on {stamp(selected.staleDecision.decidedAt, outlet.timezone)}, but the evidence has changed since. This day is back on its baseline until a scenario is accepted for the current evidence.</p><Decide date={date!} proposalId={selected.staleDecision.proposalId} decision="WITHDRAWN" label="Clear the old decision" /></div> : null}

    <h3>4. What changes if you accept</h3>
    {accepted && selected.decision ? <>
      <p><StatusBadge tone="success">Accepted</StatusBadge> {scenarioLabel(selected.decision.scenario, selected.decision.adjustmentBps)}, by a {selected.decision.decidedByRole === "OWNER" ? "business owner" : "Manager"} on {stamp(selected.decision.decidedAt, outlet.timezone)}.</p>
      <Comparison caption="Baseline and accepted figures" adjustedLabel="With accepted scenario" baseline={baseline} adjusted={day} />
      <p className="note">FairShift’s own policy and regular cover turned the adjusted demand into these figures. Expected sales and pay are not changed.</p>
      <div className="button-row">{(day.casualGapMinutes ?? 0) > 0 ? <Link className="primary-button button-link" href={fillHref(date!)}>Fill shifts for this day</Link> : null}<Decide date={date!} proposalId={selected.decision.proposalId} decision="WITHDRAWN" label="Withdraw and return to baseline" /></div>
    </> : proposal && selected.preview ? <>
      <Comparison caption="Baseline and proposed figures" adjustedLabel="If accepted" baseline={baseline} adjusted={selected.preview} />
      {selected.state === "DISMISSED" && selected.decision ? <><p><StatusBadge tone="neutral">Dismissed</StatusBadge> on {stamp(selected.decision.decidedAt, outlet.timezone)}. This day stays on its baseline.</p><Decide date={date!} proposalId={proposal.id} decision="WITHDRAWN" label="Reconsider" /></>
      : <><p>Only the baseline drives staffing until you decide.</p><div className="button-row"><Decide date={date!} proposalId={proposal.id} decision="ACCEPTED" label="Accept scenario" primary /><Decide date={date!} proposalId={proposal.id} decision="DISMISSED" label="Dismiss" /></div></>}
    </> : <p>Nothing changes. Only the baseline drives staffing.</p>}
  </section>;
}
