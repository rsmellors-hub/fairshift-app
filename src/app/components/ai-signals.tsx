import Link from "next/link";
import { DataLabel, StatusBadge } from "@/app/components/product-ui";
import { AiFoundLabel, DemoScenarioLabel, SourceLink, stamp } from "@/app/components/source-labels";
import { longDate } from "@/app/components/staffing";
import { acceptSignalAction, decideSignalAction } from "@/app/local-intelligence-actions";
import type { LocalDay, LocalSignalView, OutletLocalIntelligence, RunView } from "@/server/intelligence/local-intelligence-service";
import type { OutletStaffing } from "@/server/intelligence/staffing";
import { formatClock } from "@/server/intelligence/workload";

// What AI found this week, as cards: each finding with its real source, what it does, the hours it
// changes and whether staffing uses it. Everything here is read from stored findings and decisions;
// nothing calls a model. DEMO scenarios are FairShift's own synthetic examples, labelled as such and
// never presented as AI findings.

const percent = (bps: number) => `${bps > 0 ? "+" : "−"}${Math.abs(bps) / 100}%`;
export const TYPE_LABEL: Record<string, string> = { DEMAND: "Demand", CAPACITY: "Can we open?", ACCESS: "Can people get there?" };
const BAND_BPS: Record<string, number> = { MINOR: 500, MODERATE: 1000 };
const ROLE_NAME: Record<string, string> = { OWNER: "the Owner", MANAGER: "a Manager" };

// The effect in words: a demand band, or a severity. Capacity and access never move demand.
export function effectLine(signal: Pick<LocalSignalView, "effectType" | "direction" | "sizeBand" | "severity" | "closureLikely">) {
  if (signal.effectType === "DEMAND" && signal.direction && signal.sizeBand) return `${signal.direction === "UP" ? "More" : "Fewer"} customers, ${percent((signal.direction === "UP" ? 1 : -1) * (BAND_BPS[signal.sizeBand] ?? 0))}`;
  const severity = `${(signal.severity ?? "").toLowerCase()} severity`;
  return signal.effectType === "CAPACITY" ? `${severity}${signal.closureLikely ? ", closure likely" : ""} · owner alert, no change to demand` : `${severity} · attendance risk flag, no change to demand`;
}

const firstSentence = (text: string) => { const match = text.match(/^.*?[.!?](\s|$)/); return (match ? match[0] : text).trim(); };
const timeSpan = (signal: Pick<LocalSignalView, "startMinute" | "endMinute">) => signal.startMinute !== null && signal.endMinute !== null ? ` · ${formatClock(signal.startMinute)}–${formatClock(signal.endMinute)}` : "";
const dateSpan = (from: string, to: string) => from === to ? longDate(from) : `${longDate(from)} – ${longDate(to)}`;
const who = (name: string | null | undefined, role: string | null | undefined) => name?.trim() || ROLE_NAME[role ?? ""] || "someone";

// The planning days and hours one signal changes, with the band FairShift applies to each hour.
export function signalChanges(local: Pick<OutletLocalIntelligence, "days">, key: string) {
  return local.days.map(day => ({ day, blocks: day.blocks.filter(block => block.applied.includes(key)) })).filter(row => row.blocks.length);
}
const changeText = (rows: ReturnType<typeof signalChanges>) => rows.map(({ day, blocks }) => `${longDate(day.date)} ${formatClock(blocks[0].start)}–${formatClock(blocks.at(-1)!.end)} (${[...new Set(blocks.map(block => percent(block.bps)))].join(", ")})`).join("; ");

// Whether staffing uses this signal: accepted on every day it changes, waiting, or partly.
export function signalState(local: Pick<OutletLocalIntelligence, "days">, signal: LocalSignalView): { state: "ACCEPTED" | "PROPOSED" | "PARTLY" | "STALE" | "NONE"; days: LocalDay[] } {
  const days = signalChanges(local, signal.key).map(row => row.day);
  if (signal.use !== "APPLIED" || !days.length) return { state: "NONE", days };
  const accepted = days.filter(day => day.state === "ACCEPTED");
  if (accepted.length === days.length) return { state: "ACCEPTED", days };
  if (days.some(day => day.state === "STALE")) return { state: "STALE", days };
  return { state: accepted.length ? "PARTLY" : "PROPOSED", days };
}

