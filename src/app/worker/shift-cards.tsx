import Link from "next/link";
import { StatusBadge } from "@/app/components/product-ui";
import { AssignmentResponse } from "@/app/components/assignment-response";
import { money, scheduledHours } from "@/app/components/format";
import { availabilityForShift, shiftWeekdays } from "@/server/scheduling/worker-pool";
import { checkWage, termsForWageCheck, UK_MINIMUM_WAGE_SOURCE, type WageJurisdiction } from "@/server/domain/statutory-wage";
import { SaWageIndicatorLine, saIndicatorFor } from "@/app/components/wage-check";

type Row = { shift: { id: string; roleName: string; shiftDate: string; startsAt: Date; endsAt: Date; status: string; termsVersion: number; earningsModel: string; rateMinor: number | null; commissionBps: number | null; expectedEarningsMinor: number | null; guaranteedBasePayMinor: number; currencyCode: string; incentiveAmountMinor: number; incentiveTargetMinor: number; incentiveBasis: string | null };
  offer: { id: string; status: string; acceptedAt: Date | null }; allocation: { state: string; confirmedAt: Date | null } | null; departmentName: string | null };

// The worker's shifts, grouped by what they need to do. Terms always come from the
// persisted shift, and the time is always the work location's.
export type WorkerShiftKind = "OFFER" | "CHANGED" | "ACCEPTED" | "UPCOMING" | "PAST" | "CLOSED";
export function workerShiftKind(row: Row, now: Date): WorkerShiftKind {
  if (row.shift.status !== "PUBLISHED" && row.shift.status !== "COMPLETED") return "CLOSED";
  // An offer for work that has already finished can no longer be answered.
  if (row.offer.status === "OFFERED" && row.shift.endsAt <= now) return "CLOSED";
  if (row.offer.status === "OFFERED") return row.allocation?.state === "REACCEPTANCE_REQUIRED" ? "CHANGED" : "OFFER";
  if (row.offer.status !== "ACCEPTED") return "CLOSED";
  if (row.shift.endsAt <= now || row.allocation?.confirmedAt) return "PAST";
  return row.allocation?.state === "ALLOCATED" ? "UPCOMING" : "ACCEPTED";
}

export function shiftWhen(startsAt: Date, endsAt: Date, timeZone: string) {
  const day = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone });
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone });
  const sameDay = day.format(startsAt) === day.format(new Date(endsAt.getTime() - 1));
  return { date: day.format(startsAt), time: sameDay ? `${time.format(startsAt)} to ${time.format(endsAt)}` : `${time.format(startsAt)} to ${time.format(endsAt)} on ${day.format(endsAt)}` };
}

// The statutory minimum wage line a worker sees: only what FairShift can actually say.
function WageNote({ shift, wage }: { shift: Row["shift"]; wage: WageJurisdiction }) {
  const terms = termsForWageCheck({ ...shift, rateMinor: shift.rateMinor ?? (shift.earningsModel === "DAILY" ? shift.guaranteedBasePayMinor : null) }, shift);
  if (!terms || terms.earningsModel === "COMMISSION") return null;
  const sa = saIndicatorFor(wage, shift.shiftDate, shift.currencyCode, terms);
  if (sa) return <SaWageIndicatorLine indicator={sa} />;
  const check = checkWage({ jurisdiction: wage, date: shift.shiftDate, currencyCode: shift.currencyCode, terms });
  const source = <a href={UK_MINIMUM_WAGE_SOURCE.url} target="_blank" rel="noreferrer">GOV.UK minimum wage rates</a>;
  if (check.status === "RATE_CHECKED") return <p className="note wage-note">This pay is at or above the 21-and-over National Living Wage for this date ({source}).</p>;
  return null;
}

