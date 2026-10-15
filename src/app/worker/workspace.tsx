import Link from "next/link";
import { PageHeader, StatePanel, StatusBadge } from "@/app/components/product-ui";
import { ActionFeedback, dateTime, money, PaymentBadge, ShiftTerms, TaskLink, WorkspaceUnavailable } from "@/app/components/workspace-ui";
import { acceptDemoShiftAction, saveDemoPayoutDestinationAction } from "@/app/scheduling-actions";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { getWorkerWorkspace } from "@/server/product/workspace";

export const workerAreas = ["shifts", "schedule", "performance", "earnings", "profile"] as const;
export type WorkerArea = "home" | typeof workerAreas[number];

function maskedEmail(value: string) {
  const [name, domain] = value.split("@");
  return `${name.slice(0, 1)}•••@${domain}`;
}

export async function WorkerWorkspace({ area, status }: { area: WorkerArea; status?: string }) {
  if (!getConfigurationStatus().databaseConfigured) return <WorkspaceUnavailable />;
  let data;
  try { data = await getWorkerWorkspace(getDatabase()); } catch { return <WorkspaceUnavailable />; }
  const { profile, assignments, currentShiftId } = data;
  const current = assignments.find((row) => row.shift.id === currentShiftId);
  const payments = assignments.filter((row) => row.incentive);
  const paid = payments.filter((row) => row.incentive?.status === "PAID").reduce((sum, row) => sum + (row.incentive?.earnedAmountMinor ?? 0), 0);
  const title = { home: `Welcome${profile ? `, ${profile.displayName}` : ""}`, shifts: "Your shift offers", schedule: "Your schedule", performance: "Your performance", earnings: "Your earnings", profile: "Your profile" }[area];
  return <>
    <PageHeader eyebrow="Rosebank Kitchen" title={title} description={area === "home" ? "Your work, next action and incentive payments." : undefined} />
    <ActionFeedback status={status} />
    {area === "home" ? <>
      {current ? <section className="panel"><StatusBadge>{current.shift.status === "COMPLETED" ? "Completed shift" : current.offer.status === "ACCEPTED" ? "Offer accepted" : "New offer"}</StatusBadge><h2>{current.shift.roleName}</h2><p>{dateTime(current.shift.startsAt)} · Johannesburg time</p><p>Guaranteed base pay {money(current.shift.guaranteedBasePayMinor)} · optional incentive {money(current.shift.incentiveAmountMinor)}</p><Link className="primary-button button-link" href={current.offer.status === "OFFERED" ? "/worker/shifts" : "/worker/schedule"}>{current.offer.status === "OFFERED" ? "Review shift offer" : "View your schedule"}</Link></section> : <StatePanel title="No shift offers yet"><p>New offers will appear in Shifts.</p></StatePanel>}
      <div className="task-grid"><TaskLink href="/worker/earnings" title="Incentive payments">{money(paid)} paid · {current?.incentive ? "Review your latest payment status." : "No current shift result yet."}</TaskLink><TaskLink href="/worker/profile" title={profile?.paypalPayoutEmail ? "Your profile" : "Complete payment settings"}>{profile?.paypalPayoutEmail ? "Payment destination saved for future approved incentives." : "Add your PayPal email once in Profile."}</TaskLink></div>
    </> : null}
    {area === "shifts" ? assignments.length ? assignments.map((row) => <article className="panel" key={row.shift.id}>
      <StatusBadge>{row.offer.status === "ACCEPTED" ? "Offer accepted" : row.offer.status === "OFFERED" ? "Awaiting your response" : "Offer closed"}</StatusBadge><h2>{row.shift.roleName}</h2><ShiftTerms shift={row.shift} />
      <details><summary>Incentive and gratuity terms</summary><p>{row.shift.incentivePolicy} Published team target: {money(row.shift.incentiveTargetMinor)}.</p><p>{row.shift.gratuityPolicy}</p></details>
      {row.offer.acceptedAt ? <p>You accepted on {dateTime(row.offer.acceptedAt)}.</p> : null}
      {row.shift.id === currentShiftId && row.offer.status === "OFFERED" && row.shift.status === "PUBLISHED" ? <form action={acceptDemoShiftAction}><input type="hidden" name="shiftId" value={row.shift.id} /><button className="primary-button" type="submit">Accept shift</button></form> : null}
    </article>) : <StatePanel title="No shift offers yet"><p>You will see complete terms here when an offer is sent.</p></StatePanel> : null}
    {area === "schedule" ? assignments.some((row) => row.offer.status === "ACCEPTED") ? assignments.filter((row) => row.offer.status === "ACCEPTED").map((row) => <article className="panel" key={row.shift.id}><StatusBadge>{row.shift.status === "COMPLETED" ? "Completed" : "Accepted shift"}</StatusBadge><h2>{row.shift.roleName} · Rosebank Kitchen</h2><ShiftTerms shift={row.shift} /><Link className="text-link" href="/worker/earnings">View earnings →</Link></article>) : <StatePanel title="No accepted shifts"><Link href="/worker/shifts">Review your offers</Link></StatePanel> : null}
    {area === "performance" ? <>
      <p className="method-note">Your incentive outcome is based on the manager-recorded shift result. Individual sales attribution is unavailable.</p>
      {payments.length ? payments.map((row) => <article className="panel" key={row.shift.id}><h2>{row.shift.shiftDate} · incentive outcome</h2><p>{row.incentive?.status === "NOT_EARNED" ? "The published team target was not met." : "The published team target was met."}</p><p>Your calculated incentive: {money(row.incentive?.earnedAmountMinor ?? 0)}.</p><PaymentBadge status={row.incentive?.status} /></article>) : <StatePanel title="Awaiting a shift result"><p>Your incentive outcome appears after completed work is reviewed.</p></StatePanel>}
    </> : null}
    {area === "earnings" ? <>
      <section className="overview-strip"><div><span>Incentives paid</span><strong>{money(paid)}</strong></div><div><span>Awaiting approval</span><strong>{money(payments.filter((row) => row.incentive?.status === "EARNED").reduce((sum, row) => sum + (row.incentive?.earnedAmountMinor ?? 0), 0))}</strong></div><div><span>Approved or processing</span><strong>{money(payments.filter((row) => ["APPROVED", "SUBMITTING", "SUBMITTED", "PROCESSING"].includes(row.incentive?.status ?? "")).reduce((sum, row) => sum + (row.incentive?.earnedAmountMinor ?? 0), 0))}</strong></div></section>
      {!profile?.paypalPayoutEmail ? <StatePanel title="Complete your payment settings" tone="warning"><Link href="/worker/profile">Add your PayPal email in Profile</Link></StatePanel> : null}
      <p className="method-note">This history covers incentive payments through PayPal Sandbox. Agreed base pay is shown with your shift terms; base pay and gratuity payment status are not tracked here.</p>
      {payments.length ? payments.map((row) => <article className="panel" key={row.shift.id}><h2>{row.shift.shiftDate} · {money(row.incentive?.earnedAmountMinor ?? 0)} incentive</h2><PaymentBadge status={row.incentive?.status} />{row.incentive?.paidAt ? <p>Confirmed paid on {dateTime(row.incentive.paidAt)}.</p> : null}{row.incentive?.status === "FAILED" ? <p>Your payment needs attention. Ask your manager to review its status.</p> : null}</article>) : <StatePanel title="No incentive payments yet" />}
    </> : null}
    {area === "profile" ? <>
      <section className="panel"><h2>Profile details</h2><p>{profile?.displayName ?? "Casual worker"} · Rosebank Kitchen</p><p>Availability and preference editing are not available in this environment.</p></section>
      <section className="panel"><h2>Payment settings</h2><p>{profile?.paypalPayoutEmail ? `PayPal destination saved: ${maskedEmail(profile.paypalPayoutEmail)}` : "Add a PayPal email to receive future approved incentives."}</p><form action={saveDemoPayoutDestinationAction} className="workspace-form"><label>{profile?.paypalPayoutEmail ? "Update PayPal email" : "PayPal payout email"}<input name="payoutEmail" type="email" autoComplete="email" maxLength={254} required /></label><button className="primary-button" type="submit">Save payment settings</button></form><p className="method-note">Saved for your profile across shifts. Saving details does not send a payment.</p></section>
    </> : null}
  </>;
}