function useBadge(local: OutletLocalIntelligence, signal: LocalSignalView, timeZone: string) {
  if (signal.demo) return <StatusBadge tone="warning">DEMO scenario · synthetic</StatusBadge>;
  if (signal.use === "DISMISSED") return <StatusBadge tone="neutral">Dismissed by {who(signal.dismissed?.byName, signal.dismissed?.byRole)}{signal.dismissed ? ` ${stamp(signal.dismissed.at, timeZone)}` : ""}</StatusBadge>;
  if (signal.use === "UNCONFIRMED") return <StatusBadge tone="warning">Unconfirmed: shown, never applied</StatusBadge>;
  if (signal.use === "ALERT") return <StatusBadge tone="danger">Owner alert</StatusBadge>;
  if (signal.use === "NOTED") return <StatusBadge tone="predictive">Noted</StatusBadge>;
  if (signal.use === "ATTENDANCE_RISK") return <StatusBadge tone="warning">Attendance risk</StatusBadge>;
  if (signal.use === "LISTED") return <StatusBadge tone="neutral">Listed, not applied</StatusBadge>;
  const { state, days } = signalState(local, signal);
  if (state === "ACCEPTED") { const last = [...days].sort((a, b) => (b.decidedAt?.getTime() ?? 0) - (a.decidedAt?.getTime() ?? 0))[0]; return <StatusBadge tone="success">Accepted by {who(last?.decidedByName, last?.decidedByRole)}{last?.decidedAt ? ` ${stamp(last.decidedAt, timeZone)}` : ""}</StatusBadge>; }
  if (state === "STALE") return <StatusBadge tone="warning">Changed since it was accepted</StatusBadge>;
  if (state === "PARTLY") return <StatusBadge tone="warning">Accepted on some days</StatusBadge>;
  return <StatusBadge tone="predictive">Proposed: not used until accepted</StatusBadge>;
}

// One finding as a card. With act, an Owner or Manager can accept it (staffing uses the current
// adjustments on the days it changes) or dismiss it (it moves nothing).
export function AiSignalCard({ local, signal, timeZone, act, next, locationName, simulated = false }: { local: OutletLocalIntelligence; signal: LocalSignalView; timeZone: string; act: boolean; next: string; locationName?: string; simulated?: boolean }) {
  const changes = signal.effectType === "DEMAND" ? signalChanges(local, signal.key) : [];
  const { state, days } = signalState(local, signal);
  const others = [...new Set(changes.flatMap(row => row.blocks.flatMap(block => block.applied)).filter(key => key !== signal.key))].map(key => local.signals.find(row => row.key === key)?.name ?? key);
  const pending = days.filter(day => day.state !== "ACCEPTED" && day.adjusted.length);
  return <li className="context-signal ai-signal-card">
    <p><strong>{locationName ? `${locationName}: ` : ""}{signal.name}</strong> {useBadge(local, signal, timeZone)}</p>
    <p className="note"><DataLabel kind={signal.demo ? "demo" : "predictive"}>{TYPE_LABEL[signal.effectType] ?? signal.effectType}</DataLabel> {effectLine(signal)} · {dateSpan(signal.validFrom, signal.validTo)}{timeSpan(signal)}</p>
    <p>{signal.demo ? <DemoScenarioLabel /> : <AiFoundLabel url={signal.sourceUrl} title={signal.sourceTitle} />}</p>
    <p>{firstSentence(signal.reasoning)}</p>
    {changes.length ? <p className="note">{state === "ACCEPTED" ? "Changes staffing on" : "Would change"} {changeText(changes)}{others.length ? `. Those hours also carry ${others.join(", ")}, so accepting uses them too.` : "."}</p> : null}
    {signal.serverNote ? <p className="note">{signal.serverNote}</p> : null}
    {act && !signal.demo && signal.effectType === "DEMAND" && signal.status !== "UNCONFIRMED" ? <div className="button-row">
      {signal.use === "APPLIED" && pending.length ? <form action={acceptSignalAction}><input type="hidden" name="next" value={next} /><input type="hidden" name="seen" value={pending.map(day => `${day.date}:${day.fingerprint}`).join(",")} /><button className="primary-button">Accept</button></form> : null}
      {signal.use === "DISMISSED"
        ? <form action={decideSignalAction}><input type="hidden" name="next" value={next} /><input type="hidden" name="signalKey" value={signal.key} /><input type="hidden" name="decision" value="RESTORED" /><button className="secondary-button">Bring back</button></form>
        : <form action={decideSignalAction}><input type="hidden" name="next" value={next} /><input type="hidden" name="signalKey" value={signal.key} /><input type="hidden" name="decision" value="DISMISSED" /><button className="secondary-button">Dismiss</button></form>}
    </div> : simulated && !signal.demo && signal.effectType === "DEMAND" && signal.status !== "UNCONFIRMED" ? <p className="note"><DataLabel kind="demo">Simulated in the public demo</DataLabel> Signed-in Owners and Managers accept or dismiss findings.</p> : null}
  </li>;
}

