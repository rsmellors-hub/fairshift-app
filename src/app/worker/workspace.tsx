import { requireScope } from "@/server/auth/request";
import { workerWorkspace } from "@/server/auth/operations";
import { listNotifications } from "@/server/notifications/service";
import Link from "next/link";
import { AssignmentResponse } from "@/app/components/assignment-response";
import { PageHeader, StatePanel, StatusBadge } from "@/app/components/product-ui";
import { ActionFeedback, currencyTotals, dateTime, money, PayableBadge, payableBasis, PaymentBadge, ShiftTerms, TaskLink, WorkspaceUnavailable } from "@/app/components/workspace-ui";
import { saveDemoPayoutDestinationAction } from "@/app/scheduling-actions";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";

export const workerAreas = ["shifts", "earnings", "profile"] as const;
export type WorkerArea = "home" | typeof workerAreas[number];

function maskedEmail(value: string) {
  const [name, domain] = value.split("@");
  return `${name.slice(0, 1)}•••@${domain}`;
}

export async function WorkerWorkspace({ area, status }: { area: WorkerArea; status?: string }) {
  if (!getConfigurationStatus().databaseConfigured) return <WorkspaceUnavailable />;
  const scope=await requireScope(["TEAM_MEMBER"]);
  const notices=await listNotifications(getDatabase(),scope.userId);
  let data;
  try { data = await workerWorkspace(getDatabase(),scope); } catch { return <WorkspaceUnavailable />; }
  const { profile, assignments, timezone } = data;
  const outstanding = assignments.filter(row => row.offer.status === "OFFERED" && row.shift.status === "PUBLISHED");
  const nextAccepted = assignments.filter(row => row.offer.status === "ACCEPTED" && row.shift.status === "PUBLISHED" && row.shift.endsAt > new Date()).sort((a,b) => a.shift.startsAt.getTime() - b.shift.startsAt.getTime())[0];
  const current = nextAccepted ?? outstanding[0];
  const payments = assignments.filter((row) => row.incentive);
  const incentiveTotal = (statuses: readonly string[]) => currencyTotals(payments.filter((row) => statuses.includes(row.incentive?.status ?? "")).map((row) => ({ amountMinor: row.incentive?.earnedAmountMinor ?? 0, currencyCode: row.shift.currencyCode }))) || money(0, payments[0]?.shift.currencyCode);
  // Work earnings: expected before confirmation, base payable after it. Neither is a payment.
  const accepted = assignments.filter((row) => row.offer.status === "ACCEPTED");
  const expectedTotal = currencyTotals(accepted.filter((row) => !row.payable && row.shift.earningsModel !== "COMMISSION" && !row.allocation?.confirmedAt).map((row) => ({ amountMinor: row.shift.expectedEarningsMinor ?? row.shift.guaranteedBasePayMinor, currencyCode: row.shift.currencyCode })));
  const payableTotal = currencyTotals(accepted.flatMap((row) => row.payable?.status === "PENDING_REVIEW" ? [{ amountMinor: row.payable.baseAmountMinor, currencyCode: row.payable.currencyCode }] : []));
  // Approved amounts not yet confirmed paid, and amounts PayPal has reported paid.
  const approvedTotal = currencyTotals(accepted.flatMap((row) => row.payable?.status === "APPROVED" && row.payout?.status !== "PAID" ? [{ amountMinor: row.payable.baseAmountMinor, currencyCode: row.payable.currencyCode }] : []));
  const inPayPalTotal = currencyTotals(accepted.flatMap((row) => row.payout && ["SUBMITTING", "PROCESSING", "RECONCILIATION_REQUIRED"].includes(row.payout.status) ? [{ amountMinor: row.payout.amountMinor, currencyCode: row.payout.currencyCode }] : []));
  const notSentTotal = currencyTotals(accepted.flatMap((row) => row.payable?.status === "APPROVED" && (!row.payout || ["NOT_SENT", "FAILED"].includes(row.payout.status)) ? [{ amountMinor: row.payable.baseAmountMinor, currencyCode: row.payable.currencyCode }] : []));
  const paidTotal = currencyTotals(accepted.flatMap((row) => row.payout?.status === "PAID" ? [{ amountMinor: row.payout.amountMinor, currencyCode: row.payout.currencyCode }] : []));
  const paymentDetailsNeeded = !profile?.paypalPayoutEmail && accepted.some((row) => row.payable?.status === "APPROVED" && (!row.payout || row.payout.status === "NOT_SENT"));
  const title = { home: `Welcome${profile ? `, ${profile.displayName}` : ""}`, shifts: "Your shift offers", earnings: "Your earnings", profile: "Your profile" }[area];
  return <>
    <PageHeader eyebrow={scope.locationName} title={title} description={area === "home" ? "Your work, next action and incentive payments." : undefined} />
    <ActionFeedback status={status} />
    {area === "home" ? <>
      {notices.filter(n => !n.readAt).slice(0,3).map(n => <div className="record-row" key={n.id}><strong>{n.title}</strong><Link href={n.href}>Review</Link></div>)}
      {notices.some(n => !n.readAt) ? <Link href="/account">All notifications</Link>:null}
      {outstanding.length ? <p><Link href="/worker/shifts">{outstanding.length} assignment offer{outstanding.length === 1 ? "" : "s"} awaiting your response →</Link></p> : null}
      {current ? <section className="panel"><StatusBadge>{current.shift.status === "COMPLETED" ? "Completed shift" : current.offer.status === "ACCEPTED" ? current.allocation?.state === "ALLOCATED" ? "Allocated" : "Accepted · awaiting allocation" : "New offer"}</StatusBadge><h2>{current.shift.roleName}</h2><p>{dateTime(current.shift.startsAt)} · Johannesburg time</p><p>{current.shift.earningsModel === "COMMISSION" ? `Commission: ${(current.shift.commissionBps ?? 0) / 100}% of verified attributed sales` : `Expected work earnings ${money(current.shift.expectedEarningsMinor ?? current.shift.guaranteedBasePayMinor, current.shift.currencyCode)}`} · potential incentive {money(current.shift.incentiveAmountMinor, current.shift.currencyCode)}</p><Link className="primary-button button-link" href="/worker/shifts">{current.offer.status === "OFFERED" ? "Review shift offer" : "View your schedule"}</Link></section> : <StatePanel title="No upcoming assignments"><p>New offers will appear in Shifts.</p></StatePanel>}
      <div className="task-grid"><TaskLink href="/worker/earnings" title="Work earnings">{[paidTotal && `${paidTotal} paid`, inPayPalTotal && `${inPayPalTotal} sent to PayPal · processing`, notSentTotal && `${notSentTotal} approved`, payableTotal && `${payableTotal} confirmed · awaiting approval`].filter(Boolean).join(" · ") || "Expected earnings are shown with each accepted shift."}</TaskLink><TaskLink href="/worker/earnings" title="Incentive payments">{payments.length ? `${incentiveTotal(["PAID"])} paid · ${current?.incentive ? "Review your latest payment status." : "No current shift result yet."}` : "No incentive payments yet."}</TaskLink><TaskLink href="/worker/profile" title={profile?.paypalPayoutEmail ? "Your profile" : "Complete payment settings"}>{profile?.paypalPayoutEmail ? "Payment destination saved for approved payments." : paymentDetailsNeeded ? "Payment details required: add your PayPal email in Profile." : "Add your PayPal email once in Profile."}</TaskLink></div>
    </> : null}
    {area === "shifts" ? assignments.length ? assignments.map((row) => <article className="panel" key={row.shift.id}>
      <StatusBadge>{row.offer.status === "ACCEPTED" ? "Offer accepted" : row.offer.status === "OFFERED" ? "Awaiting your response" : "Offer closed"}</StatusBadge><h2>{row.departmentName ?? row.shift.roleName}</h2><p>Terms version {row.shift.termsVersion} · {row.allocation?.state === "ALLOCATED" ? "Allocated" : row.offer.status === "ACCEPTED" ? "Awaiting allocation" : "Offer"}</p><ShiftTerms shift={row.shift} locationName={scope.locationName} />
      <details><summary>Incentive and gratuity terms</summary><p>{row.shift.incentivePolicy} Published team target: {money(row.shift.incentiveTargetMinor, row.shift.currencyCode)}.</p><p>{row.shift.gratuityPolicy}</p></details>
      {row.offer.acceptedAt ? <p>You accepted on {dateTime(row.offer.acceptedAt)}.</p> : null}
      {row.offer.status === "OFFERED" && row.shift.status === "PUBLISHED" ? <AssignmentResponse offerId={row.offer.id} version={row.shift.termsVersion} /> : null}
    </article>) : <StatePanel title="No shift offers yet"><p>You will see complete terms here when an offer is sent.</p></StatePanel> : null}
    {area === "earnings" ? <>
      <section className="panel" aria-labelledby="work-earnings-title"><h2 id="work-earnings-title">Work earnings</h2>
        <div className="overview-strip"><div><span>Expected · work not yet confirmed</span><strong>{expectedTotal || "None"}</strong></div><div><span>Confirmed · awaiting approval</span><strong>{payableTotal || "None"}</strong></div><div><span>Approved · payment not yet confirmed</span><strong>{approvedTotal || "None"}</strong></div><div><span>Paid · confirmed by PayPal</span><strong>{paidTotal || "None"}</strong></div></div>
        {paymentDetailsNeeded ? <StatePanel title="Payment details required" tone="warning"><p>Approved earnings cannot be sent until you add a PayPal email. <Link href="/worker/profile">Add it in Profile → Payment settings</Link></p></StatePanel> : null}
        {accepted.length ? accepted.map(row => <div className="record-row" key={row.offer.id}><span>{row.shift.shiftDate} · {row.departmentName ?? row.shift.roleName}</span>{row.payable ? <><span>{money(row.payable.baseAmountMinor, row.payable.currencyCode)} base payable · {payableBasis(row.payable)} · work confirmed{row.payout?.status === "PAID" && row.payout.paidAt ? ` · paid to your PayPal account ${dateTime(row.payout.paidAt, timezone ?? undefined)}${timezone ? ` (${timezone})` : ""}` : ""}{row.payout?.status === "FAILED" ? " · your payment needs attention: ask your manager to review it" : ""}{row.payout?.status === "PROCESSING" && row.payout.paypalStatus === "ONHOLD" ? " · PayPal is holding this payment: check your PayPal account to accept it" : ""}{row.payout?.status === "PROCESSING" && row.payout.paypalStatus === "UNCLAIMED" ? " · claim this payment by signing in to PayPal with your saved email" : ""}</span><PayableBadge status={row.payable.status} payout={row.payout} /></>
          : <span>{row.shift.earningsModel === "COMMISSION" ? "Commission awaiting verified attributed sales" : `${money(row.shift.expectedEarningsMinor ?? row.shift.guaranteedBasePayMinor, row.shift.currencyCode)} expected work earnings`} · {row.allocation?.confirmedAt ? row.shift.earningsModel === "COMMISSION" ? "Work confirmed" : "Work confirmed · base payable not yet recorded" : "Awaiting work confirmation"}</span>}</div>) : <p>No accepted shifts yet.</p>}
        <p className="method-note">When your manager confirms the work, FairShift calculates your base payable from the terms you accepted. Your manager then approves it and sends it to your PayPal account. An amount shows as Paid only after PayPal confirms the payment. Questions about a payment? Ask your manager.</p>
      </section>
      {!profile?.paypalPayoutEmail && !paymentDetailsNeeded ? <StatePanel title="Complete your payment settings" tone="warning"><Link href="/worker/profile">Add your PayPal email in Profile</Link></StatePanel> : null}
      <h2>Incentive payments</h2>
      {payments.length ? <section className="overview-strip"><div><span>Incentives paid</span><strong>{incentiveTotal(["PAID"])}</strong></div><div><span>Awaiting approval</span><strong>{incentiveTotal(["EARNED"])}</strong></div><div><span>Approved or processing</span><strong>{incentiveTotal(["APPROVED", "SUBMITTING", "SUBMITTED", "PROCESSING"])}</strong></div></section> : null}
      <p className="method-note">Incentive payments through PayPal Sandbox are separate from work earnings. Gratuity payment status is not tracked here.</p>
      {payments.length ? payments.map((row) => <article className="panel" key={row.shift.id}><h2>{row.shift.shiftDate} · {money(row.incentive?.earnedAmountMinor ?? 0, row.shift.currencyCode)} incentive</h2><PaymentBadge status={row.incentive?.status} />{row.incentive?.paidAt ? <p>Confirmed paid on {dateTime(row.incentive.paidAt)}.</p> : null}{row.incentive?.status === "FAILED" ? <p>Your payment needs attention. Ask your manager to review its status.</p> : null}</article>) : <StatePanel title="No incentive payments yet" />}
    </> : null}
    {area === "profile" ? <>
      <section className="panel"><h2>Profile details</h2><p>{profile?.displayName ?? "Casual worker"} · {scope.locationName}</p><p>FairShift sales attribution code: {profile?.attributionCode ?? "Unavailable"}</p><p>Availability and preference editing are not available in this environment.</p></section>
      <section className="panel"><h2>Payment settings</h2><p>{profile?.paypalPayoutEmail ? `PayPal destination saved: ${maskedEmail(profile.paypalPayoutEmail)}` : "Add a PayPal email to receive approved work earnings and incentives."}</p><form action={saveDemoPayoutDestinationAction} className="workspace-form"><label>{profile?.paypalPayoutEmail ? "Update PayPal email" : "PayPal payout email"}<input name="payoutEmail" type="email" autoComplete="email" maxLength={254} required /></label><button className="primary-button" type="submit">Save payment settings</button></form><p className="method-note">Saved for your profile across shifts. Saving details does not send a payment.</p></section>
    </> : null}
  </>;
}
