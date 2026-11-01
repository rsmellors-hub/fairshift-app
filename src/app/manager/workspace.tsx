import { resendInvitationAction, revokeInvitationAction } from "@/app/auth-actions";
import { requireScope } from "@/server/auth/request";
import type { Scope } from "@/server/auth/access";
import { DEMO_ORGANISATION_ID } from "@/server/constants";
import Link from "next/link";
import { DataLabel, PageHeader, StatePanel, StatusBadge } from "@/app/components/product-ui";
import { ActionFeedback, currencyTotals, money, PayableBadge, payableBasis, payableLabel, scheduledHours, ShiftTerms, WorkspaceUnavailable, dateTime } from "@/app/components/workspace-ui";
import { getLocationPerformance, type ImportRejection } from "@/server/performance/attribution";
import { finalPayableMinor } from "@/server/domain/work-payable";
import { confirmPerformanceAction, importAttributedSalesAction } from "@/app/operations-actions";
import { createTeamAction, createRequirementAction, offerAssignmentAction, allocateAssignmentAction, confirmWorkAction, changeAssignmentAction, approvePayableAction, sendPayoutAction, refreshPayoutAction } from "@/app/operations-actions";
import { publishDemoShiftAction } from "@/app/scheduling-actions";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { getOperations } from "@/server/scheduling/operations";
import { getAllocationSchedule } from "@/server/scheduling/allocations";
import { getWeeklyStaffing, type WeeklyStaffing } from "@/server/intelligence/staffing";
import { isSyntheticSource } from "@/server/intelligence/forecast";
import { labourHours, longDate, policyDescription, StaffingDayTable, StaffingMethodNote, wholeMoney } from "@/app/components/staffing";
import { RequirementForm } from "./requirement-form";
import { availabilityForShift, isOfferable, OPPORTUNITY_LABEL, shiftWeekdays, workerOpportunityState } from "@/server/scheduling/worker-pool";
import { getStaffingAssessmentView } from "@/server/intelligence/ai-staffing";
import { AiStaffingAssessment } from "@/app/components/ai-staffing-assessment";
import { generateLocationAssessmentAction } from "@/app/intelligence-actions";
import { AllocationScheduler } from "./allocation-scheduler";
import { DemoReview } from "./review-workspace";
import { DecisionNote, fillHref, ManagerJourney, WeekCover } from "./plan-week";
import { PayoutProgress, ReviewStages } from "@/app/components/payment-progress";
import { SquareLiveRefresh } from "@/app/components/square-live-refresh";
import { getSquareFreshness } from "@/server/commerce/square-connection";
import { SquarePanel } from "./square-panel";

export const managerAreas = ["plan", "fill", "allocations", "team", "review"] as const;
export type ManagerArea = "overview" | typeof managerAreas[number];