// Times AI actually searched, from the runs themselves: "05:05–05:11" per kind, in local time.
export function searchTimes(runs: readonly (RunView & { timeZone: string })[]) {
  const clock = (run: RunView & { timeZone: string }) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: run.timeZone }).format(run.completedAt ?? run.createdAt);
  const parts = (["DAILY", "DISRUPTIONS"] as const).map(kind => {
    const times = runs.filter(run => run.kind === kind && run.status === "COMPLETED").map(clock).sort();
    if (!times.length) return null;
    return times[0] === times.at(-1) ? times[0] : `${times[0]}–${times.at(-1)}`;
  }).filter(Boolean);
  return parts.join(" and ");
}

// Kept findings first (applied, proposed, alerts, risks), then unconfirmed and rejected, labelled.
const RANK: Record<LocalSignalView["use"], number> = { APPLIED: 0, ALERT: 1, ATTENDANCE_RISK: 2, LISTED: 3, NOTED: 4, DISMISSED: 5, UNCONFIRMED: 6 };

// The Owner's "AI this week": every location's findings for the planning week, read from storage.
export function AiThisWeek({ outlets, act = false }: { outlets: readonly OutletStaffing[]; act?: boolean }) {
  const rows = outlets.flatMap(outlet => (outlet.localIntelligence?.signals ?? []).map(signal => ({ outlet, signal })));
  const kept = rows.filter(row => !row.signal.demo && row.signal.use !== "UNCONFIRMED").sort((a, b) => RANK[a.signal.use] - RANK[b.signal.use] || a.signal.validFrom.localeCompare(b.signal.validFrom));
  const demo = rows.filter(row => row.signal.demo);
  const unconfirmed = rows.filter(row => row.signal.use === "UNCONFIRMED");
  const rejected = outlets.flatMap(outlet => (outlet.localIntelligence?.runs ?? []).flatMap(run => run.rejected.map(item => ({ outlet, item }))));
  const runs = outlets.flatMap(outlet => (outlet.localIntelligence?.runs ?? []).map(run => ({ ...run, timeZone: outlet.timezone })));
  const searched = outlets.filter(outlet => outlet.localIntelligence?.runs.some(run => run.status === "COMPLETED")).length;
  const changing = kept.filter(row => row.signal.use === "APPLIED" || row.signal.use === "ALERT" || row.signal.use === "ATTENDANCE_RISK");
  const latest = runs.filter(run => run.status === "COMPLETED").sort((a, b) => (b.completedAt ?? b.createdAt).getTime() - (a.completedAt ?? a.createdAt).getTime())[0];
  const timeZone = outlets[0]?.timezone ?? "UTC";
  return <section className="panel ai-this-week" id="ai-signals" aria-labelledby="ai-this-week-title">
    <div className="panel-head"><div><DataLabel kind="predictive">AI-found</DataLabel><h2 id="ai-this-week-title">AI this week</h2></div></div>
    {!searched ? <p>AI hasn’t searched around any location yet. The forecast uses its calculated baseline until it does.</p>
      : !changing.length ? <p><strong>AI checked {searched} {searched === 1 ? "location" : "locations"} at {searchTimes(runs)}{latest ? ` (latest ${stamp(latest.completedAt ?? latest.createdAt, latest.timeZone)})` : ""}: nothing changes your forecast.</strong></p>
        : <p className="panel-lede">AI checked {searched} {searched === 1 ? "location" : "locations"} at {searchTimes(runs)}. Each finding below has a source page FairShift opened; staffing uses a demand change only after an Owner or Manager accepts it.</p>}
    {kept.length ? <ul className="context-signals">{kept.map(({ outlet, signal }) => <AiSignalCard key={`${outlet.outletId}-${signal.key}`} local={outlet.localIntelligence!} signal={signal} timeZone={outlet.timezone} act={act} next="/owner/forecast" locationName={outlet.outletName} />)}</ul> : null}
    {demo.length ? <><h3>DEMO scenario</h3><p className="note">Made by FairShift for the demonstration: synthetic, not found by AI.</p><ul className="context-signals">{demo.map(({ outlet, signal }) => <AiSignalCard key={`${outlet.outletId}-${signal.key}`} local={outlet.localIntelligence!} signal={signal} timeZone={outlet.timezone} act={false} next="/owner/forecast" locationName={outlet.outletName} />)}</ul></> : null}
    {unconfirmed.length || rejected.length ? <details className="disclosure-inline"><summary>Not used · {unconfirmed.length} unconfirmed · {rejected.length} rejected</summary>
      {unconfirmed.length ? <><h3>Unconfirmed: shown, never applied</h3><ul>{unconfirmed.map(({ outlet, signal }) => <li key={`${outlet.outletId}-${signal.key}`}><strong>{outlet.outletName}: {signal.name}</strong> · {dateSpan(signal.validFrom, signal.validTo)} · <SourceLink url={signal.sourceUrl} title={signal.sourceTitle} />{signal.serverNote ? <small> {signal.serverNote}</small> : null}</li>)}</ul></> : null}
      {rejected.length ? <><h3>Rejected by FairShift</h3><ul>{rejected.map(({ outlet, item }, i) => <li key={i}><strong>{outlet.outletName}: {item.name}</strong> · {item.note ?? item.code} · <SourceLink url={item.sourceUrl} /></li>)}</ul></> : null}
    </details> : null}
    {latest ? <p className="note">Latest search {stamp(latest.completedAt ?? latest.createdAt, timeZone)}. <Link className="text-link" href="/owner/proof">How each finding was checked <span aria-hidden="true">→</span></Link></p> : null}
  </section>;
}

