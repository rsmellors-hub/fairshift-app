import Link from "next/link";

import { PageHeader, StatePanel, StatusBadge } from "@/app/components/product-ui";
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

function paymentStatus(value: string | null) {
  if (!value) return "Not submitted";
  if (value === "SUCCESS" || value === "PAID") return "Paid";
  if (value === "FAILED" || value === "DENIED" || value === "RETURNED") return "Needs attention";
  return "Processing";
}

export default async function WorkerPage({
  searchParams = Promise.resolve({}),
}: {
  searchParams?: Promise<{ paymentDetails?: string }>;
} = {}) {
  const paymentDetailsStatus = (await searchParams).paymentDetails;
  const configuration = getConfigurationStatus();

  if (!configuration.databaseConfigured) {
    return (
      <div className="product-page">
        <PageHeader eyebrow="Worker home" title="Your work at a glance" />
        <StatePanel title="Shift information is unavailable" tone="warning">
          <p>Your shift details cannot be loaded right now. Try again after the workspace has been configured.</p>
          <Link className="text-link" href="/manager">Back to manager</Link>
        </StatePanel>
      </div>
    );
  }

  let assignment: Awaited<ReturnType<typeof getDemoWorkerShift>> | null = null;
  let incentive: Awaited<ReturnType<typeof getDemoIncentive>> | null = null;

  try {
    assignment = await getDemoWorkerShift(getDatabase());
    incentive = await getDemoIncentive(getDatabase());
  } catch {
    return (
      <div className="product-page">
        <PageHeader eyebrow="Worker home" title="Your work at a glance" />
        <StatePanel title="Shift could not be loaded" tone="danger">
          <p>We could not load your shift information. Try again in a moment.</p>
          <Link className="text-link" href="/manager">Back to manager</Link>
        </StatePanel>
      </div>
    );
  }

  if (!assignment) {
    return (
      <div className="product-page">
        <PageHeader eyebrow="Worker home" title="Your work at a glance" />
        <StatePanel title="No shift offers yet">
          <p>A manager must publish the demo casual shift before it appears here.</p>
          <Link className="text-link" href="/manager">Go to manager view</Link>
        </StatePanel>
      </div>
    );
  }

  const { worker, shift, offer } = assignment;
  const accepted = offer.status === "ACCEPTED";

  return (
    <div className="product-page worker-page">
      <PageHeader
        eyebrow="Worker home"
        title={`Welcome, ${worker.displayName}`}
        description="Your next shift, earnings opportunity and payment progress."
        actions={<StatusBadge tone={accepted ? "success" : "warning"}>{accepted ? "Offer accepted" : "Response needed"}</StatusBadge>}
      />

      <section className="worker-next-shift">
        <div>
          <span className="eyebrow">Next shift</span>
          <h2>{shift.roleName}</h2>
          <p>{formatDateTime(shift.startsAt)} · Rosebank Kitchen</p>
        </div>
        <div className="worker-pay-card">
          <span>Guaranteed base pay</span>
          <strong>{formatMoney(shift.guaranteedBasePayMinor, shift.currencyCode)}</strong>
          <small>Guaranteed shift amount · gratuity and optional incentive are separate.</small>
        </div>
      </section>

      <section className="panel" aria-labelledby="shift-terms-heading">
        <div className="panel-head">
          <div>
            <span className="eyebrow">Your offer</span>
            <h2 id="shift-terms-heading">Shift terms</h2>
          </div>
          <StatusBadge tone={accepted ? "success" : "warning"}>{accepted ? "Accepted" : "Offered"}</StatusBadge>
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
            <dd>{accepted ? "Accepted" : "Awaiting your response"}</dd>
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
        <span className="eyebrow">Incentive progress</span>
        {incentive ? (
          <>
            <h2>{incentive.incentive.status === "EARNED" ? "Incentive earned" : incentive.incentive.status === "APPROVED" ? "Approved for payment" : incentive.incentive.status === "PAID" ? "Paid" : incentive.incentive.status.replaceAll("_", " ").toLowerCase()}</h2>
            <p>Team sales {formatMoney(incentive.incentive.performanceSalesMinor, shift.currencyCode)} / target {formatMoney(incentive.incentive.targetSalesMinor, shift.currencyCode)}. Earned incentive: {formatMoney(incentive.incentive.earnedAmountMinor, shift.currencyCode)}.</p>
            <p>Manager approval: {incentive.incentive.approvedAt ? "Approved" : "Awaiting approval"} · Payment: {paymentStatus(incentive.incentive.paypalStatus)}</p>
          </>
        ) : <p>No completed shift result has been recorded yet.</p>}
        <form action={saveDemoPayoutDestinationAction}>
          <label>Payment email <input name="payoutEmail" type="email" maxLength={254} defaultValue={worker.paypalPayoutEmail ?? ""} required /></label>
          <button className="secondary-button" type="submit">Save payment details</button>
        </form>
        {paymentDetailsStatus === "saved" ? (
          <p className="method-note" role="status">Payment details saved for future approved incentives.</p>
        ) : paymentDetailsStatus === "error" ? (
          <p className="method-note" role="alert">Payment details could not be saved. Check the email and try again.</p>
        ) : null}
        <p className="method-note">This will move to Profile in the dedicated worker experience. It is used only after earnings are approved by a manager.</p>
      </section>

      <section className="panel worker-action-panel">
        <div>
          <span className="eyebrow">Worker decision</span>
          <h2>{accepted ? "Shift accepted" : "Accept these terms?"}</h2>
          <p>
            {accepted
              ? `You accepted this offer${offer.acceptedAt ? ` on ${formatDateTime(offer.acceptedAt)}` : ""}.`
              : "Accepting confirms these published shift terms."}
          </p>
        </div>

        {accepted ? (
          <StatusBadge tone="success">Accepted</StatusBadge>
        ) : (
          <form action={acceptDemoShiftAction}>
            <button className="primary-button" type="submit">Accept shift</button>
          </form>
        )}
      </section>

      <Link className="text-link" href="/manager">← Manager operational view</Link>
    </div>
  );
}