function Earn({ shift, detailed = false, wage }: { shift: Row["shift"]; detailed?: boolean; wage?: WageJurisdiction | null }) {
  const amount = (value: number) => money(value, shift.currencyCode);
  const hours = scheduledHours(shift.startsAt, shift.endsAt);
  const guaranteed = shift.earningsModel === "COMMISSION"
    ? <p className="worker-shift-earn">{(shift.commissionBps ?? 0) / 100}% commission<small>of sales recorded to you. The amount isn’t known in advance, so no base pay is guaranteed.</small></p>
    : (() => {
      const base = shift.expectedEarningsMinor ?? shift.guaranteedBasePayMinor;
      const basis = shift.earningsModel === "HOURLY" ? `${amount(shift.rateMinor ?? 0)} an hour × ${hours}` : `${amount(shift.rateMinor ?? shift.guaranteedBasePayMinor)} for the day · ${hours}`;
      return <p className="worker-shift-earn">{amount(base)}<small>You’ll earn this for the work · {basis}</small></p>;
    })();
  const base = shift.earningsModel === "COMMISSION" ? null : shift.expectedEarningsMinor ?? shift.guaranteedBasePayMinor;
  const bonus = shift.incentiveBasis ? <>
    <dl className="offer-terms">
      <div><dt>Sales target</dt><dd>{amount(shift.incentiveTargetMinor)}</dd></div>
      <div><dt>Bonus</dt><dd>{amount(shift.incentiveAmountMinor)}</dd></div>
      {base !== null ? <div><dt>Up to</dt><dd>{amount(base + shift.incentiveAmountMinor)}</dd></div> : null}
    </dl>
  </> : null;
  if (!detailed) return <>{guaranteed}{bonus}</>;
  return <div className="pay-breakdown">
    <section className="pay-block pay-block-guaranteed" aria-label="Guaranteed base pay"><h4>Guaranteed base pay</h4>{guaranteed}</section>
    <section className="pay-block pay-block-variable" aria-label="Potential variable earnings"><h4>Potential variable earnings <span>Not guaranteed</span></h4>
      {bonus ? <>{bonus}<p className="worker-shift-bonus">You earn the {amount(shift.incentiveAmountMinor)} bonus if your own sales for this shift reach {amount(shift.incentiveTargetMinor)}.</p></> : (shift.incentiveAmountMinor > 0 ? <p>A {amount(shift.incentiveAmountMinor)} incentive if the team meets its target.</p> : <p>No sales bonus on this shift.</p>)}
      <p className="pay-line"><strong>Tips</strong> Not part of this shift’s terms. Any tips follow the location’s tip policy and are shown under Earnings; none are promised here.</p>
    </section>
    <section className="pay-block pay-block-final" aria-label="Final approved earnings"><h4>Final approved earnings</h4>
      <p>Set after the shift: your manager confirms the work{shift.incentiveBasis ? " and checks your sales" : ""}, then approves the total. Only an approved total is paid, through PayPal.</p>
    </section>
    <p className="note">Holiday pay isn’t calculated in FairShift and isn’t included in these amounts. Ask your manager how it’s handled. Amounts are before any tax or National Insurance.</p>
    {wage ? <WageNote shift={shift} wage={wage} /> : null}
  </div>;
}

const NEXT: Record<WorkerShiftKind, string> = {
  OFFER: "If you accept, your manager confirms who is working. You’ll see it here once you’re booked.",
  CHANGED: "The details changed, so we need your answer again. You’re not booked until you accept and your manager confirms.",
  ACCEPTED: "You said yes. You’re not booked yet: your manager still has to confirm who is working.",
  UPCOMING: "You’re booked. See you there.",
  PAST: "",
  CLOSED: "",
};
const BADGE: Record<WorkerShiftKind, string> = { OFFER: "New offer", CHANGED: "Details changed", ACCEPTED: "Waiting for your manager", UPCOMING: "You’re booked", PAST: "Finished", CLOSED: "Closed" };

