import { DEMO_ORGANISATION_ID } from "@/server/constants";
import { requireScope } from "@/server/auth/request";
import { createLocationAction, inviteAction, refreshSubscriptionAction, selectLocationAction, revokeInvitationAction, resendInvitationAction } from "@/app/auth-actions";
import { subscriptionFor } from "@/server/billing/service";
import { teamInvitations } from "@/server/db/schema";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { createDepartmentAction, createPolicyAction } from "@/app/operations-actions";
import { getOperations } from "@/server/scheduling/operations";
import { PageHeader } from "@/app/components/product-ui";
import { ActionFeedback, money, PayableBadge, PaymentBadge, WorkspaceUnavailable } from "@/app/components/workspace-ui";
import OwnerPage from "@/app/owner/page";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { getWeeklyForecast } from "@/server/intelligence/weekly";
import { getWeeklyStaffing } from "@/server/intelligence/staffing";
import { loadDailySales } from "@/server/intelligence/sales-history";
import { OwnerWeeklyForecast } from "@/app/owner/weekly-forecast";
import { getOwnerWorkspace } from "@/server/product/workspace";
import { getStaffingAssessmentView } from "@/server/intelligence/ai-staffing";
import { getStaffingConfiguration } from "@/server/intelligence/business-policy";
import { StaffingConfiguration } from "@/app/owner/staffing-configuration";
import { AiStaffingAssessment } from "@/app/components/ai-staffing-assessment";
import { generateOwnerAssessmentAction } from "@/app/intelligence-actions";
import { DEMO_SHIFT_TERMS } from "@/server/scheduling/demo";
import { commerceConnectionsConfigured, getCommerceConnections } from "@/server/commerce/connections";
import { OwnerSales } from "@/app/owner/sales";
import { getSquareActivity, squareSandboxCredentials } from "@/server/commerce/square-connection";

export const ownerAreas = ["locations", "forecast", "reporting", "workforce", "policies", "payments", "settings"] as const;
export type OwnerArea = "overview" | typeof ownerAreas[number];

