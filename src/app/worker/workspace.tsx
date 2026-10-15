import Link from "next/link";
import { AssignmentResponse } from "@/app/components/assignment-response";
import { PageHeader, StatePanel, StatusBadge } from "@/app/components/product-ui";
import { ActionFeedback, dateTime, money, PaymentBadge, ShiftTerms, TaskLink, WorkspaceUnavailable } from "@/app/components/workspace-ui";
import { saveDemoPayoutDestinationAction } from "@/app/scheduling-actions";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { getWorkerWorkspace } from "@/server/product/workspace";

export const workerAreas = ["shifts", "earnings", "profile"] as const;
export type WorkerArea = "home" | typeof workerAreas[number];

function maskedEmail(value: string) {
  const [name, domain] = value.split("@");
  return `${name.slice(0, 1)}•••@${domain}`;
}

export async function WorkerWorkspace({ area, status }: { area: WorkerArea; status?: string }) {
  if (!getConfigurationStatus().databaseConfigured) return <WorkspaceUnavailable />;
  let data;
  try { data = await getWorkerWorkspace(getDatabase()); } catch { return <WorkspaceUnavailable />; }
  const { profile, assignments } = data;
  const outstanding = assignments.filter(row => row.offer.status === "OFFERED" && row.shift.status === "PUBLISHED");
  const nextAccepted = assignments.filter(row => row.offer.status === "ACCEPTED" && row.shift.status === "PUBLISHED" && row.shift.endsAt > new Date()).sort((a,b) => a.shift.startsAt.getTime() - b.shift.startsAt.getTime())[0];
  const current = nextAccepted ?? outstanding[0];
  const payments = assignments.filter((row) => row.incentive);
  const paid = payments.filter((row) => row.incentive?.status === "PAID").reduce((sum, row) => sum + (row.incentive?.earnedAmountMinor ?? 0), 0);
  const title = { home: `Welcome${profile ? `, ${profile.displayName}` : ""}`, shifts: "Your shift offers", earnings: "Your earnings", profile: "Your profile" }[area];
  return <>
    <PageHeader eyebrow="Rosebank Kitchen" title={title} description={area === "home" ? "Your work, next action and incentive payments." : undefined} />
    <ActionFeedback status={status} />
    {area === "home" ? <>
      {outstanding.length ? <p><Link href="/worker/shifts">{outstanding.length} assignment offer{outstanding.length === 1 ? "" : "s"} awaiting your response →</Link></p> : null}
      {current ? <section className="panel"><StatusBadge>{current.shift.status === "COMPLETED" ? "Completed shift" : current.offer.status === "ACCEPTED" ? current.allocation?.state === "ALLOCATED" ? "Allocated" : "Accepted · awaiting allocation" : "New offer"}</StatusBadge><h2>{current.shift.roleName}</h2><p>{dateTime(current.shift.startsAt)} · Johannesburg time</p><p>{current.shift.earningsModel === "COMMISSION" ? `Commission: ${(current.shift.commissionBps ?? 0) / 100}% of verified attributed sales` : `Expected work earnings ${money(current.shift.expectedEarningsMinor ?? current.shift.guaranteedBasePayMinor)}`} · potential incentive {money(current.shift.incentiveAmountMinor)}</p><Link className="primary-button button-link" href="/worker/shifts">{current.offer.status === "OFFERED" ? "Review shift offer" : "View your schedule"}</Link></section> : <StatePanel title="No upcoming assignments"><p>New offers will appear in Shifts.</p></StatePanel>}
      <div className="task-grid"><TaskLink href="/worker/earnings" title="Incentive payments">{money(paid)} paid · {current?.incentive ? "Review your latest payment status." : "No current shift result yet."}</TaskLink><TaskLink href="/worker/profile" title={profile?.paypalPayoutEmail ? "Your profile" : "Complete payment settings"}>{profile?.paypalPayoutEmail ? "Payment destination saved for future approved incentives." : "Add your PayPal email once in Profile."}</TaskLink></div>
    </> : null}
    {area === "shifts" ? assignments.length ? assignments.map((row) => <article className="panel" key={row.shift.id}>
      <StatusBadge>{row.offer.status === "ACCEPTED" ? "Offer accepted" : row.offer.status === "OFFERED" ? "Awaiting your response" : "Offer closed"}</StatusBadge><h2>{row.departmentName ?? row.shift.roleName}</h2><p>Terms version {row.shift.termsVersion} · {row.allocation?.state === "ALLOCATED" ? "Allocated" : row.offer.status === "ACCEPTED" ? "Awaiting allocation" : "Offer"}</p><ShiftTerms shift={row.shift} />
      <details><summary>Incentive and gratuity terms</summary><p>{row.shift.incentivePolicy} Published team target: {money(row.shift.incentiveTargetMinor)}.</p><p>{row.shift.gratuityPolicy}</p></details>
      {row.offer.acceptedAt ? <p>You accepted on {dateTime(row.offer.acceptedAt)}.</p> : null}
      {row.offer.status === "OFFERED" && row.shift.status === "PUBLISHED" ? <AssignmentResponse offerId={row.offer.id} version={row.shift.termsVersion} /> : null}
    </article>) : <StatePanel title="No shift offers yet"><p>You will see complete terms here when an offer is sent.</p></StatePanel> : null}
    {area === "earnings" ? <>
      <section className="overview-strip"><div><span>Incentives paid</span><strong>{money(paid)}</strong></div><div><span>Awaiting approval</span><strong>{money(payments.filter((row) => row.incentive?.status === "EARNED").reduce((sum, row) => sum + (row.incentive?.earnedAmountMinor ?? 0), 0))}</strong></div><div><span>Approved or processing</span><strong>{money(payments.filter((row) => ["APPROVED", "SUBMITTING", "SUBMITTED", "PROCESSING"].includes(row.incentive?.status ?? "")).reduce((sum, row) => sum + (row.incentive?.earnedAmountMinor ?? 0), 0))}</strong></div></section>
      <section className="panel"><h2>Work earnings</h2>{assignments.filter(r => r.offer.status === "ACCEPTED").map(row => <div className="record-row" key={row.offer.id}><span>{row.shift.shiftDate} · {row.departmentName ?? row.shift.roleName}</span><span>{row.shift.earningsModel === "COMMISSION" ? "Commission awaiting verified attributed sales" : `${money(row.shift.expectedEarningsMinor ?? row.shift.guaranteedBasePayMinor)} expected work earnings`} · {row.allocation?.confirmedAt ? "Work confirmed" : "Awaiting work confirmation"}</span></div>)}</section>
      {!profile?.paypalPayoutEmail ? <StatePanel title="Complete your payment settings" tone="warning"><Link href="/worker/profile">Add your PayPal email in Profile</Link></StatePanel> : null}
      <p className="method-note">This history covers incentive payments through PayPal Sandbox. Expected work earnings are shown with your shift terms; work earnings and gratuity payment status are not tracked here.</p>
      {payments.length ? payments.map((row) => <article className="panel" key={row.shift.id}><h2>{row.shift.shiftDate} · {money(row.incentive?.earnedAmountMinor ?? 0)} incentive</h2><PaymentBadge status={row.incentive?.status} />{row.incentive?.paidAt ? <p>Confirmed paid on {dateTime(row.incentive.paidAt)}.</p> : null}{row.incentive?.status === "FAILED" ? <p>Your payment needs attention. Ask your manager to review its status.</p> : null}</article>) : <StatePanel title="No incentive payments yet" />}
    </> : null}
    {area === "profile" ? <>
      <section className="panel"><h2>Profile details</h2><p>{profile?.displayName ?? "Casual worker"} · Rosebank Kitchen</p><p>FairShift sales attribution code: {profile?.attributionCode ?? "Unavailable"}</p><p>Availability and preference editing are not available in this environment.</p></section>
      <section className="panel"><h2>Payment settings</h2><p>{profile?.paypalPayoutEmail ? `PayPal destination saved: ${maskedEmail(profile.paypalPayoutEmail)}` : "Add a PayPal email to receive future approved incentives."}</p><form action={saveDemoPayoutDestinationAction} className="workspace-form"><label>{profile?.paypalPayoutEmail ? "Update PayPal email" : "PayPal payout email"}<input name="payoutEmail" type="email" autoComplete="email" maxLength={254} required /></label><button className="primary-button" type="submit">Save payment settings</button></form><p className="method-note">Saved for your profile across shifts. Saving details does not send a payment.</p></section>
    </> : null}
  </>;
}
