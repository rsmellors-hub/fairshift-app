import Link from "next/link";
import { ManagerForecast } from "@/app/components/manager-forecast";
import { PageHeader, StatePanel, StatusBadge } from "@/app/components/product-ui";
import { ActionFeedback, money, PaymentBadge, ShiftTerms, TaskLink, WorkspaceUnavailable } from "@/app/components/workspace-ui";
import { approveDemoIncentiveAction, publishDemoShiftAction, recordDemoPerformanceAction, refreshDemoIncentivePayoutAction, submitDemoIncentivePayoutAction } from "@/app/scheduling-actions";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { getAiOperationalAssessment } from "@/server/integrations/openai/operational-intelligence";
import { getManagerForecast } from "@/server/intelligence/manager";
import { getLocationWorkspace } from "@/server/product/workspace";
import { DEMO_SHIFT_TERMS } from "@/server/scheduling/demo";
import { getAllocationSchedule } from "@/server/scheduling/allocations";
import { AllocationScheduler } from "./allocation-scheduler";

export const managerAreas = ["forecast", "fill-shifts", "allocations", "workers", "performance", "payments"] as const;
export type ManagerArea = "overview" | typeof managerAreas[number];

export async function ManagerWorkspace({ area, status }: { area: ManagerArea; status?: string }) {
  const configuration = getConfigurationStatus();
  if (!configuration.databaseConfigured) return <WorkspaceUnavailable />;
  const db = getDatabase();
  if (area === "allocations") {
    let schedule;
    try { schedule = await getAllocationSchedule(db); } catch { return <WorkspaceUnavailable />; }
    return <>
      <PageHeader eyebrow="Rosebank Kitchen" title="Shift Allocations" description="Review offered shifts, accepted allocations and completed work for your location." />
      {schedule.events.length ? <AllocationScheduler schedule={schedule} /> : <StatePanel title="No shift allocations"><p>No shift offers have been recorded for this location.</p><Link href="/manager/fill-shifts">Fill a shift</Link></StatePanel>}
      <Link className="text-link" href="/manager/performance">Review completed shift performance →</Link>
    </>;
  }
  let data;
  try { data = await getLocationWorkspace(db); } catch { return <WorkspaceUnavailable />; }
  const { current, assignments, worker } = data;
  const active = assignments.find((row) => row.shift.id === current?.shift.id);
  const incentive = active?.incentive;
  const title = { overview: "Location overview", forecast: "Forecast & Staffing", "fill-shifts": "Fill Shifts", allocations: "Shift Allocations", workers: "Worker Pool", performance: "Performance", payments: "Payments & Approvals" }[area];
  if (area === "forecast") {
    let result;
    let aiResult;
    try {
      result = await getManagerForecast(db);
      aiResult = await getAiOperationalAssessment(result);
    } catch { return <ManagerForecast result={null} error="Sales evidence could not be loaded. Please try again shortly." />; }
    return <><ManagerForecast result={result} aiResult={aiResult} /><section className="panel"><h2>Staffing decision</h2><p>{current ? `Current shift: ${current.shift.shiftDate}. Review the published allocation before adding work.` : "Review the recommendation and published terms before sending an offer."}</p><Link className="text-link" href="/manager/fill-shifts">Open Fill Shifts →</Link></section></>;
  }
  return <>
    <PageHeader eyebrow="Rosebank Kitchen" title={title} description={area === "overview" ? "Staffing, work awaiting review and payment exceptions for your location." : undefined} />
    <ActionFeedback status={status} />
    {area === "overview" ? <>
      <section className="overview-strip">
        <div><span>Offers awaiting response</span><strong>{assignments.filter((row) => row.offer.status === "OFFERED").length}</strong></div>
        <div><span>Accepted allocations</span><strong>{assignments.filter((row) => row.offer.status === "ACCEPTED" && row.shift.status === "PUBLISHED").length}</strong></div>
        <div><span>Awaiting approval</span><strong>{assignments.filter((row) => row.incentive?.status === "EARNED").length}</strong></div>
      </section>
      <div className="task-grid">
        <TaskLink href="/manager/forecast" title="Plan staffing">Review demand evidence and staffing recommendations.</TaskLink>
        <TaskLink href={current ? "/manager/allocations" : "/manager/fill-shifts"} title={current ? "Review current shift" : "Fill a shift"}>{current ? `${current.shift.shiftDate} · ${current.offer.status === "ACCEPTED" ? "Offer accepted" : "Awaiting response"}` : "Review terms and send a worker offer."}</TaskLink>
        <TaskLink href="/manager/performance" title="Review performance">Review completed work and record shift results.</TaskLink>
        <TaskLink href="/manager/payments" title="Payments & Approvals">{incentive?.status === "FAILED" ? "A payment needs attention. Duplicate submission remains blocked." : "Review incentives and monitor payment status."}</TaskLink>
      </div>
    </> : null}
    {area === "fill-shifts" ? current ? <section className="panel">
      <StatusBadge>{current.offer.status === "ACCEPTED" ? "Offer accepted" : "Offer sent"}</StatusBadge><h2>{current.shift.roleName}</h2><ShiftTerms shift={current.shift} />
      <p>The current offer has been sent to {current.worker.displayName}.</p><Link className="text-link" href="/manager/allocations">Review responses and allocation →</Link>
    </section> : <section className="panel">
      <h2>Review shift and invite a worker</h2><p>The current environment supports one casual worker and fixed shift terms. Date, capacity and compensation editing are not available.</p>
      <ShiftTerms shift={DEMO_SHIFT_TERMS} />
      <p>One casual place · optional {money(DEMO_SHIFT_TERMS.incentiveAmountMinor)} incentive when the team target of {money(DEMO_SHIFT_TERMS.incentiveTargetMinor)} is met.</p>
      <form action={publishDemoShiftAction} className="workspace-form"><label><input type="checkbox" name="workerSelected" value="yes" required /> Invite {worker?.displayName ?? "Alex Morgan"} · Rosebank Kitchen</label><button className="primary-button" type="submit">Publish shift and send offer</button></form>
    </section> : null}
    {area === "workers" ? <section className="panel"><h2>{worker?.displayName ?? "No worker profile yet"}</h2><p>{worker ? `${worker.status === "ACTIVE" ? "Active" : "Inactive"} casual worker · Rosebank Kitchen environment` : "A worker profile is created when payment details are saved or the first offer is published."}</p><p>Availability and matching preferences have not been collected. No availability or suitability score is inferred.</p><Link className="text-link" href="/manager/fill-shifts">Review shift invitation →</Link></section> : null}
    {area === "performance" ? <>
      {current?.offer.status === "ACCEPTED" && (!incentive || ["EARNED", "NOT_EARNED"].includes(incentive.status)) ? <section className="panel">
        <h2>Record completed work · {current.shift.shiftDate}</h2><p>Confirm the shift is complete and enter the team result. Results in this environment are manager-recorded, not POS-verified.</p>
        <form action={recordDemoPerformanceAction} className="workspace-form"><input type="hidden" name="shiftId" value={current.shift.id} />
          <label>Completed shift team sales (USD)<input name="performanceSales" type="number" min="0" max="99999999.99" step="0.01" defaultValue={incentive ? (incentive.performanceSalesMinor / 100).toFixed(2) : ""} required /></label>
          <label><input type="checkbox" name="completed" value="yes" required /> I confirm this shift is complete and this is the recorded result.</label><button className="primary-button" type="submit">Save completed shift result</button>
        </form></section> : !incentive ? <StatePanel title="No completed result to review"><p>An accepted shift is required before recording performance.</p></StatePanel> : null}
      {assignments.filter((row) => row.incentive).map((row) => <article className="panel" key={row.shift.id}><h2>{row.shift.shiftDate} · recorded team result</h2><p>{money(row.incentive!.performanceSalesMinor)} recorded against a {money(row.incentive!.targetSalesMinor)} target. Calculated incentive: {money(row.incentive!.earnedAmountMinor)}.</p><p>Source: manager-recorded shift result.</p><PaymentBadge status={row.incentive!.status} /></article>)}
      {incentive ? <Link className="text-link" href="/manager/payments">Review incentive payment →</Link> : null}
    </> : null}
    {area === "payments" ? <>
      <p className="method-note">Payments cover the calculated incentive only. Base pay and gratuity settlement are not tracked by this payment rail. PayPal Sandbox is used in this environment.</p>
      {!incentive ? <StatePanel title="No current incentive to approve"><Link href="/manager/performance">Review performance</Link></StatePanel> : <section className="panel">
        <h2>{worker?.displayName ?? "Casual worker"} · {active?.shift.shiftDate}</h2><PaymentBadge status={incentive.status} />
        <dl className="shift-terms"><div><dt>Agreed base pay</dt><dd>{money(active!.shift.guaranteedBasePayMinor)}</dd></div><div><dt>Calculated incentive</dt><dd>{money(incentive.earnedAmountMinor)}</dd></div><div><dt>Incentive approved for payout</dt><dd>{money(incentive.approvedAt ? incentive.earnedAmountMinor : 0)}</dd></div></dl>
        {incentive.status === "EARNED" ? <form action={approveDemoIncentiveAction}><input type="hidden" name="incentiveId" value={incentive.id} /><button className="primary-button" type="submit">Approve incentive</button></form> : null}
        {incentive.status === "APPROVED" && !incentive.submittedAt ? configuration.paypalPayoutConfigured && worker?.paypalPayoutEmail ? <form action={submitDemoIncentivePayoutAction}><input type="hidden" name="incentiveId" value={incentive.id} /><button className="primary-button" type="submit">Send approved incentive with PayPal</button></form> : <p>{!worker?.paypalPayoutEmail ? "The worker must complete payment settings in their Profile before payment." : "The payment service is unavailable. Contact your platform operator."}</p> : null}
        {incentive.paypalBatchId ? <form action={refreshDemoIncentivePayoutAction}><input type="hidden" name="incentiveId" value={incentive.id} /><button className="secondary-button" type="submit">Check payment status</button></form> : null}
        {incentive.status === "FAILED" ? <p>Payment needs review. This submitted incentive cannot be sent again. Contact your platform operator for reconciliation.</p> : null}
      </section>}
      <section className="panel"><h2>Incentive payment history</h2>{assignments.filter((row) => row.incentive).map((row) => <div className="record-row" key={row.shift.id}><span>{row.shift.shiftDate} · {money(row.incentive!.earnedAmountMinor)}</span><PaymentBadge status={row.incentive!.status} /></div>)}</section>
    </> : null}
  </>;
}
