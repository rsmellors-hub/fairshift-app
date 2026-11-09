import { DataLabel, StatusBadge } from "@/app/components/product-ui";
import { labourHours, longDate } from "@/app/components/staffing";
import { approveSuggestedShiftAction } from "@/app/suggestion-actions";
import type { AssessmentView } from "@/server/intelligence/ai-staffing";
import type { OutletStaffing } from "@/server/intelligence/staffing";
import { formatClock } from "@/server/intelligence/workload";
import { suggestShifts, type ShiftRules, type SuggestedShift } from "@/server/scheduling/shift-rules";

// Suggested shifts for one location: its open casual gap cut into blocks with the location's own
// shift-length rules (deterministic). When the AI briefing is current, it orders them and says why;
// it never books a shift or chooses a worker. Approving one creates the shift and sends the first
// offer round in the fair offer order (FS-OFFER-ORDER-DEC-001).

export type SuggestionState = { shiftId: string; rounds: { round: number; closesAt: Date | null; offered: number }[]; accepted: number; headcount: number };
type Option = { id: string; name: string };

const hoursText = (minutes: number) => labourHours(minutes);

export function SuggestedShifts({ outlet, briefing, departments, policies, approved, act, simulated, notice }: {
  outlet: OutletStaffing & { shiftRules?: ShiftRules | null };
  briefing: AssessmentView | null;
  departments: Option[]; policies: Option[];
  // By suggestion key: the shift already approved for it, with its offer rounds.
  approved: ReadonlyMap<string, SuggestionState>;
  act: boolean; simulated: boolean; notice?: string;
}) {
  const rules = outlet.shiftRules;
  const suggestions = suggestShifts(outlet);
  // The AI's order, where its briefing is current for these figures; otherwise date and time.
  const order = briefing?.state === "CURRENT" && briefing.assessment ? briefing.assessment.suggestionOrder ?? [] : [];
  const keyOf = (ref: string) => briefing?.prepared.suggestionKeys?.[ref]?.split("|")[1];
  const reasons = new Map(order.map((row, i) => [keyOf(row.ref), { rank: i + 1, reason: row.reason }]));
  const sorted = [...suggestions].sort((a, b) => (reasons.get(a.key)?.rank ?? 99) - (reasons.get(b.key)?.rank ?? 99) || a.date.localeCompare(b.date) || a.start - b.start);
  const zone = outlet.timezone;
  const at = (date: Date) => new Intl.DateTimeFormat("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: zone }).format(date);
  const row = (s: SuggestedShift) => {
    const ai = reasons.get(s.key), done = approved.get(s.key);
    return <li key={s.key} className="context-signal suggested-shift">
      <p><strong>{longDate(s.date)} · {formatClock(s.start)}–{formatClock(s.end)}</strong> · {hoursText(s.minutes)} · {s.headcount === 1 ? "1 person" : `${s.headcount} people`}{ai ? <> <StatusBadge tone="predictive">AI order {ai.rank}</StatusBadge></> : null}</p>
      <p className="note">Covers the casual gap {s.window.replace("-", "–")} ({hoursText(s.windowRemainingMinutes)} short), cut with this location’s rules.</p>
      {ai ? <p><DataLabel kind="predictive">AI</DataLabel> {ai.reason}</p> : null}
      {done ? <p className="note"><StatusBadge tone={done.accepted >= done.headcount ? "success" : "neutral"}>{done.accepted >= done.headcount ? "Filled" : "Approved: offers out"}</StatusBadge> {done.rounds.map(r => `Round ${r.round}: ${r.offered} offered${r.closesAt ? ` until ${at(r.closesAt)}` : ", open until filled"}`).join(" · ")} · {done.accepted} of {done.headcount} accepted. Finalise accepted workers on Fill shifts.</p>
        : act ? <form action={approveSuggestedShiftAction} className="button-row suggestion-approve"><input type="hidden" name="key" value={s.key} />
          <label>Role<select name="departmentId" defaultValue={departments[0]?.id}>{departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
          <label>Pay terms<select name="policyId" defaultValue={policies[0]?.id}>{policies.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <button className="primary-button" disabled={!departments.length || !policies.length}>Approve and send offers</button></form>
        : simulated ? <p className="note"><DataLabel kind="demo">Simulated in the public demo</DataLabel> Signed-in Owners and Managers approve suggested shifts.</p> : null}
    </li>;
  };
  return <section className="panel" id="suggested-shifts" aria-labelledby="suggested-shifts-title">
    <h2 id="suggested-shifts-title">Suggested shifts</h2>
    {notice ? <p role="status" className="note context-notice">{notice}</p> : null}
    {!rules ? <p>This location has no shift-length rules yet, so no shifts are suggested. The Owner sets them in Settings.</p>
      : <p className="panel-lede">The open casual gap, cut into shifts of {hoursText(rules.minMinutes)} to {hoursText(rules.maxMinutes)} (about {hoursText(rules.preferredMinutes)} where it fits). Approving one creates it and offers it first to workers here who want more hours, fewest hours left to the business’s hours alert first, for up to {hoursText(rules.firstRoundMinutes)} (or until {hoursText(rules.firstRoundCutoffMinutes)} before it starts); then to everyone eligible here until it’s filled. {order.length ? "The order and reasons are the AI briefing’s; the shifts and offers are FairShift’s rules." : ""}</p>}
    {rules && !sorted.length ? <p>No open casual gap this week, so nothing to suggest.</p> : null}
    {sorted.length ? <ul className="context-signals">{sorted.map(row)}</ul> : null}
    {act && rules && sorted.length && (!departments.length || !policies.length) ? <p className="note">Add a role and hourly pay terms for this location before approving.</p> : null}
  </section>;
}
