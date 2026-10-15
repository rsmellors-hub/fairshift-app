import { resendInvitationAction, revokeInvitationAction } from "@/app/auth-actions";
import { requireScope } from "@/server/auth/request";
import type { Scope } from "@/server/auth/access";
import { DEMO_ORGANISATION_ID } from "@/server/constants";
import Link from "next/link";
import { PageHeader, StatePanel } from "@/app/components/product-ui";
import { ActionFeedback, ShiftTerms, WorkspaceUnavailable, dateTime } from "@/app/components/workspace-ui";
import { ManagerForecast } from "@/app/components/manager-forecast";
import { createTeamAction, createRequirementAction, offerAssignmentAction, allocateAssignmentAction, confirmWorkAction, changeAssignmentAction } from "@/app/operations-actions";
import { publishDemoShiftAction } from "@/app/scheduling-actions";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { getOperations } from "@/server/scheduling/operations";
import { getAllocationSchedule } from "@/server/scheduling/allocations";
import { getManagerForecast } from "@/server/intelligence/manager";
import { getAiOperationalAssessment } from "@/server/integrations/openai/operational-intelligence";
import { AllocationScheduler } from "./allocation-scheduler";
import { DemoReview } from "./review-workspace";

export const managerAreas = ["plan", "team", "review"] as const;
export type ManagerArea = "overview" | typeof managerAreas[number];

export async function ManagerWorkspace({ area, status, date, department }: { area: ManagerArea; status?: string; date?: string; department?: string }) {
  if (!getConfigurationStatus().databaseConfigured) return <WorkspaceUnavailable />;
  const scope=await requireScope(["OWNER","MANAGER"]);
  let data;
  try { data = await getOperations(getDatabase(),scope); } catch { return <WorkspaceUnavailable />; }
  const { team, departments, policies, requirements, offers, paymentIssues } = data;
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
      <details className="panel"><summary>Demand forecast & staffing recommendation</summary>{await Forecast(scope)}</details>
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
      <details className="panel"><summary>Add a department coverage requirement</summary>{departments.length && policies.length ? <form action={createRequirementAction} className="workspace-form form-grid"><PlanContext date={date} department={department} /><label>Department<select name="departmentId" defaultValue={department}>{departments.map(d => <option value={d.id} key={d.id}>{d.name}</option>)}</select></label><label>Owner-defined work terms<select name="policyId">{policies.map(p => <option key={p.id} value={p.id}>{p.name} · {p.earningsModel.toLowerCase()}</option>)}</select></label><label>Starts · Johannesburg<input name="startsAt" type="datetime-local" required /></label><label>Ends · Johannesburg<input name="endsAt" type="datetime-local" required /></label><label>Required headcount<input name="headcount" type="number" min="1" max="1000" defaultValue="1" required /></label><button className="primary-button">Create requirement</button></form> : <p>Owner/Admin must configure a department and work policy first.</p>}</details>
      {await Roster(scope)}
      {scope.organisationId === DEMO_ORGANISATION_ID ? <details className="panel"><summary>Controlled demo assignment</summary><p>Fixed daily terms and the existing deterministic team incentive. This creates the established demonstration offer for Alex Morgan.</p><form action={publishDemoShiftAction}><label><input name="workerSelected" type="checkbox" value="yes" required /> Invite Alex Morgan</label><button className="secondary-button">Publish demo assignment</button></form></details> : null}
    </> : null}
    {area === "review" ? <>
      <section className="panel"><h2>Confirm work performed</h2>{offers.filter(o => o.allocation?.state === "ALLOCATED").map(o => { const r = requirements.find(r => r.id === o.offer.shiftId)!; return <div className="requirement" key={o.offer.id}><h3>{o.workerName} · {r.shiftDate} · {r.roleName}</h3><ShiftTerms shift={r} locationName={scope.locationName} />{o.allocation?.confirmedAt ? <p>Work confirmed {dateTime(o.allocation.confirmedAt)}. Payment of work earnings is not tracked by the incentive payment rail.</p> : <form action={confirmWorkAction}><input name="offerId" type="hidden" value={o.offer.id} /><label><input name="confirmed" type="checkbox" value="yes" required /> I confirm the scheduled work was performed.</label><button className="primary-button" disabled={r.endsAt > new Date()}>Confirm work</button></form>}{r.earningsModel === "COMMISSION" ? <p>Commission unavailable: verified attributed sales have not been supplied.</p> : null}</div>; })}</section>
      {scope.organisationId === DEMO_ORGANISATION_ID ? await DemoReview() : null}
    </> : null}
  </>;
}
function PlanContext({ date, department }: { date?: string; department?: string }) {
  return <><input type="hidden" name="planDate" value={date ?? ""} /><input type="hidden" name="planDepartment" value={department ?? ""} /></>;
}
async function Forecast(scope:Scope) {
  let result, aiResult;
  try { result = await getManagerForecast(getDatabase(),new Date(),scope); aiResult = await getAiOperationalAssessment(result); }
  catch { return <ManagerForecast result={null} error="Demand evidence is unavailable. Prior requirements remain available." />; }
  return <ManagerForecast result={result} aiResult={aiResult} />;
}
async function Roster(scope:Scope) {
  let schedule;
  try { schedule = await getAllocationSchedule(getDatabase(),scope); }
  catch { return <WorkspaceUnavailable />; }
  return schedule.events.length ? <AllocationScheduler schedule={schedule} /> : <StatePanel title="No shift allocations" />;
}
