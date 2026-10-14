import Link from "next/link";

import { CreateSaleButton } from "@/app/components/create-sale-button";
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
    <main className="shell">
      <header className="topbar">
        <div className="brand"><span>F</span><strong>FairShift</strong></div>
        <span className="sandbox-banner">PAYPAL SANDBOX ONLY</span>
      </header>

      <section className="hero">
        <div>
          <span className="eyebrow">Inbound payment evidence</span>
          <h1>From PayPal sandbox<br /><em>to persisted FairShift sale.</em></h1>
          <p>This slice creates an order on the server, returns through buyer approval, captures it, and reconciles the capture before a sale can be verified.</p>
        </div>
        <div className="proof-card">
          <span>Technical proof amount</span>
          <strong>{configuration.currency} {configuration.amount}</strong>
          <small>USD is listed for PayPal REST payments. ZAR is not assumed.</small>
        </div>
      </section>

      <section className="status-grid">
        <article><span>PayPal integration</span><strong className={paypalState === "CONNECTED" ? "good" : "neutral"}>{paypalState}</strong><small>{configuration.environment}</small></article>
        <article><span>PostgreSQL</span><strong className={databaseState === "CONNECTED" ? "good" : "neutral"}>{databaseState}</strong><small>Authoritative application state</small></article>
        <article><span>Webhook</span><strong className="neutral">IMPLEMENTED</strong><small>NOT YET LIVE-VERIFIED</small></article>
        <article><span>Operational intelligence</span><strong className="good">IMPLEMENTED</strong><small>Local statistical forecast · <Link href="/manager">View demand &amp; staffing</Link></small></article>
      </section>

      <section className="panel outlet-panel">
        <div>
          <span className="eyebrow">Seeded outlet</span>
          <h2>{outlet?.name ?? "Rosebank Kitchen"}</h2>
          <p>{outlet?.timezone ?? "Africa/Johannesburg"} · one outlet only</p>
        </div>
        <CreateSaleButton enabled={ready} />
      </section>

      <section className="panel">
        <div className="panel-head">
          <div><span className="eyebrow">Persisted evidence</span><h2>Sandbox transactions</h2></div>
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
    </main>
  );
}
