import { requireScope } from "@/server/auth/request";
import { createLocationAction, inviteAction, refreshSubscriptionAction, selectLocationAction, revokeInvitationAction, resendInvitationAction } from "@/app/auth-actions";
import { subscriptionFor } from "@/server/billing/service";
import { teamInvitations } from "@/server/db/schema";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { createDepartmentAction, createPolicyAction } from "@/app/operations-actions";
import { getOperations } from "@/server/scheduling/operations";
import { DataLabel, PageHeader, StatePanel } from "@/app/components/product-ui";
import { ActionFeedback, money, PaymentBadge, WorkspaceUnavailable } from "@/app/components/workspace-ui";
import OwnerPage from "@/app/owner/page";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { getWeeklyForecast } from "@/server/intelligence/weekly";
import { getWeeklyStaffing } from "@/server/intelligence/staffing";
import { loadDailySales } from "@/server/intelligence/sales-history";
import { OwnerWeeklyForecast } from "@/app/owner/weekly-forecast";
import { getOwnerWorkspace } from "@/server/product/workspace";
import { DEMO_SHIFT_TERMS } from "@/server/scheduling/demo";

const REPORTING_SOURCE = { REFERENCE: "Reference sales history · synthetic", DEMO_SEEDED: "Demo / seeded history", PAYPAL_SANDBOX: "Verified PayPal Sandbox sales" } as const;
export const ownerAreas = ["locations", "forecast", "reporting", "workforce", "policies", "payments", "settings"] as const;
export type OwnerArea = "overview" | typeof ownerAreas[number];

