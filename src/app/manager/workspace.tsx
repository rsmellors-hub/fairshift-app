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
import { getTicketmasterApiKey } from "@/server/integrations/ticketmaster/events";
import { getDatabase } from "@/server/db/client";
import { getOperations } from "@/server/scheduling/operations";
import { getAllocationSchedule, planningRanges } from "@/server/scheduling/allocations";
import { getWeeklyStaffing, type WeeklyStaffing } from "@/server/intelligence/staffing";
import { isSyntheticSource, localDate } from "@/server/intelligence/forecast";
import { labourHours, longDate, OpportunityList, ServiceDays, StaffingDayTable, StaffingMethodNote, transactions, WhyThisShift, WorkloadSetupNotice, policyDescription, wholeMoney } from "@/app/components/staffing";
import { dayOpportunities, selectOpportunity, windowParam } from "@/server/intelligence/opportunity";
import { getShiftOpportunityEvidence } from "@/server/intelligence/opportunity-shifts";
import { RequirementForm } from "./requirement-form";
import { availabilityForShift, isOfferable, OPPORTUNITY_LABEL, shiftWeekdays, workerOpportunityState, type WorkerOpportunityState } from "@/server/scheduling/worker-pool";
import { ManagerToday } from "./today";
import { EarlierEvidenceLabel } from "@/app/demo/demo-bar";
import { getStaffingAssessmentView } from "@/server/intelligence/ai-staffing";
import { AiStaffingAssessment } from "@/app/components/ai-staffing-assessment";
import { generateLocationAssessmentAction } from "@/app/intelligence-actions";
import { AllocationScheduler } from "./allocation-scheduler";
import { DemoReview } from "./review-workspace";
import { DecisionNote, fillHref, ManagerJourney, WeekCover } from "./plan-week";
import { refreshContextFeedsIfDue } from "@/server/intelligence/demand-context-service";
import { DemandContextPanel, periodLabel, scenarioLabel } from "./demand-context";
import { PayoutProgress, ReviewStages } from "@/app/components/payment-progress";
import { SquareLiveRefresh } from "@/app/components/square-live-refresh";
import { getSquareFreshness, liveSquareConnection } from "@/server/commerce/square-connection";
import { getSquareMappings } from "@/server/commerce/square-mapping";
import { SquarePanel } from "./square-panel";
import { checkWage, termsForWageCheck, wageAllowsOffer, type WageJurisdiction } from "@/server/domain/statutory-wage";
import { WageCheckLine } from "@/app/components/wage-check";

const DAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const INVITATION: Record<string, string> = { CREATED_NOT_SENT: "Prepared · not sent", SENT: "Invited", DELIVERY_FAILED: "Invitation couldn’t be sent", REDEEMED: "Active", REVOKED: "Invitation revoked" };
const CANNOT_OFFER: Partial<Record<WorkerOpportunityState, string>> = { UNAVAILABLE: "Marked this day as unavailable", ALREADY_WORKING: "Has an overlapping accepted shift", AWAITING_ACTIVATION: "Hasn’t activated their account yet", INACTIVE: "No longer active" };
const dayLabel = (date: Date, timeZone: string) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone }).format(date);
const timeRange = (start: Date, end: Date, timeZone: string) => { const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }); return `${time.format(start)}–${time.format(end)}`; };

// What would stop this worker's sales counting or their pay arriving, said before the offer goes out.
function WorkerReadiness({ worker, squareConnected, mapped, hasTarget }: { worker: { id: string; paypalPayoutEmail: string | null }; squareConnected: boolean; mapped: ReadonlySet<string>; hasTarget: boolean }) {
  const notes = [!worker.paypalPayoutEmail ? "No PayPal email yet, so they can’t be paid until they add one" : null, squareConnected && hasTarget && !mapped.has(worker.id) ? "Not mapped to Square, so their sales won’t count towards the target" : null].filter(Boolean);
  return notes.length ? <small className="candidate-note">{notes.join(" · ")}</small> : null;
}

// The economic terms a worker will see, always shown the same way.
function ShiftTermsBar({ shift }: { shift: Parameters<typeof ShiftTerms>[0]["shift"] }) {
  const base = shift.expectedEarningsMinor ?? shift.guaranteedBasePayMinor, amount = (value: number) => money(value, shift.currencyCode);
  if (shift.earningsModel === "COMMISSION") return <dl className="terms-bar"><div><dt>Pay</dt><dd>{(shift.commissionBps ?? 0) / 100}% commission</dd></div></dl>;
  return <dl className="terms-bar">
    <div><dt>Base pay</dt><dd>{amount(base)}<small>{shift.earningsModel === "HOURLY" ? `${amount(shift.rateMinor ?? 0)}/hour` : "Fixed for the shift"}</small></dd></div>
    {shift.incentiveBasis ? <><div><dt>Sales target</dt><dd>{amount(shift.incentiveTargetMinor ?? 0)}</dd></div><div><dt>Bonus</dt><dd>{amount(shift.incentiveAmountMinor)}</dd></div><div className="terms-bar-total"><dt>Up to</dt><dd>{amount(base + shift.incentiveAmountMinor)}</dd></div></> : shift.incentiveAmountMinor > 0 ? <div><dt>Potential incentive</dt><dd>{amount(shift.incentiveAmountMinor)}</dd></div> : null}
  </dl>;
}

// The statutory wage check for a shift, on its own date and stored terms: the rule the server applies to every offer.
function shiftWageCheck(shift: { earningsModel: string; rateMinor: number | null; guaranteedBasePayMinor: number; currencyCode: string; shiftDate: string; startsAt: Date; endsAt: Date }, jurisdiction: WageJurisdiction) {
  const terms = termsForWageCheck({ ...shift, rateMinor: shift.rateMinor ?? (shift.earningsModel === "DAILY" ? shift.guaranteedBasePayMinor : null) }, shift);
  // Unreadable terms are checked as unreadable, never skipped: the same rule the server applies.
  return checkWage({ jurisdiction, date: shift.shiftDate, currencyCode: shift.currencyCode, terms: terms ?? { earningsModel: "HOURLY", rateMinor: -1 } });
}

