import Link from "next/link";
import { DataLabel, StatusBadge } from "@/app/components/product-ui";
import { AiFoundLabel, stamp } from "@/app/components/source-labels";
import { labourHours, longDate, transactions } from "@/app/components/staffing";
import { decideLocalAdjustmentsAction } from "@/app/local-intelligence-actions";
import { TrackRecord } from "@/app/components/track-record";
import type { LocalDay, LocalSignalView, RunView } from "@/server/intelligence/local-intelligence-service";
import type { OutletStaffing } from "@/server/intelligence/staffing";
import { formatClock } from "@/server/intelligence/workload";

// What AI found around a location: each finding with its source and reasoning, what FairShift applied
// and in which hours, and the manager's choice whether staffing uses it. Nothing here calls a model.

const percent = (bps: number) => bps === 0 ? "0%" : `${bps > 0 ? "+" : "−"}${Math.abs(bps) / 100}%`;
const BAND = { MINOR: "minor band", MODERATE: "moderate band" } as const;
const BAND_BPS = { MINOR: 500, MODERATE: 1000 } as const;
const TIER: Record<string, string> = { OFFICIAL: "Official source", EVENT_ORGANISER: "Event organiser", NEWS: "News report", UNCONFIRMED: "Unconfirmed source" };
const CERTAINTY: Record<string, string> = { FIXED: "fixed date", MOON_DEPENDENT: "date depends on the moon", ESTIMATED: "estimated date", SHORT_NOTICE: "short notice" };
const ROLE: Record<string, string> = { FOH: "front of house", BOH: "kitchen" };
const PART: Record<string, string> = { MORNING: "morning", AFTERNOON: "afternoon", EVENING: "evening" };
const USE: Record<LocalSignalView["use"], [string, "success" | "neutral" | "warning" | "predictive" | "danger"]> = {
  APPLIED: ["Applied to the forecast", "success"], LISTED: ["Listed, not applied", "neutral"], UNCONFIRMED: ["Unconfirmed: shown, never applied", "warning"],
  ALERT: ["Owner alert: could stop trading", "danger"], ATTENDANCE_RISK: ["Staff attendance risk", "warning"], NOTED: ["Noted: no change to demand", "predictive"],
};
const NOTICE: Record<string, string> = {
  "local-accepted": "Staffing for this day now uses the AI-found adjustments shown.", "local-withdrawn": "Staffing for this day is back on its baseline.",
  "local-changed": "The AI-found signals have changed since you looked. Check them again before using them.", "local-scenario-accepted": "This day already uses an accepted scenario. Withdraw it first, so the same influence isn’t counted twice.",
  "local-nothing-to-use": "There are no AI-found adjustments for that day.", "local-not-found": "That is no longer available.", error: "That couldn’t be completed. Staffing is unaffected.",
};
const FAILURE = (code: string | null) => !code ? "it didn’t complete" : code.startsWith("VALIDATION_") ? "its answer broke FairShift’s rules, so nothing from it was used" : code === "TIMEOUT" ? "the AI service didn’t respond in time" : code.startsWith("HTTP_") ? "the AI service returned an error" : "the AI service couldn’t be reached";

export const dateSpan = (from: string, to: string) => from === to ? longDate(from) : `${longDate(from)} to ${longDate(to)}`;
export function effectText(signal: Pick<LocalSignalView, "effectType" | "direction" | "sizeBand" | "severity" | "closureLikely">) {
  if (signal.effectType === "DEMAND" && signal.direction && signal.sizeBand) return `${signal.direction === "UP" ? "More customers" : "Fewer customers"}, ${BAND[signal.sizeBand as keyof typeof BAND]} (${percent((signal.direction === "UP" ? 1 : -1) * BAND_BPS[signal.sizeBand as keyof typeof BAND_BPS])})`;
  return `${signal.effectType === "CAPACITY" ? "Ability to trade" : "Getting here"}: ${(signal.severity ?? "").toLowerCase()} severity${signal.closureLikely ? ", closure likely" : ""}`;
}

