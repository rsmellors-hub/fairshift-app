import { resendInvitationAction, revokeInvitationAction } from "@/app/auth-actions";
import { requireScope } from "@/server/auth/request";
import type { Scope } from "@/server/auth/access";
import { DEMO_ORGANISATION_ID } from "@/server/constants";
import Link from "next/link";
import { DataLabel, PageHeader, StatePanel } from "@/app/components/product-ui";
import { ActionFeedback, currencyTotals, money, PayableBadge, payableBasis, payableLabel, ShiftTerms, WorkspaceUnavailable, dateTime } from "@/app/components/workspace-ui";
import { ManagerForecast } from "@/app/components/manager-forecast";
import { createTeamAction, createRequirementAction, offerAssignmentAction, allocateAssignmentAction, confirmWorkAction, changeAssignmentAction, approvePayableAction, sendPayoutAction, refreshPayoutAction } from "@/app/operations-actions";
import { publishDemoShiftAction } from "@/app/scheduling-actions";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { getOperations } from "@/server/scheduling/operations";
import { getAllocationSchedule } from "@/server/scheduling/allocations";
import { getManagerForecast } from "@/server/intelligence/manager";
import { getWeeklyStaffing, type WeeklyStaffing } from "@/server/intelligence/staffing";
import { labourHours, longDate, StaffingDayTable, StaffingMethodNote } from "@/app/components/staffing";
import { getStaffingAssessmentView } from "@/server/intelligence/ai-staffing";
import { AiStaffingAssessment } from "@/app/components/ai-staffing-assessment";
import { generateLocationAssessmentAction } from "@/app/intelligence-actions";
import { AllocationScheduler } from "./allocation-scheduler";
import { DemoReview } from "./review-workspace";

export const managerAreas = ["plan", "team", "review"] as const;
export type ManagerArea = "overview" | typeof managerAreas[number];

