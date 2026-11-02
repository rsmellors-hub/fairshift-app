import Link from "next/link";
import { DataLabel, StatusBadge } from "@/app/components/product-ui";
import { labourHours, longDate, transactions } from "@/app/components/staffing";
import { addManagerSignalAction, addStructuredSignalAction, decideDemandContextAction, proposeDemandContextAction, refreshContextFeedsAction, withdrawManagerSignalAction } from "@/app/demand-context-actions";
import { fillHref } from "@/app/manager/plan-week";
import type { ContextDay, FeedState, OutletDemandContext } from "@/server/intelligence/demand-context";
import type { DemandScenario } from "@/server/intelligence/demand-context-policy";
import type { ContextSignal } from "@/server/intelligence/demand-signals";
import { eventInfluence } from "@/server/intelligence/event-influence";
import { ATTENDANCE_BANDS, ATTENDANCE_LABEL, DISTANCE_BANDS, DISTANCE_LABEL } from "@/server/intelligence/manager-signals";
import type { OutletStaffing, PlanningBlock, StaffingDay } from "@/server/intelligence/staffing";
import { VENUE_PROFILE_LABEL } from "@/server/intelligence/venue-profile";
import { formatClock, type TradingWindow } from "@/server/intelligence/workload";

const SCENARIO: Record<DemandScenario, string> = { NONE: "No change", MINOR_UP: "Minor increase", MODERATE_UP: "Moderate increase", MINOR_DOWN: "Minor decrease", MODERATE_DOWN: "Moderate decrease" };
const assumption = (bps: number) => bps === 0 ? "0%" : `${bps > 0 ? "+" : "−"}${Math.abs(bps) / 100}%`;
export const scenarioLabel = (scenario: string, bps: number) => `${SCENARIO[scenario as DemandScenario] ?? "Scenario"} (${assumption(bps)})`;
export const periodLabel = (period: TradingWindow | null | undefined) => period ? `${formatClock(period.start)}–${formatClock(period.end)}` : "the whole trading day";
const ageText = (hours: number | null) => hours === null ? "" : hours < 1 ? "under an hour old" : hours < 48 ? `${Math.round(hours)} h old` : `${Math.round(hours / 24)} days old`;
const shortDay = (date: string) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
const stamp = (date: Date, timeZone: string) => new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone }).format(date);

