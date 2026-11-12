import { requireScope } from "@/server/auth/request";
import { workerWorkspace } from "@/server/auth/operations";
import Link from "next/link";
import { WorkerPerformance, WorkerShiftCard, WorkerTarget, shiftWhen, workerShiftKind } from "@/app/worker/shift-cards";
import { PayoutProgress } from "@/app/components/payment-progress";
import { finalPayableMinor } from "@/server/domain/work-payable";
import { DataLabel, PageHeader, StatePanel, StatusBadge } from "@/app/components/product-ui";
import { isDemoOrganisation } from "@/server/demo/organisation";
import { WORKER_PAY_STATUS_NOTE, workerPayStatus } from "@/server/pay-agent/presentation";
import { labelledMoney, maskedEmail } from "@/app/components/format";
import { EarlierEvidenceLabel } from "@/app/demo/demo-bar";
import { ActionFeedback, currencyTotals, dateTime, money, payableBasis, PaymentBadge, WorkerPaymentBadge, WorkspaceUnavailable } from "@/app/components/workspace-ui";
import { saveDemoPayoutDestinationAction } from "@/app/scheduling-actions";
import { updateOwnDetailsAction } from "@/app/settings-actions";
import { saveAvailabilityAction } from "@/app/operations-actions";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { SquareLiveRefresh } from "@/app/components/square-live-refresh";
import { getSquareFreshness } from "@/server/commerce/square-connection";
import { getWorkerTips } from "@/server/tips/view";
import { formatMinute } from "@/server/tips/policy";
import { markInboxRead, workerInbox } from "@/server/worker/inbox";
import { pendingPayoutChange } from "@/server/worker/payout-destination";
import { workerCancellations } from "@/server/worker/cancellations";
import { WorkerInbox } from "@/app/worker/inbox";
import { HomeStrip, OfferPicker, ShiftsMonth, ShiftsList } from "@/app/worker/home-and-shifts";
import { cancelPayoutChangeAction } from "@/app/worker-actions";
import { signOutAction } from "@/app/auth-actions";

// Monday-to-Sunday in the location's time zone.
const WEEKDAY: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
const localDay = (date: Date, timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
function sameWeek(date: Date, now: Date, timeZone: string) {
  const offset = WEEKDAY[new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone }).format(now)] ?? 0;
  const monday = Date.parse(`${localDay(now, timeZone)}T00:00:00Z`) - offset * 86_400_000;
  const day = Date.parse(`${localDay(date, timeZone)}T00:00:00Z`);
  return day >= monday && day < monday + 7 * 86_400_000;
}
export const workerAreas = ["shifts", "pay", "inbox", "availability", "profile"] as const;
export type WorkerArea = "home" | typeof workerAreas[number];

