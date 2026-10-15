import Link from "next/link";

import { CreateSaleButton } from "@/app/components/create-sale-button";
import { FairShiftBrand } from "@/app/components/product-shell";
import { StatusBadge } from "@/app/components/product-ui";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import {
  getConnection,
  getDemoOutlet,
  listDemoOutletTransactions,
} from "@/server/db/repository";

export const dynamic = "force-dynamic";

function formatMoney(minor: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100);
}

export default async function Home() {
  const configuration = getConfigurationStatus();
  let databaseState: "CONNECTED" | "NOT CONFIGURED" | "ERROR" = configuration.databaseConfigured
    ? "ERROR"
    : "NOT CONFIGURED";
  let outlet: Awaited<ReturnType<typeof getDemoOutlet>> | null = null;
  let connection: Awaited<ReturnType<typeof getConnection>> | null = null;
  let transactions: Awaited<ReturnType<typeof listDemoOutletTransactions>> = [];

  if (configuration.databaseConfigured) {
    try {
      const db = getDatabase();
      [outlet, connection, transactions] = await Promise.all([
        getDemoOutlet(db),
        getConnection(db),
        listDemoOutletTransactions(db),
      ]);
      databaseState = "CONNECTED";
    } catch {
      databaseState = "ERROR";
    }
  }

  const ready =
    databaseState === "CONNECTED" &&
    configuration.paypalConfigured &&
    Boolean(outlet);
  const paypalState = !configuration.paypalConfigured
    ? "NOT CONFIGURED"
    : connection?.status === "CONNECTED"
      ? "CONNECTED"
      : connection?.status === "ERROR"
        ? "ERROR"
        : "CONFIGURED — NOT VERIFIED";

  return (
    <main className="entry-shell">
      <header className="entry-topbar">
        <FairShiftBrand />
        <span className="entry-status">Product preview · Sandbox environment</span>
      </header>

      <section className="entry-hero">
        <div>
          <span className="eyebrow">Workforce operating intelligence</span>
          <h1>Turn demand into the right shift — and approved work into payment.</h1>
          <p>FairShift connects commercial activity, demand forecasting, staffing decisions and transparent worker payments in one operating loop.</p>
          <div className="entry-actions">
            <Link className="primary-button button-link" href="/manager">Open manager workspace</Link>
            <Link className="secondary-button button-link" href="/worker">Open worker workspace</Link>
          </div>
          <p className="entry-note">These links open current demo product contexts. Sign-in and role-based access are not yet implemented.</p>
        </div>
        <div className="operating-loop" aria-label="FairShift operating loop">
          <span>01 · Understand demand</span>
          <strong>Sales → forecast → staffing</strong>
          <span>02 · Put the plan to work</span>
          <strong>Shifts → workers → performance</strong>
          <span>03 · Pay transparently</span>
          <strong>Approval → PayPal → confirmation</strong>
        </div>
      </section>

      <section className="entry-contexts" aria-labelledby="available-workspaces">
        <div className="section-heading">
          <span className="eyebrow">Current product contexts</span>
          <h2 id="available-workspaces">Explore the verified workflow</h2>
          <p>These entry points support the current demonstration while leaving room for a future commercial sign-in and onboarding journey.</p>
        </div>
        <div className="context-grid">
          <Link href="/manager"><span>Manager</span><strong>Forecast, staff and approve</strong><small>Current operational workflow →</small></Link>
          <Link href="/worker"><span>Worker</span><strong>Review shifts and earnings</strong><small>Current worker workflow →</small></Link>
          <Link href="/owner"><span>Owner</span><strong>Company intelligence</strong><small>Structural preview →</small></Link>
        </div>
      </section>

      <section className="integration-summary" aria-labelledby="integration-state">
        <div className="section-heading">
          <span className="eyebrow">Truthful integration state</span>
          <h2 id="integration-state">Connected where it counts</h2>
        </div>
        <div className="overview-strip">
          <div><span>Worker payments</span><StatusBadge tone="success">PayPal Sandbox connected</StatusBadge></div>
          <div><span>Demand input</span><StatusBadge tone="warning">Zettle planned · needs verification</StatusBadge></div>
          <div><span>Current sales evidence</span><StatusBadge tone="fact">Demo seeded or verified Sandbox</StatusBadge></div>
        </div>
      </section>

      <details className="evidence-lab">
        <summary>PayPal inbound integration evidence</summary>
        <div className="evidence-lab-content">
          <div className="panel outlet-panel">
            <div>
              <span className="eyebrow">Sandbox test outlet</span>
              <h2>{outlet?.name ?? "Rosebank Kitchen"}</h2>
              <p>{outlet?.timezone ?? "Africa/Johannesburg"} · one demo outlet</p>
            </div>
            <CreateSaleButton enabled={ready} />
          </div>
          <div className="status-grid">
            <article><span>PayPal inbound</span><strong className={paypalState === "CONNECTED" ? "good" : "neutral"}>{paypalState}</strong><small>{configuration.environment}</small></article>
            <article><span>Application data</span><strong className={databaseState === "CONNECTED" ? "good" : "neutral"}>{databaseState}</strong><small>PostgreSQL</small></article>
            <article><span>Webhook</span><strong className="neutral">Implemented</strong><small>Not live-verified</small></article>
            <article><span>Forecasting</span><strong className="good">Implemented</strong><small><Link href="/manager">View manager evidence</Link></small></article>
          </div>
          <section className="panel">
        <div className="panel-head">
          <div><span className="eyebrow">Technical evidence</span><h2>Sandbox transactions</h2></div>
          <span className="count">{transactions.length}</span>
        </div>
        {transactions.length === 0 ? (
          <div className="empty-state">No PayPal sandbox transaction has been persisted yet.</div>
        ) : (
          <div className="transaction-list">
            {transactions.map((transaction) => (
              <article className="transaction" key={transaction.id}>
                <div className="transaction-title">
                  <strong>{transaction.internalReference}</strong>
                  <span className={`status ${transaction.verificationState.toLowerCase()}`}>{transaction.verificationState}</span>
                </div>
                <dl className="evidence-list">
                  <div><dt>PayPal order ID</dt><dd>{transaction.paypalOrderId ?? "PENDING"}</dd></div>
                  <div><dt>PayPal capture ID</dt><dd>{transaction.paypalCaptureId ?? "PENDING"}</dd></div>
                  <div><dt>Amount</dt><dd>{formatMoney(transaction.grossAmountMinor, transaction.currencyCode)}</dd></div>
                  <div><dt>Provider status</dt><dd>{transaction.providerStatus}</dd></div>
                  <div><dt>Reconciliation</dt><dd>{transaction.reconciliationState}</dd></div>
                  <div><dt>Updated</dt><dd>{transaction.updatedAt.toISOString()}</dd></div>
                </dl>
              </article>
            ))}
          </div>
        )}
          </section>
        </div>
      </details>
    </main>
  );
}