const PROVENANCE: Record<ContextSignal["provenance"], { label: string; kind: "fact" | "demo" | "predictive" }> = {
  DETERMINISTIC_CALCULATION: { label: "Calculated from sales history, not AI", kind: "fact" },
  MANAGER_ENTERED: { label: "Manager-entered context, not independently verified", kind: "demo" },
  OFFICIAL_SNAPSHOT: { label: "Official GOV.UK dates, stored snapshot", kind: "fact" },
  PROVIDER_FORECAST: { label: "Weather forecast from Open-Meteo, not a measurement", kind: "predictive" },
  PROVIDER_EVENT: { label: "Listed by Ticketmaster, listings aren’t complete", kind: "fact" },
};
const SIGNAL_KIND: Partial<Record<ContextSignal["type"], string>> = { BOOKINGS: "Bookings", LOCAL_EVENT: "Local event", PROMOTION: "Promotion", WEATHER_FORECAST: "Weather" };
const DIRECTION: Record<ContextSignal["direction"], string> = { UP: "Points to more demand", DOWN: "Points to less demand", FLAT: "About level", UNSPECIFIED: "No expected direction stated" };
const NOTICE: Record<string, string> = {
  "signal-saved": "Your context is saved. It changes nothing until you accept a scenario.", "signal-withdrawn": "Context withdrawn.",
  proposed: "AI has proposed a scenario. Nothing changes unless you accept it.", failed: "The AI proposal failed or was rejected. The calculated baseline is unaffected.",
  accepted: "Scenario accepted. The figures below and in Fill shifts now include it.", dismissed: "Scenario dismissed. This day stays on its baseline.", withdrawn: "Decision withdrawn. This day is back on its baseline.",
  "not-configured": "AI isn’t configured in this environment. The calculated baseline is complete without it.", error: "That couldn’t be completed. The calculated baseline is unaffected.",
  "context-changed": "The evidence has changed since this was proposed, so it can’t be decided on. Ask for a new proposal.", "context-not-found": "That is no longer available.",
  "context-no-signal": "There’s no context for that day, so there’s nothing to weigh against the baseline.", "context-no-baseline": "There’s no demand baseline for that day.",
  "context-signal-fields": "Check the details: fill in what’s required, with the end time after the start.",
  "feeds-refreshed": "Weather and listed events checked. If anything changed, an earlier proposal for that day needs a fresh look.", "feeds-failed": "A provider couldn’t be reached. The last good information stays, marked with its age, and planning isn’t affected.", "feeds-no-coordinates": "This location has no coordinates, so weather and listed events stay unknown. The business owner can set them under Compensation & incentives.",
  "context-signal-invalid": "Enter the dates, a short description and what you expect.", "context-signal-dates": "Choose dates from today onwards, up to two weeks long.",
};
const FAILURE = (code: string | null) => !code ? "it could not be completed"
  : code.startsWith("VALIDATION_") ? "its answer broke FairShift’s rules, so it was rejected" : code === "TIMEOUT" ? "the AI service did not respond in time" : code === "NETWORK_ERROR" ? "the AI service could not be reached" : code === "REFUSAL" ? "the AI service declined the request" : code.startsWith("HTTP_") ? "the AI service returned an error" : "the AI service returned an unusable response";
const HOLIDAY = { NATION_NOT_STATED: "Bank holidays: unknown, because this location’s record doesn’t state its UK nation.", NO_HOLIDAY_ON_DATE: "No bank holiday on this date (GOV.UK snapshot).", HOLIDAY_ON_DATE: null } as const;

const feedOf = (signal: ContextSignal, context: OutletDemandContext): FeedState | null => signal.provenance === "PROVIDER_FORECAST" ? context.weather : signal.provenance === "PROVIDER_EVENT" ? context.events : null;
const feedAge = (state: FeedState) => `${state.status === "STALE" ? "Stale, " : "Fetched, "}${ageText(state.ageHours)}`;
const signalAge = (signal: ContextSignal, context: OutletDemandContext, timeZone: string) => {
  const feed = feedOf(signal, context);
  return feed ? feedAge(feed) : signal.provenance === "MANAGER_ENTERED" && signal.createdAt ? `Entered ${stamp(signal.createdAt, timeZone)}` : signal.sourceLabel;
};

// Why a period does or doesn't qualify for a scenario citing this event.
function InfluenceNote({ signal }: { signal: ContextSignal }) {
  if (signal.type !== "LOCAL_EVENT") return null;
  const influence = eventInfluence(signal);
  return <p className="note">{influence ? `Influence window ${periodLabel(influence)}: from 2 hours before it starts to ${signal.period || signal.metadata.endTime ? "1 hour after it ends" : "3 hours after it starts, as no end time is given"}. A scenario citing it must overlap this time.` : "No start time is given, so this can support only a whole-day scenario."}</p>;
}

function Signal({ signal, date, timeZone, context }: { signal: ContextSignal; date: string; timeZone: string; context: OutletDemandContext }) {
  const source = PROVENANCE[signal.provenance];
  return <li className="context-signal">
    <p>{SIGNAL_KIND[signal.type] ? <strong>{SIGNAL_KIND[signal.type]} </strong> : null}<DataLabel kind={source.kind}>{source.label}</DataLabel></p>
    <p>{signal.summary}</p>
    <p className="note">{DIRECTION[signal.direction]} · {signal.validFrom === signal.validTo ? longDate(signal.validFrom) : `${longDate(signal.validFrom)} to ${longDate(signal.validTo)}`}{signal.period && signal.provenance === "MANAGER_ENTERED" ? ` · ${periodLabel(signal.period)}` : ""} · {signalAge(signal, context, timeZone)}</p>
    <InfluenceNote signal={signal} />
    {signal.provenance === "MANAGER_ENTERED" ? <form action={withdrawManagerSignalAction}><input type="hidden" name="signalId" value={signal.id} /><input type="hidden" name="date" value={date} /><button className="secondary-button">Withdraw this context</button></form> : null}
  </li>;
}