export async function ManagerWorkspace({ area, status, date, department, ai, importResult }: { area: ManagerArea; status?: string; date?: string; department?: string; ai?: string; importResult?: string }) {
  if (!getConfigurationStatus().databaseConfigured) return <WorkspaceUnavailable />;
  const scope=await requireScope(["OWNER","MANAGER"]);
  let data;
  try { data = await getOperations(getDatabase(),scope); } catch { return <WorkspaceUnavailable />; }
  const { team, departments, policies, requirements, offers, paymentIssues, payables, availability, timezone } = data;
  const visibleRequirements = requirements.filter(r => (!date || r.shiftDate === date) && (!department || r.departmentId === department));
  const coverage = (id: string) => {
    const rows = offers.filter(r => r.offer.shiftId === id);
    return { pending: rows.filter(r => r.offer.status === "OFFERED").length, accepted: rows.filter(r => r.offer.status === "ACCEPTED").length, allocated: rows.filter(r => r.allocation?.state === "ALLOCATED").length };
  };
  // The one calculated week behind both the staffing panel and the Fill Shifts context.
  let staffing: WeeklyStaffing | null = null;
  if (area === "plan" || area === "fill") { try { staffing = await getWeeklyStaffing(getDatabase(),scope,new Date()); } catch { staffing = null; } }
  const planningOutlet = staffing?.outlets.find(row => row.outletId === scope.locationId) ?? null;
  const planningDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
  const gapDay = planningDate ? planningOutlet?.days.find(day => day.planningDate === planningDate) ?? null : null;
  const stated = (workerId: string) => new Map(availability.filter(row => row.workerId === workerId).map(row => [row.isoWeekday, row.state]));
  // The same rule the server enforces when an offer is sent.
  const poolState = (worker: (typeof team)[number]["worker"], shift: (typeof requirements)[number]) => workerOpportunityState({
    active: worker.status === "ACTIVE", activated: !!worker.userId,
    conflict: offers.some(o => o.offer.workerId === worker.id && o.offer.status === "ACCEPTED" && requirements.some(s => s.id === o.offer.shiftId && s.id !== shift.id && ["PUBLISHED", "COMPLETED"].includes(s.status) && s.startsAt < shift.endsAt && s.endsAt > shift.startsAt)),
    availability: availabilityForShift(stated(worker.id), shiftWeekdays(shift, timezone)),
  });
  return <>
    <PageHeader eyebrow={scope.locationName} title={{ overview: "Today", plan: "Plan", fill: "Fill shifts", allocations: "Allocations", team: "Team", review: "Review" }[area]} />
    {area === "plan" || area === "fill" || area === "allocations" || area === "review" ? <ManagerJourney current={area} /> : null}
    <ActionFeedback status={status} />
    {area === "overview" ? <>
      <section className="overview-strip"><div><span>Uncovered places</span><strong>{requirements.filter(r => r.status === "PUBLISHED").reduce((n,r) => n + Math.max(0, r.requiredHeadcount - coverage(r.id).allocated),0)}</strong></div><div><span>Awaiting response</span><strong>{offers.filter(r => r.offer.status === "OFFERED").length}</strong></div><div><span>Work to review</span><strong>{offers.filter(r => r.allocation?.state === "ALLOCATED" && !r.allocation.confirmedAt && requirements.find(s => s.id === r.offer.shiftId)!.endsAt <= new Date()).length}</strong></div></section>
      <section className="panel"><h2>Needs attention</h2>{requirements.filter(r => r.status === "PUBLISHED" && coverage(r.id).allocated < r.requiredHeadcount).map(r => <div className="record-row" key={r.id}><span>{r.shiftDate} · {departments.find(d => d.id === r.departmentId)?.name ?? r.roleName} · {r.requiredHeadcount - coverage(r.id).allocated} uncovered</span><Link href={`/manager/fill#requirement-${r.id}`}>Fill shifts</Link></div>)}
      {offers.some(r => r.offer.status === "ACCEPTED" && r.allocation?.state !== "ALLOCATED") ? <p><Link href="/manager/fill#work-opportunities">Accepted offers need allocation</Link></p> : null}
      {paymentIssues.map(issue => <div className="record-row" key={issue.id}><span>{issue.workerName} · {issue.shiftDate} · {issue.status === "FAILED" ? "Payment needs attention" : "Incentive awaiting approval"}</span><Link href="/manager/review#incentive-review">Review payment</Link></div>)}
      <Link href="/manager/review">Review completed work →</Link></section>
    </> : null}
    {area === "team" ? <>
      <section className="panel"><h2>Location team · {team.length}</h2><div className="table-scroll"><table><thead><tr><th>Name</th><th>Contact</th><th>Sales attribution code</th><th>FairShift invitation</th></tr></thead><tbody>{team.map(({worker, invitation}) => <tr key={worker.id}><td>{worker.displayName}</td><td>{worker.telephone ?? "—"}<br />{worker.email ?? "—"}</td><td>{worker.attributionCode}</td><td>{invitation ? invitation.state === "CREATED_NOT_SENT" ? "Prepared · not sent" : invitation.state.replaceAll("_"," ") : "Existing profile"}{invitation && !["REDEEMED","REVOKED"].includes(invitation.state) ? <><form action={resendInvitationAction}><input type="hidden" name="invitationId" value={invitation.id}/><button className="secondary-button">Resend invite</button></form><form action={revokeInvitationAction}><input type="hidden" name="invitationId" value={invitation.id}/><button className="secondary-button">Revoke invite</button></form></>:null}</td></tr>)}</tbody></table></div></section>
      <section className="panel"><h2>Add team member</h2><form action={createTeamAction} className="workspace-form form-grid"><label>First name<input name="firstName" maxLength={100} required /></label><label>Surname<input name="surname" maxLength={100} required /></label><label>Telephone number<input type="tel" name="telephone" maxLength={30} required /></label><label>Email address<input type="email" name="email" maxLength={254} required /></label><p>Location: {scope.locationName}. Email is sent only when configured; invitation state is tracked separately.</p><button className="primary-button">Create & send FairShift invite</button></form></section>
    </> : null}
    {area === "team" ? await SquarePanel({ scope, team: team.filter(row => row.worker.status === "ACTIVE").map(row => ({ id: row.worker.id, displayName: row.worker.displayName })) }) : null}
    {area === "plan" ? await Staffing(scope, ai, staffing) : null}
    {area === "allocations" ? await Roster(scope, timezone) : null}
    {area === "fill" ? <>
      <section className="panel" id="work-opportunities"><h2>Work to fill</h2><p>{scope.locationName} · times shown at this location ({timezone})</p>
      <form method="get" action="/manager/fill" className="inline-form"><label>Trading day<input type="date" name="date" defaultValue={date} /></label><label>Department<select name="department" defaultValue={department ?? ""}><option value="">All departments</option>{departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label><button className="secondary-button">Apply</button><Link href="/manager/fill">All dates</Link></form>
        {visibleRequirements.length ? visibleRequirements.sort((a,b) => a.startsAt.getTime() - b.startsAt.getTime()).map(r => {
          const c = coverage(r.id);
          const rows = offers.filter(o => o.offer.shiftId === r.id);
          const pool = team.filter(({worker}) => !rows.some(o => o.offer.workerId === worker.id)).map(({worker}) => ({ worker, state: poolState(worker, r) }));
          const hasCapacity = c.pending + c.accepted < r.requiredHeadcount;
          return <article id={`requirement-${r.id}`} className="requirement" key={r.id}><h3>{dateTime(r.startsAt, timezone)} – {dateTime(r.endsAt, timezone)} · {departments.find(d => d.id === r.departmentId)?.name ?? r.roleName}</h3>
          <p><strong>{r.earningsModel === "COMMISSION" ? `Commission ${(r.commissionBps ?? 0) / 100}%` : `${money(r.expectedEarningsMinor ?? r.guaranteedBasePayMinor, r.currencyCode)} expected earnings per worker`}</strong> · {scheduledHours(r.startsAt, r.endsAt)}</p>
          <p>{r.requiredHeadcount} needed · {c.allocated} allocated · {c.accepted} accepted · {c.pending} awaiting response · {Math.max(0,r.requiredHeadcount-c.allocated)} still to fill</p><details><summary>Full terms · version {r.termsVersion}</summary><ShiftTerms shift={r} locationName={scope.locationName} timeZone={timezone} /></details>
          {rows.length ? <><h4>Responses</h4>{rows.map(o => <div className="record-row" key={o.offer.id}><span>{o.workerName} · {responseLabel(o)}</span>{o.offer.status === "ACCEPTED" && o.allocation?.state !== "ALLOCATED" ? <form action={allocateAssignmentAction}><PlanContext date={date} department={department} /><input name="offerId" type="hidden" value={o.offer.id} /><button className="primary-button">Finalise allocation</button></form> : null}</div>)}</> : null}
          {r.status === "PUBLISHED" ? <><h4>Worker pool · {scope.locationName}</h4>{pool.length ? pool.map(({worker, state}) => <div className="record-row" key={worker.id}><span>{worker.displayName} · {OPPORTUNITY_LABEL[state]}</span>{isOfferable(state) ? hasCapacity ? <form action={offerAssignmentAction}><PlanContext date={date} department={department} /><input type="hidden" name="shiftId" value={r.id} /><input type="hidden" name="workerId" value={worker.id} /><button className="secondary-button">Send offer</button></form> : <small>All places are offered</small> : null}</div>) : <p>Everyone at this location already has an offer for this work.</p>}<p className="method-note">Only workers at this location appear. Availability is what each worker has told FairShift; no reason is asked for.</p></> : null}
          {r.status === "PUBLISHED" ? <details><summary>Change scheduled work</summary><form action={changeAssignmentAction} className="workspace-form"><PlanContext date={date} department={department}/><input name="shiftId" type="hidden" value={r.id}/><label>New start · {timezone}<input name="startsAt" type="datetime-local" required/></label><label>New end · {timezone}<input name="endsAt" type="datetime-local" required/></label><p>Material changes require renewed acceptance. Reviewed work is locked.</p><button className="secondary-button">Update schedule</button></form><form action={changeAssignmentAction}><input name="shiftId" type="hidden" value={r.id}/><input name="cancel" type="hidden" value="yes"/><label><input type="checkbox" required/> Confirm cancellation</label><button className="secondary-button">Cancel assignment</button></form></details>:null}
          </article>;
        }) : <StatePanel title="No work opportunities yet"><p>Create one below when you are ready to fill a gap.</p></StatePanel>}
      <p className="method-note">You can offer each piece of work to as many workers as it needs.</p></section>
      <details className="panel" id="add-requirement" open={!!date}><summary>Create a paid work opportunity</summary>
        {gapDay ? <section className="staffing-handoff" aria-label="Staffing requirement"><p><strong>FairShift identified a staffing requirement for {longDate(gapDay.planningDate)}.</strong> You are creating the work to address it. Nothing is created or offered until you do.</p>
          <dl className="shift-terms"><div><dt>Required labour</dt><dd>{gapDay.requiredMinutes === null ? "Unavailable" : labourHours(gapDay.requiredMinutes)}</dd></div><div><dt>Regular coverage</dt><dd>{gapDay.regularMinutes === null ? "Not set" : labourHours(gapDay.regularMinutes)}</dd></div><div><dt>Allocated casual</dt><dd>{labourHours(gapDay.allocatedCasualMinutes)}</dd></div><div><dt>Casual labour gap</dt><dd>{gapDay.casualGapMinutes === null ? "Unavailable" : labourHours(gapDay.casualGapMinutes)}</dd></div><div><dt>Indicative shifts</dt><dd>{gapDay.indicativeShifts ?? "Unavailable"}</dd></div></dl>
          <p className="method-note">{planningOutlet?.policy ? `Calculated with ${policyDescription(planningOutlet.policy)}. ` : ""}{planningOutlet?.evidence ? `Sales evidence through ${longDate(planningOutlet.evidence.dataThrough)}.` : ""}</p></section> : null}
        {departments.length && policies.length ? <RequirementForm action={createRequirementAction} departments={departments.map(d => ({ id: d.id, name: d.name }))} policies={policies.map(p => ({ id: p.id, name: p.name, earningsModel: p.earningsModel, rateMinor: p.rateMinor, commissionBps: p.commissionBps, currencyCode: p.currencyCode, incentiveTargetMinor: p.incentiveTargetMinor, incentiveBonusMinor: p.incentiveBonusMinor }))} timeZone={timezone} locationName={scope.locationName}
          defaults={{ departmentId: department, startsAt: planningDate ? `${planningDate}T09:00` : "", endsAt: planningDate ? `${planningDate}T17:00` : "", headcount: gapDay?.indicativeShifts || 1 }} context={<PlanContext date={date} department={department} />} /> : <p>The business owner must configure a department and work policy first.</p>}</details>
      <p><Link href="/manager/allocations">See accepted and allocated work on the weekly schedule →</Link></p>
      {scope.organisationId === DEMO_ORGANISATION_ID ? <details className="panel"><summary>Controlled demo assignment</summary><p>Fixed daily terms and the existing deterministic team incentive. This creates the established demonstration offer for Alex Morgan.</p><form action={publishDemoShiftAction}><label><input name="workerSelected" type="checkbox" value="yes" required /> Invite Alex Morgan</label><button className="secondary-button">Publish demo assignment</button></form></details> : null}
    </> : null}
    {area === "review" ? <>
      <ReviewStages stages={[
        { label: "Work confirmed", waiting: offers.filter(o => o.allocation?.state === "ALLOCATED" && !o.allocation.confirmedAt && requirements.find(s => s.id === o.offer.shiftId)!.endsAt <= new Date()).length, href: "#confirm-work" },
        { label: "Sales checked", waiting: payables.filter(p => p.payable.status === "PENDING_REVIEW" && p.payable.incentiveRequired && p.payable.incentiveAmountMinor === null).length, href: "#performance" },
        { label: "Approve", waiting: payables.filter(p => p.payable.status === "PENDING_REVIEW" && !(p.payable.incentiveRequired && p.payable.incentiveAmountMinor === null)).length, href: "#base-payables" },
        { label: "Pay with PayPal", waiting: payables.filter(p => p.payable.status === "APPROVED" && (!p.payout || p.payout.status === "NOT_SENT")).length, href: "#base-payables" },
      ]} />
      <section className="panel" id="confirm-work"><h2>Confirm work performed</h2>{offers.filter(o => o.allocation?.state === "ALLOCATED").map(o => { const r = requirements.find(r => r.id === o.offer.shiftId)!; const payable = payables.find(p => p.payable.allocationId === o.allocation!.id)?.payable; return <div className="requirement" key={o.offer.id}><h3>{o.workerName} · {r.shiftDate} · {r.roleName}</h3><ShiftTerms shift={r} locationName={scope.locationName} timeZone={timezone} />{o.allocation?.confirmedAt ? <>
        <p>Work confirmed {dateTime(o.allocation.confirmedAt, timezone)} ({timezone}) as scheduled.</p>
        {payable ? <p>Base payable {money(payable.baseAmountMinor, payable.currencyCode)} from the accepted terms · {payable.incentiveRequired && payable.incentiveAmountMinor === null ? <a href="#performance">Sales results needed</a> : <a href="#base-payables">{payableLabel(payable.status, payables.find(p => p.payable.id === payable.id)?.payout)}</a>}</p>
          : r.earningsModel === "COMMISSION" ? <p>Commission is not payable: verified attributed sales are required.</p>
          : <form action={confirmWorkAction}><input name="offerId" type="hidden" value={o.offer.id} /><input name="confirmed" type="hidden" value="yes" /><p>The base payable for this confirmed work has not been recorded.</p><button className="secondary-button">Calculate base payable</button></form>}
      </> : <form action={confirmWorkAction}><input name="offerId" type="hidden" value={o.offer.id} /><label><input name="confirmed" type="checkbox" value="yes" required /> I confirm the scheduled work was performed.</label><button className="primary-button" disabled={r.endsAt > new Date()}>Confirm work</button>{r.endsAt > new Date() ? <small>Available after the scheduled end.</small> : null}</form>}</div>; })}</section>
      {await PerformanceReview(scope, payables, timezone, importResult)}
      <section className="panel" id="base-payables" aria-labelledby="base-payables-title"><h2 id="base-payables-title">Payments &amp; approvals · confirmed work</h2>
        <p className="method-note">Payables are calculated by FairShift: the base from the terms each worker accepted, for work confirmed as scheduled, plus any bonus earned under those terms. No timesheet or overtime is applied. Approving confirms the calculated amount; it cannot be edited. Sending the payout pays exactly the approved amount and currency through PayPal (Sandbox in this environment). A payment shows as Paid only after PayPal reports it as successful.</p>
        {payables.length ? <>
          <div className="overview-strip">
            <div><span>Awaiting approval</span><strong>{currencyTotals(payables.filter(p => p.payable.status === "PENDING_REVIEW").map(p => ({ amountMinor: finalPayableMinor(p.payable), currencyCode: p.payable.currencyCode }))) || "None"}</strong></div>
            <div><span>Approved · not yet paid</span><strong>{currencyTotals(payables.filter(p => p.payable.status === "APPROVED" && p.payout?.status !== "PAID").map(p => ({ amountMinor: p.payable.approvedAmountMinor ?? 0, currencyCode: p.payable.approvedCurrencyCode ?? p.payable.currencyCode }))) || "None"}</strong></div>
            <div><span>Paid · confirmed by PayPal</span><strong>{currencyTotals(payables.filter(p => p.payout?.status === "PAID").map(p => ({ amountMinor: p.payout!.amountMinor, currencyCode: p.payout!.currencyCode }))) || "None"}</strong></div>
          </div>
          <div className="table-scroll" role="region" aria-label="Payables and payouts" tabIndex={0}><table><thead><tr><th>Worker</th><th>Shift</th><th>Accepted terms</th><th>Confirmed · {timezone}</th><th>Payable</th><th>Status</th><th>Action</th></tr></thead><tbody>{payables.map(({ payable, payout, workerName, shiftDate, roleName, paymentDetailsSaved }) => <tr key={payable.id}><td>{workerName}</td><td>{shiftDate} · {roleName}</td><td>{payableBasis(payable)} · version {payable.termsVersion}</td><td>{dateTime(payable.confirmedAt, timezone)}</td><td><strong>{payable.incentiveRequired && payable.incentiveAmountMinor === null ? "Total not known yet" : `Total ${money(finalPayableMinor(payable), payable.currencyCode)}`}</strong>{payable.incentiveRequired ? <><br /><small>{payable.incentiveAmountMinor === null ? `${money(finalPayableMinor(payable), payable.currencyCode)} base only · bonus not known yet` : `${money(payable.baseAmountMinor, payable.currencyCode)} base + ${money(payable.incentiveAmountMinor, payable.currencyCode)} bonus`}</small></> : null}{payable.approvedAt ? <><br /><small>Approved {dateTime(payable.approvedAt, timezone)}</small></> : null}</td><td><PayableBadge status={payable.status} payout={payout} /><PayoutProgress status={payable.status} payout={payout} /></td><td><PayableAction payable={payable} payout={payout} paymentDetailsSaved={paymentDetailsSaved} payoutsConfigured={getConfigurationStatus().paypalPayoutConfigured} timezone={timezone} /></td></tr>)}</tbody></table></div>
        </> : <StatePanel title="No confirmed work awaiting approval"><p>Base payables appear here when allocated work is confirmed.</p></StatePanel>}
      </section>
      {scope.organisationId === DEMO_ORGANISATION_ID ? await DemoReview() : null}
    </> : null}
  </>;
}
const IMPORT_REASON: Record<ImportRejection, string> = {
  INVALID_ROW: "not readable: check the columns, the time's offset and a two-decimal amount above zero",
  IN_THE_FUTURE: "the time is in the future",
  UNKNOWN_CODE: "no worker at this location has that attribution code",
  NO_MATCHING_SHIFT: "not within an accepted incentive shift for that worker",
  WRONG_CURRENCY: "not in the currency of the accepted terms",
  RESULTS_FINAL: "that shift's sales results are already confirmed",
  TRANSACTION_CHANGED: "that transaction was already imported with different details",
};
// Each number and reason is checked, so an edited link can only show what is valid.
function ImportOutcome({ value }: { value?: string }) {
  const match = value?.match(/^(\d+)\.(\d+)\.(\d+)(?:\.([\w:,]+))?$/);
  if (!match) return null;
  const rows = (match[4] ?? "").split(",").flatMap(item => { const [line, reason] = item.split(":"); return reason && reason in IMPORT_REASON ? [{ line, reason: IMPORT_REASON[reason as ImportRejection] }] : []; });
  return <StatePanel title={`${match[1]} imported · ${match[2]} already imported · ${match[3]} not imported`} tone={match[3] === "0" ? "success" : "warning"}>
    {rows.length ? <ul>{rows.map(row => <li key={row.line}>Line {row.line}: {row.reason}.</li>)}</ul> : null}
    {Number(match[3]) > rows.length ? <p>Only the first {rows.length} are listed.</p> : null}
  </StatePanel>;
}
// Sales evidence for incentive shifts, in aggregate: count and value, never transactions.
async function PerformanceReview(scope: Scope, payables: Awaited<ReturnType<typeof getOperations>>["payables"], timezone: string, importResult?: string) {
  let work: Awaited<ReturnType<typeof getLocationPerformance>>;
  let freshness: Awaited<ReturnType<typeof getSquareFreshness>> = null;
  try { work = await getLocationPerformance(getDatabase(), scope); freshness = await getSquareFreshness(getDatabase(), scope); } catch { return <StatePanel title="Sales results are unavailable" tone="warning"><p>Please try again shortly. Nothing has been calculated as zero.</p></StatePanel>; }
  return <section className="panel" id="performance" aria-labelledby="performance-title"><h2 id="performance-title">Performance · attributed sales</h2>
    {freshness ? <>
      <p className="method-note">Sales come from Square Sandbox payments carrying the team-member identity mapped to a worker, within their accepted shift at this location. This doesn’t show who was logged in to a till. Refunds are recorded but don’t change the result. The bonus is calculated from the accepted terms and can’t be edited.</p>
      {work.some(item => !item.result) ? <SquareLiveRefresh timeZone={timezone} initial={{ revision: freshness.revision, failed: freshness.attention || freshness.lastFailed, lastCheckedAt: freshness.lastSuccessAt?.toISOString() ?? null }} /> : null}
    </> : <p className="method-note">Sales are imported, matched to a worker by attribution code within their accepted shift at this location, and marked “Imported · not provider-verified”. Confirming them for payment doesn’t change that. The bonus is calculated from the accepted terms and can’t be edited.</p>}
    <ImportOutcome value={importResult} />
    {work.length ? work.map(item => {
      const payable = payables.find(row => row.payable.allocationId === item.allocationId)?.payable, currency = item.terms.currencyCode, amount = (value: number) => money(value, currency);
      const square = item.result ? item.result.evidenceProvenance === "SQUARE_TEAM_MEMBER" : item.evidence === "SQUARE";
      const none = square ? "None attributed yet" : "None imported yet";
      const count = item.result?.salesCount ?? item.attributed.count, value = item.result?.salesMinor ?? item.attributed.minor, base = payable?.baseAmountMinor;
      return <article className="requirement" key={item.allocationId}><h3>{item.workerName} · {item.shiftDate} · {item.roleName}</h3>
        <p><StatusBadge tone="warning">{square ? "Square Sandbox attributed sales" : !item.result && item.evidence === "MIXED" ? "Square Sandbox and imported sales" : "Imported · not provider-verified"}</StatusBadge> {item.result ? <strong>Confirmed for payment</strong> : <strong>Not complete yet</strong>}</p>
        <dl className="shift-terms">
          <div><dt>Attributed sales</dt><dd>{count === 0 && !item.result ? none : count}</dd></div>
          <div><dt>Attributed sales value</dt><dd>{count === 0 && !item.result ? "Not known yet" : amount(value)}</dd></div>
          <div><dt>Target · accepted</dt><dd>{amount(item.terms.targetMinor)}</dd></div>
          <div><dt>Fixed bonus · accepted</dt><dd>{amount(item.terms.bonusMinor)}</dd></div>
          <div><dt>Accepted base earnings</dt><dd>{base === undefined ? "After work is confirmed" : amount(base)}</dd></div>
          <div><dt>Bonus earned</dt><dd>{item.result ? `${amount(item.result.earnedMinor)} · target ${item.result.earnedMinor > 0 ? "reached" : "not reached"}` : "Not known yet"}</dd></div>
          <div><dt>Final payable</dt><dd>{payable && item.result ? amount(finalPayableMinor(payable)) : "Not known yet"}</dd></div>
        </dl>
        {item.result ? null : payable ? <form action={confirmPerformanceAction}><input type="hidden" name="allocationId" value={item.allocationId} /><input type="hidden" name="seenCount" value={item.attributed.count} /><input type="hidden" name="seenMinor" value={item.attributed.minor} />
          <label><input type="checkbox" name="complete" value="yes" required /> {count === 0 ? "I’ve checked: this worker made no attributed sales on this shift." : "I’ve checked: these sales are complete for this shift."}</label>
          <button className="primary-button">Confirm sales results</button></form>
          : <p><small>Confirm the work above before its sales results. Allocated {dateTime(item.startsAt, timezone)}.</small></p>}
      </article>; }) : <StatePanel title="No incentive shifts yet"><p>Allocated work with a sales target appears here.</p></StatePanel>}
    {freshness ? null : <details><summary>Import attributed sales</summary>
      <form action={importAttributedSalesAction} className="workspace-form">
        <label>Paste rows from your sales export<textarea name="rows" rows={6} required spellCheck={false} placeholder="transaction_id,attribution_code,occurred_at,amount,currency" /></label>
        <p className="method-note">Columns: transaction_id, attribution_code, occurred_at (with a time zone offset, such as 2026-11-03T11:15:00+00:00), amount (such as 25.00), currency. Importing the same rows again doesn’t count them twice. Don’t include customer or product details.</p>
        <button className="secondary-button">Import sales</button>
      </form></details>}
  </section>;
}
// The structured PayPal error code recorded with a payout, if any (never a provider message).
function payoutReason(lastError: unknown) {
  const code = typeof lastError === "object" && lastError !== null && "code" in lastError ? (lastError as { code: unknown }).code : null;
  return typeof code === "string" ? code : null;
}
type ManagerPayables = Awaited<ReturnType<typeof getOperations>>["payables"];
// One next action per payable: approve, then send, then check status. Each form posts
// only the payable ID; the server reads amount, currency and recipient itself.
function PayableAction({ payable, payout, paymentDetailsSaved, payoutsConfigured, timezone }: Pick<ManagerPayables[number], "payable" | "payout" | "paymentDetailsSaved"> & { payoutsConfigured: boolean; timezone: string }) {
  const id = <input name="payableId" type="hidden" value={payable.id} />;
  if (payable.status === "PENDING_REVIEW" && payable.incentiveRequired && payable.incentiveAmountMinor === null) return <a href="#performance">Confirm sales results first</a>;
  if (payable.status === "PENDING_REVIEW") return <form action={approvePayableAction}>{id}<button className="primary-button">Approve {money(finalPayableMinor(payable), payable.currencyCode)}</button></form>;
  if (payable.status !== "APPROVED") return <span>Unavailable</span>;
  if (!payout || payout.status === "NOT_SENT") {
    return <>
      {payout?.status === "NOT_SENT" ? <p><small>PayPal did not receive the previous request, so nothing was paid. It can be sent again.</small></p> : null}
      {!paymentDetailsSaved ? <p><strong>Payment details required.</strong> <small>The worker must add a PayPal email in Profile → Payment settings.</small></p>
        : !payoutsConfigured ? <p><small>The payment service is unavailable. Contact your platform operator.</small></p>
        : <form action={sendPayoutAction}>{id}<button className="primary-button">Send {money(payable.approvedAmountMinor ?? 0, payable.approvedCurrencyCode ?? payable.currencyCode)} payout with PayPal</button></form>}
    </>;
  }
  return <>
    {payout.status === "FAILED" ? <p><small>PayPal did not complete this payment. It cannot be sent again from FairShift; contact your platform operator.</small></p> : null}
    {payout.status === "PROCESSING" && ["ONHOLD", "UNCLAIMED"].includes(payout.paypalStatus ?? "") ? <p><small>PayPal is waiting for the worker to {payout.paypalStatus === "UNCLAIMED" ? "claim the payment with a PayPal account" : "accept the payment in their PayPal account"}. Nothing is paid until PayPal reports success.</small></p> : null}
    {["PROVIDER_AMOUNT_MISMATCH", "PROVIDER_AMOUNT_UNAVAILABLE"].includes(payoutReason(payout.lastError) ?? "") ? <p><small>PayPal reports this item as complete, but FairShift could not match PayPal&apos;s amount to the approved amount. It is not shown as paid. Contact your platform operator.</small></p> : null}
    {payout.status === "RECONCILIATION_REQUIRED" ? <p><small>PayPal&apos;s response was not received, so this payment is unconfirmed. Checking repeats the identical request, which PayPal pays at most once.</small></p> : null}
    {payout.status !== "FAILED" || payout.paypalBatchId ? <form action={refreshPayoutAction}>{id}<button className="secondary-button">Check payment status</button></form> : null}
    <details><summary>PayPal Sandbox reference</summary><dl className="shift-terms">
      <div><dt>Amount sent</dt><dd>{money(payout.amountMinor, payout.currencyCode)}</dd></div>
      <div><dt>Payout batch</dt><dd>{payout.paypalBatchId ?? "Not yet received"}</dd></div>
      <div><dt>Payout item</dt><dd>{payout.paypalItemId ?? "Not yet received"}</dd></div>
      <div><dt>Transaction</dt><dd>{payout.paypalTransactionId ?? "Not yet received"}</dd></div>
      <div><dt>PayPal status</dt><dd>{payout.paypalStatus ?? payout.paypalBatchStatus ?? "Unknown"}</dd></div>
      {payoutReason(payout.lastError) ? <div><dt>PayPal reason</dt><dd>{payoutReason(payout.lastError)}</dd></div> : null}
      <div><dt>Last checked</dt><dd>{payout.statusCheckedAt ? dateTime(payout.statusCheckedAt, timezone) : "Not yet checked"}</dd></div>
      {payout.paidAt ? <div><dt>Paid</dt><dd>{dateTime(payout.paidAt, timezone)}</dd></div> : null}
    </dl></details>
  </>;
}
function responseLabel(o: { offer: { status: string }; allocation: { state: string } | null }) {
  if (o.offer.status === "ACCEPTED") return o.allocation?.state === "ALLOCATED" ? "Allocated" : "Accepted · ready to allocate";
  if (o.offer.status === "OFFERED") return o.allocation?.state === "REACCEPTANCE_REQUIRED" ? "Reacceptance required" : "Pending response";
  return o.offer.status === "DECLINED" ? "Declined" : "Offer closed";
}
function PlanContext({ date, department }: { date?: string; department?: string }) {
  return <><input type="hidden" name="planDate" value={date ?? ""} /><input type="hidden" name="planDepartment" value={department ?? ""} /></>;
}
// Planning-week staffing evidence for the manager's own location; managers are
// scoped to one location, so no location selector is shown.
async function Staffing(scope:Scope, aiNotice: string | undefined, staffing: WeeklyStaffing | null) {
  if (!staffing) return <StatePanel title="Staffing unavailable" tone="warning"><p>Forecast or coverage could not be loaded, so no labour gap is shown. Existing requirements remain available below.</p></StatePanel>;
  const outlet = staffing.outlets.find(row => row.outletId === scope.locationId);
  if (!outlet) return <StatePanel title="Staffing unavailable" tone="warning"><p>This location is not available for planning.</p></StatePanel>;
  const evidence = outlet.evidence;
  return <section className="panel staffing-week" aria-labelledby="staffing-week-title">
    <h2 id="staffing-week-title">Planning week staffing</h2>
    <p>{scope.locationName} · Planning week {longDate(outlet.days[0].planningDate)} – {longDate(outlet.days[6].planningDate)} · {outlet.timezone}</p>
    {evidence ? <DataLabel kind={isSyntheticSource(evidence.source) ? "demo" : "fact"}>{evidence.source === "REFERENCE" ? "Reference sales history · synthetic" : evidence.source === "DEMO_SEEDED" ? "Demo / seeded history" : evidence.source === "IMPORTED" ? "Imported sales history · not provider-verified" : evidence.source === "SQUARE" ? "Square Sandbox sales · connected seller" : evidence.source === "ZETTLE" ? "Earlier connected-account sales" : "Verified PayPal Sandbox sales"}</DataLabel> : null}
    <p className="method-note">{evidence ? evidence.kind === "HISTORICAL" ? `Historical evidence through ${longDate(evidence.dataThrough)} (${evidence.ageDays} days before the planning week), mapped onto planning weekdays. Not live demand.` : `Sales through ${longDate(evidence.dataThrough)}.` : "No eligible sales history, so no demand or labour requirement has been assumed."}</p>
    <WeekCover outlet={outlet} />
    {outlet.totals ? <div className="status-grid forecast-grid" aria-label="Planning week totals">
      <article><span>Required labour</span><strong>{labourHours(outlet.totals.requiredMinutes)}</strong><small>From forecast demand</small></article>
      <article><span>Existing coverage</span><strong>{labourHours(outlet.totals.coverageMinutes)}</strong><small>Regular {labourHours(outlet.totals.regularMinutes)} · allocated casual {labourHours(outlet.totals.allocatedCasualMinutes)}</small></article>
      <article><span>Casual labour gap</span><strong>{labourHours(outlet.totals.casualGapMinutes)}</strong><small>Approx. {outlet.totals.indicativeShifts} shifts to fill · none created</small></article>
      <article><span>Estimated cost to fill</span><strong>{outlet.commercial?.cost && outlet.currency ? outlet.commercial.cost.lowMinor === outlet.commercial.cost.highMinor ? wholeMoney(outlet.commercial.cost.lowMinor, outlet.currency) : `${wholeMoney(outlet.commercial.cost.lowMinor, outlet.currency)} – ${wholeMoney(outlet.commercial.cost.highMinor, outlet.currency)}` : "Not available"}</strong><small>{outlet.commercial?.cost ? "Estimate on this location’s work policies" : "Needs a work policy in this currency"}</small></article>
      <article><span>Expected sales</span><strong>{outlet.commercial?.forecast && outlet.currency ? wholeMoney(outlet.commercial.forecast.totalMinor, outlet.currency) : "Not available"}</strong><small>{outlet.commercial?.comparable && outlet.currency ? `Comparable days ${wholeMoney(outlet.commercial.comparable.salesMinor, outlet.currency)}` : "Forecast, not recorded sales"}</small></article>
    </div> : null}
    <div className="history-scroll" role="region" aria-label="Staffing by planning day" tabIndex={0}><StaffingDayTable outlet={outlet} className="history-table" planHref={fillHref} /></div>
    <p className="method-note"><StaffingMethodNote policy={outlet.policy} /> No AI is used in these figures.</p>
    <h3>AI priorities</h3>
    <DecisionNote />
    {await LocationAssessment(scope, staffing, aiNotice)}
  </section>;
}
// AI interpretation of this location's staffing week. A failure here never hides the
// calculated figures above it.
async function LocationAssessment(scope:Scope, staffing:WeeklyStaffing, notice?: string) {
  let view = null;
  try { view = await getStaffingAssessmentView(getDatabase(),scope,"LOCATION",staffing); } catch { view = null; }
  const names = Object.fromEntries(staffing.outlets.map(outlet => [outlet.outletId, outlet.outletName]));
  return <AiStaffingAssessment view={view} names={names} configured={getConfigurationStatus().aiConfigured} action={generateLocationAssessmentAction} notice={notice}
    timeZone={staffing.outlets.find(outlet => outlet.outletId === scope.locationId)?.timezone}
    planHref={(outletId, date) => outletId === scope.locationId ? `/manager/fill${date ? `?date=${date}` : ""}#add-requirement` : null} />;
}
async function Roster(scope:Scope, timeZone:string) {
  let schedule;
  try { schedule = await getAllocationSchedule(getDatabase(),scope); }
  catch { return <WorkspaceUnavailable />; }
  return schedule.events.length ? <AllocationScheduler schedule={schedule} timeZone={timeZone} /> : <StatePanel title="No shift allocations" />;
}
