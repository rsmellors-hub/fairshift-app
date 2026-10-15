import { ManagerForecast } from "@/app/components/manager-forecast";
import { publishDemoShiftAction, startNewDemoCycleAction } from "@/app/scheduling-actions";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { getAiOperationalAssessment } from "@/server/integrations/openai/operational-intelligence";
import { getManagerForecast } from "@/server/intelligence/manager";
import { getDemoWorkerShift } from "@/server/scheduling/demo";
import { getDemoIncentive } from "@/server/incentives/demo";
import {
  approveDemoIncentiveAction,
  recordDemoPerformanceAction,
  refreshDemoIncentivePayoutAction,
  submitDemoIncentivePayoutAction,
} from "@/app/scheduling-actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function money(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value / 100);
}

export default async function ManagerPage() {
  if (!getConfigurationStatus().databaseConfigured) {
    return (
      <div className="product-page">
        <ManagerForecast
          result={null}
          aiResult={null}
          error="Commercial history is unavailable until the workspace data connection is configured."
        />
      </div>
    );
  }

  let result;
  try {
    result = await getManagerForecast(getDatabase());
  } catch {
    return (
      <div className="product-page">
        <ManagerForecast
          result={null}
          aiResult={null}
          error="Commercial history could not be loaded or validated. Try again after checking the workspace data connection."
        />
      </div>
    );
  }

  const aiResult = await getAiOperationalAssessment(result);
  const db = getDatabase();
  const assignment = await getDemoWorkerShift(db);
  const incentive = assignment ? await getDemoIncentive(db, assignment.shift.id) : null;
  const payoutConfigured = getConfigurationStatus().paypalPayoutConfigured;

  return (
    <div className="product-page">
      <ManagerForecast result={result} aiResult={aiResult} />

      {result.status === "AVAILABLE" ? (
        <section className="manager-schedule-cta">
          <div>
            <span className="eyebrow">Manager decision</span>
            <h2>Turn the staffing recommendation into a worker shift</h2>
            <p>
              The deterministic baseline recommends {result.staffing.workers} workers.
              Publish the demo casual shift as a manager decision; AI does not publish or accept it.
            </p>
            {assignment ? <p>Current demo shift: {assignment.shift.shiftDate} · offer {assignment.offer.status.toLowerCase()}.</p> : null}
          </div>

          {!assignment ? <form action={publishDemoShiftAction}>
            <button className="primary-button" type="submit">
              Publish casual shift
            </button>
          </form> : null}
        </section>
      ) : null}
      <section className="manager-schedule-cta">
        <div>
          <span className="eyebrow">DEMO incentive workflow</span>
          <h2>Shift result → earned incentive → approval → PayPal</h2>
          {incentive ? (
            <>
              <p>Recorded team sales: {money(incentive.incentive.performanceSalesMinor)} · target: {money(incentive.incentive.targetSalesMinor)} · incentive: {money(incentive.incentive.earnedAmountMinor)} · status: {incentive.incentive.status}</p>
              <p>PayPal payout status: {incentive.incentive.paypalStatus ?? "NOT SUBMITTED"}{incentive.incentive.paypalBatchId ? ` · batch ${incentive.incentive.paypalBatchId}` : ""}</p>
            </>
          ) : assignment?.offer.status === "ACCEPTED" ? (
            <form action={recordDemoPerformanceAction}>
              <input type="hidden" name="shiftId" value={assignment.shift.id} />
              <label>Completed shift team sales (USD) <input name="performanceSales" type="number" min="0" step="0.01" defaultValue="720.00" required /></label>
              <button className="primary-button" type="submit">Record demo shift result</button>
            </form>
          ) : <p>Publish and accept the demo shift before recording its result.</p>}
          {incentive?.incentive.status === "EARNED" ? (
            <form action={approveDemoIncentiveAction}><input type="hidden" name="incentiveId" value={incentive.incentive.id} /><button className="primary-button" type="submit">Manager approve incentive</button></form>
          ) : null}
          {incentive?.incentive.status === "APPROVED" ? (
            payoutConfigured && incentive.worker.paypalPayoutEmail ? (
              <form action={submitDemoIncentivePayoutAction}><input type="hidden" name="incentiveId" value={incentive.incentive.id} /><button className="primary-button" type="submit">Submit PayPal Sandbox payout</button></form>
            ) : <p>Add a worker PayPal payout email and configure sandbox credentials before payout.</p>
          ) : null}
          {incentive?.incentive.paypalBatchId ? (
            <form action={refreshDemoIncentivePayoutAction}><input type="hidden" name="incentiveId" value={incentive.incentive.id} /><button className="secondary-button" type="submit">Refresh PayPal status</button></form>
          ) : null}
          <p className="method-note">Performance threshold and incentive amount are fixed demo shift terms. Earnings are deterministic; only a manager action approves payment. No real payout is sent unless PayPal Sandbox credentials and a recipient are configured.</p>
        </div>
      </section>
      {incentive && ["PAID", "FAILED", "NOT_EARNED"].includes(incentive.incentive.status) ? (
        <section className="manager-schedule-cta">
          <div>
            <span className="eyebrow">Demo control</span>
            <h2>Run another demo cycle</h2>
            <p>This creates a new shift, offer and incentive path. Previous payment records stay in history.</p>
          </div>
          <form action={startNewDemoCycleAction}>
            <button className="secondary-button" type="submit">Start new demo cycle</button>
          </form>
        </section>
      ) : null}
    </div>
  );
}