export async function OwnerWorkspace({ area, status }: { area: OwnerArea; status?: string }) {
  if (area === "overview") return OwnerPage();
  const configuration = getConfigurationStatus();
  if (!configuration.databaseConfigured) return <WorkspaceUnavailable />;
  const scope=await requireScope(["OWNER"]);
  // The forecast needs only its own aggregated evidence, not the workspace record set.
  if (area === "forecast") {
    // One clock for both reads; a staffing failure leaves the forecast intact and vice versa.
    const now = new Date();
    let weekly = null, staffing = null;
    try { weekly = await getWeeklyForecast(getDatabase(), scope, now); } catch { weekly = null; }
    try { staffing = await getWeeklyStaffing(getDatabase(), scope, now); } catch { staffing = null; }
    return <OwnerWeeklyForecast weekly={weekly} staffing={staffing} />;
  }
  const subscription=await subscriptionFor(getDatabase(),scope);
  const invitations=await getDatabase().select().from(teamInvitations).where(eq(teamInvitations.organisationId,scope.organisationId));
  let data;
  try { data = await getOwnerWorkspace(getDatabase(),scope.organisationId); } catch { return <WorkspaceUnavailable />; }
  const { locations, sales, payments, workforce } = data;
  let history: Awaited<ReturnType<typeof loadDailySales>> = [], historyUnavailable = false;
  if (area === "reporting") { try { history = await loadDailySales(getDatabase(), scope.organisationId); } catch { historyUnavailable = true; } }
  const operations = area === "policies" ? await getOperations(getDatabase(),scope) : null;
  const title = { locations: "Locations", forecast: "Forecast & Staffing", reporting: "Reporting & Analytics", workforce: "Workforce & Managers", policies: "Work Terms & Incentive Policies", payments: "Payments", settings: "Settings & Integrations" }[area];
  return <>
    <PageHeader eyebrow="Owner / Admin" title={title} description="Business visibility across the locations currently configured for this organisation." />
    <ActionFeedback status={status} />{status?.startsWith("Your ") ? <p role="alert">{status}</p> : null}<form action={selectLocationAction} className="inline-form"><label>Operating location<select name="locationId" defaultValue={scope.locationId}>{locations.filter(l=>l.active).map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select></label><button className="secondary-button">Select location</button></form>
    {area === "locations" ? <>
      {locations.map((location) => <article className="panel" key={location.id}><h2>{location.name}</h2><p>{location.timezone}</p><p>{sales.filter((sale) => sale.outletId === location.id).reduce((sum, sale) => sum + sale.records, 0)} recorded commercial entries · {payments.filter((payment) => payment.outletId === location.id).length} incentive results</p><Link className="text-link" href="/owner/reporting">Inspect commercial evidence →</Link></article>)}
      <form action={createLocationAction} className="inline-form"><label>Location name<input name="name" required maxLength={150}/></label><button className="primary-button">Add location</button></form><p className="method-note">Only persisted locations are shown. Additional locations and their operating data have not been configured.</p>
    </> : null}
    {area === "reporting" ? <>
      <p className="method-note">Eligible sales history, grouped by location, source and currency. Reference, demo and verified Sandbox sales are reported separately and never combined.</p>
      {locations.flatMap((location) => (["REFERENCE", "DEMO_SEEDED", "PAYPAL_SANDBOX"] as const).flatMap((source) => [...new Set(history.filter((day) => day.outletId === location.id && day.source === source).map((day) => day.currency))].map((currency) => {
        const days = history.filter((day) => day.outletId === location.id && day.source === source && day.currency === currency);
        const dates = days.map((day) => day.date).sort();
        return <article className="panel" key={`${location.id}-${source}-${currency}`}><DataLabel kind={source === "PAYPAL_SANDBOX" ? "fact" : "demo"}>{REPORTING_SOURCE[source]}</DataLabel><h2>{location.name}</h2><p>{money(days.reduce((sum, day) => sum + day.salesMinor, 0), currency)} · {days.reduce((sum, day) => sum + day.transactions, 0)} eligible records · {days.length} trading days, {dates[0]} to {dates.at(-1)}</p></article>;
      })))}
      {historyUnavailable ? <StatePanel title="Sales history could not be loaded" tone="warning"><p>No sales have been assumed. Reload to try again.</p></StatePanel> : !history.length ? <StatePanel title="No commercial history available" /> : null}
    </> : null}
    {area === "workforce" ? <section className="panel"><h2>Organisation workforce</h2>{workforce.length ? workforce.map((person) => <div className="record-row" key={person.name}><strong>{person.name}</strong><span>{person.type === "CASUAL" ? "Casual worker" : "Regular staff record"} · {person.status === "ACTIVE" ? "Active" : "Inactive"}</span></div>) : <p>No worker profiles have been created.</p>}<h3>Invite to {scope.locationName}</h3><form action={inviteAction} className="workspace-form form-grid"><label>Role<select name="role"><option value="MANAGER">Manager</option><option value="TEAM_MEMBER">Team Member</option></select></label><label>First name<input name="firstName" required /></label><label>Surname<input name="surname" required /></label><label>Telephone<input name="telephone" type="tel" required /></label><label>Email<input name="email" type="email" required /></label><button className="primary-button">Create & send FairShift invite</button></form><h3>Invitations</h3>{invitations.map(i=><div className="record-row" key={i.id}><span>{i.email} · {i.role.replaceAll("_"," ")} · {i.state.replaceAll("_"," ")}</span>{!["REDEEMED","REVOKED"].includes(i.state) ? <div><form action={resendInvitationAction}><input type="hidden" name="invitationId" value={i.id}/><button className="secondary-button">Resend invite</button></form><form action={revokeInvitationAction}><input type="hidden" name="invitationId" value={i.id}/><button className="secondary-button">Revoke</button></form></div>:null}</div>)}</section> : null}
    {area === "policies" && operations ? <>
      <section className="panel"><h2>Location departments</h2>{operations.departments.map(d => <div className="record-row" key={d.id}>{d.name}</div>)}<form action={createDepartmentAction} className="inline-form"><label>Department name<input name="name" maxLength={100} required /></label><button className="primary-button">Add department</button></form></section>
      <section className="panel"><h2>Owner-defined work policies</h2><p>Policies apply to new requirements. Existing assignment terms remain as offered. Managers select a policy and cannot change rates.</p>{operations.policies.map(p => <div className="record-row" key={p.id}><span>{p.name} · {p.earningsModel.toLowerCase()}</span><span>{p.earningsModel === "COMMISSION" ? `${(p.commissionBps ?? 0)/100}% · verified attributed sales` : `${money(p.rateMinor!)} / ${p.earningsModel === "HOURLY" ? "hour" : "day"}`}</span></div>)}
      <form action={createPolicyAction} className="workspace-form"><label>Policy name<input name="name" maxLength={100} required /></label><label>Earnings model<select name="earningsModel"><option value="HOURLY">Hourly</option><option value="DAILY">Daily</option><option value="COMMISSION">Commission</option></select></label><label>Rate (USD) or commission percentage<input type="number" name="rate" min="0" step="0.01" required /></label><p>Commission basis: verified attributed sales. No incentive applies to new policies; the controlled demo incentive remains separate.</p><button className="primary-button">Create work policy</button></form></section>
      <section className="panel"><h2>Controlled demo incentive</h2><p>{money(DEMO_SHIFT_TERMS.incentiveAmountMinor)} when the recorded team result reaches {money(DEMO_SHIFT_TERMS.incentiveTargetMinor)}. Manager approval is required. The permanent incentive policy is unresolved.</p></section>
    </> : null}
    {area === "payments" ? <section className="panel"><h2>Organisation incentive payments</h2>{payments.length ? payments.map((payment, index) => <div className="record-row" key={`${payment.outletId}-${payment.shiftDate}-${index}`}><span>{locations.find((location) => location.id === payment.outletId)?.name} · {payment.shiftDate} · {money(payment.amount, payment.currency)}</span><PaymentBadge status={payment.status} /></div>) : <p>No incentive results recorded.</p>}<p className="method-note">Approval and payment initiation belong to the location manager. This view covers incentive payouts; work earnings settlement is not tracked.</p></section> : null}
    {area === "settings" ? <section className="panel"><h2>Organisation subscription</h2><Link href="/onboarding">Business details & subscription setup</Link><p>{subscription?.status ?? "UNCONFIGURED"}</p><p>{subscription?.verifiedAt ? `Last verified ${subscription.verifiedAt.toISOString()}`:"Not yet verified with PayPal."}</p><p>Subscription billing belongs to {scope.organisationName} and is separate from worker incentive payments. Sandbox only.</p><Link href="/subscribe">Review subscription</Link><form action={refreshSubscriptionAction}><button className="secondary-button">Check subscription with PayPal</button></form><h2>Organisation environment</h2><p>{locations.length} configured location{locations.length === 1 ? "" : "s"} · USD incentive payouts</p><h3>PayPal worker payments</h3><p>{configuration.paypalPayoutConfigured ? "Sandbox credentials configured. Configuration does not establish current provider availability." : "Not configured."}</p><h3>Commercial data</h3><p>Zettle is planned and has not been verified. Current history may contain explicitly labelled seeded records and verified PayPal Sandbox sales.</p><p>Connection editing is managed by the platform operator in this environment.</p></section> : null}
  </>;
}
