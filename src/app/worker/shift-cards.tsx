import Link from "next/link";
import { StatusBadge } from "@/app/components/product-ui";
import { AssignmentResponse } from "@/app/components/assignment-response";
import { money, scheduledHours } from "@/app/components/format";
import { availabilityForShift, shiftWeekdays } from "@/server/scheduling/worker-pool";

type Row = { shift: { id: string; roleName: string; startsAt: Date; endsAt: Date; status: string; termsVersion: number; earningsModel: string; rateMinor: number | null; commissionBps: number | null; expectedEarningsMinor: number | null; guaranteedBasePayMinor: number; currencyCode: string; incentiveAmountMinor: number };
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

function Earn({ shift }: { shift: Row["shift"] }) {
  if (shift.earningsModel === "COMMISSION") return <p className="worker-shift-earn">{(shift.commissionBps ?? 0) / 100}% commission<small>of sales recorded to you. The amount isn’t known in advance.</small></p>;
  const hours = scheduledHours(shift.startsAt, shift.endsAt);
  const basis = shift.earningsModel === "HOURLY" ? `${money(shift.rateMinor ?? 0, shift.currencyCode)} an hour × ${hours}` : `${money(shift.rateMinor ?? shift.guaranteedBasePayMinor, shift.currencyCode)} for the day · ${hours}`;
  return <p className="worker-shift-earn">{money(shift.expectedEarningsMinor ?? shift.guaranteedBasePayMinor, shift.currencyCode)}<small>You’ll earn this for the work · {basis}</small></p>;
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

export function WorkerShiftCard({ row, kind, locationName, timeZone, availability }: { row: Row; kind: WorkerShiftKind; locationName: string; timeZone: string; availability: ReadonlyMap<number, string> }) {
  const when = shiftWhen(row.shift.startsAt, row.shift.endsAt, timeZone);
  const respond = kind === "OFFER" || kind === "CHANGED";
  const blocked = respond && availabilityForShift(availability, shiftWeekdays(row.shift, timeZone)) === "UNAVAILABLE";
  return <article className="worker-shift" aria-label={`${row.departmentName ?? row.shift.roleName}, ${when.date}`}>
    <StatusBadge tone={kind === "UPCOMING" ? "success" : kind === "OFFER" || kind === "CHANGED" ? "predictive" : "neutral"}>{BADGE[kind]}</StatusBadge>
    <h3>{row.departmentName ?? row.shift.roleName}</h3>
    <p>{locationName}</p>
    <p><strong>{when.date}</strong><br />{when.time}, {locationName} time</p>
    <Earn shift={row.shift} />
    {row.shift.incentiveAmountMinor > 0 ? <p>You could also earn a {money(row.shift.incentiveAmountMinor, row.shift.currencyCode)} incentive if the team meets its target.</p> : null}
    {NEXT[kind] ? <p>{NEXT[kind]}</p> : null}
    {blocked ? <p role="status">You’ve marked this day as unavailable. <Link href="/worker/availability">Change your availability</Link> if you want to accept.</p> : null}
    {respond ? <AssignmentResponse offerId={row.offer.id} version={row.shift.termsVersion} canAccept={!blocked} /> : null}
  </article>;
}