function Decide({ date, proposalId, decision, label, primary }: { date: string; proposalId: string; decision: string; label: string; primary?: boolean }) {
  return <form action={decideDemandContextAction}><input type="hidden" name="date" value={date} /><input type="hidden" name="proposalId" value={proposalId} /><input type="hidden" name="decision" value={decision} /><button className={primary ? "primary-button" : "secondary-button"}>{label}</button></form>;
}

// A day's figures added up over the blocks inside a period, for a time-targeted scenario.
function withinPeriod(blocks: readonly PlanningBlock[], period: TradingWindow) {
  const inside = blocks.filter(block => block.start >= period.start && block.end <= period.end);
  const sum = (value: (block: PlanningBlock) => number | null) => inside.every(block => value(block) !== null) ? inside.reduce((total, block) => total + value(block)!, 0) : null;
  return { expectedMilliTransactions: sum(block => block.expectedMilliTransactions), requiredMinutes: sum(block => block.requiredMinutes), casualGapMinutes: sum(block => block.remainingMinutes) };
}
function PeriodComparison({ baseline, adjusted, period, adjustedLabel }: { baseline: readonly PlanningBlock[]; adjusted: readonly PlanningBlock[]; period: TradingWindow | null; adjustedLabel: string }) {
  if (!period) return null;
  return <Comparison heading={`In ${periodLabel(period)}`} caption={`Baseline and scenario figures for ${periodLabel(period)}`} adjustedLabel={adjustedLabel} baseline={withinPeriod(baseline, period)} adjusted={withinPeriod(adjusted, period)} />;
}

// Baseline beside what the scenario gives. Both come from the same calculation.
function Comparison({ baseline, adjusted, caption, adjustedLabel, heading = "For this day" }: { baseline: Pick<StaffingDay, "expectedMilliTransactions" | "requiredMinutes" | "casualGapMinutes">; adjusted: { expectedMilliTransactions: number | null; requiredMinutes: number | null; casualGapMinutes: number | null }; caption: string; adjustedLabel: string; heading?: string }) {
  const hours = (value: number | null) => value === null ? "Unavailable" : labourHours(value);
  return <div className="table-scroll" role="region" aria-label={caption} tabIndex={0}><table className="data-table context-compare"><caption className="visually-hidden">{caption}</caption>
    <thead><tr><th scope="col">{heading}</th><th scope="col">Baseline</th><th scope="col">{adjustedLabel}</th></tr></thead>
    <tbody>
      <tr><th scope="row">Expected transactions</th><td data-label="Baseline">{transactions(baseline.expectedMilliTransactions)}</td><td data-label={adjustedLabel}>{transactions(adjusted.expectedMilliTransactions)}</td></tr>
      <tr><th scope="row">Required staff capacity</th><td data-label="Baseline">{hours(baseline.requiredMinutes)}</td><td data-label={adjustedLabel}>{hours(adjusted.requiredMinutes)}</td></tr>
      <tr><th scope="row">Casual requirement</th><td data-label="Baseline">{hours(baseline.casualGapMinutes)}</td><td data-label={adjustedLabel}><strong>{hours(adjusted.casualGapMinutes)}</strong></td></tr>
    </tbody></table></div>;
}