export function SignalCard({ signal }: { signal: LocalSignalView }) {
  const [use, tone] = USE[signal.use];
  const time = signal.startMinute !== null && signal.endMinute !== null ? ` · ${formatClock(signal.startMinute)}–${formatClock(signal.endMinute)}` : "";
  return <li className="context-signal local-signal">
    <p><strong>{signal.name}</strong> <StatusBadge tone={tone}>{use}</StatusBadge></p>
    <p><AiFoundLabel url={signal.sourceUrl} title={signal.sourceTitle} /></p>
    <p>{signal.reasoning}</p>
    <p className="note">{signal.categoryLabel} · {effectText(signal)} · {dateSpan(signal.validFrom, signal.validTo)}{time}{signal.shiftBlocks.length ? ` · ${signal.shiftBlocks.map(part => PART[part] ?? part).join(", ")}` : ""}{signal.roles.length ? ` · affects ${signal.roles.map(role => ROLE[role] ?? role).join(" and ")}` : ""} · {CERTAINTY[signal.dateCertainty] ?? signal.dateCertainty} · {signal.confidence.toLowerCase()} confidence · {TIER[signal.sourceTier] ?? signal.sourceTier}</p>
    {signal.serverNote ? <p className="note">{signal.serverNote}</p> : null}
  </li>;
}

export function runLine(run: RunView | null, timeZone: string) {
  if (!run) return "AI hasn’t searched for this location yet.";
  const who = `OpenAI ${run.responseModel ?? run.model} with web search`;
  if (run.status === "COMPLETED") return `Searched ${stamp(run.completedAt ?? run.createdAt, timeZone)} by ${who}${run.responseId ? ` · response ${run.responseId}` : ""}.`;
  if (run.status === "RUNNING") return `A search started ${stamp(run.createdAt, timeZone)} and is still running.`;
  return `The search at ${stamp(run.createdAt, timeZone)} ${run.status === "INTERRUPTED" ? "was interrupted" : `failed: ${FAILURE(run.failureCode)}`}. Earlier findings stand.`;
}

export function CoverageLog({ run, timeZone }: { run: RunView; timeZone: string }) {
  const outcome = (value: string) => value === "FOUND" ? "found something" : value === "NOTHING_FOUND" ? "nothing found" : value === "NOT_SEARCHED" ? "not searched" : "not reported by the AI";
  const queries = run.searches.flatMap(search => search.queries);
  return <details className="disclosure-inline coverage-log"><summary>Coverage log · {run.kind === "DAILY" ? "daily search" : "short-notice check"} · {stamp(run.createdAt, timeZone)}</summary>
    <ul>{run.coverage.map(row => <li key={row.category}><strong>{row.label}</strong>: {outcome(row.outcome)}{row.queries.length ? ` · searched “${row.queries.join("”, “")}”` : ""}</li>)}</ul>
    <p className="note">{queries.length ? `Searches recorded by OpenAI: “${queries.slice(0, 20).join("”, “")}”${queries.length > 20 ? ` and ${queries.length - 20} more` : ""}.` : "OpenAI recorded no search queries for this run."} Found {run.counts.found ?? 0} · applied or listed {run.counts.accepted ?? 0} · unconfirmed {run.counts.unconfirmed ?? 0} · rejected {run.counts.rejected ?? 0}.</p>
    {run.rejected.length ? <><p className="note">Rejected by FairShift:</p><ul>{run.rejected.map((row, i) => <li key={i}>{row.name}: {row.note ?? row.code}</li>)}</ul></> : null}
  </details>;
}

function Decide({ date, action, fingerprint, label, primary }: { date: string; action: "ACCEPTED" | "WITHDRAWN"; fingerprint?: string; label: string; primary?: boolean }) {
  return <form action={decideLocalAdjustmentsAction}><input type="hidden" name="date" value={date} /><input type="hidden" name="decision" value={action} />{fingerprint ? <input type="hidden" name="fingerprint" value={fingerprint} /> : null}<button className={primary ? "primary-button" : "secondary-button"}>{label}</button></form>;
}