// The Plan page's cards for one location: kept findings for the week, with Accept and Dismiss.
export function PlanSignalCards({ outlet, act, notice, simulated = false }: { outlet: OutletStaffing; act: boolean; notice?: string; simulated?: boolean }) {
  const local = outlet.localIntelligence;
  if (!local || local.status === "UNAVAILABLE") return null;
  const kept = local.signals.filter(signal => signal.use !== "UNCONFIRMED").sort((a, b) => RANK[a.use] - RANK[b.use] || a.validFrom.localeCompare(b.validFrom));
  const unconfirmed = local.signals.filter(signal => signal.use === "UNCONFIRMED");
  const runs = local.runs.map(run => ({ ...run, timeZone: outlet.timezone }));
  return <section className="panel ai-this-week" id="ai-signals" aria-labelledby="plan-signals-title">
    <div className="panel-head"><div><DataLabel kind="predictive">AI-found</DataLabel><h2 id="plan-signals-title">AI signals for {outlet.outletName} this week</h2></div></div>
    {notice ? <p role="status" className="note context-notice">{notice}</p> : null}
    {!local.runs.some(run => run.status === "COMPLETED") ? <p>AI hasn’t searched around {outlet.outletName} yet. The figures below are the calculated baseline.</p>
      : !kept.length ? <p><strong>AI checked {outlet.outletName} at {searchTimes(runs)}: nothing changes your forecast.</strong></p>
        : <p className="panel-lede">Accept to have staffing use a demand change on the days it affects; dismiss to set it aside. Nothing changes staffing until an Owner or Manager accepts it.</p>}
    {kept.length ? <ul className="context-signals">{kept.map(signal => <AiSignalCard key={signal.key} local={local} signal={signal} timeZone={outlet.timezone} act={act} next="/manager/plan" simulated={simulated} />)}</ul> : null}
    {unconfirmed.length ? <details className="disclosure-inline"><summary>Unconfirmed · {unconfirmed.length}: shown, never applied</summary><ul className="context-signals">{unconfirmed.map(signal => <AiSignalCard key={signal.key} local={local} signal={signal} timeZone={outlet.timezone} act={false} next="/manager/plan" />)}</ul></details> : null}
  </section>;
}