const SIGNAL_NOTE = "Recorded as your own information, and FairShift doesn’t verify it. It’s sent to the AI service when you ask for a proposal, so don’t include anyone’s name or personal details.";
const venueLine = (context: OutletDemandContext) => context.venueProfile ? `Venue type: ${VENUE_PROFILE_LABEL[context.venueProfile]}${context.venueContextSource === "REFERENCE" ? " (reference configuration)" : ""}.` : "Venue type: unknown, because none is set.";
function weatherLine(state: FeedState, onThisDay: boolean) {
  if (state.status === "NO_COORDINATES") return "Weather: unknown, because this location has no coordinates.";
  if (state.status === "NOT_FETCHED") return `Weather: unknown, because no forecast has been fetched${state.lastFailureCode ? " (the provider couldn’t be reached)" : ""}.`;
  const failed = state.lastFailureCode ? " The latest check failed, so this is the last good forecast." : "";
  return `${onThisDay ? `Weather forecast ${ageText(state.ageHours)}.` : "Weather: unknown for this day."}${state.status === "STALE" ? " It’s stale." : ""}${failed}`;
}
function eventsLine(state: FeedState, configured: boolean) {
  if (!configured) return "Listed events: unavailable here, so local events are only what you add.";
  if (state.status === "NO_COORDINATES") return "Listed events: unknown, because this location has no coordinates.";
  if (state.status === "NOT_FETCHED") return `Listed events: unknown, because none have been fetched${state.lastFailureCode ? " (the provider couldn’t be reached)" : ""}.`;
  return `Listed events within 3 km checked, ${ageText(state.ageHours)}${state.status === "STALE" ? " and stale" : ""}. Listings that can’t affect your trading hours, standing attractions and repeats are left out. Listings aren’t complete, so an event not shown may still be happening.`;
}

// Which day opens first: one with something to decide or a Manager's note, else the first open day.
export function defaultContextDate(outlet: OutletStaffing) {
  const days = outlet.demandContext?.days ?? [];
  return (days.find(day => day.state === "PROPOSED" || day.state === "STALE_ACCEPTANCE") ?? days.find(day => day.state === "ACCEPTED") ?? days.find(day => day.signals.some(signal => signal.provenance === "MANAGER_ENTERED")) ?? days.find(day => day.input))?.date ?? null;
}

