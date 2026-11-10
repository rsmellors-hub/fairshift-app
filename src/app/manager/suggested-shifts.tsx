import Link from "next/link";
import { DataLabel, StatusBadge } from "@/app/components/product-ui";
import { money } from "@/app/components/format";
import { labourHours, longDate } from "@/app/components/staffing";
import { approveAllSuggestedShiftsAction, approveSuggestedShiftAction } from "@/app/suggestion-actions";
import type { AssessmentView } from "@/server/intelligence/ai-staffing";
import { fillPlaceholders } from "@/server/intelligence/ai-staffing-contract";
import type { OutletStaffing } from "@/server/intelligence/staffing";
import { formatClock } from "@/server/intelligence/workload";
import { suggestShifts, type ShiftRules, type SuggestedShift } from "@/server/scheduling/shift-rules";

// Fill shifts (design: OwnerFill, 10 Nov 2026): the location's open casual gap cut into shifts with its own
// shift rules (deterministic) and its pay terms. When the AI briefing is current it orders them and says
// why first; it never books a shift or chooses a worker. "Approve all" sends round 1 offers in the fair
// offer order (FS-OFFER-ORDER-DEC-001) for each; a row can be approved alone, or edited first.

export type SuggestionState = { shiftId: string; rounds: { round: number; closesAt: Date | null; offered: number }[]; accepted: number; headcount: number };
type Option = { id: string; name: string };
type PayOption = Option & { rateMinor: number; currencyCode: string };