export async function OwnerWorkspace({ area, status, ai }: { area: OwnerArea; status?: string; ai?: string }) {
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
    // The AI assessment is read from storage only; a failure leaves the forecast intact.
    let view = null;
    if (staffing) { try { view = await getStaffingAssessmentView(getDatabase(), scope, "ORGANISATION", staffing); } catch { view = null; } }
    const names = Object.fromEntries((staffing?.outlets ?? []).map(outlet => [outlet.outletId, outlet.outletName]));
    const assessment = staffing === null && weekly === null ? null : <AiStaffingAssessment view={view} names={names} configured={configuration.aiConfigured} action={generateOwnerAssessmentAction} notice={ai}
      timeZone={staffing?.outlets.find(outlet => outlet.outletId === scope.locationId)?.timezone}
      planHref={(outletId, date) => outletId === scope.locationId ? `/manager/plan${date ? `?date=${date}` : ""}#add-requirement` : null} />;
    return <OwnerWeeklyForecast weekly={weekly} staffing={staffing} assessment={assessment} />;
  }
  const subscription=await subscriptionFor(getDatabase(),scope);
  const invitations=await getDatabase().select().from(teamInvitations).where(eq(teamInvitations.organisationId,scope.organisationId));
  let data;
  try { data = await getOwnerWorkspace(getDatabase(),scope.organisationId); } catch { return <WorkspaceUnavailable />; }
  const { locations, sales, payments, workforce, workPayments } = data;
  let history: Awaited<ReturnType<typeof loadDailySales>> = [], historyUnavailable = false;
  if (area === "reporting") { try { history = await loadDailySales(getDatabase(), scope.organisationId); } catch { historyUnavailable = true; } }
  let weekly = null, connections: Awaited<ReturnType<typeof getCommerceConnections>> = [], connectionsAvailable = true;
  if (area === "reporting") { try { weekly = await getWeeklyForecast(getDatabase(), scope); } catch { weekly = null; } }
  if (area === "reporting" || area === "settings") { try { connections = await getCommerceConnections(getDatabase(), scope); } catch { connectionsAvailable = false; } }
  // One Square location connects to one location here, but the view does not assume which.
  let squareActivity: { outletId: string; rows: Awaited<ReturnType<typeof getSquareActivity>> }[] = [];
  if (area === "reporting") { try { squareActivity = await Promise.all(connections.filter(row => row.provider === "SQUARE").map(async row => ({ outletId: row.outletId, rows: await getSquareActivity(getDatabase(), scope, row.outletId) }))); } catch { squareActivity = []; } }
  const operations = area === "policies" ? await getOperations(getDatabase(),scope) : null;
  const staffingConfiguration = area === "policies" ? await getStaffingConfiguration(getDatabase(),scope) : null;
  const title = { locations: "Locations", forecast: "Forecast & Staffing", reporting: "Sales", workforce: "Workforce & Managers", policies: "Work Terms & Incentive Policies", payments: "Payments", settings: "Settings & Integrations" }[area];
  return <>
    <PageHeader eyebrow="Owner / Admin" title={title} description="Business visibility across the locations currently configured for this organisation." />
    <ActionFeedback status={status} />{status?.startsWith("Your ") ? <p role="alert">{status}</p> : null}<form action={selectLocationAction} className="inline-form"><label>Operating location<select name="locationId" defaultValue={scope.locationId}>{locations.filter(l=>l.active).map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select></label><button className="secondary-button">Select location</button></form>
    {area === "locations" ? <>
      {locations.map((location) => <article className="panel" key={location.id}><h2><Link href={`/owner/locations/${location.id}`}>{location.name}</Link></h2><p>{location.timezone}</p><p>{sales.filter((sale) => sale.outletId === location.id).reduce((sum, sale) => sum + sale.records, 0)} recorded commercial entries · {payments.filter((payment) => payment.outletId === location.id).length} incentive results</p><Link className="text-link" href={`/owner/locations/${location.id}`}>Open location: commerce through staffing →</Link></article>)}
      <form action={createLocationAction} className="inline-form"><label>Location name<input name="name" required maxLength={150}/></label><button className="primary-button">Add location</button></form><p className="method-note">Only persisted locations are shown. Additional locations and their operating data have not been configured.</p>
    </> : null}
    {area === "reporting" ? <OwnerSales locations={locations} history={history} historyUnavailable={historyUnavailable} weekly={weekly} connections={connections} connectionsAvailable={connectionsAvailable} configured={commerceConnectionsConfigured() && squareSandboxCredentials() !== null} activity={squareActivity} /> : null}
    {area === "workforce" ? <section className="panel"><h2>Organisation workforce</h2>{workforce.length ? workforce.map((person) => <div className="record-row" key={person.name}><strong>{person.name}</strong><span>{person.type === "CASUAL" ? "Casual worker" : "Regular staff record"} · {person.status === "ACTIVE" ? "Active" : "Inactive"}</span></div>) : <p>No worker profiles have been created.</p>}<h3>Invite to {scope.locationName}</h3><form action={inviteAction} className="workspace-form form-grid"><label>Role<select name="role"><option value="MANAGER">Manager</option><option value="TEAM_MEMBER">Team Member</option></select></label><label>First name<input name="firstName" required /></label><label>Surname<input name="surname" required /></label><label>Telephone<input name="telephone" type="tel" required /></label><label>Email<input name="email" type="email" required /></label><button className="primary-button">Create & send FairShift invite</button></form><h3>Invitations</h3>{invitations.map(i=><div className="record-row" key={i.id}><span>{i.email} · {i.role.replaceAll("_"," ")} · {i.state.replaceAll("_"," ")}</span>{!["REDEEMED","REVOKED"].includes(i.state) ? <div><form action={resendInvitationAction}><input type="hidden" name="invitationId" value={i.id}/><button className="secondary-button">Resend invite</button></form><form action={revokeInvitationAction}><input type="hidden" name="invitationId" value={i.id}/><button className="secondary-button">Revoke</button></form></div>:null}</div>)}</section> : null}
    {area === "policies" && staffingConfiguration ? <StaffingConfiguration configuration={staffingConfiguration} locationName={scope.locationName} /> : null}
    {area === "policies" && operations ? <>
      <section className="panel"><h2>Location departments</h2>{operations.departments.map(d => <div className="record-row" key={d.id}>{d.name}</div>)}<form action={createDepartmentAction} className="inline-form"><label>Department name<input name="name" maxLength={100} required /></label><button className="primary-button">Add department</button></form></section>
      <section className="panel" id="work-policies"><h2>Owner-defined work policies</h2><p>Policies apply to new requirements. Existing assignment terms remain as offered. Managers select a policy and cannot change rates.</p>{operations.policies.map(p => <div className="record-row" key={p.id}><span>{p.name} · {p.earningsModel.toLowerCase()}</span><span>{p.earningsModel === "COMMISSION" ? `${(p.commissionBps ?? 0)/100}% · verified attributed sales` : `${money(p.rateMinor!, p.currencyCode)} / ${p.earningsModel === "HOURLY" ? "hour" : "day"}`}</span></div>)}
      <form action={createPolicyAction} className="workspace-form"><label>Policy name<input name="name" maxLength={100} required /></label><label>Earnings model<select name="earningsModel"><option value="HOURLY">Hourly</option><option value="DAILY">Daily</option><option value="COMMISSION">Commission</option></select></label><label>Rate ({operations.currency}) or commission percentage<input type="number" name="rate" min="0" step="0.01" required /></label><label>Individual sales target ({operations.currency}, optional)<input type="number" name="incentiveTarget" min="0.01" step="0.01" /></label><label>Fixed bonus ({operations.currency}, optional)<input type="number" name="incentiveBonus" min="0.01" step="0.01" /></label><p>A worker earns the bonus if their own attributed sales for the shift reach the target. Set both or neither, on hourly or daily terms; workers see them before accepting, and later changes don’t affect accepted work. Commission basis: verified attributed sales.</p><button className="primary-button">Create work policy</button></form></section>
      {scope.organisationId === DEMO_ORGANISATION_ID ? <section className="panel"><h2>Controlled demo incentive</h2><p>{money(DEMO_SHIFT_TERMS.incentiveAmountMinor)} when the recorded team result reaches {money(DEMO_SHIFT_TERMS.incentiveTargetMinor)}. Manager approval is required. This demo rule is separate from the policies above.</p></section> : null}
    </> : null}
    {area === "payments" ? <section className="panel"><h2>Work earnings payments</h2>{workPayments.length ? workPayments.map((payment) => <div className="record-row" key={payment.id}><span>{locations.find((location) => location.id === payment.outletId)?.name} · {payment.workerName} · {payment.shiftDate} · {money(payment.amountMinor, payment.currencyCode)}</span><PayableBadge status={payment.status} payout={payment.payout} /></div>) : <p>No confirmed work payables yet.</p>}<p className="method-note">Base payables of confirmed work, with manager approval and PayPal payout state. Paid is shown only after PayPal confirms the payment.</p></section> : null}
    {area === "payments" ? <section className="panel"><h2>Organisation incentive payments</h2>{payments.length ? payments.map((payment, index) => <div className="record-row" key={`${payment.outletId}-${payment.shiftDate}-${index}`}><span>{locations.find((location) => location.id === payment.outletId)?.name} · {payment.shiftDate} · {money(payment.amount, payment.currency)}</span><PaymentBadge status={payment.status} /></div>) : <p>No incentive results recorded.</p>}<p className="method-note">Approval and payment initiation belong to the location manager. This section covers incentive payouts.</p></section> : null}
    {area === "settings" ? <section className="panel"><h2>Organisation subscription</h2><Link href="/onboarding">Business details & subscription setup</Link><p>{subscription?.status ?? "UNCONFIGURED"}</p><p>{subscription?.verifiedAt ? `Last verified ${subscription.verifiedAt.toISOString()}`:"Not yet verified with PayPal."}</p><p>Subscription billing belongs to {scope.organisationName} and is separate from worker incentive payments. Sandbox only.</p><Link href="/subscribe">Review subscription</Link><form action={refreshSubscriptionAction}><button className="secondary-button">Check subscription with PayPal</button></form><h2>Organisation environment</h2><p>{locations.length} configured location{locations.length === 1 ? "" : "s"}</p><h3>PayPal worker payments</h3><p>{configuration.paypalPayoutConfigured ? "Sandbox credentials configured. Configuration does not establish current provider availability." : "Not configured."}</p><h3>Commercial data</h3><p>{!connectionsAvailable ? "Square connection status could not be loaded." : connections.some(row => row.provider === "SQUARE") ? `${connections.filter(row => row.provider === "SQUARE").length} of ${locations.filter(l=>l.active).length} active locations connected to Square Sandbox.` : "No location is connected to Square Sandbox."} {commerceConnectionsConfigured() && squareSandboxCredentials() ? "" : "Square Sandbox is not configured in this environment."}</p><p>Every sales record keeps its source; reference, demo, imported, Square Sandbox and PayPal Sandbox history are never combined. <Link href="/owner/reporting">Manage sales sources</Link></p></section> : null}
  </>;
}
