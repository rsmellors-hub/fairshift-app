import Link from "next/link";
import { createDepartmentAction, createPolicyAction } from "@/app/operations-actions";
import { getOperations } from "@/server/scheduling/operations";
import { ManagerForecast } from "@/app/components/manager-forecast";
import { DataLabel, PageHeader, StatePanel } from "@/app/components/product-ui";
import { ActionFeedback, money, PaymentBadge, TaskLink, WorkspaceUnavailable } from "@/app/components/workspace-ui";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { getManagerForecast } from "@/server/intelligence/manager";
import { getAiOperationalAssessment } from "@/server/integrations/openai/operational-intelligence";
import { getOwnerWorkspace } from "@/server/product/workspace";
import { DEMO_SHIFT_TERMS } from "@/server/scheduling/demo";

export const ownerAreas = ["locations", "forecast", "reporting", "workforce", "policies", "payments", "settings"] as const;
export type OwnerArea = "overview" | typeof ownerAreas[number];

export async function OwnerWorkspace({ area, status }: { area: OwnerArea; status?: string }) {
  const configuration = getConfigurationStatus();
  if (!configuration.databaseConfigured) return <WorkspaceUnavailable />;
  let data;
  try { data = await getOwnerWorkspace(getDatabase()); } catch { return <WorkspaceUnavailable />; }
  const { locations, sales, payments, workforce } = data;
  if (area === "forecast") {
    let result;
    let aiResult;
    try {
      result = await getManagerForecast(getDatabase());
      aiResult = await getAiOperationalAssessment(result);
    } catch { return <ManagerForecast result={null} error="Forecast evidence could not be loaded." />; }
    return <><ManagerForecast result={result} aiResult={aiResult} /><p className="method-note">Forecast scope: Rosebank Kitchen. Seven-day and additional-location forecasts are not available. Shift operations belong to the location manager.</p></>;
  }
  const operations = area === "policies" ? await getOperations(getDatabase()) : null;
  const title = { overview: "Company overview", locations: "Locations", forecast: "Forecast & Staffing", reporting: "Reporting & Analytics", workforce: "Workforce & Managers", policies: "Work Terms & Incentive Policies", payments: "Payments", settings: "Settings & Integrations" }[area];
  return <>
    <PageHeader eyebrow="Owner / Admin" title={title} description="Business visibility across the locations currently configured for this organisation." />
    <ActionFeedback status={status} />
    {area === "overview" ? <>
      <section className="overview-strip"><div><span>Configured locations</span><strong>{locations.length}</strong></div><div><span>Worker records</span><strong>{workforce.length}</strong></div><div><span>Payment exceptions</span><strong>{payments.filter((row) => row.status === "FAILED").length}</strong></div></section>
      <div className="task-grid"><TaskLink href="/owner/locations" title="Location visibility">Review configured locations and their sales provenance.</TaskLink><TaskLink href="/owner/forecast" title="Demand & staffing outlook">Inspect the supported forecast and staffing assumptions.</TaskLink><TaskLink href="/owner/payments" title="Payment governance">Review calculated incentives, approval and payment outcomes.</TaskLink><TaskLink href="/owner/policies" title="Work terms">Inspect the current environment policy.</TaskLink></div>
    </> : null}
    {area === "locations" ? <>
      {locations.map((location) => <article className="panel" key={location.id}><h2>{location.name}</h2><p>{location.timezone}</p><p>{sales.filter((sale) => sale.outletId === location.id).length} recorded commercial entries · {payments.filter((payment) => payment.outletId === location.id).length} incentive results</p><Link className="text-link" href="/owner/reporting">Inspect commercial evidence →</Link></article>)}
      <p className="method-note">Only persisted locations are shown. Additional locations and their operating data have not been configured.</p>
    </> : null}
    {area === "reporting" ? <>
      <p className="method-note">All recorded history, grouped by location, source and currency. Seeded records and verified Sandbox sales are reported separately.</p>
      {locations.flatMap((location) => ["DEMO_SEEDED", "PAYPAL_SANDBOX"].flatMap((source) => [...new Set(sales.filter((sale) => sale.outletId === location.id && sale.source === source).map((sale) => sale.currency))].map((currency) => {
        const entries = sales.filter((sale) => sale.outletId === location.id && sale.source === source && sale.currency === currency && (source === "DEMO_SEEDED" || (sale.verification === "VERIFIED" && sale.reconciliation === "RECONCILED")));
        return <article className="panel" key={`${location.id}-${source}-${currency}`}><DataLabel kind={source === "DEMO_SEEDED" ? "demo" : "fact"}>{source === "DEMO_SEEDED" ? "Demo / seeded history" : "Verified PayPal Sandbox sales"}</DataLabel><h2>{location.name}</h2><p>{money(entries.reduce((sum, sale) => sum + sale.amount, 0), currency)} · {entries.length} eligible records</p></article>;
      })))}
      {!sales.length ? <StatePanel title="No commercial history available" /> : null}
    </> : null}
    {area === "workforce" ? <section className="panel"><h2>Organisation workforce</h2>{workforce.length ? workforce.map((person) => <div className="record-row" key={person.name}><strong>{person.name}</strong><span>{person.type === "CASUAL" ? "Casual worker" : "Regular staff record"} · {person.status === "ACTIVE" ? "Active" : "Inactive"}</span></div>) : <p>No worker profiles have been created.</p>}<p>Manager account and assignment administration is not implemented. Current manager access uses the configured Rosebank Kitchen context.</p></section> : null}
    {area === "policies" && operations ? <>
      <section className="panel"><h2>Location departments</h2>{operations.departments.map(d => <div className="record-row" key={d.id}>{d.name}</div>)}<form action={createDepartmentAction} className="inline-form"><label>Department name<input name="name" maxLength={100} required /></label><button className="primary-button">Add department</button></form></section>
      <section className="panel"><h2>Owner-defined work policies</h2><p>Policies apply to new requirements. Existing assignment terms remain as offered. Managers select a policy and cannot change rates.</p>{operations.policies.map(p => <div className="record-row" key={p.id}><span>{p.name} · {p.earningsModel.toLowerCase()}</span><span>{p.earningsModel === "COMMISSION" ? `${(p.commissionBps ?? 0)/100}% · verified attributed sales` : `${money(p.rateMinor!)} / ${p.earningsModel === "HOURLY" ? "hour" : "day"}`}</span></div>)}
      <form action={createPolicyAction} className="workspace-form"><label>Policy name<input name="name" maxLength={100} required /></label><label>Earnings model<select name="earningsModel"><option value="HOURLY">Hourly</option><option value="DAILY">Daily</option><option value="COMMISSION">Commission</option></select></label><label>Rate (USD) or commission percentage<input type="number" name="rate" min="0" step="0.01" required /></label><p>Commission basis: verified attributed sales. No incentive applies to new policies; the controlled demo incentive remains separate.</p><button className="primary-button">Create work policy</button></form></section>
      <section className="panel"><h2>Controlled demo incentive</h2><p>{money(DEMO_SHIFT_TERMS.incentiveAmountMinor)} when the recorded team result reaches {money(DEMO_SHIFT_TERMS.incentiveTargetMinor)}. Manager approval is required. The permanent incentive policy is unresolved.</p></section>
    </> : null}
    {area === "payments" ? <section className="panel"><h2>Organisation incentive payments</h2>{payments.length ? payments.map((payment, index) => <div className="record-row" key={`${payment.outletId}-${payment.shiftDate}-${index}`}><span>{locations.find((location) => location.id === payment.outletId)?.name} · {payment.shiftDate} · {money(payment.amount, payment.currency)}</span><PaymentBadge status={payment.status} /></div>) : <p>No incentive results recorded.</p>}<p className="method-note">Approval and payment initiation belong to the location manager. This view covers incentive payouts; work earnings settlement is not tracked.</p></section> : null}
    {area === "settings" ? <section className="panel"><h2>Organisation environment</h2><p>{locations.length} configured location{locations.length === 1 ? "" : "s"} · USD incentive payouts</p><h3>PayPal worker payments</h3><p>{configuration.paypalPayoutConfigured ? "Sandbox credentials configured. Configuration does not establish current provider availability." : "Not configured."}</p><h3>Commercial data</h3><p>Zettle is planned and has not been verified. Current history may contain explicitly labelled seeded records and verified PayPal Sandbox sales.</p><p>Connection editing is managed by the platform operator in this environment.</p></section> : null}
  </>;
}