export function SuggestedShifts({ outlet, briefing, departments, policies, approved, act, simulated, notice, now }: {
  outlet: OutletStaffing & { shiftRules?: ShiftRules | null };
  briefing: AssessmentView | null;
  departments: Option[]; policies: PayOption[];
  approved: ReadonlyMap<string, SuggestionState>;
  act: boolean; simulated: boolean; notice?: string; now: number;
}) {
  const rules = outlet.shiftRules;
  const suggestions = suggestShifts(outlet).filter(row => Date.parse(row.startsAt) > now || approved.has(row.key));
  const order = briefing?.state === "CURRENT" && briefing.assessment ? briefing.assessment.suggestionOrder ?? [] : [];
  const keyOf = (ref: string) => briefing?.prepared.suggestionKeys?.[ref]?.split("|")[1];
  const reasons = new Map(order.map((row, i) => [keyOf(row.ref), { rank: i + 1, reason: row.reason }]));
  const sorted = [...suggestions].sort((a, b) => (reasons.get(a.key)?.rank ?? 99) - (reasons.get(b.key)?.rank ?? 99) || a.date.localeCompare(b.date) || a.start - b.start);
  const open = sorted.filter(s => !approved.has(s.key)), sent = sorted.filter(s => approved.has(s.key));
  const pay = policies[0];
  const zone = outlet.timezone;
  const at = (date: Date) => new Intl.DateTimeFormat("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: zone }).format(date);
  const chooser = <><label>Role<select name="departmentId" defaultValue={departments[0]?.id}>{departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
    <label>Pay terms<select name="policyId" defaultValue={pay?.id}>{policies.map(p => <option key={p.id} value={p.id}>{p.name} · {money(p.rateMinor, p.currencyCode)}/h</option>)}</select></label></>;
  const row = (s: SuggestedShift, i: number) => {
    const ai = reasons.get(s.key);
    const why = ai ? fillPlaceholders(ai.reason, { window: `${formatClock(s.start)}–${formatClock(s.end)}`, gap_hours: labourHours(s.windowRemainingMinutes), location: outlet.outletName }) : null;
    return <tr key={s.key}>
      <td data-label="#">{i + 1}</td>
      <th scope="row">{outlet.outletName}<small>{longDate(s.date)} · {formatClock(s.start)}–{formatClock(s.end)} · {s.headcount === 1 ? "1 person" : `${s.headcount} people`}</small></th>
      <td data-label="Terms">{pay ? <>{money(pay.rateMinor, pay.currencyCode)} / h · {money(Math.round(pay.rateMinor * s.minutes / 60), pay.currencyCode)}</> : "No pay terms yet"}</td>
      <td data-label="Why first">{why ? <><DataLabel kind="predictive">AI</DataLabel> {why}</> : <span className="note">Covers the gap {s.window.replace("-", "–")} ({labourHours(s.windowRemainingMinutes)} short).</span>}</td>
      <td data-label="Act">{act && departments.length && policies.length ? <div className="button-row">
        <form action={approveSuggestedShiftAction}><input type="hidden" name="key" value={s.key} /><input type="hidden" name="departmentId" value={departments[0].id} /><input type="hidden" name="policyId" value={pay!.id} /><button className="secondary-button">Approve</button></form>
        <Link className="link-button" href={`/manager/fill?date=${s.date}&window=${formatClock(s.start)}-${formatClock(s.end)}#add-requirement`}>Edit</Link></div>
        : simulated ? <DataLabel kind="demo">Simulated in the public demo</DataLabel> : null}</td>
    </tr>;
  };
  return <section className="panel" id="suggested-shifts" aria-labelledby="suggested-shifts-title">
    <div className="panel-head"><h2 id="suggested-shifts-title">Fill shifts · {outlet.outletName}</h2><span className="note">{open.length} {open.length === 1 ? "shift" : "shifts"} ready to send</span></div>
    {notice ? <p role="status" className="note context-notice">{notice}</p> : null}
    {!rules ? <p>This location has no shift-length rules yet, so no shifts are suggested. Set them on the location’s page under Staffing and offers.</p>
      : <p className="panel-lede">Cut from this venue’s gap using its shift rules ({labourHours(rules.minMinutes)}–{labourHours(rules.maxMinutes)}, about {labourHours(rules.preferredMinutes)}) and its pay terms. {order.length ? "The AI orders them by need and says why. " : ""}Nothing is sent until you approve.</p>}
    {act && open.length && departments.length && policies.length ? <form action={approveAllSuggestedShiftsAction} className="button-row suggestion-approve">{open.map(s => <input key={s.key} type="hidden" name="key" value={s.key} />)}{chooser}
      <button className="primary-button">Approve all {open.length} and send offers</button></form> : null}
    {rules && !suggestions.length ? <p>No open casual gap this week, so nothing to suggest.</p> : null}
    {open.length ? <div className="table-frame"><table className="data-table"><caption className="visually-hidden">Suggested shifts</caption><thead><tr><th scope="col">#</th><th scope="col">Shift</th><th scope="col">Terms</th><th scope="col">Why first</th><th scope="col"><span className="visually-hidden">Act</span></th></tr></thead><tbody>{open.map(row)}</tbody></table></div> : null}
    {act && rules && open.length && (!departments.length || !policies.length) ? <p className="note">Add a role and hourly pay terms for this location before approving.</p> : null}
    {sent.length ? <><h3 id="on-offer-now">On offer now</h3><p className="note">Offer rules: round 1 for people who want more hours, {rules ? `${labourHours(rules.firstRoundMinutes)} or until ${labourHours(rules.firstRoundCutoffMinutes)} before start` : "as set for this location"}. Then everyone eligible.</p>
      <ul className="role-list">{sent.map(s => { const done = approved.get(s.key)!; const latest = done.rounds.at(-1);
        return <li key={s.key}><p><strong>{outlet.outletName} · {longDate(s.date)} · {formatClock(s.start)}–{formatClock(s.end)}</strong> <StatusBadge tone={done.accepted >= done.headcount ? "success" : "neutral"}>{latest ? `Round ${latest.round}${latest.closesAt ? "" : " · open"}` : "Approved"}</StatusBadge></p>
          <p className="note">{done.accepted} of {done.headcount} {done.headcount === 1 ? "place" : "places"} filled{latest?.closesAt ? ` · closes ${at(latest.closesAt)}` : ""} · {done.rounds.map(r => `round ${r.round}: ${r.offered} offered`).join(", ")}. Finalise accepted workers below.</p></li>; })}</ul></> : null}
  </section>;
}
