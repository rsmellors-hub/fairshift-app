import Link from "next/link";
import { labourHours } from "@/app/components/staffing";
import { busiestDay, fillHref } from "@/app/manager/plan-week";
import { finalPayableMinor } from "@/server/domain/work-payable";
import { money } from "@/app/components/format";
import type { getOperations } from "@/server/scheduling/operations";
import type { OutletStaffing } from "@/server/intelligence/staffing";

type Operations = Awaited<ReturnType<typeof getOperations>>;
const longDay = (date: string) => new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
const shortDay = (date: string) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
const time = (date: Date, timeZone: string) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(date);

// The Manager's work queue: what happens today, what needs a decision, and the next gap.
export function ManagerToday({ today, now, timezone, staffing, requirements, offers, payables, paymentIssues, departments, team }: {
  today: string; now: Date; timezone: string; staffing: OutletStaffing | null;
  requirements: Operations["requirements"]; offers: Operations["offers"]; payables: Operations["payables"]; paymentIssues: Operations["paymentIssues"]; departments: Operations["departments"]; team: Operations["team"];
}) {
  const shiftOf = (id: string) => requirements.find(row => row.id === id)!;
  const coverage = (id: string) => offers.filter(row => row.offer.shiftId === id && row.allocation?.state === "ALLOCATED").length;
  const uncovered = requirements.filter(row => row.status === "PUBLISHED" && row.endsAt > now && coverage(row.id) < row.requiredHeadcount);
  const awaiting = offers.filter(row => row.offer.status === "OFFERED");
  const toAllocate = offers.filter(row => row.offer.status === "ACCEPTED" && row.allocation?.state !== "ALLOCATED");
  const toConfirm = offers.filter(row => row.allocation?.state === "ALLOCATED" && !row.allocation.confirmedAt && shiftOf(row.offer.shiftId).endsAt <= now);
  const salesToCheck = payables.filter(row => row.payable.status === "PENDING_REVIEW" && row.payable.incentiveRequired && row.payable.incentiveAmountMinor === null);
  const toApprove = payables.filter(row => row.payable.status === "PENDING_REVIEW" && !(row.payable.incentiveRequired && row.payable.incentiveAmountMinor === null));
  const toSend = payables.filter(row => row.payable.status === "APPROVED" && (!row.payout || row.payout.status === "NOT_SENT"));
  const stuck = payables.filter(row => row.payout?.status === "FAILED" || row.payout?.status === "RECONCILIATION_REQUIRED");
  const actions: { key: string; title: string; detail: string; href: string; cta: string; urgent?: boolean }[] = [
    ...stuck.map(row => ({ key: `stuck-${row.payable.id}`, title: `${row.workerName}: payment needs attention`, detail: "It has not been confirmed as paid.", href: "/manager/review#base-payables", cta: "Review payment", urgent: true })),
    ...paymentIssues.map(issue => ({ key: `issue-${issue.id}`, title: `${issue.workerName} · ${shortDay(issue.shiftDate)}`, detail: issue.status === "FAILED" ? "Payment needs attention" : "Incentive awaiting approval", href: "/manager/review#incentive-review", cta: "Review payment", urgent: issue.status === "FAILED" })),
    ...toAllocate.map(row => ({ key: `allocate-${row.offer.id}`, title: `${row.workerName} accepted`, detail: `Finalise the allocation for ${shortDay(shiftOf(row.offer.shiftId).shiftDate)}.`, href: "/manager/allocations", cta: "Finalise" })),
    ...toConfirm.map(row => ({ key: `confirm-${row.offer.id}`, title: `Confirm ${row.workerName}’s shift`, detail: `${shortDay(shiftOf(row.offer.shiftId).shiftDate)} has finished.`, href: "/manager/review#confirm-work", cta: "Review completed work" })),
    ...salesToCheck.map(row => ({ key: `sales-${row.payable.id}`, title: `Check ${row.workerName}’s sales`, detail: `Needed before the total for ${shortDay(row.shiftDate)} is known.`, href: "/manager/review#performance", cta: "Check sales" })),
    ...toApprove.map(row => ({ key: `approve-${row.payable.id}`, title: `Approve ${money(finalPayableMinor(row.payable), row.payable.currencyCode)} for ${row.workerName}`, detail: `Shift on ${shortDay(row.shiftDate)}.`, href: "/manager/review#base-payables", cta: "Review" })),
    ...toSend.map(row => ({ key: `send-${row.payable.id}`, title: `Send ${row.workerName}’s approved pay`, detail: `Shift on ${shortDay(row.shiftDate)}. Approved, not yet sent to PayPal.`, href: "/manager/review#base-payables", cta: "Pay with PayPal" })),
    ...offers.filter(row => row.allocation?.state === "ALLOCATED" && !row.allocation.confirmedAt && !team.find(member => member.worker.id === row.offer.workerId)?.worker.paypalPayoutEmail).map(row => ({ key: `details-${row.offer.id}`, title: `${row.workerName} has no PayPal email yet`, detail: `Booked for ${shortDay(shiftOf(row.offer.shiftId).shiftDate)}. Ask them to add it so they can be paid without delay.`, href: "/manager/team", cta: "See workers" })),
    ...uncovered.map(row => ({ key: `fill-${row.id}`, title: `${row.requiredHeadcount - coverage(row.id)} uncovered · ${shortDay(row.shiftDate)}`, detail: departments.find(item => item.id === row.departmentId)?.name ?? row.roleName, href: `/manager/fill#requirement-${row.id}`, cta: "Fill shifts" })),
  ];
  const working = offers.filter(row => row.allocation?.state === "ALLOCATED" && shiftOf(row.offer.shiftId).shiftDate === today).sort((a, b) => shiftOf(a.offer.shiftId).startsAt.getTime() - shiftOf(b.offer.shiftId).startsAt.getTime());
  const next = staffing ? busiestDay(staffing.days) : null;
  return <>
    <section className="overview-strip">
      <div><span>Uncovered places</span><strong>{uncovered.reduce((sum, row) => sum + Math.max(0, row.requiredHeadcount - coverage(row.id)), 0)}</strong></div>
      <div><span>Awaiting response</span><strong>{awaiting.length}</strong></div>
      <div><span>Work to review</span><strong>{toConfirm.length}</strong></div>
      <div><span>To approve or pay</span><strong>{toApprove.length + toSend.length}</strong></div>
    </section>
    <div className="overview-columns">
      <section className="panel"><h2>Needs attention</h2>
        {actions.length ? <ul className="action-list">{actions.map(action => <li key={action.key} data-urgent={action.urgent || undefined}><span><strong>{action.title}</strong><small>{action.detail}</small></span><Link className="secondary-button button-link" href={action.href}>{action.cta}</Link></li>)}</ul> : <p className="note">Nothing needs a decision right now.</p>}
        {awaiting.length ? <p className="note">{awaiting.map(row => row.workerName).join(", ")} {awaiting.length === 1 ? "hasn’t" : "haven’t"} responded yet.</p> : null}
      </section>
      <div className="stack">
        <section className="panel next-gap"><h2>Next staffing problem</h2>
          {next ? <><p className="next-gap-day">{longDay(next.planningDate)}</p><p className="next-gap-hours">{labourHours(next.casualGapMinutes ?? 0)} gap to fill</p><p className="note">The largest gap in the planning week, after regular and allocated cover.</p><Link className="primary-button button-link" href={fillHref(next.planningDate)}>Fill this gap</Link> <Link className="text-link" href="/manager/plan">See the week <span aria-hidden="true">→</span></Link></> : <><p>{staffing?.days.some(day => day.casualGapMinutes === 0) ? "No casual gap in the days we can calculate." : "The staffing gap can’t be calculated yet."}</p><Link className="text-link" href="/manager/plan">Open Forecast &amp; staffing <span aria-hidden="true">→</span></Link></>}
        </section>
        <section className="panel"><h2>Working today</h2>
          {working.length ? <ul className="today-list">{working.map(row => { const shift = shiftOf(row.offer.shiftId); return <li key={row.offer.id}><strong>{row.workerName}</strong><span>{time(shift.startsAt, timezone)}–{time(shift.endsAt, timezone)}</span></li>; })}</ul> : <p className="note">No casual shifts allocated today.</p>}
        </section>
      </div>
    </div>
  </>;
}
