import { requireScope } from "@/server/auth/request";
import { workerWorkspace } from "@/server/auth/operations";
import Link from "next/link";
import { WorkerShiftCard, shiftWhen, workerShiftKind } from "@/app/worker/shift-cards";
import { PageHeader, StatePanel } from "@/app/components/product-ui";
import { ActionFeedback, currencyTotals, dateTime, money, payableBasis, PaymentBadge, TaskLink, WorkerPaymentBadge, WorkspaceUnavailable } from "@/app/components/workspace-ui";
import { saveDemoPayoutDestinationAction } from "@/app/scheduling-actions";
import { saveAvailabilityAction } from "@/app/operations-actions";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";

export const workerAreas = ["shifts", "earnings", "availability", "profile"] as const;
export type WorkerArea = "home" | typeof workerAreas[number];

function maskedEmail(value: string) {
  const [name, domain] = value.split("@");
  return `${name.slice(0, 1)}•••@${domain}`;
}

export async function WorkerWorkspace({ area, status }: { area: WorkerArea; status?: string }) {
  if (!getConfigurationStatus().databaseConfigured) return <WorkspaceUnavailable />;
  const scope=await requireScope(["TEAM_MEMBER"]);
  let data;
  try { data = await workerWorkspace(getDatabase(),scope); } catch { return <WorkspaceUnavailable />; }
  const { profile, assignments, availability, timezone } = data;
  if (!timezone) return <WorkspaceUnavailable />;
  const now = new Date();
  const stated = new Map(availability.map(row => [row.isoWeekday, row.state]));
  const kindOf = (row: (typeof assignments)[number]) => workerShiftKind(row, now);
  const soonest = <T extends { shift: { startsAt: Date } }>(rows: T[]) => [...rows].sort((a, b) => a.shift.startsAt.getTime() - b.shift.startsAt.getTime());
  const offersNow = soonest(assignments.filter(row => ["OFFER", "CHANGED"].includes(kindOf(row))));
  const waiting = soonest(assignments.filter(row => kindOf(row) === "ACCEPTED"));
  const upcoming = soonest(assignments.filter(row => kindOf(row) === "UPCOMING"));
  const earlier = assignments.filter(row => ["PAST", "CLOSED"].includes(kindOf(row)));
  const card = (row: (typeof assignments)[number]) => <WorkerShiftCard key={row.offer.id} row={row} kind={kindOf(row)} locationName={scope.locationName} timeZone={timezone} availability={stated} />;
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
  const title = { home: `Welcome${profile ? `, ${profile.displayName}` : ""}`, shifts: "Your shifts", earnings: "Your earnings", availability: "Your availability", profile: "Your profile" }[area];
  return <>
    <PageHeader eyebrow={scope.locationName} title={title} description={area === "home" ? "What needs your attention." : undefined} />
    <ActionFeedback status={status} />
    {area === "home" ? <>
      {offersNow.length ? <section className="worker-section" aria-labelledby="home-offers"><h2 id="home-offers">{offersNow.length === 1 ? "You have a new shift offer" : `You have ${offersNow.length} new shift offers`}</h2>{card(offersNow[0])}{offersNow.length > 1 ? <p><Link href="/worker/shifts">See all offers →</Link></p> : null}</section> : null}
      {waiting.length ? <section className="worker-section" aria-labelledby="home-waiting"><h2 id="home-waiting">Waiting for your manager</h2>{card(waiting[0])}{waiting.length > 1 ? <p><Link href="/worker/shifts">See all →</Link></p> : null}</section> : null}
      {upcoming.length ? <section className="worker-section" aria-labelledby="home-upcoming"><h2 id="home-upcoming">Your next shift</h2>{card(upcoming[0])}{upcoming.length > 1 ? <p><Link href="/worker/shifts">See all your shifts →</Link></p> : null}</section> : null}
      {!offersNow.length && !waiting.length && !upcoming.length ? <StatePanel title="Nothing needs you right now"><p>When a manager offers you work, it appears here with what you’ll earn.</p></StatePanel> : null}
      {!profile?.paypalPayoutEmail ? <StatePanel title="Payment setup incomplete" tone="warning"><p>Add your payment details before your approved earnings can be sent. <Link href="/worker/profile#payment-settings">Add payment details</Link></p></StatePanel> : null}
      <div className="task-grid"><TaskLink href="/worker/earnings" title="Earnings">{[paidTotal && `${paidTotal} paid`, inPayPalTotal && `${inPayPalTotal} sent to PayPal · processing`, notSentTotal && `${notSentTotal} approved`, payableTotal && `${payableTotal} confirmed · awaiting approval`].filter(Boolean).join(" · ") || "What you’ve earned and how payment is going."}</TaskLink><TaskLink href="/worker/availability" title="Availability">{availability.length ? "Update the days you can work." : "Tell your manager which days you can work."}</TaskLink></div>
    </> : null}
    {area === "shifts" ? assignments.length ? <>
      {offersNow.length ? <section className="worker-section" aria-labelledby="shifts-offers"><h2 id="shifts-offers">New offers</h2>{offersNow.map(card)}</section> : null}
      {waiting.length ? <section className="worker-section" aria-labelledby="shifts-waiting"><h2 id="shifts-waiting">Waiting for your manager</h2>{waiting.map(card)}</section> : null}
      {upcoming.length ? <section className="worker-section" aria-labelledby="shifts-upcoming"><h2 id="shifts-upcoming">You’re booked</h2>{upcoming.map(card)}</section> : null}
      {!offersNow.length && !waiting.length && !upcoming.length ? <StatePanel title="Nothing to do right now"><p>New offers will appear here with what you’ll earn.</p></StatePanel> : null}
      {earlier.length ? <details className="worker-section"><summary>Earlier and closed shifts · {earlier.length}</summary>{earlier.map(card)}</details> : null}
    </> : <StatePanel title="No shift offers yet"><p>When a manager offers you work, you’ll see where, when and what you’ll earn here.</p></StatePanel> : null}
    {area === "availability" ? <section className="panel" aria-labelledby="availability-title"><h2 id="availability-title">When can you work?</h2>
      <p>Tell your manager which days you can usually work at {scope.locationName}. You don’t need to give a reason. You can still decline any offer.</p>
      <form action={saveAvailabilityAction} className="workspace-form">
        {["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"].map((day, i) => { const current = availability.find(row => row.isoWeekday === i + 1)?.state ?? ""; return <fieldset className="availability-day" key={day}><legend>{day}</legend><div className="availability-options">
          <label><input type="radio" name={`day${i + 1}`} value="AVAILABLE" defaultChecked={current === "AVAILABLE"} /> Can work</label>
          <label><input type="radio" name={`day${i + 1}`} value="UNAVAILABLE" defaultChecked={current === "UNAVAILABLE"} /> Can’t work</label>
          <label><input type="radio" name={`day${i + 1}`} value="" defaultChecked={current === ""} /> Not sure</label>
        </div></fieldset>; })}
        <button className="primary-button">Save availability</button>
      </form>
      <p className="method-note">If you choose “Can’t work”, your manager can’t offer you shifts that day. “Not sure” means they may still offer you work, and you decide then.</p>
    </section> : null}
    {area === "earnings" ? <>
      <section className="panel" aria-labelledby="work-earnings-title"><h2 id="work-earnings-title">Work earnings</h2>
        <div className="overview-strip"><div><span>Expected · work not yet confirmed</span><strong>{expectedTotal || "None"}</strong></div><div><span>Confirmed · awaiting approval</span><strong>{payableTotal || "None"}</strong></div><div><span>Approved · payment not yet confirmed</span><strong>{approvedTotal || "None"}</strong></div><div><span>Paid · confirmed by PayPal</span><strong>{paidTotal || "None"}</strong></div></div>
        {paymentDetailsNeeded ? <StatePanel title="Payment details required" tone="warning"><p>Approved earnings cannot be sent until you add a PayPal email. <Link href="/worker/profile#payment-settings">Add it in Profile → Payment settings</Link></p></StatePanel> : null}
        {accepted.length ? accepted.map(row => <div className="record-row" key={row.offer.id}><span>{shiftWhen(row.shift.startsAt, row.shift.endsAt, timezone).date} · {row.departmentName ?? row.shift.roleName}</span>{row.payable ? <><span>{money(row.payable.baseAmountMinor, row.payable.currencyCode)} earned · {payableBasis(row.payable)} · work confirmed{row.payout?.status === "PAID" && row.payout.paidAt ? ` · paid to your PayPal account ${dateTime(row.payout.paidAt, timezone)} (${timezone})` : ""}{row.payout?.status === "FAILED" ? " · your payment needs attention: ask your manager to review it" : ""}{row.payout?.status === "PROCESSING" && row.payout.paypalStatus === "ONHOLD" ? " · PayPal is holding this payment, so it has not reached you yet: check your PayPal account to accept it" : ""}{row.payout?.status === "PROCESSING" && row.payout.paypalStatus === "UNCLAIMED" ? " · claim this payment by signing in to PayPal with your saved email" : ""}</span><WorkerPaymentBadge status={row.payable.status} payout={row.payout} /></>
          : <span>{row.shift.earningsModel === "COMMISSION" ? "Commission awaiting verified attributed sales" : `${money(row.shift.expectedEarningsMinor ?? row.shift.guaranteedBasePayMinor, row.shift.currencyCode)} expected`} · {row.allocation?.confirmedAt ? row.shift.earningsModel === "COMMISSION" ? "Work confirmed" : "Work confirmed · earnings not yet recorded" : "Awaiting work confirmation"}</span>}</div>) : <p>No accepted shifts yet.</p>}
        <p className="method-note">When your manager confirms the work, FairShift works out your earnings from the terms you accepted. Your manager then approves them and sends them to your PayPal account. An amount shows as Paid only after PayPal confirms the payment. Questions about a payment? Ask your manager.</p>
      </section>
      {!profile?.paypalPayoutEmail && !paymentDetailsNeeded ? <StatePanel title="Payment setup incomplete" tone="warning"><p>Add your payment details before your approved earnings can be sent. <Link href="/worker/profile#payment-settings">Add payment details</Link></p></StatePanel> : null}
      {payments.length ? <h2>Incentive payments</h2> : null}
      {payments.length ? <section className="overview-strip"><div><span>Incentives paid</span><strong>{incentiveTotal(["PAID"])}</strong></div><div><span>Awaiting approval</span><strong>{incentiveTotal(["EARNED"])}</strong></div><div><span>Approved or processing</span><strong>{incentiveTotal(["APPROVED", "SUBMITTING", "SUBMITTED", "PROCESSING"])}</strong></div></section> : null}
      {payments.length ? <p className="method-note">Incentive payments are separate from work earnings. Gratuity payment status is not tracked here.</p> : null}
      {payments.length ? payments.map((row) => <article className="panel" key={row.shift.id}><h2>{shiftWhen(row.shift.startsAt, row.shift.endsAt, timezone).date} · {money(row.incentive?.earnedAmountMinor ?? 0, row.shift.currencyCode)} incentive</h2><PaymentBadge status={row.incentive?.status} />{row.incentive?.paidAt ? <p>Confirmed paid on {dateTime(row.incentive.paidAt, timezone)}.</p> : null}{row.incentive?.status === "FAILED" ? <p>Your payment needs attention. Ask your manager to review its status.</p> : null}</article>) : null}
    </> : null}
    {area === "profile" ? <>
      <section className="panel"><h2>Profile details</h2><p>{profile?.displayName ?? "Casual worker"} · {scope.locationName}</p><p><Link href="/worker/availability">Set the days you can work</Link></p><p><Link href="/account">Account and notifications</Link></p></section>
      <section className="panel" id="payment-settings"><h2>Payment settings</h2><p>{profile?.paypalPayoutEmail ? `Payment details added: ${maskedEmail(profile.paypalPayoutEmail)}` : "Payment setup incomplete. Add your payment details before your approved earnings can be sent."}</p><form action={saveDemoPayoutDestinationAction} className="workspace-form"><label>{profile?.paypalPayoutEmail ? "Update PayPal email" : "PayPal payout email"}<input name="payoutEmail" type="email" autoComplete="email" maxLength={254} required /></label><button className="primary-button" type="submit">Save payment settings</button></form><p className="method-note">Saved for your profile across shifts. Saving details does not send a payment, and FairShift has not checked this email with PayPal, so please make sure it’s right.</p></section>
    </> : null}
  </>;
}