export function WorkerShiftCard({ row, kind, locationName, timeZone, availability, wage = null }: { row: Row; kind: WorkerShiftKind; locationName: string; timeZone: string; availability: ReadonlyMap<number, string>; wage?: WageJurisdiction | null }) {
  const when = shiftWhen(row.shift.startsAt, row.shift.endsAt, timeZone);
  const respond = kind === "OFFER" || kind === "CHANGED";
  const blocked = respond && availabilityForShift(availability, shiftWeekdays(row.shift, timeZone)) === "UNAVAILABLE";
  return <article className="worker-shift" aria-label={`${row.departmentName ?? row.shift.roleName}, ${when.date}`}>
    <div className="worker-shift-head"><h3>{when.date}</h3><StatusBadge tone={kind === "UPCOMING" ? "success" : kind === "OFFER" || kind === "CHANGED" ? "predictive" : "neutral"}>{BADGE[kind]}</StatusBadge></div>
    <p className="worker-shift-when"><strong>{when.time}</strong> · {scheduledHours(row.shift.startsAt, row.shift.endsAt)}<br />{locationName} · {row.departmentName ?? row.shift.roleName}</p>
    <Earn shift={row.shift} detailed={kind !== "PAST" && kind !== "CLOSED"} wage={wage} />
    {kind !== "PAST" && kind !== "CLOSED" ? null : row.shift.incentiveBasis ? <p className="worker-shift-bonus">You earn the {money(row.shift.incentiveAmountMinor, row.shift.currencyCode)} bonus if your own sales for this shift reach {money(row.shift.incentiveTargetMinor, row.shift.currencyCode)}.</p>
      : row.shift.incentiveAmountMinor > 0 ? <p>You could also earn a {money(row.shift.incentiveAmountMinor, row.shift.currencyCode)} incentive if the team meets its target.</p> : null}
    {NEXT[kind] ? <p className="note">{NEXT[kind]}</p> : null}
    {blocked ? <p role="status">You’ve marked this day as unavailable. <Link href="/worker/availability">Change your availability</Link> if you want to accept.</p> : null}
    {respond ? <AssignmentResponse offerId={row.offer.id} version={row.shift.termsVersion} canAccept={!blocked} /> : null}
  </article>;
}

// What the worker earned on one shift. Before the sales are confirmed the bonus is
// unknown, not zero, so no sales figures or total are shown.
type Earned = { baseAmountMinor: number; currencyCode: string; incentiveRequired: boolean; incentiveAmountMinor: number | null };
type Performance = { salesCount: number; salesMinor: number; currencyCode: string; targetMinor: number; bonusMinor: number; earnedMinor: number; evidenceProvenance?: string };
export function WorkerPerformance({ payable, performance, shift }: { payable: Earned; performance: Performance | null; shift: { incentiveTargetMinor: number; incentiveAmountMinor: number } }) {
  const amount = (value: number) => money(value, payable.currencyCode);
  if (!performance) return <div className="worker-performance">
    <p><strong>Your sales results aren’t final yet.</strong> Your manager confirms them after the shift. You’ll earn a {amount(shift.incentiveAmountMinor)} bonus if your sales reached {amount(shift.incentiveTargetMinor)}.</p>
    <dl><div><dt>Base earnings</dt><dd>{amount(payable.baseAmountMinor)}</dd></div><div><dt>Bonus</dt><dd>Not known yet</dd></div></dl>
  </div>;
  return <div className="worker-performance">
    <dl>
      <div><dt>Your sales</dt><dd>{performance.salesCount}</dd></div>
      <div><dt>Your sales value</dt><dd>{amount(performance.salesMinor)}</dd></div>
      <div><dt>Target</dt><dd>{amount(performance.targetMinor)} · {performance.salesMinor >= performance.targetMinor ? "reached" : "not reached"}</dd></div>
      <div><dt>Base earnings</dt><dd>{amount(payable.baseAmountMinor)}</dd></div>
      <div><dt>Bonus earned</dt><dd>{amount(performance.earnedMinor)}</dd></div>
      <div className="worker-performance-total"><dt>Total earnings</dt><dd>{amount(payable.baseAmountMinor + performance.earnedMinor)}</dd></div>
    </dl>
    {performance.evidenceProvenance === "SQUARE_TEAM_MEMBER"
      ? <p className="note">Based on Square Sandbox payments carrying your team-member identity, confirmed by your manager.</p>
      : <p className="note">Based on sales records your manager imported and confirmed. They haven’t been checked by a sales provider.</p>}
  </div>;
}

