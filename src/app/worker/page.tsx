import Link from "next/link";

import { acceptDemoShiftAction } from "@/app/scheduling-actions";
import { saveDemoPayoutDestinationAction } from "@/app/scheduling-actions";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { getDemoWorkerShift } from "@/server/scheduling/demo";
import { getDemoIncentive } from "@/server/incentives/demo";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function formatMoney(minor: number, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(minor / 100);
}

function formatDateTime(value: Date) {
  return new Intl.DateTimeFormat("en-ZA", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Africa/Johannesburg",
  }).format(value);
}

export default async function WorkerPage() {
  const configuration = getConfigurationStatus();

  if (!configuration.databaseConfigured) {
    return (
      <main className="centered-shell">
        <div className="brand"><span>F</span><strong>FairShift</strong></div>
        <section className="result-card">
          <span className="eyebrow">Worker shift</span>
          <h2>Database not configured</h2>
          <p>Connect PostgreSQL before loading persisted worker shift terms.</p>
          <Link className="text-link" href="/manager">Back to manager</Link>
        </section>
      </main>
    );
  }

  let assignment: Awaited<ReturnType<typeof getDemoWorkerShift>> | null = null;
  let incentive: Awaited<ReturnType<typeof getDemoIncentive>> | null = null;

  try {
    assignment = await getDemoWorkerShift(getDatabase());
    incentive = await getDemoIncentive(getDatabase());
  } catch {
    return (
      <main className="centered-shell">
        <div className="brand"><span>F</span><strong>FairShift</strong></div>
        <section className="result-card">
          <span className="eyebrow">Worker shift</span>
          <h2>Shift could not be loaded</h2>
          <p>Check the database connection and workforce scheduling migration.</p>
          <Link className="text-link" href="/manager">Back to manager</Link>
        </section>
      </main>
    );
  }

  if (!assignment) {
    return (
      <main className="centered-shell">
        <div className="brand"><span>F</span><strong>FairShift</strong></div>
        <section className="result-card">
          <span className="eyebrow">Worker shift</span>
          <h2>No shift offered yet</h2>
          <p>A manager must publish the demo casual shift before it appears here.</p>
          <Link className="text-link" href="/manager">Go to manager view</Link>
        </section>
      </main>
    );
  }

  const { worker, shift, offer } = assignment;
  const accepted = offer.status === "ACCEPTED";

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand"><span>F</span><strong>FairShift</strong></div>
        <span className={accepted ? "worker-state accepted" : "worker-state offered"}>
          {offer.status}
        </span>
      </header>

      <section className="worker-hero">
        <div>
          <span className="eyebrow">Casual worker portal</span>
          <h1>{worker.displayName}</h1>
          <p>
            Review the exact published shift terms before accepting.
            Acceptance does not alter the guaranteed base pay or published policies.
          </p>
        </div>
        <div className="worker-pay-card">
          <span>Guaranteed base pay</span>
          <strong>{formatMoney(shift.guaranteedBasePayMinor, shift.currencyCode)}</strong>
          <small>Guaranteed shift amount · gratuity and optional incentive are separate.</small>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">Published shift</span>
            <h2>{shift.roleName}</h2>
          </div>
          <span className="count">{shift.status}</span>
        </div>

        <dl className="shift-terms">
          <div>
            <dt>Starts</dt>
            <dd>{formatDateTime(shift.startsAt)}</dd>
          </div>
          <div>
            <dt>Ends</dt>
            <dd>{formatDateTime(shift.endsAt)}</dd>
          </div>
          <div>
            <dt>Guaranteed base pay</dt>
            <dd>{formatMoney(shift.guaranteedBasePayMinor, shift.currencyCode)}</dd>
          </div>
          <div>
            <dt>Offer status</dt>
            <dd>{offer.status}</dd>
          </div>
        </dl>
      </section>

      <section className="worker-policy-grid">
        <article className="panel">
          <span className="eyebrow">Gratuity</span>
          <h2>Separate from base pay</h2>
          <p>{shift.gratuityPolicy}</p>
        </article>

        <article className="panel">
          <span className="eyebrow">Optional team incentive</span>
          <h2>Performance-based</h2>
          <p>{shift.incentivePolicy}</p>
        </article>
      </section>

      <section className="panel">
        <span className="eyebrow">Shift incentive</span>
        {incentive ? (
          <>
            <h2>{incentive.incentive.status.replaceAll("_", " ")}</h2>
            <p>Team sales {formatMoney(incentive.incentive.performanceSalesMinor, shift.currencyCode)} / target {formatMoney(incentive.incentive.targetSalesMinor, shift.currencyCode)}. Earned incentive: {formatMoney(incentive.incentive.earnedAmountMinor, shift.currencyCode)}.</p>
            <p>Manager approval: {incentive.incentive.approvedAt ? "APPROVED" : "PENDING"} · PayPal payout: {incentive.incentive.paypalStatus ?? "NOT SUBMITTED"}</p>
          </>
        ) : <p>No completed shift result has been recorded yet.</p>}
        <form action={saveDemoPayoutDestinationAction}>
          <label>PayPal payout email <input name="payoutEmail" type="email" maxLength={254} defaultValue={worker.paypalPayoutEmail ?? ""} required /></label>
          <button className="secondary-button" type="submit">Save payout destination</button>
        </form>
        <p className="method-note">Payout destination is used only after the incentive is earned and approved by a manager.</p>
      </section>

      <section className="panel worker-action-panel">
        <div>
          <span className="eyebrow">Worker decision</span>
          <h2>{accepted ? "Shift accepted" : "Accept these terms?"}</h2>
          <p>
            {accepted
              ? `Acceptance persisted${offer.acceptedAt ? ` at ${formatDateTime(offer.acceptedAt)}` : ""}.`
              : "Accepting records your response against this exact published shift offer."}
          </p>
        </div>

        {accepted ? (
          <span className="accepted-proof">ACCEPTED · PERSISTED</span>
        ) : (
          <form action={acceptDemoShiftAction}>
            <button className="primary-button" type="submit">Accept shift</button>
          </form>
        )}
      </section>

      <Link className="text-link" href="/manager">← Manager operational view</Link>
    </main>
  );
}