export async function ManagerWorkspace({ area, status, date, department, ai }: { area: ManagerArea; status?: string; date?: string; department?: string; ai?: string }) {
  if (!getConfigurationStatus().databaseConfigured) return <WorkspaceUnavailable />;
  const scope=await requireScope(["OWNER","MANAGER"]);
  let data;
  try { data = await getOperations(getDatabase(),scope); } catch { return <WorkspaceUnavailable />; }
  const { team, departments, policies, requirements, offers, paymentIssues, payables, timezone } = data;
  const visibleRequirements = requirements.filter(r => (!date || r.shiftDate === date) && (!department || r.departmentId === department));
  const coverage = (id: string) => {
    const rows = offers.filter(r => r.offer.shiftId === id);
    return { pending: rows.filter(r => r.offer.status === "OFFERED").length, accepted: rows.filter(r => r.offer.status === "ACCEPTED").length, allocated: rows.filter(r => r.allocation?.state === "ALLOCATED").length };
  };
  return <>
    <PageHeader eyebrow={scope.locationName} title={{ overview: "Today", plan: "Plan", team: "Team", review: "Review" }[area]} />
    <ActionFeedback status={status} />
    {area === "overview" ? <>
      <section className="overview-strip"><div><span>Uncovered places</span><strong>{requirements.filter(r => r.status === "PUBLISHED").reduce((n,r) => n + Math.max(0, r.requiredHeadcount - coverage(r.id).allocated),0)}</strong></div><div><span>Awaiting response</span><strong>{offers.filter(r => r.offer.status === "OFFERED").length}</strong></div><div><span>Work to review</span><strong>{offers.filter(r => r.allocation?.state === "ALLOCATED" && !r.allocation.confirmedAt && requirements.find(s => s.id === r.offer.shiftId)!.endsAt <= new Date()).length}</strong></div></section>
      <section className="panel"><h2>Needs attention</h2>{requirements.filter(r => r.status === "PUBLISHED" && coverage(r.id).allocated < r.requiredHeadcount).map(r => <div className="record-row" key={r.id}><span>{r.shiftDate} · {departments.find(d => d.id === r.departmentId)?.name ?? r.roleName} · {r.requiredHeadcount - coverage(r.id).allocated} uncovered</span><Link href={`/manager/plan#requirement-${r.id}`}>Resolve coverage</Link></div>)}
      {offers.some(r => r.offer.status === "ACCEPTED" && r.allocation?.state !== "ALLOCATED") ? <p><Link href="/manager/plan">Accepted offers need allocation</Link></p> : null}
      {paymentIssues.map(issue => <div className="record-row" key={issue.id}><span>{issue.workerName} · {issue.shiftDate} · {issue.status === "FAILED" ? "Payment needs attention" : "Incentive awaiting approval"}</span><Link href="/manager/review#incentive-review">Review payment</Link></div>)}
      <Link href="/manager/review">Review completed work →</Link></section>
    </> : null}
    {area === "team" ? <>
      <section className="panel"><h2>Location team · {team.length}</h2><div className="table-scroll"><table><thead><tr><th>Name</th><th>Contact</th><th>Sales attribution code</th><th>FairShift invitation</th></tr></thead><tbody>{team.map(({worker, invitation}) => <tr key={worker.id}><td>{worker.displayName}</td><td>{worker.telephone ?? "—"}<br />{worker.email ?? "—"}</td><td>{worker.attributionCode}</td><td>{invitation ? invitation.state === "CREATED_NOT_SENT" ? "Prepared · not sent" : invitation.state.replaceAll("_"," ") : "Existing profile"}{invitation && !["REDEEMED","REVOKED"].includes(invitation.state) ? <><form action={resendInvitationAction}><input type="hidden" name="invitationId" value={invitation.id}/><button className="secondary-button">Resend invite</button></form><form action={revokeInvitationAction}><input type="hidden" name="invitationId" value={invitation.id}/><button className="secondary-button">Revoke invite</button></form></>:null}</td></tr>)}</tbody></table></div></section>
      <section className="panel"><h2>Add team member</h2><form action={createTeamAction} className="workspace-form form-grid"><label>First name<input name="firstName" maxLength={100} required /></label><label>Surname<input name="surname" maxLength={100} required /></label><label>Telephone number<input type="tel" name="telephone" maxLength={30} required /></label><label>Email address<input type="email" name="email" maxLength={254} required /></label><p>Location: {scope.locationName}. Email is sent only when configured; invitation state is tracked separately.</p><button className="primary-button">Create & send FairShift invite</button></form></section>
    </> : null}
    {area === "plan" ? <>
      {await Staffing(scope, ai)}
      <details className="panel"><summary>Single-day demand forecast</summary>{await Forecast(scope)}</details>
      <section className="panel"><h2>Coverage requirements</h2><p>{scope.locationName} · Johannesburg time</p>
      <form method="get" action="/manager/plan" className="inline-form"><label>Trading day<input type="date" name="date" defaultValue={date} /></label><label>Department<select name="department" defaultValue={department ?? ""}><option value="">All departments</option>{departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label><button className="secondary-button">Apply</button><Link href="/manager/plan">All dates</Link></form>
        {visibleRequirements.length ? visibleRequirements.sort((a,b) => a.shiftDate.localeCompare(b.shiftDate)).map(r => {
          const c = coverage(r.id);
          const rows = offers.filter(o => o.offer.shiftId === r.id);
          const eligible = team.filter(({worker}) => worker.status === "ACTIVE" && !rows.some(o => o.offer.workerId === worker.id) && !offers.some(o => o.offer.workerId === worker.id && o.offer.status === "ACCEPTED" && requirements.some(s => s.id === o.offer.shiftId && s.startsAt < r.endsAt && s.endsAt > r.startsAt)));
          return <article id={`requirement-${r.id}`} className="requirement" key={r.id}><h3>{r.shiftDate} · {departments.find(d => d.id === r.departmentId)?.name ?? r.roleName}</h3><p>{r.requiredHeadcount} required · {c.allocated} allocated · {c.accepted} accepted · {c.pending} awaiting response · {Math.max(0,r.requiredHeadcount-c.allocated)} uncovered</p><details><summary>Assignment terms · version {r.termsVersion}</summary><ShiftTerms shift={r} locationName={scope.locationName} /></details>
          {rows.map(o => <div className="record-row" key={o.offer.id}><span>{o.workerName} · {o.offer.status === "OFFERED" ? "Awaiting response" : o.offer.status === "ACCEPTED" ? o.allocation?.state === "ALLOCATED" ? "Allocated" : "Accepted · allocation needed" : "Offer closed"}</span>{o.offer.status === "ACCEPTED" && o.allocation?.state !== "ALLOCATED" ? <form action={allocateAssignmentAction}><PlanContext date={date} department={department} /><input name="offerId" type="hidden" value={o.offer.id} /><button className="secondary-button">Allocate accepted work</button></form> : null}</div>)}
          {r.status === "PUBLISHED" && c.pending + c.accepted < r.requiredHeadcount ? <form action={offerAssignmentAction} className="inline-form"><PlanContext date={date} department={department} /><input type="hidden" name="shiftId" value={r.id} /><label>Eligible team members<select name="workerId" required defaultValue=""><option value="" disabled>Select a team member</option>{eligible.map(({worker}) => <option key={worker.id} value={worker.id}>{worker.displayName}</option>)}</select></label><button className="primary-button" disabled={!eligible.length}>Send assignment offer</button><small>Active location team; accepted overlaps excluded. Availability and department preferences are not recorded.</small></form> : null}
          {r.status === "PUBLISHED" ? <details><summary>Change scheduled work</summary><form action={changeAssignmentAction} className="workspace-form"><PlanContext date={date} department={department}/><input name="shiftId" type="hidden" value={r.id}/><label>New start · Johannesburg<input name="startsAt" type="datetime-local" required/></label><label>New end · Johannesburg<input name="endsAt" type="datetime-local" required/></label><p>Material changes require renewed acceptance. Reviewed work is locked.</p><button className="secondary-button">Update schedule</button></form><form action={changeAssignmentAction}><input name="shiftId" type="hidden" value={r.id}/><input name="cancel" type="hidden" value="yes"/><label><input type="checkbox" required/> Confirm cancellation</label><button className="secondary-button">Cancel assignment</button></form></details>:null}
          </article>;
        }) : <StatePanel title="No coverage requirements" />}
      <p className="method-note">Invitations beyond the requested headcount are unavailable pending a capacity-policy decision.</p></section>
      <details className="panel" id="add-requirement" open={!!date}><summary>Add a department coverage requirement</summary>{departments.length && policies.length ? <form action={createRequirementAction} className="workspace-form form-grid"><PlanContext date={date} department={department} /><label>Department<select name="departmentId" defaultValue={department}>{departments.map(d => <option value={d.id} key={d.id}>{d.name}</option>)}</select></label><label>Owner-defined work terms<select name="policyId">{policies.map(p => <option key={p.id} value={p.id}>{p.name} · {p.earningsModel.toLowerCase()}</option>)}</select></label><label>Starts · Johannesburg<input name="startsAt" type="datetime-local" required /></label><label>Ends · Johannesburg<input name="endsAt" type="datetime-local" required /></label><label>Required headcount<input name="headcount" type="number" min="1" max="1000" defaultValue="1" required /></label><button className="primary-button">Create requirement</button></form> : <p>Owner/Admin must configure a department and work policy first.</p>}</details>
      {await Roster(scope)}
      {scope.organisationId === DEMO_ORGANISATION_ID ? <details className="panel"><summary>Controlled demo assignment</summary><p>Fixed daily terms and the existing deterministic team incentive. This creates the established demonstration offer for Alex Morgan.</p><form action={publishDemoShiftAction}><label><input name="workerSelected" type="checkbox" value="yes" required /> Invite Alex Morgan</label><button className="secondary-button">Publish demo assignment</button></form></details> : null}
    </> : null}
    {area === "review" ? <>
      <section className="panel"><h2>Confirm work performed</h2>{offers.filter(o => o.allocation?.state === "ALLOCATED").map(o => { const r = requirements.find(r => r.id === o.offer.shiftId)!; const payable = payables.find(p => p.payable.allocationId === o.allocation!.id)?.payable; return <div className="requirement" key={o.offer.id}><h3>{o.workerName} · {r.shiftDate} · {r.roleName}</h3><ShiftTerms shift={r} locationName={scope.locationName} />{o.allocation?.confirmedAt ? <>
        <p>Work confirmed {dateTime(o.allocation.confirmedAt, timezone)} ({timezone}) as scheduled.</p>
        {payable ? <p>Base payable {money(payable.baseAmountMinor, payable.currencyCode)} from the accepted terms · <a href="#base-payables">{payableLabel(payable.status, payables.find(p => p.payable.id === payable.id)?.payout)}</a></p>
          : r.earningsModel === "COMMISSION" ? <p>Commission is not payable: verified attributed sales are required.</p>
          : <form action={confirmWorkAction}><input name="offerId" type="hidden" value={o.offer.id} /><input name="confirmed" type="hidden" value="yes" /><p>The base payable for this confirmed work has not been recorded.</p><button className="secondary-button">Calculate base payable</button></form>}
      </> : <form action={confirmWorkAction}><input name="offerId" type="hidden" value={o.offer.id} /><label><input name="confirmed" type="checkbox" value="yes" required /> I confirm the scheduled work was performed.</label><button className="primary-button" disabled={r.endsAt > new Date()}>Confirm work</button>{r.endsAt > new Date() ? <small>Available after the scheduled end.</small> : null}</form>}</div>; })}</section>
      <section className="panel" id="base-payables" aria-labelledby="base-payables-title"><h2 id="base-payables-title">Payments &amp; approvals · confirmed work</h2>
        <p className="method-note">Base payables are calculated by FairShift from the terms each worker accepted, for work confirmed as scheduled. No timesheet, overtime or incentive is applied. Approving confirms the calculated amount; it cannot be edited. Sending the payout pays exactly the approved amount and currency through PayPal (Sandbox in this environment). A payment shows as Paid only after PayPal reports it as successful.</p>
        {payables.length ? <>
          <div className="overview-strip">
            <div><span>Awaiting approval</span><strong>{currencyTotals(payables.filter(p => p.payable.status === "PENDING_REVIEW").map(p => ({ amountMinor: p.payable.baseAmountMinor, currencyCode: p.payable.currencyCode }))) || "None"}</strong></div>
            <div><span>Approved · not yet paid</span><strong>{currencyTotals(payables.filter(p => p.payable.status === "APPROVED" && p.payout?.status !== "PAID").map(p => ({ amountMinor: p.payable.approvedAmountMinor ?? 0, currencyCode: p.payable.approvedCurrencyCode ?? p.payable.currencyCode }))) || "None"}</strong></div>
            <div><span>Paid · confirmed by PayPal</span><strong>{currencyTotals(payables.filter(p => p.payout?.status === "PAID").map(p => ({ amountMinor: p.payout!.amountMinor, currencyCode: p.payout!.currencyCode }))) || "None"}</strong></div>
          </div>
          <div className="table-scroll" role="region" aria-label="Payables and payouts" tabIndex={0}><table><thead><tr><th>Worker</th><th>Shift</th><th>Accepted terms</th><th>Confirmed · {timezone}</th><th>Payable</th><th>Status</th><th>Action</th></tr></thead><tbody>{payables.map(({ payable, payout, workerName, shiftDate, roleName, paymentDetailsSaved }) => <tr key={payable.id}><td>{workerName}</td><td>{shiftDate} · {roleName}</td><td>{payableBasis(payable)} · version {payable.termsVersion}</td><td>{dateTime(payable.confirmedAt, timezone)}</td><td><strong>{money(payable.baseAmountMinor, payable.currencyCode)}</strong>{payable.approvedAt ? <><br /><small>Approved {dateTime(payable.approvedAt, timezone)}</small></> : null}</td><td><PayableBadge status={payable.status} payout={payout} /></td><td><PayableAction payable={payable} payout={payout} paymentDetailsSaved={paymentDetailsSaved} payoutsConfigured={getConfigurationStatus().paypalPayoutConfigured} timezone={timezone} /></td></tr>)}</tbody></table></div>
        </> : <StatePanel title="No confirmed work awaiting approval"><p>Base payables appear here when allocated work is confirmed.</p></StatePanel>}
      </section>
      {scope.organisationId === DEMO_ORGANISATION_ID ? await DemoReview() : null}
    </> : null}
  </>;
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
  if (payable.status === "PENDING_REVIEW") return <form action={approvePayableAction}>{id}<button className="primary-button">Approve {money(payable.baseAmountMinor, payable.currencyCode)}</button></form>;
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
function PlanContext({ date, department }: { date?: string; department?: string }) {
  return <><input type="hidden" name="planDate" value={date ?? ""} /><input type="hidden" name="planDepartment" value={department ?? ""} /></>;
}
// The single-day forecast is deterministic only: AI interpretation is the weekly
// assessment in Staffing, which is stored and never requested by rendering.
async function Forecast(scope:Scope) {
  let result;
  try { result = await getManagerForecast(getDatabase(),new Date(),scope); }
  catch { return <ManagerForecast result={null} error="Demand evidence is unavailable. Prior requirements remain available." />; }
  return <ManagerForecast result={result} />;
}
// Planning-week staffing evidence for the manager's own location; managers are
// scoped to one location, so no location selector is shown.
async function Staffing(scope:Scope, aiNotice?: string) {
  let staffing;
  try { staffing = await getWeeklyStaffing(getDatabase(),scope,new Date()); }
  catch { return <StatePanel title="Staffing unavailable" tone="warning"><p>Forecast or coverage could not be loaded, so no labour gap is shown. Existing requirements remain available below.</p></StatePanel>; }
  const outlet = staffing.outlets.find(row => row.outletId === scope.locationId);
  if (!outlet) return <StatePanel title="Staffing unavailable" tone="warning"><p>This location is not available for planning.</p></StatePanel>;
  const evidence = outlet.evidence;
  return <section className="panel staffing-week" aria-labelledby="staffing-week-title">
    <h2 id="staffing-week-title">Planning week staffing</h2>
    <p>{scope.locationName} · Planning week {longDate(outlet.days[0].planningDate)} – {longDate(outlet.days[6].planningDate)} · {outlet.timezone}</p>
    {evidence ? <DataLabel kind={evidence.source === "PAYPAL_SANDBOX" ? "fact" : "demo"}>{evidence.source === "REFERENCE" ? "Reference sales history · synthetic" : evidence.source === "DEMO_SEEDED" ? "Demo / seeded history" : "Verified PayPal Sandbox sales"}</DataLabel> : null}
    <p className="method-note">{evidence ? evidence.kind === "HISTORICAL" ? `Historical evidence through ${longDate(evidence.dataThrough)} (${evidence.ageDays} days before the planning week), mapped onto planning weekdays. Not live demand.` : `Sales through ${longDate(evidence.dataThrough)}.` : "No eligible sales history, so no demand or labour requirement has been assumed."}</p>
    {outlet.totals ? <div className="status-grid forecast-grid" aria-label="Planning week totals">
      <article><span>Required labour</span><strong>{labourHours(outlet.totals.requiredMinutes)}</strong><small>From forecast demand</small></article>
      <article><span>Existing coverage</span><strong>{labourHours(outlet.totals.coverageMinutes)}</strong><small>Regular {labourHours(outlet.totals.regularMinutes)} · allocated casual {labourHours(outlet.totals.allocatedCasualMinutes)}</small></article>
      <article><span>Casual labour gap</span><strong>{labourHours(outlet.totals.casualGapMinutes)}</strong><small>Approx. {outlet.totals.indicativeShifts} shifts to fill · none created</small></article>
    </div> : null}
    <div className="history-scroll" role="region" aria-label="Staffing by planning day" tabIndex={0}><StaffingDayTable outlet={outlet} className="history-table" /></div>
    <p className="method-note"><StaffingMethodNote policy={outlet.policy} /> No AI is used in these figures.</p>
    {outlet.totals?.casualGapMinutes ? <p><Link href="#add-requirement">Plan shifts for the casual labour gap ↓</Link></p> : null}
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
    planHref={(outletId, date) => outletId === scope.locationId ? `/manager/plan${date ? `?date=${date}` : ""}#add-requirement` : null} />;
}
async function Roster(scope:Scope) {
  let schedule;
  try { schedule = await getAllocationSchedule(getDatabase(),scope); }
  catch { return <WorkspaceUnavailable />; }
  return schedule.events.length ? <AllocationScheduler schedule={schedule} /> : <StatePanel title="No shift allocations" />;
}
