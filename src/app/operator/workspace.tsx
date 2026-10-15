import { requireOperator } from "@/server/auth/request";
import Link from "next/link";
import { CreateSaleButton } from "@/app/components/create-sale-button";
import { PageHeader, StatePanel } from "@/app/components/product-ui";
import { ActionFeedback, money } from "@/app/components/workspace-ui";
import { startNewDemoCycleAction } from "@/app/operator/actions";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { getConnection, listDemoOutletTransactions } from "@/server/db/repository";
import { getLocationWorkspace, getOwnerWorkspace } from "@/server/product/workspace";

export const operatorAreas = ["environment", "integrations"] as const;
export type OperatorArea = "overview" | typeof operatorAreas[number];

export async function OperatorWorkspace({ area, status }: { area: OperatorArea; status?: string }) {
  await requireOperator();
  const config = getConfigurationStatus();
  let system: "Not configured" | "Reachable" | "Unavailable" = "Not configured";
  let location: Awaited<ReturnType<typeof getLocationWorkspace>> | null = null;
  let owner: Awaited<ReturnType<typeof getOwnerWorkspace>> | null = null;
  let connection: Awaited<ReturnType<typeof getConnection>> | null = null;
  let transactions: Awaited<ReturnType<typeof listDemoOutletTransactions>> = [];
  if (config.databaseConfigured) {
    try {
      const db = getDatabase();
      [location, owner, connection, transactions] = await Promise.all([getLocationWorkspace(db), getOwnerWorkspace(db), getConnection(db), listDemoOutletTransactions(db)]);
      system = "Reachable";
    } catch { system = "Unavailable"; }
  }
  const active = location?.assignments.find((row) => row.shift.id === location.current?.shift.id);
  const canStart = active?.incentive && ["PAID", "FAILED", "NOT_EARNED"].includes(active.incentive.status);
  return <>
    <PageHeader eyebrow="FairShift platform operator" title={area === "overview" ? "Environment operations" : area === "environment" ? "Demo Environment" : "Integration Health"} description="Controlled environment tooling. Production authentication and role-based access are not implemented." />
    <ActionFeedback status={status} />
    {area === "overview" ? <>
      <StatePanel title="Sandbox environment"><p>Customer workspaces use a server-pinned organisation, location and worker. These links select testing contexts; they do not authenticate a role.</p></StatePanel>
      <div className="task-grid"><Link className="task-link" href="/owner"><strong>Owner / Admin</strong><span>Business visibility and governance</span></Link><Link className="task-link" href="/manager"><strong>Manager</strong><span>Location operations</span></Link><Link className="task-link" href="/worker"><strong>Worker</strong><span>Personal shifts and earnings</span></Link></div>
    </> : null}
    {area === "environment" ? <>
      <section className="panel"><h2>Current cycle</h2><p>{location?.current ? `${location.current.shift.shiftDate} · shift ${location.current.shift.id}` : "No shift has been published."}</p><p>Data and dates are controlled environment fixtures. A new cycle creates a new published shift and worker offer; it never resets an existing payout.</p>
        {canStart ? <form action={startNewDemoCycleAction}><button className="secondary-button" type="submit">Start new demo cycle</button></form> : <p>Start another cycle after the current incentive is paid, failed, or not earned. Publish the first shift through Manager → Fill Shifts.</p>}
      </section>
      <section className="panel"><h2>Data provenance</h2><p>{owner?.sales.filter((sale) => sale.source === "DEMO_SEEDED").length ?? "Unavailable"} seeded records · {owner?.sales.filter((sale) => sale.source === "PAYPAL_SANDBOX" && sale.verification === "VERIFIED").length ?? "Unavailable"} verified PayPal Sandbox records</p><p>Zettle sales ingestion and worker-level attribution are not implemented.</p></section>
      <section className="panel"><h2>Payout diagnostics</h2>{location?.assignments.filter((row) => row.incentive).map((row) => <details key={row.shift.id}><summary>{row.shift.shiftDate} · {row.incentive!.status}</summary><dl className="evidence-list"><div><dt>Incentive</dt><dd>{row.incentive!.id}</dd></div><div><dt>Submission lock</dt><dd>{row.incentive!.submittedAt?.toISOString() ?? "Not submitted"}</dd></div><div><dt>Provider batch</dt><dd>{row.incentive!.paypalBatchId ?? "None"}</dd></div><div><dt>Provider item</dt><dd>{row.incentive!.paypalItemId ?? "None"}</dd></div><div><dt>Provider status</dt><dd>{row.incentive!.paypalStatus ?? "None"}</dd></div><div><dt>Failure code</dt><dd>{row.incentive!.failureCode ?? "None"}</dd></div></dl></details>)}</section>
    </> : null}
    {area === "integrations" || area === "overview" ? <section className="panel"><h2>Configuration and recorded evidence</h2><dl className="evidence-list"><div><dt>Database query</dt><dd>{system}</dd></div><div><dt>PayPal payout configuration</dt><dd>{config.paypalPayoutConfigured ? "Sandbox configured; current connectivity not probed" : "Not configured"}</dd></div><div><dt>PayPal inbound connection record</dt><dd>{connection?.status ?? "Unavailable"}</dd></div><div><dt>AI</dt><dd>{config.aiConfigured ? "Configured; current response not probed" : "Not configured; deterministic fallback available"}</dd></div><div><dt>POS / Zettle</dt><dd>Planned / needs verification</dd></div></dl><p>No provider calls are made by this health view.</p></section> : null}
    {area === "integrations" ? <section className="panel"><h2>Inbound Sandbox test</h2><p>Creates a controlled PayPal Sandbox purchase for the existing inbound integration.</p><CreateSaleButton enabled={system === "Reachable" && config.paypalConfigured} /></section> : null}
    {area === "integrations" ? <section className="panel"><h2>Recorded inbound evidence</h2>{transactions.length ? transactions.map((transaction) => <details key={transaction.id}><summary>{transaction.internalReference} · {money(transaction.grossAmountMinor, transaction.currencyCode)}</summary><dl className="evidence-list"><div><dt>Order</dt><dd>{transaction.paypalOrderId ?? "None"}</dd></div><div><dt>Capture</dt><dd>{transaction.paypalCaptureId ?? "None"}</dd></div><div><dt>Verification</dt><dd>{transaction.verificationState}</dd></div><div><dt>Reconciliation</dt><dd>{transaction.reconciliationState}</dd></div></dl></details>) : <p>No recorded inbound evidence is available.</p>}</section> : null}
  </>;
}