// The worker's own target for an allocated shift, from their own attributed sales so far.
// No sales recorded yet is shown as that, never as a result of zero. The bonus stays
// unconfirmed until the manager has checked the sales, even once the target is reached.
type Target = { terms: { targetMinor: number; bonusMinor: number; currencyCode: string; startsAt: Date; endsAt: Date }; attributed: { count: number; minor: number }; evidence?: "SQUARE" | "IMPORTED" | "MIXED" };
export function WorkerTarget({ target, baseMinor, timeZone, now, salesKnown = true }: { target: Target; baseMinor: number | null; timeZone: string; now: Date; salesKnown?: boolean }) {
  const { terms, attributed } = target, amount = (value: number) => money(value, terms.currencyCode);
  const when = shiftWhen(terms.startsAt, terms.endsAt, timeZone);
  const phase = terms.endsAt <= now ? "Finished · your manager checks your sales next" : terms.startsAt <= now ? "On shift now" : `${when.date}, ${when.time}`;
  const reached = attributed.minor >= terms.targetMinor;
  const percent = Math.min(100, Math.floor((attributed.minor / terms.targetMinor) * 100));
  const circumference = 2 * Math.PI * 54;
  return <article className="worker-target" aria-label="Your shift target">
    <div className="worker-target-head"><h3>Your shift target</h3><span>{phase}</span></div>
    <div className="target-ring" role="progressbar" aria-label="Progress to your target" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <svg viewBox="0 0 128 128" aria-hidden="true"><circle cx="64" cy="64" r="54" className="target-ring-track" /><circle cx="64" cy="64" r="54" className="target-ring-value" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - percent / 100)} /></svg>
      <div><strong>{attributed.count === 0 ? "—" : amount(attributed.minor)}</strong><small>of {amount(terms.targetMinor)} target</small></div>
    </div>
    <p className="target-status"><strong>{attributed.count === 0 && !salesKnown ? `Your sales aren’t known yet · target ${amount(terms.targetMinor)}` : attributed.count === 0 ? `No sales recorded yet · target ${amount(terms.targetMinor)}` : reached ? `Target of ${amount(terms.targetMinor)} reached` : `${amount(terms.targetMinor - attributed.minor)} to go · target ${amount(terms.targetMinor)}`}</strong></p>
    <dl className="target-figures">
      <div><dt>Your sales</dt><dd>{attributed.count === 0 ? salesKnown ? "None yet" : "Not known yet" : attributed.count}</dd></div>
      <div><dt>Your sales value</dt><dd>{attributed.count === 0 ? salesKnown ? "None yet" : "Not known yet" : amount(attributed.minor)}</dd></div>
      <div><dt>Base pay</dt><dd>{baseMinor === null ? "Per your accepted terms" : amount(baseMinor)}</dd></div>
      <div><dt>Bonus</dt><dd>{reached ? `${amount(terms.bonusMinor)} · to be confirmed` : `${amount(terms.bonusMinor)} if you reach your target`}</dd></div>
    </dl>
    {target.evidence === "SQUARE"
      ? <p className="note"><span className="provenance">Square Sandbox · team-member attributed.</span> Your own sales only, from payments carrying your team-member identity during this shift. Your manager confirms the result before any bonus is final.</p>
      : target.evidence === "MIXED" ? <p className="note"><span className="provenance">Square Sandbox and imported sales.</span> Your own sales only. Your manager confirms the result before any bonus is final.</p>
      : <p className="note"><span className="provenance">Imported · not provider-verified.</span> Your own sales only, from records your manager imported. They haven’t been checked by a sales provider. Your manager confirms the result before any bonus is final.</p>}
  </article>;
}