export const managerAreas = ["plan", "fill", "allocations", "team", "review"] as const;
export type ManagerArea = "overview" | typeof managerAreas[number];

export async function ManagerWorkspace({ area, status, date, window: requestedWindow, department, ai, context, importResult }: { area: ManagerArea; status?: string; date?: string; window?: string; department?: string; ai?: string; context?: string; importResult?: string }) {
  if (!getConfigurationStatus().databaseConfigured) return <WorkspaceUnavailable />;
  const scope=await requireScope(["OWNER","MANAGER"]);
  let data;
  try { data = await getOperations(getDatabase(),scope); } catch { return <WorkspaceUnavailable />; }
  const { team, departments, policies, paymentIssues, payables, availability, timezone, wageJurisdiction: wageReference } = data;
  // A demo reset closes shifts rather than deleting their evidence, so demo views leave them out.
  const requirements = scope.demo ? data.requirements.filter(row => row.status !== "CANCELLED") : data.requirements;
  const offers = scope.demo ? data.offers.filter(row => requirements.some(shift => shift.id === row.offer.shiftId)) : data.offers;
  const visibleRequirements = requirements.filter(r => (!date || r.shiftDate === date) && (!department || r.departmentId === department));
  const coverage = (id: string) => {
    const rows = offers.filter(r => r.offer.shiftId === id);
    return { pending: rows.filter(r => r.offer.status === "OFFERED").length, accepted: rows.filter(r => r.offer.status === "ACCEPTED").length, allocated: rows.filter(r => r.allocation?.state === "ALLOCATED").length };
  };
  // The one calculated week behind both the staffing panel and the Fill Shifts context.
  let staffing: WeeklyStaffing | null = null;
  // Opening the plan brings weather and listed events up to date when they're due. It waits a few
  // seconds at most, a failure changes nothing, and a public demo never reaches a provider.
  if (area === "plan" && !scope.demo) { try { await refreshContextFeedsIfDue(getDatabase(), scope); } catch { console.error("Context feeds could not be checked; planning continues."); } }
  if (area === "plan" || area === "fill" || area === "overview") { try { staffing = await getWeeklyStaffing(getDatabase(),scope,new Date()); } catch { staffing = null; } }
  const planningOutlet = staffing?.outlets.find(row => row.outletId === scope.locationId) ?? null;
  const planningDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
  const gapDay = planningDate ? planningOutlet?.days.find(day => day.planningDate === planningDate) ?? null : null;
  // The window to start from: the one the link named, else the day's largest still open.
  const dayWindows = gapDay && planningOutlet ? dayOpportunities(planningOutlet, gapDay) : [];
  const opportunity = selectOpportunity(dayWindows, requestedWindow);
  const openWindows = dayWindows.filter(row => row.state === "OPEN");
  // Why each shift here was created, read only for the Fill Shifts page.
  let shiftReasons = new Map<string, Awaited<ReturnType<typeof getShiftOpportunityEvidence>> extends Map<string, infer T> ? T : never>();
  if (area === "fill") { try { shiftReasons = await getShiftOpportunityEvidence(getDatabase(), scope, requirements.map(row => row.id)); } catch { shiftReasons = new Map(); } }
  const stated = (workerId: string) => new Map(availability.filter(row => row.workerId === workerId).map(row => [row.isoWeekday, row.state]));
  // The same rule the server enforces when an offer is sent.
  const poolState = (worker: (typeof team)[number]["worker"], shift: (typeof requirements)[number]) => workerOpportunityState({
    active: worker.status === "ACTIVE", activated: !!worker.userId,
    conflict: offers.some(o => o.offer.workerId === worker.id && o.offer.status === "ACCEPTED" && requirements.some(s => s.id === o.offer.shiftId && s.id !== shift.id && ["PUBLISHED", "COMPLETED"].includes(s.status) && s.startsAt < shift.endsAt && s.endsAt > shift.startsAt)),
    availability: availabilityForShift(stated(worker.id), shiftWeekdays(shift, timezone)),
  });
  const now = new Date();
  // Square connection and mappings are read from FairShift's own records, not from Square.
  let squareConnected = false, mappedWorkers = new Set<string>();
  if (area === "team" || area === "fill") { try { squareConnected = !!await liveSquareConnection(getDatabase(), scope); if (squareConnected) mappedWorkers = new Set((await getSquareMappings(getDatabase(), scope)).map(row => row.workerId)); } catch { squareConnected = false; } }
  // Finished-shift evidence for review, loaded once and used by both the sales check and the pay cards.
  let work: Awaited<ReturnType<typeof getLocationPerformance>> | null = null;
  if (area === "review") { try { work = await getLocationPerformance(getDatabase(), scope); } catch { work = null; } }
  return <>
    <PageHeader eyebrow={scope.locationName} title={{ overview: "Today", plan: "Forecast & staffing", fill: "Fill shifts", allocations: "Allocations", team: "Workers", review: "Review & pay" }[area]} description={{ overview: undefined, plan: "Next week’s demand by time of day, what you already have covered, and what’s left to fill.", fill: "Turn a casual requirement into a shift, then offer it to workers at this location.", allocations: "Who is working when. Finalise accepted offers and change shifts here.", team: `The casual workers at ${scope.locationName}.`, review: "Check finished work, approve what was earned, and pay it through PayPal." }[area]} />
    {area === "plan" || area === "fill" || area === "allocations" || area === "review" ? <ManagerJourney current={area} /> : null}
    <ActionFeedback status={status} saved={area === "fill" ? "Saved. Check the shifts below for your next step" : "Changes saved"} />
    {area === "overview" ? <ManagerToday today={localDate(now, timezone)} now={now} timezone={timezone} staffing={planningOutlet} requirements={requirements} offers={offers} payables={payables} paymentIssues={paymentIssues} departments={departments} team={team} /> : null}
    {area === "team" ? <>
      <section className="panel"><h2>Worker pool · {team.length}</h2>{team.length ? <div className="table-frame"><table className="data-table worker-pool-table"><caption className="visually-hidden">Workers at this location</caption><thead><tr><th scope="col">Name</th><th scope="col">Availability</th><th scope="col">Shifts</th><th scope="col">Pay &amp; sales readiness</th><th scope="col">FairShift account</th></tr></thead><tbody>{team.map(({worker, invitation}) => { const days = availability.filter(row => row.workerId === worker.id && row.state === "AVAILABLE").map(row => DAY[row.isoWeekday - 1]); const open = offers.filter(o => o.offer.workerId === worker.id && o.offer.status === "OFFERED").length, booked = offers.filter(o => o.offer.workerId === worker.id && o.allocation?.state === "ALLOCATED" && requirements.find(r => r.id === o.offer.shiftId)!.endsAt > now).length; return <tr key={worker.id}><th scope="row">{worker.displayName}<small>{worker.email ?? worker.telephone ?? ""}</small><small>Sales attribution code {worker.attributionCode}</small></th><td data-label="Availability">{days.length ? days.join(" ") : "No availability set"}</td><td data-label="Shifts">{open || booked ? `${open} awaiting response · ${booked} booked` : "None"}</td><td data-label="Payment details">{worker.paypalPayoutEmail ? "Saved" : "Not added yet"}{squareConnected ? <small>{mappedWorkers.has(worker.id) ? "Mapped to a Square team member" : "Not mapped to Square: sales won’t count"}</small> : null}</td><td data-label="FairShift account">{worker.userId ? "Active" : invitation ? INVITATION[invitation.state] ?? "Invited" : "Existing profile"}{invitation && !["REDEEMED","REVOKED"].includes(invitation.state) ? <div className="button-row"><form action={resendInvitationAction}><input type="hidden" name="invitationId" value={invitation.id}/><button className="secondary-button">Resend invite</button></form><form action={revokeInvitationAction}><input type="hidden" name="invitationId" value={invitation.id}/><button className="secondary-button">Revoke invite</button></form></div>:null}</td></tr>; })}</tbody></table></div> : <StatePanel title="No workers yet"><p>Add the casual workers who fill your gaps. They appear here and can then be offered shifts.</p></StatePanel>}</section>
      <details className="panel disclosure" open={!team.length}><summary>Add a worker</summary><form action={createTeamAction} className="workspace-form form-grid"><label>First name<input name="firstName" maxLength={100} required /></label><label>Surname<input name="surname" maxLength={100} required /></label><label>Telephone number<input type="tel" name="telephone" maxLength={30} required /></label><label>Email address<input type="email" name="email" maxLength={254} required /></label><p className="form-span note">They join {scope.locationName} and receive an invitation by email.</p><button className="primary-button">Create & send FairShift invite</button></form></details>
    </> : null}
    {area === "team" && !scope.demo ? await SquarePanel({ scope, team: team.filter(row => row.worker.status === "ACTIVE").map(row => ({ id: row.worker.id, displayName: row.worker.displayName })) }) : null}
    {area === "plan" ? await Staffing(scope, ai, staffing, planningDate, context) : null}
    {area === "allocations" ? await Roster(scope, timezone) : null}
    {area === "fill" ? <>
      {gapDay ? <section className="panel staffing-handoff" aria-label="Staffing requirement"><h2>{longDate(gapDay.planningDate)}{opportunity ? ` · ${opportunity.windowStart}–${opportunity.windowEnd}` : ""}</h2>
          <p>{opportunity ? <>FairShift identified a casual requirement for {longDate(gapDay.planningDate)}, {opportunity.windowStart}–{opportunity.windowEnd}.</> : requestedWindow ? <>That time no longer has an open casual requirement. Check the figures below.</> : <>FairShift identified no open casual requirement for {longDate(gapDay.planningDate)} from the figures below.</>} You decide what to create. Nothing is created or offered until you do.</p>
          {opportunity ? <ol className="demand-flow demand-flow-compact" aria-label="Why this time needs cover">
            <li><span>Expected transactions</span><strong>{opportunity.expectedTransactions}</strong><small>Range {opportunity.lowerTransactions}–{opportunity.upperTransactions}{opportunity.support ? ` · ${opportunity.support === "MODERATE" ? "moderate" : "low"} support` : ""}</small></li>
            <li><span>Required staff capacity</span><strong>{labourHours(opportunity.requiredMinutes)}</strong></li>
            <li><span>Regular coverage</span><strong>{labourHours(opportunity.regularMinutes)}</strong></li>
            <li><span>Allocated casual</span><strong>{labourHours(opportunity.allocatedCasualMinutes)}</strong></li>
            <li className="demand-flow-gap"><span>Casual requirement</span><strong>{labourHours(opportunity.remainingCasualMinutes)}</strong><small>Up to {opportunity.peakCasualStaff} {opportunity.peakCasualStaff === 1 ? "person" : "people"} at once</small></li>
          </ol> : <ol className="demand-flow demand-flow-compact" aria-label="This day's figures">
            <li><span>Expected transactions</span><strong>{transactions(gapDay.expectedMilliTransactions)}</strong></li>
            <li><span>Required staff capacity</span><strong>{gapDay.requiredMinutes === null ? "Unavailable" : labourHours(gapDay.requiredMinutes)}</strong></li>
            <li><span>Regular coverage</span><strong>{gapDay.regularMinutes === null ? "Not set" : labourHours(gapDay.regularMinutes)}</strong></li>
            <li className="demand-flow-gap"><span>Casual requirement</span><strong>{gapDay.casualGapMinutes === null ? "Unavailable" : labourHours(gapDay.casualGapMinutes)}</strong></li>
          </ol>}
          {openWindows.length > 1 ? <p className="opportunity-switch">Other times this day: {openWindows.filter(row => row !== opportunity).map(row => <Link key={row.windowStart} className="text-link" href={fillHref(row.localDate, windowParam(row))}>{row.windowStart}–{row.windowEnd} · {labourHours(row.remainingCasualMinutes)}</Link>)}</p> : null}
          <p className="note">{opportunity?.commercial ? `Expected sales in this time ${wholeMoney(opportunity.commercial.expectedSalesMinor, opportunity.commercial.currency)}: commercial context only, it doesn’t set staffing. ` : ""}{gapDay.context ? `Includes the accepted scenario ${scenarioLabel(gapDay.context.scenario, gapDay.context.adjustmentBps)} for ${periodLabel(gapDay.context.period)}: this day’s expected transactions are ${transactions(gapDay.expectedMilliTransactions)}, against ${transactions(gapDay.context.baseline.expectedMilliTransactions)} on the baseline. ` : ""}{planningOutlet?.policy ? `Calculated with ${policyDescription(planningOutlet.policy)}. ` : ""}{planningOutlet?.evidence ? `Sales evidence through ${longDate(planningOutlet.evidence.dataThrough)}.` : ""}</p></section> : null}
      <details className="panel disclosure create-shift" id="add-requirement" open={(!!date && !visibleRequirements.length) || !requirements.length}><summary>Create a shift</summary>

        {departments.length && policies.length ? <RequirementForm action={createRequirementAction} departments={departments.map(d => ({ id: d.id, name: d.name }))} policies={policies.map(p => ({ id: p.id, name: p.name, earningsModel: p.earningsModel, rateMinor: p.rateMinor, commissionBps: p.commissionBps, currencyCode: p.currencyCode, incentiveTargetMinor: p.incentiveTargetMinor, incentiveBonusMinor: p.incentiveBonusMinor }))} timeZone={timezone} locationName={scope.locationName} wageJurisdiction={wageReference}
          defaults={{ departmentId: department, startsAt: planningDate ? `${planningDate}T${opportunity?.windowStart ?? "09:00"}` : "", endsAt: planningDate ? `${planningDate}T${opportunity?.windowEnd ?? "17:00"}` : "", headcount: opportunity?.peakCasualStaff || 1 }}
          context={<><PlanContext date={date} department={department} />{opportunity ? <><input type="hidden" name="planWindow" value={windowParam(opportunity)} /><input type="hidden" name="opportunityDate" value={opportunity.localDate} /><input type="hidden" name="opportunityWindow" value={windowParam(opportunity)} /></> : null}</>} /> : <StatePanel title="Pay terms are needed first" tone="warning"><p>The business owner must configure a department and work policy for this location before a shift can be created.</p></StatePanel>}</details>
      <section className="panel" id="work-opportunities"><div className="panel-head"><h2>Work to fill</h2><Link className="text-link" href="/manager/allocations">See the schedule <span aria-hidden="true">→</span></Link></div><p className="panel-lede">Times shown at this location ({timezone}).</p>
      <form method="get" action="/manager/fill" className="filter-row"><label>Trading day<input type="date" name="date" defaultValue={date} /></label><label>Department<select name="department" defaultValue={department ?? ""}><option value="">All departments</option>{departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label><button className="secondary-button">Apply</button>{date || department ? <Link className="text-link" href="/manager/fill">All dates</Link> : null}</form>
        {visibleRequirements.length ? visibleRequirements.sort((a,b) => a.startsAt.getTime() - b.startsAt.getTime()).map(r => {
          const c = coverage(r.id);
          const rows = offers.filter(o => o.offer.shiftId === r.id);
          const pool = team.filter(({worker}) => !rows.some(o => o.offer.workerId === worker.id)).map(({worker}) => ({ worker, state: poolState(worker, r) }));
          const hasCapacity = c.pending + c.accepted < r.requiredHeadcount;
          const wage = shiftWageCheck(r, wageReference), payAllowed = wageAllowsOffer(wage);
          return <article id={`requirement-${r.id}`} className="shift-card" key={r.id}>
          <header><div><h3>{dayLabel(r.startsAt, timezone)} · {timeRange(r.startsAt, r.endsAt, timezone)}</h3><p>{departments.find(d => d.id === r.departmentId)?.name ?? r.roleName} · {scope.locationName} · {scheduledHours(r.startsAt, r.endsAt)}</p></div><p className="shift-count"><strong>{Math.max(0,r.requiredHeadcount-c.allocated)} still to fill</strong><small>{r.requiredHeadcount} needed · {c.allocated} allocated · {c.accepted} accepted · {c.pending} awaiting response</small></p></header>
          <ShiftTermsBar shift={r} />
          {r.status === "PUBLISHED" ? <WageCheckLine check={wage} compact /> : null}
          {shiftReasons.get(r.id) ? <WhyThisShift evidence={shiftReasons.get(r.id)!} /> : null}
          {rows.length ? <><h4>Responses</h4>{rows.map(o => <div className="record-row" key={o.offer.id}><span>{o.workerName} · {responseLabel(o)}</span>{o.offer.status === "ACCEPTED" && o.allocation?.state !== "ALLOCATED" ? <form action={allocateAssignmentAction} data-demo-write=""><PlanContext date={date} department={department} /><input name="offerId" type="hidden" value={o.offer.id} /><button className="primary-button">Finalise allocation</button></form> : null}</div>)}</> : null}
          {r.status === "PUBLISHED" ? <><h4>Worker pool · {scope.locationName}</h4>{pool.length ? <ul className="candidate-list">{pool.map(({worker, state}) => <li key={worker.id}><span><strong>{worker.displayName}</strong><StatusBadge tone={state === "AVAILABLE" ? "success" : isOfferable(state) ? "neutral" : "warning"}>{OPPORTUNITY_LABEL[state]}</StatusBadge></span>{isOfferable(state) && !payAllowed ? <small>{wage.status === "BELOW_DEMO_MINIMUM" ? "Pay is below the FairShift demo minimum, so this shift can’t be offered" : "Pay can’t be checked against the demo minimum, so this shift can’t be offered"}</small> : isOfferable(state) ? hasCapacity ? <form action={offerAssignmentAction} data-demo-write=""><PlanContext date={date} department={department} /><input type="hidden" name="shiftId" value={r.id} /><input type="hidden" name="workerId" value={worker.id} /><button className="secondary-button">Send offer<span className="visually-hidden"> to {worker.displayName}</span></button></form> : <small>All places are offered</small> : <small>{CANNOT_OFFER[state]}</small>}{isOfferable(state) ? <WorkerReadiness worker={worker} squareConnected={squareConnected} mapped={mappedWorkers} hasTarget={!!r.incentiveBasis} /> : null}</li>)}</ul> : <p>{team.length ? "Everyone at this location already has an offer for this work." : "No workers at this location yet. Add them under Workers."}</p>}<p className="note">Only workers at this location appear. Availability is what each worker has told FairShift. You choose who gets an offer.</p></> : null}
          {r.status === "PUBLISHED" ? <details className="disclosure-inline"><summary>Change scheduled work</summary><form action={changeAssignmentAction} className="workspace-form" data-demo-write=""><PlanContext date={date} department={department}/><input name="shiftId" type="hidden" value={r.id}/><label>New start · {timezone}<input name="startsAt" type="datetime-local" required/></label><label>New end · {timezone}<input name="endsAt" type="datetime-local" required/></label><p className="note">Workers who have accepted must accept the new terms. Reviewed work is locked.</p><button className="secondary-button">Update schedule</button></form><form action={changeAssignmentAction} className="workspace-form" data-demo-write=""><input name="shiftId" type="hidden" value={r.id}/><input name="cancel" type="hidden" value="yes"/><label className="acceptance-check"><input type="checkbox" required/> Confirm cancellation</label><button className="secondary-button">Cancel assignment</button></form><details className="disclosure-inline"><summary>Full terms · version {r.termsVersion}</summary><ShiftTerms shift={r} locationName={scope.locationName} timeZone={timezone} /></details></details>:null}
          </article>;
        }) : <StatePanel title="No work opportunities yet"><p>Create one above when you are ready to fill a gap, or start from a day on <Link href="/manager/plan">Forecast &amp; staffing</Link>.</p></StatePanel>}
      </section>
      {scope.organisationId === DEMO_ORGANISATION_ID ? <details className="panel"><summary>Controlled demo assignment</summary><p>Fixed daily terms and the existing deterministic team incentive. This creates the established demonstration offer for Alex Morgan.</p><form action={publishDemoShiftAction}><label><input name="workerSelected" type="checkbox" value="yes" required /> Invite Alex Morgan</label><button className="secondary-button">Publish demo assignment</button></form></details> : null}
    </> : null}
    {area === "review" ? <>
      <ReviewStages stages={[
        { label: "Work confirmed", waiting: offers.filter(o => o.allocation?.state === "ALLOCATED" && !o.allocation.confirmedAt && requirements.find(s => s.id === o.offer.shiftId)!.endsAt <= new Date()).length, href: "#confirm-work" },
        { label: "Sales checked", waiting: payables.filter(p => p.payable.status === "PENDING_REVIEW" && p.payable.incentiveRequired && p.payable.incentiveAmountMinor === null).length, href: "#performance" },
        { label: "Approve", waiting: payables.filter(p => p.payable.status === "PENDING_REVIEW" && !(p.payable.incentiveRequired && p.payable.incentiveAmountMinor === null)).length, href: "#base-payables" },
        { label: "Pay with PayPal", waiting: payables.filter(p => p.payable.status === "APPROVED" && (!p.payout || p.payout.status === "NOT_SENT")).length, href: "#base-payables" },
      ]} />
      {(() => { const allocated = offers.filter(o => o.allocation?.state === "ALLOCATED"); const isOver = (o: (typeof offers)[number]) => requirements.find(r => r.id === o.offer.shiftId)!.endsAt <= now; const waiting = allocated.filter(o => !o.allocation?.confirmedAt && isOver(o)), upcoming = allocated.filter(o => !o.allocation?.confirmedAt && !isOver(o)), done = allocated.filter(o => o.allocation?.confirmedAt);
        const item = (o: (typeof offers)[number]) => { const r = requirements.find(r => r.id === o.offer.shiftId)!; const payable = payables.find(p => p.payable.allocationId === o.allocation!.id)?.payable; return <div className="requirement" key={o.offer.id}><h3>{o.workerName} · {dayLabel(r.startsAt, timezone)} · {timeRange(r.startsAt, r.endsAt, timezone)}</h3><ShiftTermsBar shift={r} />{o.allocation?.confirmedAt ? <>
        <p>Work confirmed {dateTime(o.allocation.confirmedAt, timezone)} ({timezone}) as scheduled.</p>
        {payable ? <p>Base payable {money(payable.baseAmountMinor, payable.currencyCode)} from the accepted terms · {payable.incentiveRequired && payable.incentiveAmountMinor === null ? <a href="#performance">Sales results needed</a> : <a href="#base-payables">{payableLabel(payable.status, payables.find(p => p.payable.id === payable.id)?.payout)}</a>}</p>
          : r.earningsModel === "COMMISSION" ? <p>Commission is not payable: verified attributed sales are required.</p>
          : <form action={confirmWorkAction}><input name="offerId" type="hidden" value={o.offer.id} /><input name="confirmed" type="hidden" value="yes" /><p>The base payable for this confirmed work has not been recorded.</p><button className="secondary-button">Calculate base payable</button></form>}
      </> : <form action={confirmWorkAction} className="workspace-form"><input name="offerId" type="hidden" value={o.offer.id} /><label className="acceptance-check"><input name="confirmed" type="checkbox" value="yes" required /> I confirm the scheduled work was performed.</label><button className="primary-button" disabled={r.endsAt > now}>Confirm work</button>{r.endsAt > now ? <small>Available after the scheduled end.</small> : null}</form>}</div>; };
        return <section className="panel" id="confirm-work"><h2>Confirm work performed</h2>{waiting.length ? waiting.map(item) : <p className="note">No finished work is waiting to be confirmed.</p>}{upcoming.length ? <details className="disclosure-inline"><summary>Not finished yet · {upcoming.length}</summary>{upcoming.map(item)}</details> : null}{done.length ? <details className="disclosure-inline"><summary>Already confirmed · {done.length}</summary>{done.map(item)}</details> : null}</section>; })()}
      {await PerformanceReview(scope, payables, timezone, work, importResult)}
      <section className="panel" id="base-payables" aria-labelledby="base-payables-title"><h2 id="base-payables-title">Payments &amp; approvals</h2>
        {payables.length ? <>
          <div className="overview-strip">
            <div><span>Awaiting approval</span><strong>{currencyTotals(payables.filter(p => p.payable.status === "PENDING_REVIEW").map(p => ({ amountMinor: finalPayableMinor(p.payable), currencyCode: p.payable.currencyCode }))) || "None"}</strong></div>
            <div><span>Approved · not yet paid</span><strong>{currencyTotals(payables.filter(p => p.payable.status === "APPROVED" && p.payout?.status !== "PAID").map(p => ({ amountMinor: p.payable.approvedAmountMinor ?? 0, currencyCode: p.payable.approvedCurrencyCode ?? p.payable.currencyCode }))) || "None"}</strong></div>
            <div><span>Paid · confirmed by PayPal</span><strong>{currencyTotals(payables.filter(p => p.payout?.status === "PAID").map(p => ({ amountMinor: p.payout!.amountMinor, currencyCode: p.payout!.currencyCode }))) || "None"}</strong></div>
          </div>
          <div className="pay-cards">{payables.map(({ payable, payout, workerName, shiftDate, roleName, paymentDetailsSaved }) => { const evidence = work?.find(item => item.allocationId === payable.allocationId); const unknown = payable.incentiveRequired && payable.incentiveAmountMinor === null; const amount = (value: number) => money(value, payable.currencyCode); const salesMinor = evidence?.result?.salesMinor ?? evidence?.attributed.minor ?? null, salesCount = evidence?.result?.salesCount ?? evidence?.attributed.count ?? 0; return <article className="pay-card" key={payable.id}>
            {scope.demo ? <EarlierEvidenceLabel /> : null}
            <header><div><h3>{workerName}</h3><p>{longDate(shiftDate)} · {roleName}</p></div><PayableBadge status={payable.status} payout={payout} /></header>
            <dl className="pay-sum">
              <div><dt>Accepted terms<small>{payableBasis(payable)} · version {payable.termsVersion}</small></dt><dd>{amount(payable.baseAmountMinor)}</dd></div>
              {payable.incentiveRequired ? <>
                <div className="pay-sum-evidence"><dt>Attributed sales<small>{evidence?.result ? `${salesCount} ${salesCount === 1 ? "sale" : "sales"} · ${evidence.result.evidenceProvenance === "SQUARE_TEAM_MEMBER" ? "Square Sandbox attributed sales" : "Imported · not provider-verified"}` : "Not confirmed yet"}</small></dt><dd>{salesMinor === null || (!evidence?.result && salesCount === 0) ? "Not known yet" : amount(salesMinor)}</dd></div>
                {evidence ? <div className="pay-sum-evidence"><dt>Target</dt><dd>{amount(evidence.terms.targetMinor)}</dd></div> : null}
                <div><dt>Bonus{evidence && !unknown ? <small>{payable.incentiveAmountMinor! > 0 ? "Target reached" : "Target not reached"}</small> : null}</dt><dd>{unknown ? "Not known yet" : amount(payable.incentiveAmountMinor!)}</dd></div>
              </> : null}
              <div className="pay-sum-total"><dt>Total payable{payable.incentiveRequired && !unknown ? <small>{amount(payable.baseAmountMinor)} base + {amount(payable.incentiveAmountMinor!)} bonus</small> : null}</dt><dd>{unknown ? "Total not known yet" : `Total ${money(finalPayableMinor(payable), payable.currencyCode)}`.replace("Total ", "")}</dd></div>
            </dl>
            {unknown ? <p className="note">{amount(finalPayableMinor(payable))} base only · bonus not known yet</p> : null}
            {payable.approvedAt ? <p className="note">Approved {dateTime(payable.approvedAt, timezone)} ({timezone})</p> : null}
            <PayoutProgress status={payable.status} payout={payout} />
            <div className="pay-card-action"><PayableAction demo={!!scope.demo} payable={payable} payout={payout} paymentDetailsSaved={paymentDetailsSaved} payoutsConfigured={getConfigurationStatus().paypalPayoutConfigured} timezone={timezone} /></div>
          </article>; })}</div>
          <p className="note">FairShift calculates each total from the terms the worker accepted, for work confirmed as scheduled, plus any bonus earned under those terms. No timesheet or overtime is applied, and amounts can’t be edited. Approving doesn’t send money: you send the approved amount to PayPal as a separate step (PayPal Sandbox in this environment). A payment shows as Paid only after PayPal reports it as successful.</p>
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
async function PerformanceReview(scope: Scope, payables: Awaited<ReturnType<typeof getOperations>>["payables"], timezone: string, work: Awaited<ReturnType<typeof getLocationPerformance>> | null, importResult?: string) {
  let freshness: Awaited<ReturnType<typeof getSquareFreshness>> = null;
  try { freshness = await getSquareFreshness(getDatabase(), scope); } catch { work = null; }
  if (!work) { return <StatePanel title="Sales results are unavailable" tone="warning"><p>Please try again shortly. Nothing has been calculated as zero.</p></StatePanel>; }
  const hasPayable = (item: (typeof work)[number]) => payables.some(row => row.payable.allocationId === item.allocationId);
  // Sales are checked after the work is confirmed, so an unconfirmed shift waits in a disclosure.
  const open = work.filter(item => !item.result && hasPayable(item)), notYet = work.filter(item => !item.result && !hasPayable(item)), settled = work.filter(item => item.result);
  const card = (item: (typeof work)[number]) => {
      const payable = payables.find(row => row.payable.allocationId === item.allocationId)?.payable, currency = item.terms.currencyCode, amount = (value: number) => money(value, currency);
      const square = item.result ? item.result.evidenceProvenance === "SQUARE_TEAM_MEMBER" : item.evidence === "SQUARE";
      const none = square ? "None attributed yet" : "None imported yet";
      const count = item.result?.salesCount ?? item.attributed.count, value = item.result?.salesMinor ?? item.attributed.minor, base = payable?.baseAmountMinor;
      return <article className="requirement" key={item.allocationId}><h3>{item.workerName} · {longDate(item.shiftDate)} · {item.roleName}</h3>
        <p><StatusBadge tone="fact">{square ? "Square Sandbox attributed sales" : !item.result && item.evidence === "MIXED" ? "Square Sandbox and imported sales" : "Imported · not provider-verified"}</StatusBadge> {item.result ? <strong>Confirmed for payment</strong> : <strong>Not complete yet</strong>}</p>
        <dl className="shift-terms">
          <div><dt>Attributed sales</dt><dd>{count === 0 && !item.result ? none : count}</dd></div>
          <div><dt>Attributed sales value</dt><dd>{count === 0 && !item.result ? "Not known yet" : amount(value)}</dd></div>
          <div><dt>Target · accepted</dt><dd>{amount(item.terms.targetMinor)}</dd></div>
          <div><dt>Fixed bonus · accepted</dt><dd>{amount(item.terms.bonusMinor)}</dd></div>
          <div><dt>Accepted base earnings</dt><dd>{base === undefined ? "After work is confirmed" : amount(base)}</dd></div>
          <div><dt>Bonus earned</dt><dd>{item.result ? `${amount(item.result.earnedMinor)} · target ${item.result.earnedMinor > 0 ? "reached" : "not reached"}` : "Not known yet"}</dd></div>
          <div><dt>Final payable</dt><dd>{payable && item.result ? amount(finalPayableMinor(payable)) : "Not known yet"}</dd></div>
        </dl>
        {item.result ? null : payable ? <form action={confirmPerformanceAction} className="workspace-form"><input type="hidden" name="allocationId" value={item.allocationId} /><input type="hidden" name="seenCount" value={item.attributed.count} /><input type="hidden" name="seenMinor" value={item.attributed.minor} />
          <label className="acceptance-check"><input type="checkbox" name="complete" value="yes" required /> {count === 0 ? "I’ve checked: this worker made no attributed sales on this shift." : "I’ve checked: these sales are complete for this shift."}</label>
          <button className="primary-button">Confirm sales results</button></form>
          : <p><small>Confirm the work above before its sales results. Allocated {dateTime(item.startsAt, timezone)}.</small></p>}
      </article>; };
  return <section className="panel" id="performance" aria-labelledby="performance-title"><h2 id="performance-title">Sales check · attributed sales</h2>
    {freshness ? <>
      <p className="note">Sales come from Square Sandbox payments carrying the team-member identity mapped to a worker, within their accepted shift at this location. This doesn’t show who was logged in to a till. Refunds are recorded but don’t change the result. The bonus is calculated from the accepted terms and can’t be edited.</p>
      {work.some(item => !item.result) && !scope.demo ? <SquareLiveRefresh timeZone={timezone} initial={{ revision: freshness.revision, failed: freshness.attention || freshness.lastFailed, lastCheckedAt: freshness.lastSuccessAt?.toISOString() ?? null }} /> : null}
    </> : <p className="note">Sales are imported, matched to a worker by attribution code within their accepted shift at this location, and marked “Imported · not provider-verified”. Confirming them for payment doesn’t change that. The bonus is calculated from the accepted terms and can’t be edited.</p>}
    <ImportOutcome value={importResult} />
    {!work.length ? <StatePanel title="No incentive shifts yet"><p>Allocated work with a sales target appears here.</p></StatePanel> : open.length ? open.map(card) : <p className="note">No sales results are waiting to be checked.</p>}
    {notYet.length ? <details className="disclosure-inline"><summary>Waiting for the work to be confirmed · {notYet.length}</summary>{notYet.map(card)}</details> : null}
    {settled.length ? <details className="disclosure-inline"><summary>Already confirmed · {settled.length}</summary>{settled.map(card)}</details> : null}
    {freshness ? null : <details><summary>Import attributed sales</summary>
      <form action={importAttributedSalesAction} className="workspace-form">
        <label>Paste rows from your sales export<textarea name="rows" rows={6} required spellCheck={false} placeholder="transaction_id,attribution_code,occurred_at,amount,currency" /></label>
        <p className="note">Columns: transaction_id, attribution_code, occurred_at (with a time zone offset, such as 2026-11-03T11:15:00+00:00), amount (such as 25.00), currency. Importing the same rows again doesn’t count them twice. Don’t include customer or product details.</p>
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
function PayableAction({ demo = false, payable, payout, paymentDetailsSaved, payoutsConfigured, timezone }: Pick<ManagerPayables[number], "payable" | "payout" | "paymentDetailsSaved"> & { demo?: boolean; payoutsConfigured: boolean; timezone: string }) {
  // The public demo never reaches PayPal. It says so, and shows no action that would try.
  if (demo && !payout) return <p className="note">Approving and paying are turned off in the public demo, so nothing here can reach PayPal.</p>;
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
    <details><summary>PayPal Sandbox reference</summary><dl className="shift-terms payout-reference">
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
async function Staffing(scope:Scope, aiNotice: string | undefined, staffing: WeeklyStaffing | null, contextDate: string | null, contextNotice?: string) {
  if (!staffing) return <StatePanel title="Staffing unavailable" tone="warning"><p>Forecast or coverage could not be loaded, so no labour gap is shown. Existing requirements remain available below.</p></StatePanel>;
  const outlet = staffing.outlets.find(row => row.outletId === scope.locationId);
  if (!outlet) return <StatePanel title="Staffing unavailable" tone="warning"><p>This location is not available for planning.</p></StatePanel>;
  const evidence = outlet.evidence;
  return <div className="staffing-week">
    <section className="panel" aria-labelledby="week-cover-title">
    <p className="provenance-line">{evidence ? <DataLabel kind={isSyntheticSource(evidence.source) ? "demo" : "fact"}>{evidence.source === "REFERENCE" ? "Reference sales history · synthetic" : evidence.source === "DEMO_SEEDED" ? "Demo / seeded history" : evidence.source === "IMPORTED" ? "Imported sales history · not provider-verified" : evidence.source === "SQUARE" ? "Square Sandbox sales · connected seller" : evidence.source === "ZETTLE" ? "Earlier connected-account sales" : "Verified PayPal Sandbox sales"}</DataLabel> : null}<span>Planning week {longDate(outlet.days[0].planningDate)} – {longDate(outlet.days[6].planningDate)} · {outlet.timezone}</span></p>
    <p className="note">{evidence ? evidence.kind === "HISTORICAL" ? `Historical evidence through ${longDate(evidence.dataThrough)} (${evidence.ageDays} days before the planning week), mapped onto planning weekdays. Not live demand.` : `Sales through ${longDate(evidence.dataThrough)}.` : "No eligible sales history, so no demand or labour requirement has been assumed."}</p>
    <WorkloadSetupNotice outlets={[outlet]} owner={scope.role === "OWNER"} />
    <WeekCover outlet={outlet} />
    </section>
    <OpportunityList outlet={outlet} act />
    <DemandContextPanel outlet={outlet} selectedDate={contextDate} notice={contextNotice} aiConfigured={getConfigurationStatus().aiConfigured} eventsConfigured={!!getTicketmasterApiKey()} />
    {outlet.baselineTotals ? <p className="note context-week-note" role="status">This week includes {outlet.days.filter(day => day.context).length === 1 ? "one accepted scenario" : `${outlet.days.filter(day => day.context).length} accepted scenarios`}. Casual requirement {labourHours(outlet.totals?.casualGapMinutes ?? 0)}, against {labourHours(outlet.baselineTotals.casualGapMinutes)} on the baseline.</p> : null}
    {outlet.totals ? <div className="metric-strip" aria-label="Planning week totals">
      <article><span>Expected transactions</span><strong>{transactions(outlet.totals.expectedMilliTransactions)}</strong><small>Sets the staff capacity needed</small></article>
      <article><span>Expected sales</span><strong>{outlet.commercial?.forecast && outlet.currency ? wholeMoney(outlet.commercial.forecast.totalMinor, outlet.currency) : "Not available"}</strong><small>{outlet.commercial?.comparable && outlet.currency ? `Comparable days ${wholeMoney(outlet.commercial.comparable.salesMinor, outlet.currency)} · ` : ""}commercial context</small></article>
      <article><span>Required staff capacity</span><strong>{labourHours(outlet.totals.requiredMinutes)}</strong><small>From expected transactions</small></article>
      <article><span>Existing coverage</span><strong>{labourHours(outlet.totals.coverageMinutes)}</strong><small>Regular {labourHours(outlet.totals.regularMinutes)} · allocated casual {labourHours(outlet.totals.allocatedCasualMinutes)}</small></article>
      <article className="metric-gap"><span>Casual requirement</span><strong>{labourHours(outlet.totals.casualGapMinutes)}</strong><small>Approx. {outlet.totals.indicativeShifts} {outlet.totals.indicativeShifts === 1 ? "shift" : "shifts"} to fill · none created</small></article>
      <article><span>Estimated cost to fill</span><strong>{outlet.commercial?.cost && outlet.currency ? outlet.commercial.cost.lowMinor === outlet.commercial.cost.highMinor ? wholeMoney(outlet.commercial.cost.lowMinor, outlet.currency) : `${wholeMoney(outlet.commercial.cost.lowMinor, outlet.currency)} – ${wholeMoney(outlet.commercial.cost.highMinor, outlet.currency)}` : "Not available"}</strong><small>{outlet.commercial?.cost ? "Estimate on this location’s work policies" : "Needs a work policy in this currency"}</small></article>
    </div> : null}
    <section className="panel" aria-labelledby="service-days-title"><h2 id="service-days-title">By time of day</h2><p className="panel-lede">Open a day to see when it’s covered and when it isn’t.</p><ServiceDays outlet={outlet} act /></section>
    <section className="panel ai-section"><h2 className="visually-hidden">AI priorities</h2><DecisionNote />{await LocationAssessment(scope, staffing, aiNotice)}</section>
    <details className="panel disclosure"><summary>Day-by-day figures</summary>
    <div className="table-scroll" role="region" aria-label="Staffing by planning day" tabIndex={0}><StaffingDayTable outlet={outlet} className="data-table" planHref={fillHref} /></div>
    <p className="note"><StaffingMethodNote policy={outlet.policy} /> No AI is used in these figures.</p>
    </details>
  </div>;
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
  // The Plan page's own staffing week, drawn on the timeline. If it can't be read the schedule
  // still works and says so; no forecast need is shown rather than an invented one.
  let planning: ReturnType<typeof planningRanges> = { ranges: [], summary: null }, planningFailed = false;
  try { planning = planningRanges((await getWeeklyStaffing(getDatabase(), scope, new Date())).outlets.find(row => row.outletId === scope.locationId) ?? null); }
  catch { planningFailed = true; }
  let schedule;
  try { schedule = await getAllocationSchedule(getDatabase(),scope,new Date(),planning.ranges); }
  catch { return <WorkspaceUnavailable />; }
  if (scope.demo) { const shown = schedule.events.filter(event => event.state !== "Cancelled"); schedule = { ...schedule, events: shown, assignments: schedule.assignments.filter(row => shown.some(event => event.id === row.eventId)) }; }
  const unavailable = planningFailed ? <StatePanel title="Forecast need unavailable" tone="warning"><p>The forecast or cover couldn’t be loaded, so no casual need is shown. Shifts and offers below are unaffected.</p></StatePanel> : null;
  return schedule.events.length || planning.summary ? <>{unavailable}<AllocationScheduler schedule={schedule} timeZone={timeZone} planning={planning.summary} dragToOffer={!scope.demo} /></> : <>{unavailable}<StatePanel title="No shift allocations yet"><p>Create a shift and send offers on <Link href="/manager/fill">Fill shifts</Link>. It appears on this schedule straight away.</p></StatePanel></>;
}