function DayBlocks({ day, outlet }: { day: LocalDay; outlet: OutletStaffing }) {
  const staffing = outlet.days.find(row => row.planningDate === day.date);
  const baseline = staffing?.context?.baseline ?? staffing?.local?.baseline ?? staffing;
  const adjustedBlocks = day.preview?.blocks ?? [];
  const nameOf = (key: string) => outlet.localIntelligence?.signals.find(signal => signal.key === key)?.name ?? key;
  const riskOf = (start: number) => day.risks.find(risk => risk.start === start) ?? { access: [], capacity: [] };
  const rows = day.blocks.filter(block => block.applied.length || block.listed.length || riskOf(block.start).access.length || riskOf(block.start).capacity.length);
  if (!rows.length) return <p className="note">No AI-found signal bears on this day’s trading hours.</p>;
  return <div className="table-scroll" role="region" aria-label={`AI-found adjustments, ${longDate(day.date)}`} tabIndex={0}><table className="data-table context-compare">
    <caption className="visually-hidden">Baseline and AI-adjusted expected transactions by hour</caption>
    <thead><tr><th scope="col">Hour</th><th scope="col">Baseline</th><th scope="col">Adjustment</th><th scope="col">AI-adjusted</th><th scope="col">Applied (top two)</th><th scope="col">Listed</th><th scope="col">Staff attendance and trading</th></tr></thead>
    <tbody>{rows.map(block => <tr key={block.start}><th scope="row">{formatClock(block.start)}–{formatClock(block.end)}</th>
      <td data-label="Baseline">{transactions(baseline?.blocks.find(row => row.start === block.start)?.expectedMilliTransactions ?? null)}</td>
      <td data-label="Adjustment">{percent(block.bps)}</td>
      <td data-label="AI-adjusted">{transactions(adjustedBlocks.find(row => row.start === block.start)?.expectedMilliTransactions ?? null)}</td>
      <td data-label="Applied">{block.applied.map(nameOf).join("; ") || "None"}</td>
      <td data-label="Listed">{block.listed.map(nameOf).join("; ") || "None"}</td>
      <td data-label="Staff attendance and trading">{[...riskOf(block.start).access.map(key => `Attendance risk: ${nameOf(key)}`), ...riskOf(block.start).capacity.map(key => `Trading: ${nameOf(key)}`)].join("; ") || "None"}</td></tr>)}</tbody></table></div>;
}

