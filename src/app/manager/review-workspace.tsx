import { requireScope } from "@/server/auth/request";
import { DEMO_ORGANISATION_ID, DEMO_OUTLET_ID } from "@/server/constants";
import Link from "next/link";
import { StatePanel } from "@/app/components/product-ui";
import { money, PaymentBadge } from "@/app/components/workspace-ui";
import { approveDemoIncentiveAction, recordDemoPerformanceAction, refreshDemoIncentivePayoutAction, submitDemoIncentivePayoutAction } from "@/app/scheduling-actions";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { getLocationWorkspace } from "@/server/product/workspace";
export async function DemoReview() {
 const scope=await requireScope(["OWNER","MANAGER"]);
 if (scope.organisationId !== DEMO_ORGANISATION_ID || scope.locationId !== DEMO_OUTLET_ID) throw new Error("Access denied.");
 const configuration = getConfigurationStatus();
 const { current, assignments, worker } = await getLocationWorkspace(getDatabase());
 const active = assignments.find(row => row.shift.id === current?.shift.id && row.incentive?.workerId === worker?.id);
 const incentive = active?.incentive;
 return <>
      {current?.offer.status === "ACCEPTED" && (!incentive || ["EARNED", "NOT_EARNED"].includes(incentive.status)) ? <section className="panel">
        <h2>Record completed work · {current.shift.shiftDate}</h2><p>Confirm the shift is complete and enter the team result. Results in this environment are manager-recorded, not POS-verified.</p>
        <form action={recordDemoPerformanceAction} className="workspace-form"><input type="hidden" name="shiftId" value={current.shift.id} />
          <label>Completed shift team sales (USD)<input name="performanceSales" type="number" min="0" max="99999999.99" step="0.01" defaultValue={incentive ? (incentive.performanceSalesMinor / 100).toFixed(2) : ""} required /></label>
          <label><input type="checkbox" name="completed" value="yes" required /> I confirm this shift is complete and this is the recorded result.</label><button className="primary-button" type="submit">Save completed shift result</button>
        </form></section> : !incentive ? <StatePanel title="No completed result to review"><p>An accepted shift is required before recording performance.</p></StatePanel> : null}
      {assignments.filter((row) => row.incentive).map((row) => <article className="panel" key={row.shift.id}><h2>{row.shift.shiftDate} · recorded team result</h2><p>{money(row.incentive!.performanceSalesMinor)} recorded against a {money(row.incentive!.targetSalesMinor)} target. Calculated incentive: {money(row.incentive!.earnedAmountMinor)}.</p><p>Source: manager-recorded shift result.</p><PaymentBadge status={row.incentive!.status} /></article>)}
      {incentive ? <Link className="text-link" href="/manager/review">Review incentive payment →</Link> : null}

      <p id="incentive-review" className="method-note">Payments cover the calculated incentive only. Work earnings and gratuity settlement are not tracked by this payment rail. PayPal Sandbox is used in this environment.</p>
      {!incentive ? <StatePanel title="No current incentive to approve"><Link href="/manager/review">Review performance</Link></StatePanel> : <section className="panel">
        <h2>{worker?.displayName ?? "Casual worker"} · {active?.shift.shiftDate}</h2><PaymentBadge status={incentive.status} />
        <dl className="shift-terms"><div><dt>Agreed work earnings</dt><dd>{money(active!.shift.guaranteedBasePayMinor)}</dd></div><div><dt>Calculated incentive</dt><dd>{money(incentive.earnedAmountMinor)}</dd></div><div><dt>Incentive approved for payout</dt><dd>{money(incentive.approvedAt ? incentive.earnedAmountMinor : 0)}</dd></div></dl>
        {incentive.status === "EARNED" ? <form action={approveDemoIncentiveAction}><input type="hidden" name="incentiveId" value={incentive.id} /><button className="primary-button" type="submit">Approve incentive</button></form> : null}
        {incentive.status === "APPROVED" && !incentive.submittedAt ? configuration.paypalPayoutConfigured && worker?.paypalPayoutEmail ? <form action={submitDemoIncentivePayoutAction}><input type="hidden" name="incentiveId" value={incentive.id} /><button className="primary-button" type="submit">Send approved incentive with PayPal</button></form> : <p>{!worker?.paypalPayoutEmail ? "The worker must complete payment settings in their Profile before payment." : "The payment service is unavailable. Contact your platform operator."}</p> : null}
        {incentive.paypalBatchId ? <form action={refreshDemoIncentivePayoutAction}><input type="hidden" name="incentiveId" value={incentive.id} /><button className="secondary-button" type="submit">Check payment status</button></form> : null}
        {incentive.status === "FAILED" ? <p>Payment needs review. This submitted incentive cannot be sent again. Contact your platform operator for reconciliation.</p> : null}
      </section>}
      <section className="panel"><h2>Incentive payment history</h2>{assignments.filter((row) => row.incentive).map((row) => <div className="record-row" key={row.shift.id}><span>{row.shift.shiftDate} · {money(row.incentive!.earnedAmountMinor)}</span><PaymentBadge status={row.incentive!.status} /></div>)}</section>
</>;
}
