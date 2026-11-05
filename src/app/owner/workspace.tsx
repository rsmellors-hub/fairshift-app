import { requireScope } from "@/server/auth/request";
import { createLocationAction, inviteAction, refreshSubscriptionAction, selectLocationAction, revokeInvitationAction, resendInvitationAction } from "@/app/auth-actions";
import { subscriptionFor } from "@/server/billing/service";
import { memberships, teamInvitations, users } from "@/server/db/schema";
import { and, eq } from "drizzle-orm";
import Link from "next/link";
import { createDepartmentAction, createPolicyAction } from "@/app/operations-actions";
import { getOperations } from "@/server/scheduling/operations";
import { PageHeader, StatusBadge } from "@/app/components/product-ui";
import { ActionFeedback, money, PayableBadge, PaymentBadge, WorkspaceUnavailable } from "@/app/components/workspace-ui";
import OwnerPage from "@/app/owner/page";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { getWeeklyForecast } from "@/server/intelligence/weekly";
import { getWeeklyStaffing } from "@/server/intelligence/staffing";
import { loadDailySales, syntheticHistoryAllowed } from "@/server/intelligence/sales-history";
import { OwnerWeeklyForecast } from "@/app/owner/weekly-forecast";
import { getOwnerWorkspace } from "@/server/product/workspace";
import { getStaffingAssessmentView } from "@/server/intelligence/ai-staffing";
import { getStaffingConfiguration } from "@/server/intelligence/business-policy";
import { StaffingConfiguration } from "@/app/owner/staffing-configuration";
import { AiStaffingAssessment } from "@/app/components/ai-staffing-assessment";
import { explainWageAction, generateOwnerAssessmentAction } from "@/app/intelligence-actions";
import { commerceConnectionsConfigured, getCommerceConnections } from "@/server/commerce/connections";
import { OwnerSales, type SalesFilter } from "@/app/owner/sales";
import { labourHours, longDate } from "@/app/components/staffing";
import { getSquareActivity, squareSandboxCredentials } from "@/server/commerce/square-connection";
import { localDate } from "@/server/intelligence/forecast";
import { checkWage } from "@/server/domain/statutory-wage";
import { PolicyForm } from "@/app/owner/policy-form";
import { PolicyWageCell, WageBelowNotice, WageReferencePanel } from "@/app/owner/wage-reference";

export const ownerAreas = ["locations", "forecast", "reporting", "workforce", "policies", "payments", "settings"] as const;
export type OwnerArea = "overview" | typeof ownerAreas[number];

const SUBSCRIPTION_STATE: Record<string, string> = { ACTIVE: "Active", UNCONFIGURED: "Not started", PENDING: "Not started", APPROVAL_PENDING: "Awaiting PayPal approval", APPROVED: "Awaiting confirmation" };
const INVITATION_STATE: Record<string, string> = { CREATED_NOT_SENT: "Prepared, not sent", SENT: "Invited", DELIVERY_FAILED: "Couldn’t be sent", REDEEMED: "Joined", REVOKED: "Revoked" };