// History's prediction, what FairShift knows, what AI proposes, and what changes only if the
// Manager accepts: in that order, so the baseline is never out of sight.
export function DemandContextPanel({ outlet, selectedDate, notice, aiConfigured, eventsConfigured = false }: { outlet: OutletStaffing; selectedDate?: string | null; notice?: string; aiConfigured: boolean; eventsConfigured?: boolean }) {
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
  const status = (row: ContextDay) => row.state === "ACCEPTED" ? "Accepted" : row.state === "PROPOSED" ? "To decide" : row.state === "DISMISSED" ? "Dismissed" : row.state === "STALE_ACCEPTANCE" ? "Needs review" : row.signals.some(signal => signal.provenance === "MANAGER_ENTERED" || signal.type === "BANK_HOLIDAY") ? "Has context" : "";
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
    {selected.signals.length ? <ul className="context-signals">{selected.signals.map(signal => <Signal key={signal.id} signal={signal} date={date!} timeZone={outlet.timezone} context={context} />)}</ul> : <p>No context is available for this day. That means unknown, not normal.</p>}
    <p className="note">{HOLIDAY[selected.holidayStatus] ? `${HOLIDAY[selected.holidayStatus]} ` : ""}{venueLine(context)} {weatherLine(context.weather, selected.signals.some(signal => signal.provenance === "PROVIDER_FORECAST"))} {eventsLine(context.events, eventsConfigured)} Bookings and promotions are known only from what you add here, so anything not listed is unknown, not normal.</p>
    {context.weather.status !== "NO_COORDINATES" ? <form action={refreshContextFeedsAction}><input type="hidden" name="date" value={date!} /><button className="secondary-button">Check weather and events now</button></form> : null}
    <details className="disclosure-inline"><summary>Add bookings</summary>
      <form action={addStructuredSignalAction} className="workspace-form form-grid"><input type="hidden" name="kind" value="BOOKINGS" /><input type="hidden" name="planDate" value={date!} />
        <label>Date<input type="date" name="date" defaultValue={date!} required /></label>
        <label>From (optional)<input type="time" name="start" /></label>
        <label>To (optional)<input type="time" name="end" /></label>
        <label>What are you counting?<select name="quantityKind" defaultValue="BOOKINGS"><option value="BOOKINGS">Bookings</option><option value="COVERS">Expected covers</option></select></label>
        <label>How many?<input type="number" name="quantity" min={0} max={100000} required /></label>
        <label>Compared with a usual day at this time<select name="comparison" defaultValue="NOT_STATED"><option value="ABOVE">Above</option><option value="SIMILAR">Similar</option><option value="BELOW">Below</option><option value="NOT_STATED">Not stated</option></select></label>
        <p className="form-span note">{SIGNAL_NOTE}</p>
        <button className="secondary-button">Save bookings</button>
      </form></details>
    <details className="disclosure-inline"><summary>Add a local event</summary>
      <form action={addStructuredSignalAction} className="workspace-form form-grid"><input type="hidden" name="kind" value="LOCAL_EVENT" /><input type="hidden" name="planDate" value={date!} />
        <label className="form-span">Event name<input name="name" minLength={3} maxLength={80} required /></label>
        <label>Date<input type="date" name="date" defaultValue={date!} required /></label>
        <label>Starts<input type="time" name="start" required /></label>
        <label>Ends<input type="time" name="end" required /></label>
        <label>How far away?<select name="distanceBand" defaultValue="UNDER_1KM">{DISTANCE_BANDS.map(band => <option key={band} value={band}>{DISTANCE_LABEL[band]}</option>)}</select></label>
        <label>Expected attendance (optional)<select name="attendanceBand" defaultValue=""><option value="">Not stated</option>{ATTENDANCE_BANDS.map(band => <option key={band} value={band}>{ATTENDANCE_LABEL[band]}</option>)}</select></label>
        <p className="form-span note">{SIGNAL_NOTE}</p>
        <button className="secondary-button">Save event</button>
      </form></details>
    <details className="disclosure-inline"><summary>Add a promotion</summary>
      <form action={addStructuredSignalAction} className="workspace-form form-grid"><input type="hidden" name="kind" value="PROMOTION" /><input type="hidden" name="planDate" value={date!} />
        <label className="form-span">Promotion name<input name="name" minLength={3} maxLength={80} required /></label>
        <label>From<input type="date" name="validFrom" defaultValue={date!} required /></label>
        <label>To<input type="date" name="validTo" defaultValue={date!} required /></label>
        <label>Starts each day (optional)<input type="time" name="start" /></label>
        <label>Ends each day (optional)<input type="time" name="end" /></label>
        <label className="form-span">Short description<input name="description" minLength={3} maxLength={200} required /></label>
        <p className="form-span note">{SIGNAL_NOTE}</p>
        <button className="secondary-button">Save promotion</button>
      </form></details>
    <details className="disclosure-inline"><summary>Add something else you know about a day</summary>
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
      <p><DataLabel kind="predictive">AI proposal</DataLabel> <strong>{scenarioLabel(proposal.scenario, proposal.adjustmentBps)}</strong>{proposal.adjustmentBps ? ` for ${periodLabel(proposal.period)}` : ""}</p>
      <p>{proposal.reason}</p>
      {proposal.citedSignalIds.length ? <><p className="note">Cites:</p><ul className="context-cited">{cited(proposal.citedSignalIds).map(signal => <li key={signal.id}>{signal.summary} <small>{PROVENANCE[signal.provenance].label} · {signalAge(signal, context, outlet.timezone)}</small></li>)}</ul></> : <p className="note">Cites no signal.</p>}
      <p className="note">Proposed {stamp(proposal.createdAt, outlet.timezone)} by {proposal.provider === "OPENAI" ? "OpenAI" : proposal.provider} {proposal.responseModel ?? proposal.model}. AI chooses only the scenario. {assumption(proposal.adjustmentBps)} is FairShift’s fixed planning assumption, not a measured effect.</p>
    </div>
    : selected.state === "FAILED" ? <><p>The last AI proposal for this evidence failed: {FAILURE(selected.failureCode)}. Nothing changed, and the baseline stands.</p>{aiConfigured ? <form action={proposeDemandContextAction}><input type="hidden" name="date" value={date!} /><button className="secondary-button">Try again</button></form> : null}</>
    : !selected.signals.length ? <p>With no context, there’s nothing for AI to weigh, so nothing is proposed.</p>
    : !aiConfigured ? <p>AI isn’t configured in this environment. The calculated baseline is complete without it.</p>
    : <><p>No proposal yet for this evidence.</p><form action={proposeDemandContextAction}><input type="hidden" name="date" value={date!} /><button className="secondary-button">Ask AI for a scenario</button></form></>}

    {selected.state === "STALE_ACCEPTANCE" && selected.staleDecision ? <div className="setup-notice" role="status"><strong>An accepted scenario no longer applies</strong><p>You accepted {scenarioLabel(selected.staleDecision.scenario, selected.staleDecision.adjustmentBps)} for {periodLabel(selected.staleDecision.period)} on {stamp(selected.staleDecision.decidedAt, outlet.timezone)}, but the evidence has changed since. This day is back on its baseline until a scenario is accepted for the current evidence.</p><Decide date={date!} proposalId={selected.staleDecision.proposalId} decision="WITHDRAWN" label="Clear the old decision" /></div> : null}

    <h3>4. What changes if you accept</h3>
    {accepted && selected.decision ? <>
      <p><StatusBadge tone="success">Accepted</StatusBadge> {scenarioLabel(selected.decision.scenario, selected.decision.adjustmentBps)} for {periodLabel(selected.decision.period)}, by a {selected.decision.decidedByRole === "OWNER" ? "business owner" : "Manager"} on {stamp(selected.decision.decidedAt, outlet.timezone)}.</p>
      <Comparison caption="Baseline and accepted figures" adjustedLabel="With accepted scenario" baseline={baseline} adjusted={day} />
      <PeriodComparison baseline={baseline.blocks} adjusted={day.blocks} period={selected.decision.period} adjustedLabel="With accepted scenario" />
      <p className="note">FairShift’s own policy and regular cover turned the adjusted demand into these figures. Expected sales and pay are not changed.</p>
      <div className="button-row">{(day.casualGapMinutes ?? 0) > 0 ? <Link className="primary-button button-link" href={fillHref(date!)}>Fill shifts for this day</Link> : null}<Decide date={date!} proposalId={selected.decision.proposalId} decision="WITHDRAWN" label="Withdraw and return to baseline" /></div>
    </> : proposal && selected.preview ? <>
      <Comparison caption="Baseline and proposed figures" adjustedLabel="If accepted" baseline={baseline} adjusted={selected.preview} />
      {proposal.adjustmentBps ? <PeriodComparison baseline={baseline.blocks} adjusted={selected.preview.blocks} period={proposal.period} adjustedLabel="If accepted" /> : null}
      {selected.state === "DISMISSED" && selected.decision ? <><p><StatusBadge tone="neutral">Dismissed</StatusBadge> on {stamp(selected.decision.decidedAt, outlet.timezone)}. This day stays on its baseline.</p><Decide date={date!} proposalId={proposal.id} decision="WITHDRAWN" label="Reconsider" /></>
      : <><p>Only the baseline drives staffing until you decide.</p><div className="button-row"><Decide date={date!} proposalId={proposal.id} decision="ACCEPTED" label="Accept scenario" primary /><Decide date={date!} proposalId={proposal.id} decision="DISMISSED" label="Dismiss" /></div></>}
    </> : <p>Nothing changes. Only the baseline drives staffing.</p>}
  </section>;
}