export function LocalIntelligencePanel({ outlet, selectedDate, notice, demo, showTrackRecord = false }: { outlet: OutletStaffing; selectedDate?: string | null; notice?: string; demo: boolean; showTrackRecord?: boolean }) {
  const local = outlet.localIntelligence;
  const banner = notice && NOTICE[notice] ? <p role="status" className="note context-notice">{NOTICE[notice]}</p> : null;
  const head = <><DataLabel kind="predictive">AI-found local influences</DataLabel><h2 id="local-intelligence-title">What’s happening around {outlet.outletName}?</h2></>;
  if (!local || local.status === "UNAVAILABLE") return <section className="panel local-intelligence" id="local-intelligence" aria-labelledby="local-intelligence-title">{head}{banner}<p>Local intelligence can’t be loaded right now. The figures on this page are the calculated baseline.</p></section>;
  const daily = local.runs.find(run => run.kind === "DAILY") ?? null, disruptions = local.runs.find(run => run.kind === "DISRUPTIONS") ?? null;
  const date = local.days.some(day => day.date === selectedDate) ? selectedDate! : (local.days.find(day => day.adjusted.length) ?? local.days[0])?.date;
  const day = local.days.find(row => row.date === date) ?? null;
  const staffing = outlet.days.find(row => row.planningDate === date);
  const shown = local.signals.filter(signal => !date || (signal.validFrom <= date && signal.validTo >= date));
  const elsewhere = local.signals.filter(signal => !shown.includes(signal));
  return <section className="panel local-intelligence" id="local-intelligence" aria-labelledby="local-intelligence-title">
    {head}
    <p className="panel-lede">Every day, and every few hours for short-notice news, AI searches the web for anything that could change demand here, or affect trading or getting here. Each finding needs a source page FairShift could reach. FairShift applies at most two findings to any hour, in fixed bands, and you decide whether staffing uses them.</p>
    {banner}
    {local.alerts.length ? <div className="setup-notice" role="status"><strong>{local.alerts.some(alert => alert.closureLikely) ? "AI found something likely to stop this location trading" : "AI found something that could stop this location trading"}</strong>
      <ul className="context-signals">{local.alerts.map(signal => <SignalCard key={signal.key} signal={signal} />)}</ul></div> : null}
    <p className="note">{runLine(daily ?? local.lastAttempt, outlet.timezone)}{disruptions ? ` Short-notice check: ${runLine(disruptions, outlet.timezone)}` : ""}{local.lastAttempt && local.lastAttempt.status !== "COMPLETED" && local.lastAttempt.id !== daily?.id ? ` Latest attempt: ${runLine(local.lastAttempt, outlet.timezone)}` : ""}</p>
    <div className="table-scroll" role="region" aria-label="AI-found adjustments by planning day" tabIndex={0}><table className="data-table">
      <caption className="visually-hidden">AI-found adjustments by planning day</caption>
      <thead><tr><th scope="col">Day</th><th scope="col">Signals applied</th><th scope="col">Expected transactions</th><th scope="col">Risks</th><th scope="col">Staffing</th></tr></thead>
      <tbody>{local.days.map(row => { const base = outlet.days.find(item => item.planningDate === row.date); const baseline = base?.context?.baseline ?? base?.local?.baseline ?? base; const applied = new Set(row.blocks.flatMap(block => block.applied)); return <tr key={row.date}>
        <th scope="row"><Link href={`/manager/plan?date=${row.date}#local-intelligence`} aria-current={row.date === date ? "true" : undefined}>{longDate(row.date)}</Link></th>
        <td data-label="Signals applied">{applied.size || "None"}</td>
        <td data-label="Expected transactions">{row.adjusted.length ? `${transactions(baseline?.expectedMilliTransactions ?? null)} → ${transactions(row.preview?.expectedMilliTransactions ?? null)} AI-adjusted` : transactions(baseline?.expectedMilliTransactions ?? null)}</td>
        <td data-label="Risks">{(() => { const access = row.risks.filter(risk => risk.access.length).length, capacity = new Set(row.risks.flatMap(risk => risk.capacity)).size; return [access ? `Attendance risk in ${access} ${access === 1 ? "hour" : "hours"}` : null, capacity ? `${capacity} trading ${capacity === 1 ? "issue" : "issues"}` : null].filter(Boolean).join(" · ") || "None"; })()}</td>
        <td data-label="Staffing">{row.state === "ACCEPTED" ? <StatusBadge tone="success">Uses AI-found adjustments</StatusBadge> : row.state === "STALE" ? <StatusBadge tone="warning">Needs review</StatusBadge> : row.state === "SCENARIO_ACCEPTED" ? "Uses an accepted scenario" : row.adjusted.length ? "Baseline (not used yet)" : "Baseline"}</td></tr>; })}</tbody></table></div>

    {day && staffing ? <>
      <h3>{longDate(day.date)}</h3>
      <DayBlocks day={day} outlet={outlet} />
      {day.preview && day.adjusted.length ? <p className="note">For the day: expected transactions {transactions((staffing.context?.baseline ?? staffing.local?.baseline ?? staffing).expectedMilliTransactions)} on the baseline, {transactions(day.preview.expectedMilliTransactions)} AI-adjusted; casual requirement {labourHours((staffing.context?.baseline ?? staffing.local?.baseline ?? staffing).casualGapMinutes ?? 0)}, against {labourHours(day.preview.casualGapMinutes ?? 0)} with the adjustments. FairShift’s fixed bands, not the AI, set these percentages. Expected sales and pay don’t change.</p> : null}
      {demo ? <p className="note">Choosing whether staffing uses these is turned off in the public demo.</p>
        : day.state === "ACCEPTED" ? <div className="button-row"><StatusBadge tone="success">In use</StatusBadge><span className="note">Used for staffing by a {day.decidedByRole === "OWNER" ? "business owner" : "Manager"}{day.decidedAt ? ` on ${stamp(day.decidedAt, outlet.timezone)}` : ""}.</span><Decide date={day.date} action="WITHDRAWN" label="Stop using and return to baseline" /></div>
        : day.state === "STALE" ? <div className="setup-notice" role="status"><strong>The AI-found signals changed</strong><p>Staffing is back on its baseline until you use the current adjustments.</p><div className="button-row">{day.adjusted.length ? <Decide date={day.date} action="ACCEPTED" fingerprint={day.fingerprint} label="Use the current adjustments" primary /> : null}<Decide date={day.date} action="WITHDRAWN" label="Clear the old decision" /></div></div>
        : day.state === "SCENARIO_ACCEPTED" ? <p className="note">This day uses an accepted scenario, so the AI-found adjustments aren’t applied.</p>
        : day.adjusted.length ? <div className="button-row"><Decide date={day.date} action="ACCEPTED" fingerprint={day.fingerprint} label="Use these adjustments for staffing" primary /><span className="note">Only the baseline drives staffing until you decide.</span></div> : null}
    </> : null}

    <h3>Findings for {date ? longDate(date) : "the planning week"}</h3>
    {shown.length ? <ul className="context-signals">{shown.map(signal => <SignalCard key={signal.key} signal={signal} />)}</ul> : <p>No AI-found influence for this day. That means none was found with a source, not that nothing is happening.</p>}
    {elsewhere.length ? <details className="disclosure-inline"><summary>Other findings this week · {elsewhere.length}</summary><ul className="context-signals">{elsewhere.map(signal => <SignalCard key={signal.key} signal={signal} />)}</ul></details> : null}
    {local.runs.map(run => <CoverageLog key={run.id} run={run} timeZone={outlet.timezone} />)}
    {showTrackRecord || local.trackRecord.length ? <details className="disclosure-inline"><summary>AI signal track record</summary><TrackRecord rows={local.trackRecord} /></details> : null}
  </section>;
}