export async function OwnerWorkspace({ area, status, ai, salesFilter }: { area: OwnerArea; status?: string; ai?: string; salesFilter?: SalesFilter }) {
  if (area === "overview") return OwnerPage({});
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
  if (area === "reporting") { try { history = await loadDailySales(getDatabase(), scope.organisationId, undefined, syntheticHistoryAllowed(scope)); } catch { historyUnavailable = true; } }
  let weekly = null, connections: Awaited<ReturnType<typeof getCommerceConnections>> = [], connectionsAvailable = true;
  if (area === "reporting") { try { weekly = await getWeeklyForecast(getDatabase(), scope); } catch { weekly = null; } }
  if (area === "reporting" || area === "settings") { try { connections = await getCommerceConnections(getDatabase(), scope); } catch { connectionsAvailable = false; } }
  // One Square location connects to one location here, but the view does not assume which.
  let squareActivity: { outletId: string; rows: Awaited<ReturnType<typeof getSquareActivity>> }[] = [];
  if (area === "reporting") { try { squareActivity = await Promise.all(connections.filter(row => row.provider === "SQUARE").map(async row => ({ outletId: row.outletId, rows: await getSquareActivity(getDatabase(), scope, row.outletId) }))); } catch { squareActivity = []; } }
  let staffing: Awaited<ReturnType<typeof getWeeklyStaffing>> | null = null;
  if (area === "locations") { try { staffing = await getWeeklyStaffing(getDatabase(), scope, new Date()); } catch { staffing = null; } }
  const managers = area === "workforce" ? await getDatabase().select({ id: memberships.id, state: memberships.state, outletId: memberships.outletId, name: users.name, email: users.email }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(and(eq(memberships.organisationId, scope.organisationId), eq(memberships.role, "MANAGER"))) : [];
  const operations = area === "policies" ? await getOperations(getDatabase(),scope) : null;
  const staffingConfiguration = area === "policies" ? await getStaffingConfiguration(getDatabase(),scope) : null;
  const title = { locations: "Locations", forecast: "Forecast & Staffing", reporting: "Sales", workforce: "Managers", policies: "Compensation & incentives", payments: "Payments", settings: "Settings" }[area];
  const description = { locations: "Every location, with its sales, staffing gap and payments.", forecast: "", reporting: "What your locations have recorded, and where each figure comes from.", workforce: "Who runs each location. Casual workers are managed at their location.", policies: "What managers may offer at each location. Managers choose from these terms and can’t change them.", payments: "Every approved shift and its PayPal status, across the business.", settings: "Your subscription and connected services." }[area];
  const active = locations.filter(location => location.active);
  // Today at the selected location: the date the Owner's terms are checked against here.
  const today = operations ? localDate(new Date(), operations.timezone) : "";
  const belowMinimum = operations ? operations.policies.filter(p => p.earningsModel === "HOURLY" && p.rateMinor !== null
    && checkWage({ jurisdiction: operations.wageJurisdiction, date: today, currencyCode: p.currencyCode, terms: { earningsModel: "HOURLY", rateMinor: p.rateMinor } }).status === "BELOW_DEMO_MINIMUM").length : 0;
  return <>
    <PageHeader eyebrow={scope.organisationName} title={title} description={description} />
    <ActionFeedback status={status} />{status?.startsWith("Your ") ? <p className="form-alert" role="alert">{status}</p> : null}
    {area === "locations" ? <>
      <div className="table-frame"><table className="data-table"><caption className="visually-hidden">Locations in this business</caption><thead><tr><th scope="col">Location</th><th scope="col">Sales records</th><th scope="col">Casual gap, next week</th><th scope="col">Time zone</th><th scope="col"><span className="visually-hidden">Open</span></th></tr></thead><tbody>
        {locations.map(location => { const outlet = staffing?.outlets.find(row => row.outletId === location.id); return <tr key={location.id}><th scope="row"><Link href={`/owner/locations/${location.id}`}><strong>{location.name}</strong></Link>{!location.active ? <small>Inactive location</small> : null}</th>
          <td data-label="Sales records">{sales.filter(sale => sale.outletId === location.id).reduce((sum, sale) => sum + sale.records, 0)} recorded commercial entries{payments.some(payment => payment.outletId === location.id) ? <small>{payments.filter(payment => payment.outletId === location.id).length} incentive results</small> : null}</td>
          <td data-label="Casual gap, next week"><strong>{outlet?.totals ? labourHours(outlet.totals.casualGapMinutes) : "Not available"}</strong></td>
          <td data-label="Time zone">{location.timezone}</td>
          <td><Link className="text-link" href={`/owner/locations/${location.id}`}>Open location <span aria-hidden="true">→</span></Link></td></tr>; })}
      </tbody></table></div>
      <details className="panel disclosure"><summary>Add a location</summary><form action={createLocationAction} className="inline-form"><label>Location name<input name="name" required maxLength={150}/></label><button className="primary-button">Add location</button></form><p className="note">Your plan sets how many active locations you can have.</p></details>
    </> : null}
    {area === "reporting" ? <OwnerSales locations={locations} history={history} historyUnavailable={historyUnavailable} weekly={weekly} connections={connections} connectionsAvailable={connectionsAvailable} configured={commerceConnectionsConfigured() && squareSandboxCredentials() !== null} activity={squareActivity} filter={salesFilter} /> : null}
    {area === "workforce" ? <>
      <section className="panel"><h2>Managers</h2>{managers.length ? <div className="table-frame"><table className="data-table"><caption className="visually-hidden">Managers and their locations</caption><thead><tr><th scope="col">Name</th><th scope="col">Location</th><th scope="col">Status</th></tr></thead><tbody>{managers.map(row => <tr key={row.id}><th scope="row">{row.name || row.email}<small>{row.name ? row.email : ""}</small></th><td data-label="Location">{locations.find(location => location.id === row.outletId)?.name ?? "Not assigned"}</td><td data-label="Status">{row.state === "ACTIVE" ? "Active" : "Inactive"}</td></tr>)}</tbody></table></div> : <p>No managers yet. You can run a location yourself, or invite a manager below.</p>}</section>
      <section className="panel"><h2>Invite to {scope.locationName}</h2><form action={inviteAction} className="workspace-form form-grid"><label>Role<select name="role"><option value="MANAGER">Manager</option><option value="TEAM_MEMBER">Casual worker</option></select></label><label>First name<input name="firstName" required /></label><label>Surname<input name="surname" required /></label><label>Telephone<input name="telephone" type="tel" required /></label><label>Email<input name="email" type="email" required /></label><button className="primary-button">Create & send FairShift invite</button></form></section>
      <section className="panel"><h2>Invitations</h2>{invitations.length ? invitations.map(i=><div className="record-row" key={i.id}><span><strong>{i.email}</strong><small>{i.role === "MANAGER" ? "Manager" : "Casual worker"} · {INVITATION_STATE[i.state] ?? "Pending"}</small></span>{!["REDEEMED","REVOKED"].includes(i.state) ? <div className="button-row"><form action={resendInvitationAction}><input type="hidden" name="invitationId" value={i.id}/><button className="secondary-button">Resend invite</button></form><form action={revokeInvitationAction}><input type="hidden" name="invitationId" value={i.id}/><button className="secondary-button">Revoke</button></form></div>:null}</div>) : <p>No invitations yet.</p>}</section>
      <section className="panel"><h2>Casual and regular staff</h2><p className="panel-lede">{workforce.filter(person => person.type === "CASUAL").length} casual workers and {workforce.filter(person => person.type !== "CASUAL").length} regular staff records. Managers look after these at each location.</p>{workforce.length ? <details className="disclosure-inline"><summary>Show everyone</summary>{workforce.map((person) => <div className="record-row" key={person.name}><strong>{person.name}</strong><span>{person.type === "CASUAL" ? "Casual worker" : "Regular staff record"} · {person.status === "ACTIVE" ? "Active" : "Inactive"}</span></div>)}</details> : <p>No worker profiles have been created.</p>}</section>
    </> : null}
    {area === "policies" ? <form action={selectLocationAction} className="filter-row context-picker" data-demo-write=""><label>Location<select name="locationId" defaultValue={scope.locationId}>{active.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select></label><button className="secondary-button">Switch location</button></form> : null}
    {area === "policies" && operations ? <>
      <WageReferencePanel jurisdiction={operations.wageJurisdiction} today={today} locationName={scope.locationName} currency={operations.currency} />
      <section className="panel" id="compensation"><h2>Compensation · {scope.locationName}</h2>
        <p className="panel-lede">Hourly or daily terms for shifts here. Later changes don’t affect work a worker has already accepted.</p>
        {operations.policies.length ? <div className="table-frame"><table className="data-table"><caption className="visually-hidden">Work policies at this location</caption><thead><tr><th scope="col">Terms</th><th scope="col">Basis</th><th scope="col">Pay</th><th scope="col">Minimum wage check · today</th></tr></thead><tbody>{operations.policies.map(p => <tr key={p.id}><th scope="row">{p.name}</th><td data-label="Basis">{p.earningsModel === "HOURLY" ? "Hourly" : p.earningsModel === "DAILY" ? "Daily, fixed for the shift" : "Commission"}</td><td data-label="Pay"><strong>{p.earningsModel === "COMMISSION" ? `${(p.commissionBps ?? 0)/100}% · verified attributed sales` : `${money(p.rateMinor!, p.currencyCode)} / ${p.earningsModel === "HOURLY" ? "hour" : "day"}`}</strong></td><td data-label="Minimum wage check" className="wage-cell"><PolicyWageCell policy={p} jurisdiction={operations.wageJurisdiction} today={today} /></td></tr>)}</tbody></table></div> : <p>No terms set yet, so managers can’t create shifts here.</p>}
        <WageBelowNotice count={belowMinimum} />
      </section>
      <section className="panel" id="work-policies"><h2>Incentives · {scope.locationName}</h2>
        <p className="panel-lede">An individual sales target with a fixed bonus. Workers see them before accepting.</p>
        {operations.policies.some(p => p.incentiveTargetMinor) ? <ul className="incentive-list">{operations.policies.filter(p => p.incentiveTargetMinor).map(p => <li key={p.id}><span>{p.name}</span><strong>Reach {money(p.incentiveTargetMinor!, p.currencyCode)} attributed sales <span aria-hidden="true">→</span> earn {money(p.incentiveBonusMinor!, p.currencyCode)} bonus</strong></li>)}</ul> : <p>No incentive set yet.</p>}
        <details className="disclosure-inline" open={!operations.policies.length}><summary>Create new terms</summary><PolicyForm action={createPolicyAction} currency={operations.currency} jurisdiction={operations.wageJurisdiction} today={today} explainAction={configuration.aiConfigured && !scope.demo ? explainWageAction : null} /></details>
      </section>
    </> : null}
    {area === "policies" && staffingConfiguration ? <StaffingConfiguration configuration={staffingConfiguration} locationName={scope.locationName} /> : null}
    {area === "policies" && operations ? <>
      <details className="panel disclosure"><summary>Departments · {scope.locationName}</summary>{operations.departments.map(d => <div className="record-row" key={d.id}>{d.name}</div>)}<form action={createDepartmentAction} className="inline-form"><label>Department name<input name="name" maxLength={100} required /></label><button className="primary-button">Add department</button></form></details>
    </> : null}
    {area === "payments" ? <section className="panel"><h2>Work earnings payments</h2><p className="panel-lede">Approve and send from Review &amp; pay at each location, yourself or through its manager. Paid shows only after PayPal confirms the payment.</p>{workPayments.length ? <div className="table-frame"><table className="data-table"><caption className="visually-hidden">Approved work and payment status</caption><thead><tr><th scope="col">Location</th><th scope="col">Worker</th><th scope="col">Shift</th><th scope="col">Total</th><th scope="col">Status</th></tr></thead><tbody>{workPayments.map((payment) => <tr key={payment.id}><th scope="row">{locations.find((location) => location.id === payment.outletId)?.name}</th><td data-label="Worker">{payment.workerName}</td><td data-label="Shift">{longDate(payment.shiftDate)}</td><td data-label="Total"><strong>{money(payment.amountMinor, payment.currencyCode)}</strong></td><td data-label="Status"><PayableBadge status={payment.status} payout={payment.payout} /></td></tr>)}</tbody></table></div> : <p>No confirmed work payables yet.</p>}</section> : null}
    {area === "payments" && payments.length ? <section className="panel"><h2>Organisation incentive payments</h2>{payments.map((payment, index) => <div className="record-row" key={`${payment.outletId}-${payment.shiftDate}-${index}`}><span>{locations.find((location) => location.id === payment.outletId)?.name} · {payment.shiftDate} · {money(payment.amount, payment.currency)}</span><PaymentBadge status={payment.status} /></div>)}</section> : null}
    {area === "settings" ? <>
      <section className="panel"><h2>Subscription</h2><p><strong>{SUBSCRIPTION_STATE[subscription?.status ?? ""] ?? "Needs attention"}</strong>{subscription?.tier ? ` · ${subscription.tier === "SINGLE_OUTLET" ? "Single Outlet" : subscription.tier === "MULTI_OUTLET" ? "Multi Outlet" : "Enterprise"}${subscription.billingPeriod ? `, billed ${subscription.billingPeriod === "ANNUAL" ? "annually" : "monthly"}` : ""}` : ""}</p><p className="note">{subscription?.verifiedAt ? `Last confirmed with PayPal ${new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" }).format(subscription.verifiedAt)}. ` : "Not yet confirmed with PayPal. "}Billed through PayPal Sandbox in this environment, separately from worker payments.</p><div className="button-row"><Link className="secondary-button button-link" href="/subscribe">Review subscription</Link><form action={refreshSubscriptionAction}><button className="secondary-button">Check subscription with PayPal</button></form></div></section>
      <section className="panel"><h2>Connected services</h2>
        <div className="record-row"><span><strong>PayPal worker payments</strong><small>Sends approved earnings. PayPal Sandbox in this environment.</small></span><StatusBadge tone={configuration.paypalPayoutConfigured ? "success" : "warning"}>{configuration.paypalPayoutConfigured ? "Set up" : "Not set up"}</StatusBadge></div>
        <div className="record-row"><span><strong>Square Sandbox</strong><small>{!connectionsAvailable ? "Connection status could not be loaded." : connections.some(row => row.provider === "SQUARE") ? `${connections.filter(row => row.provider === "SQUARE").length} of ${active.length} active locations connected.` : "No location is connected."} <Link href="/owner/reporting">Manage sales sources</Link></small></span><StatusBadge tone={commerceConnectionsConfigured() && squareSandboxCredentials() ? "success" : "warning"}>{commerceConnectionsConfigured() && squareSandboxCredentials() ? "Available" : "Not set up"}</StatusBadge></div>
        <p className="note">Every sales record keeps its source. Reference, imported, Square Sandbox and PayPal Sandbox history are never combined.</p>
      </section>
      <section className="panel"><h2>Business</h2><p>{scope.organisationName} · {locations.length} {locations.length === 1 ? "location" : "locations"}</p></section>
    </> : null}
  </>;
}