export async function WorkerWorkspace({ area, status, view, offer: selectedOffer }: { area: WorkerArea; status?: string; view?: string; offer?: string }) {
  if (!getConfigurationStatus().databaseConfigured) return <WorkspaceUnavailable />;
  const scope=await requireScope(["TEAM_MEMBER"]);
  let data;
  try { data = await workerWorkspace(getDatabase(),scope); } catch { return <WorkspaceUnavailable />; }
  let tips: Awaited<ReturnType<typeof getWorkerTips>> = { pooled: [], shiftPayMinor: 0, currencyCode: null };
  if (area === "pay") { try { tips = await getWorkerTips(getDatabase(), scope); } catch { /* tips are shown only when they can be read */ } }
  const { profile, availability, timezone, targets } = data;
  // Inbox (design, 10 Nov 2026): read on Home (newest unread first) and on the Inbox, which marks them read.
  let inbox: Awaited<ReturnType<typeof workerInbox>> | null = null;
  if (area === "home" || area === "inbox") { try { inbox = await workerInbox(getDatabase(), scope); } catch { inbox = null; } }
  if (area === "inbox" && inbox && !scope.demo) { try { await markInboxRead(getDatabase(), scope); } catch { /* shown as unread until next time */ } }
  let pendingChange: Awaited<ReturnType<typeof pendingPayoutChange>> = null;
  if (area === "profile" && scope.workerId) { try { pendingChange = await pendingPayoutChange(getDatabase(), scope.workerId); } catch { pendingChange = null; } }
  let cancellations: Awaited<ReturnType<typeof workerCancellations>> = new Map();
  if (area === "shifts" && scope.workerId) { try { cancellations = await workerCancellations(getDatabase(), scope); } catch { /* shown without the details */ } }
  // A demo reset closes shifts rather than deleting their evidence, so demo views leave them out.
  const assignments = scope.demo ? data.assignments.filter(row => row.shift.status !== "CANCELLED") : data.assignments;
  if (!timezone) return <WorkspaceUnavailable />;
  let freshness: Awaited<ReturnType<typeof getSquareFreshness>> = null;
  if (targets.length) { try { freshness = await getSquareFreshness(getDatabase(), scope); } catch { freshness = null; } }
  const now = new Date();
  const stated = new Map(availability.map(row => [row.isoWeekday, row.state]));
  const kindOf = (row: (typeof assignments)[number]) => workerShiftKind(row, now);
  const soonest = <T extends { shift: { startsAt: Date } }>(rows: T[]) => [...rows].sort((a, b) => a.shift.startsAt.getTime() - b.shift.startsAt.getTime());
  const offersNow = soonest(assignments.filter(row => ["OFFER", "CHANGED"].includes(kindOf(row))));
  const waiting = soonest(assignments.filter(row => kindOf(row) === "ACCEPTED"));
  const upcoming = soonest(assignments.filter(row => kindOf(row) === "UPCOMING"));
  const earlier = assignments.filter(row => ["PAST", "CLOSED"].includes(kindOf(row)));
  const card = (row: (typeof assignments)[number]) => <WorkerShiftCard key={row.offer.id} row={row} kind={kindOf(row)} locationName={scope.locationName} timeZone={timezone} availability={stated} wage={data.wageJurisdiction} />;
  const payments = assignments.filter((row) => row.incentive);
  const incentiveTotal = (statuses: readonly string[]) => currencyTotals(payments.filter((row) => statuses.includes(row.incentive?.status ?? "")).map((row) => ({ amountMinor: row.incentive?.earnedAmountMinor ?? 0, currencyCode: row.shift.currencyCode }))) || money(0, payments[0]?.shift.currencyCode);
  // Work earnings: expected before confirmation, base payable after it. Neither is a payment.
  const accepted = assignments.filter((row) => row.offer.status === "ACCEPTED");
  const expectedTotal = currencyTotals(accepted.filter((row) => !row.payable && row.shift.earningsModel !== "COMMISSION" && !row.allocation?.confirmedAt).map((row) => ({ amountMinor: row.shift.expectedEarningsMinor ?? row.shift.guaranteedBasePayMinor, currencyCode: row.shift.currencyCode })));
  const payableTotal = currencyTotals(accepted.flatMap((row) => row.payable?.status === "PENDING_REVIEW" ? [{ amountMinor: finalPayableMinor(row.payable), currencyCode: row.payable.currencyCode }] : []));
  // Approved amounts not yet confirmed paid, and amounts PayPal has reported paid.
  const approvedTotal = currencyTotals(accepted.flatMap((row) => row.payable?.status === "APPROVED" && row.payout?.status !== "PAID" ? [{ amountMinor: finalPayableMinor(row.payable), currencyCode: row.payable.currencyCode }] : []));
  const inPayPalTotal = currencyTotals(accepted.flatMap((row) => row.payout && ["SUBMITTING", "PROCESSING", "RECONCILIATION_REQUIRED"].includes(row.payout.status) ? [{ amountMinor: row.payout.amountMinor, currencyCode: row.payout.currencyCode }] : []));
  const notSentTotal = currencyTotals(accepted.flatMap((row) => row.payable?.status === "APPROVED" && (!row.payout || ["NOT_SENT", "FAILED"].includes(row.payout.status)) ? [{ amountMinor: finalPayableMinor(row.payable), currencyCode: row.payable.currencyCode }] : []));
  const paidTotal = currencyTotals(accepted.flatMap((row) => row.payout?.status === "PAID" ? [{ amountMinor: row.payout.amountMinor, currencyCode: row.payout.currencyCode }] : []));
  const paymentDetailsNeeded = !profile?.paypalPayoutEmail && accepted.some((row) => row.payable?.status === "APPROVED" && (!row.payout || row.payout.status === "NOT_SENT"));
  // Soonest open target first: the one the worker is on now, or next.
  const targetCards = [...targets].sort((a, b) => a.terms.startsAt.getTime() - b.terms.startsAt.getTime()).map(target => <WorkerTarget key={target.allocationId} target={target} baseMinor={assignments.find(row => row.shift.id === target.shiftId)?.shift.expectedEarningsMinor ?? null} timeZone={timezone} now={now} salesKnown={!freshness || !!freshness.lastSuccessAt} />);
  const liveRefresh = !scope.demo && freshness && targets.some(target => target.evidence !== "IMPORTED") ? <SquareLiveRefresh timeZone={timezone} initial={{ revision: freshness.revision, failed: freshness.attention || freshness.lastFailed, lastCheckedAt: freshness.lastSuccessAt?.toISOString() ?? null }} /> : null;
  // A target leads only while the worker is on that shift; otherwise a decision comes first.
  const onShift = targets.some(target => target.terms.startsAt <= now && target.terms.endsAt > now);
  const earned = accepted.filter(row => row.payable?.status === "PENDING_REVIEW");
  const pending = accepted.filter(row => row.payable?.status === "APPROVED" && row.payout?.status !== "PAID");
  const paid = accepted.filter(row => row.payout?.status === "PAID");
  const expected = accepted.filter(row => !row.payable);
  const earning = (row: (typeof accepted)[number]) => {
    const payable = row.payable!, amount = (value: number) => money(value, payable.currencyCode);
    const bonusUnknown = payable.incentiveRequired && payable.incentiveAmountMinor === null;
    const when = shiftWhen(row.shift.startsAt, row.shift.endsAt, timezone);
    // Before any payout exists, the Pay Agent's state as one of the plain statuses. Once a payout
    // exists its own provider state is shown instead (including "Action required" when PayPal is
    // waiting for the worker), and "Paid" only after PayPal confirms the item.
    const agentStatus = row.payAgentStatus && !row.payout ? workerPayStatus({ workConfirmed: !!row.allocation?.confirmedAt, hasPayable: true, approved: payable.status === "APPROVED", agentStatus: row.payAgentStatus }) : null;
    return <article className="earning-item" key={row.offer.id} data-earlier={scope.demo ? "" : undefined} aria-label={`${row.departmentName ?? row.shift.roleName}, ${when.date}`}>
      <div className="worker-shift-head"><h4>{when.date}</h4>{agentStatus ? <StatusBadge tone={agentStatus === "Paid" ? "success" : agentStatus === "Under review" ? "warning" : "neutral"}>{agentStatus}</StatusBadge> : <WorkerPaymentBadge status={payable.status} payout={row.payout} />}</div>
      {agentStatus ? <p className="note" role="status">{WORKER_PAY_STATUS_NOTE[agentStatus]}</p> : null}
      {row.payAgentHoldSummary ? <p className="note">Why it&rsquo;s held: {row.payAgentHoldSummary}</p> : null}
      {row.payAgentChecklist?.length ? <ul className="pay-agent-checklist" aria-label="Pay Agent checks">{row.payAgentChecklist.map(item => <li key={item.text}><span aria-hidden="true">{item.ok ? "✓" : "⚠"}</span> {item.ok ? null : <span className="visually-hidden">Concern: </span>}{item.text}</li>)}</ul> : null}
      <p className="note">{scope.locationName} · {when.time} · <Link href={`/worker/pay/${payable.id}`}>This shift’s pay and questions →</Link></p>
      <dl className="earning-sum">
        <div><dt>Base pay<small>{payableBasis(payable)}</small></dt><dd>{amount(payable.baseAmountMinor)}</dd></div>
        {payable.incentiveRequired ? <div><dt>Bonus{bonusUnknown ? null : <small>{payable.incentiveAmountMinor! > 0 ? "Target reached" : "Target not reached"}</small>}</dt><dd>{bonusUnknown ? "Not known yet" : `+ ${amount(payable.incentiveAmountMinor!)}`}</dd></div> : null}
        <div className="earning-total"><dt>{row.payout?.status === "PAID" ? "Paid" : payable.status === "APPROVED" ? "Final earnings" : "Total"}{row.payout?.status !== "PAID" && payable.status !== "APPROVED" && !agentStatus ? <small>Checked by FairShift before it’s paid</small> : null}</dt><dd>{bonusUnknown ? `${amount(finalPayableMinor(payable))} so far` : amount(finalPayableMinor(payable))}</dd></div>
      </dl>
      {row.payout?.fxRateMicros ? <p className="note payout-conversion">{amount(row.payout.amountMinor)} {row.payout.refusal ? "was to be paid to PayPal" : "is paid to PayPal"} as {labelledMoney(row.payout.providerAmountMinor, row.payout.providerCurrency)}, at {(row.payout.fxRateMicros / 1_000_000).toFixed(4)} {payable.currencyCode === "ZAR" ? "rand" : payable.currencyCode} per {row.payout.providerCurrency === "USD" ? "US dollar" : row.payout.providerCurrency}, the European Central Bank reference rate{row.payout.fxRateSource?.includes(":") ? ` of ${row.payout.fxRateSource.split(":")[1]}` : ""}, locked in when the payment was reserved.</p> : null}
      <PayoutProgress status={payable.status} payout={row.payout} />
      {row.payout?.status === "PAID" && row.payout.paidAt ? <p className="paid-confirmation">PayPal confirmed: paid to your PayPal account {dateTime(row.payout.paidAt, timezone)} ({timezone})</p> : null}
      {row.payout?.status === "FAILED" ? <p>{row.payout.refusal ? "This payment was not made, so nothing has reached your PayPal account. Ask your manager to review it." : "Your payment needs attention: ask your manager to review it."}</p> : null}
      {row.payout?.status === "PROCESSING" && row.payout.paypalStatus === "ONHOLD" ? <p>PayPal is holding this payment, so it has not reached you yet: check your PayPal account to accept it.</p> : null}
      {row.payout?.status === "PROCESSING" && row.payout.paypalStatus === "UNCLAIMED" ? <p>Claim this payment by signing in to PayPal with your saved email.</p> : null}
      {payable.incentiveRequired ? <details className="disclosure-inline"><summary>Sales on this shift</summary><WorkerPerformance payable={payable} performance={row.performance} shift={row.shift} /></details> : null}
    </article>;
  };
  const title = { home: `Hi${profile ? `, ${profile.displayName.split(" ")[0]}` : ""}`, shifts: "Your shifts", pay: "Your pay", inbox: "Inbox", availability: "Your availability", profile: "Your profile" }[area];
  return <>
    <PageHeader eyebrow={scope.locationName} title={title} />
    {isDemoOrganisation(scope.organisationId) ? <p className="note"><DataLabel kind="demo">Fictional demo staff</DataLabel> A fictional staff account at a fictional venue, made for the demonstration.</p> : null}
    <ActionFeedback status={status} saved={area === "shifts" ? "Response saved" : "Changes saved"} />
    {area === "home" ? (() => {
      // Design (WorkerHome, 10 Nov 2026): messages, the open offers as one card, this week's pay as one card,
      // and the 7-day strip with the next shift. Full offer and shift cards fold, so every action stays here.
      const unread = inbox ? inbox.notices.filter(notice => !notice.readAt) : [];
      const short = (date: Date) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: timezone }).format(date);
      const clock = (date: Date) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: timezone }).format(date);
      const earns = (row: (typeof assignments)[number]) => row.shift.earningsModel === "COMMISSION" ? "Commission" : money(row.shift.expectedEarningsMinor ?? row.shift.guaranteedBasePayMinor, row.shift.currencyCode);
      const hours = (row: (typeof assignments)[number]) => { const h = (row.shift.endsAt.getTime() - row.shift.startsAt.getTime()) / 3_600_000; return `${Number.isInteger(h) ? h : h.toFixed(1)} ${h === 1 ? "hour" : "hours"}`; };
      const week = accepted.filter(row => row.shift.status !== "CANCELLED" && sameWeek(row.shift.startsAt, now, timezone));
      const weekTotal = currencyTotals(week.map(row => ({ amountMinor: row.payable ? finalPayableMinor(row.payable) : row.shift.earningsModel === "COMMISSION" ? 0 : row.shift.expectedEarningsMinor ?? row.shift.guaranteedBasePayMinor, currencyCode: row.shift.currencyCode })));
      const moneyLine = [paidTotal && `${paidTotal} paid`, inPayPalTotal && `${inPayPalTotal} sent to PayPal · processing`, notSentTotal && `${notSentTotal} approved`, payableTotal && `${payableTotal} confirmed · awaiting approval`].filter(Boolean).join(" · ");
      const next = upcoming[0];
      return <>
      {unread.length ? <section className="worker-section home-messages" aria-labelledby="home-inbox"><div className="home-section-head"><h2 id="home-inbox">Messages · {unread.length} new</h2><Link href="/worker/inbox">Open inbox</Link></div>
        <ul className="inbox-list">{unread.slice(0, 3).map(notice => <li key={notice.id} className="inbox-new"><Link href={notice.href.startsWith("/") ? notice.href : "/worker/inbox"}><strong>{notice.title}</strong></Link></li>)}</ul></section> : null}
      {offersNow.length ? (() => { const first = offersNow[0];
        return <section className="panel home-offers" aria-labelledby="home-offers"><h2 id="home-offers">{offersNow.length === 1 ? "You have a new shift offer" : `You have ${offersNow.length} new shift offers`}</h2>
          <p className="home-offer-when"><strong>{short(first.shift.startsAt)} · {clock(first.shift.startsAt)}–{clock(first.shift.endsAt)}</strong><small>{scope.locationName} · {first.departmentName ?? first.shift.roleName} · {hours(first)}</small></p>
          <p className="home-offer-pay"><strong>{earns(first)}</strong>{first.shift.earningsModel === "HOURLY" && first.shift.rateMinor ? <small>{money(first.shift.rateMinor, first.shift.currencyCode)} an hour</small> : null}</p>
          {offersNow.length > 1 ? <p className="note">+ {offersNow.slice(1, 4).map(row => short(row.shift.startsAt)).join(" · ")}{offersNow.length > 4 ? " …" : ""}</p> : null}
          <Link className="primary-button button-link home-offers-cta" href="/worker/shifts#offers">{offersNow.length === 1 ? "See the offer" : "See all offers"}</Link>
          <details className="offer-fold"><summary>Answer {offersNow.length === 1 ? "it" : "the first one"} here</summary>{card(first)}</details></section>; })() : null}
      <section className="worker-section" aria-labelledby="home-week-pay"><Link className="panel home-pay" href="/worker/pay"><span className="eyebrow" id="home-week-pay">This week’s pay <span aria-hidden="true">→</span></span>
        <strong className="money">{weekTotal || "Nothing yet"}</strong><small>{weekTotal ? `from ${week.length} ${week.length === 1 ? "shift" : "shifts"} you accepted (Mon–Sun)` : "No accepted shifts this week yet"}</small>
        {moneyLine ? <small className="home-pay-status">{moneyLine}</small> : null}</Link></section>
      <HomeStrip rows={assignments} kindOf={kindOf} timezone={timezone} now={now} />
      {next ? <p className="note home-next">Next: <strong>{short(next.shift.startsAt)}, {clock(next.shift.startsAt)}–{clock(next.shift.endsAt)}</strong> · {scope.locationName} · {earns(next)}</p> : null}
      {onShift ? targetCards.length ? <section className="worker-section" aria-label="Your shift target">{liveRefresh}{targetCards[0]}{targetCards.length > 1 ? <p><Link href="/worker/shifts">See your other targets →</Link></p> : null}</section> : null : null}
      {!onShift ? targetCards.length ? <section className="worker-section" aria-label="Your shift target">{liveRefresh}{targetCards[0]}{targetCards.length > 1 ? <p><Link href="/worker/shifts">See your other targets →</Link></p> : null}</section> : null : null}
      {waiting.length ? <details className="worker-section"><summary>Accepted · your manager will confirm the booking · {waiting.length}</summary>{card(waiting[0])}{waiting.length > 1 ? <p><Link href="/worker/shifts">See all →</Link></p> : null}</details> : null}
      {next ? <details className="worker-section"><summary>Your next shift · {short(next.shift.startsAt)}</summary>{card(next)}{upcoming.length > 1 ? <p><Link href="/worker/shifts">See all your shifts →</Link></p> : null}</details> : null}
      {!offersNow.length && !waiting.length && !upcoming.length ? <StatePanel title="Nothing needs you right now"><p>When a manager offers you work, it appears here with what you’ll earn.</p></StatePanel> : null}
      {!profile?.paypalPayoutEmail ? <StatePanel title="Payment setup incomplete" tone="warning"><p>Add your payment details before your approved earnings can be sent. <Link href="/worker/profile#payment-settings">Add payment details</Link></p></StatePanel> : null}
      {!availability.length ? <p className="note"><Link href="/worker/availability">Tell your manager which days you can work</Link></p> : null}
    </>; })() : null}
    {area === "shifts" ? <nav className="page-tabs" aria-label="Shifts view"><Link href="/worker/shifts" aria-current={view !== "month" && view !== "list" ? "page" : undefined}>To do</Link><Link href="/worker/shifts?view=month" aria-current={view === "month" ? "page" : undefined}>Month</Link><Link href="/worker/shifts?view=list" aria-current={view === "list" ? "page" : undefined}>List</Link></nav> : null}
    {area === "shifts" && view === "month" ? <section className="panel"><ShiftsMonth rows={assignments} kindOf={kindOf} timezone={timezone} now={now} /></section> : null}
    {area === "shifts" && view === "list" ? <section className="panel"><ShiftsList rows={assignments} kindOf={kindOf} timezone={timezone} cancellations={cancellations} /></section> : null}
    {area === "shifts" && view !== "month" && view !== "list" ? assignments.length ? <>
      {!profile?.paypalPayoutEmail && (offersNow.length || waiting.length || upcoming.length) && !scope.demo ? <StatePanel title="Add your PayPal email" tone="warning"><p>Do it now so your pay isn’t held up after the shift. <Link href="/worker/profile#payment-settings">Add payment details</Link></p></StatePanel> : null}
      {onShift ? targetCards.length ? <section className="worker-section" aria-label="Your shift targets">{liveRefresh}{targetCards}</section> : null : null}
      {offersNow.length ? (() => { const chosen = offersNow.find(row => row.offer.id === selectedOffer) ?? offersNow[0];
        return <section className="worker-section" id="offers" aria-labelledby="shifts-offers"><h2 id="shifts-offers">{offersNow.length} open {offersNow.length === 1 ? "offer" : "offers"}</h2>
          {offersNow.length > 1 ? <OfferPicker rows={offersNow} selected={chosen.offer.id} timezone={timezone} basePath="/worker/shifts" /> : null}{card(chosen)}
          <p className="note">Accepting checks for clashes with work you’ve already accepted. If you decline, the shift passes to the next person.</p></section>; })() : null}
      {!onShift ? targetCards.length ? <section className="worker-section" aria-label="Your shift targets">{liveRefresh}{targetCards}</section> : null : null}
      {waiting.length ? <section className="worker-section" aria-labelledby="shifts-waiting"><h2 id="shifts-waiting">Accepted · your manager will confirm the booking</h2>{waiting.map(card)}</section> : null}
      {upcoming.length ? <section className="worker-section" aria-labelledby="shifts-upcoming"><h2 id="shifts-upcoming">You’re booked</h2>{upcoming.map(card)}</section> : null}
      {!offersNow.length && !waiting.length && !upcoming.length ? <StatePanel title="Nothing to do right now"><p>New offers will appear here with what you’ll earn.</p></StatePanel> : null}
      {earlier.length ? <details className="worker-section"><summary>Earlier and closed shifts · {earlier.length}</summary>{earlier.map(card)}</details> : null}
    </> : <StatePanel title="No shift offers yet"><p>When a manager offers you work, you’ll see where, when and what you’ll earn here.</p></StatePanel> : null}
    {area === "inbox" ? inbox ? <WorkerInbox inbox={inbox} timezone={timezone} locationName={scope.locationName} demo={!!scope.demo} /> : <WorkspaceUnavailable /> : null}
    {area === "availability" ? <section className="panel" aria-labelledby="availability-title"><h2 id="availability-title">When can you work?</h2>
      <p>The days you can usually work at {scope.locationName}. You don’t need to give a reason, and you can still decline any offer.</p>
      <form action={saveAvailabilityAction} className="stack-form">
        {["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"].map((day, i) => { const current = availability.find(row => row.isoWeekday === i + 1)?.state ?? ""; return <fieldset className="availability-day" key={day}><legend>{day}</legend><div className="availability-options">
          <label><input type="radio" name={`day${i + 1}`} value="AVAILABLE" defaultChecked={current === "AVAILABLE"} /> Available</label>
          <label><input type="radio" name={`day${i + 1}`} value="UNAVAILABLE" defaultChecked={current === "UNAVAILABLE"} /> Unavailable</label>
          <label><input type="radio" name={`day${i + 1}`} value="" defaultChecked={current === ""} /> Not set</label>
        </div></fieldset>; })}
        <label className="acceptance-check"><input type="checkbox" name="wantsMoreHours" value="yes" defaultChecked={!!profile?.wantsMoreHours} /> I want more hours. New shifts here are offered first to people who said so; you don’t need to give a reason.</label>
        <button className="primary-button">Save availability</button>
      </form>
      <p className="note">If you choose Unavailable, your manager can’t offer you shifts that day. Not set means they may still offer you work, and you decide then.</p>
    </section> : null}
    {area === "pay" ? <>
      <section aria-labelledby="work-earnings-title"><h2 id="work-earnings-title" className="visually-hidden">Work earnings</h2>
        <div className="earnings-strip">
          <div><span>Earned</span><strong>{payableTotal || "None"}</strong><small>Awaiting approval</small></div>
          <div><span>Pending</span><strong>{approvedTotal || "None"}</strong><small>Approved</small></div>
          <div className="earnings-strip-paid"><span>Paid so far</span><strong>{paidTotal || "None"}</strong><small>Confirmed by PayPal</small></div>
        </div>
        {paymentDetailsNeeded ? <StatePanel title="Payment details required" tone="warning"><p>Approved earnings cannot be sent until you add a PayPal email. <Link href="/worker/profile#payment-settings">Add it in Profile → Payment settings</Link></p></StatePanel> : null}
        {earned.length ? <div className="earnings-group"><h3>Earned</h3>{scope.demo ? <EarlierEvidenceLabel /> : null}{earned.map(earning)}</div> : null}
        {pending.length ? <div className="earnings-group"><h3>Pending</h3>{pending.map(earning)}</div> : null}
        {paid.length ? <div className="earnings-group"><h3>Paid</h3>{scope.demo ? <EarlierEvidenceLabel /> : null}{paid.map(earning)}</div> : null}
        {expected.length ? <div className="earnings-group"><h3>Coming up{expectedTotal ? ` · ${expectedTotal} expected` : ""}</h3>{expected.map(row => <div className="record-row" key={row.offer.id}><span><strong>{shiftWhen(row.shift.startsAt, row.shift.endsAt, timezone).date}</strong><small>{row.departmentName ?? row.shift.roleName}</small></span><span>{row.shift.earningsModel === "COMMISSION" ? "Commission awaiting verified attributed sales" : `${money(row.shift.expectedEarningsMinor ?? row.shift.guaranteedBasePayMinor, row.shift.currencyCode)} expected`}<small>{row.allocation?.confirmedAt ? row.shift.earningsModel === "COMMISSION" ? "Work confirmed" : "Work confirmed · earnings not yet recorded" : "Awaiting work confirmation"}</small></span></div>)}</div> : null}
        {!accepted.length ? <StatePanel title="No earnings yet"><p>When you accept a shift and finish it, your pay appears here.</p></StatePanel> : null}
        <p className="note">A manager or the Owner confirms the work, and FairShift works out your earnings from the terms you accepted. FairShift checks them and pays them to your PayPal account in US dollars, converted from rand at the European Central Bank rate locked when the payment is reserved. Amounts show in rand first. An amount shows as Paid only after PayPal confirms it. Questions about a payment? Ask your manager.</p>
        <p className="note">Your earnings are your pay for each shift, from the terms you accepted, and your tips, which follow your location’s tip policy and are shown separately below. FairShift doesn’t calculate holiday pay or handle tax.</p>
      </section>
      {tips.pooled.length || tips.shiftPayMinor ? <section className="panel" aria-labelledby="tips-title"><h2 id="tips-title">Your tips</h2>
        {tips.pooled.map((line, index) => <div className="record-row" key={index}><span><strong>{line.localDate}</strong><small>{line.blockName ? `${line.blockName} ${formatMinute(line.blockStartMinute!)}–${formatMinute(line.blockEndMinute!)} · pooled share` : "Direct tips"}</small></span><span>{money(line.shareMinor, line.currencyCode)}<small>{line.payoutStatus === "PAID" ? "Paid (PayPal confirmed)" : line.payoutStatus && line.payoutStatus !== "FAILED" ? "Released, awaiting PayPal" : line.gateOutcome === "HELD" ? "Under review" : "Recorded"}</small></span></div>)}
        {tips.pooled.length ? <p className="note">At this location tips are pooled by shift block: each block’s tips are split equally between everyone who worked it, and your share is paid through the pool, not with your shift pay.</p> : null}
        {tips.shiftPayMinor && tips.currencyCode ? <p className="note">{money(tips.shiftPayMinor, tips.currencyCode)} in tips is recorded against your shifts at a direct-tip location. It stays on your shift pay, which FairShift doesn’t pay out yet.</p> : null}
      </section> : null}
      {!profile?.paypalPayoutEmail && !paymentDetailsNeeded ? <StatePanel title="Payment setup incomplete" tone="warning"><p>Add your payment details before your approved earnings can be sent. <Link href="/worker/profile#payment-settings">Add payment details</Link></p></StatePanel> : null}
      {payments.length ? <h2>Incentive payments</h2> : null}
      {payments.length ? <section className="overview-strip"><div><span>Incentives paid</span><strong>{incentiveTotal(["PAID"])}</strong></div><div><span>Awaiting approval</span><strong>{incentiveTotal(["EARNED"])}</strong></div><div><span>Approved or processing</span><strong>{incentiveTotal(["APPROVED", "SUBMITTING", "SUBMITTED", "PROCESSING"])}</strong></div></section> : null}
      {payments.length ? <p className="note">Incentive payments are separate from work earnings. Gratuity payment status is not tracked here.</p> : null}
      {payments.length ? payments.map((row) => <article className="panel" key={row.shift.id}><h2>{shiftWhen(row.shift.startsAt, row.shift.endsAt, timezone).date} · {money(row.incentive?.earnedAmountMinor ?? 0, row.shift.currencyCode)} incentive</h2><PaymentBadge status={row.incentive?.status} />{row.incentive?.paidAt ? <p>Confirmed paid on {dateTime(row.incentive.paidAt, timezone)}.</p> : null}{row.incentive?.status === "FAILED" ? <p>Your payment needs attention. Ask your manager to review its status.</p> : null}</article>) : null}
    </> : null}
    {area === "profile" ? <>
      <section className="panel" id="your-details"><h2>{profile?.displayName ?? "Casual worker"}</h2><p>{scope.locationName}</p>
        {scope.demo ? null : <details className="disclosure-inline"><summary>Edit your details</summary><form action={updateOwnDetailsAction} className="workspace-form form-grid">
          <label>First name<input name="firstName" defaultValue={profile?.firstName ?? ""} maxLength={100} required /></label>
          <label>Surname<input name="surname" defaultValue={profile?.surname ?? ""} maxLength={100} required /></label>
          <label>Phone (optional)<input name="telephone" type="tel" defaultValue={profile?.telephone ?? ""} maxLength={30} /></label>
          <button className="secondary-button">Save details</button><p className="form-span note">Your email is how you sign in; ask your manager if it needs changing.</p></form></details>}</section>
      <nav className="profile-links" aria-label="Profile"><Link href="/worker/availability"><span>Availability</span><small>The days you can work</small></Link><Link href="/account"><span>Account and notifications</span><small>Sign out, notices</small></Link></nav>
      <section className="panel" id="payment-settings"><h2>Payment settings</h2><p>{profile?.paypalPayoutEmail ? `Payment details added: ${maskedEmail(profile.paypalPayoutEmail)}` : "Payment setup incomplete. Add your payment details before your approved earnings can be sent."}</p><form action={saveDemoPayoutDestinationAction} className="workspace-form"><label>{profile?.paypalPayoutEmail ? "New PayPal email" : "PayPal payout email"}<input name="payoutEmail" type="email" autoComplete="email" maxLength={254} required /></label><label>Type it again<input name="confirmPayoutEmail" type="email" autoComplete="off" maxLength={254} required /></label>{profile?.paypalPayoutEmail ? <label>Your FairShift password<input name="currentPassword" type="password" autoComplete="current-password" maxLength={128} required /></label> : null}<button className="primary-button" type="submit">{profile?.paypalPayoutEmail ? "Change PayPal email" : "Save payment settings"}</button></form><p className="note">Saved for your profile across shifts. Saving details does not send a payment, and FairShift has not checked this email with PayPal, so please make sure it’s right.{profile?.paypalPayoutEmail ? " Changing it needs your password, then a link we email to the new address. Until you use that link, FairShift pauses new payouts to you. Payments already being sent still go to the email they were prepared with." : ""}</p>
        {pendingChange ? <StatePanel title="Payouts paused" tone="warning"><p>We emailed a link to {pendingChange.newEmail}. Use it before {dateTime(pendingChange.expiresAt, timezone)} to confirm your new PayPal email; until then FairShift won’t send you new payouts.</p><form action={cancelPayoutChangeAction}><button className="secondary-button">Cancel this change</button></form></StatePanel> : null}</section>
      {scope.demo ? null : <form action={signOutAction}><button className="secondary-button">Sign out</button></form>}
    </> : null}
  </>;
}
