import Link from "next/link";
import { notFound } from "next/navigation";
import { labelledMoney, money } from "@/app/components/format";
import { PageHeader, StatusBadge } from "@/app/components/product-ui";
import { ActionFeedback, dateTime, WorkspaceUnavailable } from "@/app/components/workspace-ui";
import { raisePayQueryAction } from "@/app/worker-actions";
import { requireScope } from "@/server/auth/request";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { finalPayableMinor } from "@/server/domain/work-payable";
import { PAY_QUERY_TOPIC_LABEL, PAY_QUERY_TOPICS, type PayQueryTopic } from "@/server/worker/pay-queries";
import { workerShiftPay } from "@/server/worker/shift-pay";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// One shift's pay (design: worker Pay). The worker's amount first, then what PayPal Sandbox was sent with
// the ECB rate it locked and the batch reference; "Paid ✓" only when PayPal reported SUCCESS. Questions go
// to the Owner, who answers in the Inbox. Nothing on this page can change an amount.
const PAYOUT: Record<string, string> = { SUBMITTING: "Sending to PayPal", NOT_SENT: "Not sent", PROCESSING: "With PayPal", PAID: "Paid ✓", FAILED: "Not paid", RECONCILIATION_REQUIRED: "Being checked with PayPal" };

export default async function ShiftPayPage({ params, searchParams }: { params: Promise<{ payableId: string }>; searchParams: Promise<{ status?: string }> }) {
  if (!getConfigurationStatus().databaseConfigured) return <WorkspaceUnavailable />;
  const scope = await requireScope(["TEAM_MEMBER"]);
  const [{ payableId }, { status }] = await Promise.all([params, searchParams]);
  const view = await workerShiftPay(getDatabase(), scope, payableId).catch(() => undefined);
  if (view === undefined) return <WorkspaceUnavailable />;
  if (!view) notFound();
  const { payable, shift, place, payout, tips, checks, queries } = view;
  const tz = place.timezone, amount = (value: number) => money(value, payable.currencyCode);
  const clock = (date: Date) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: tz }).format(date);
  const day = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: tz }).format(shift.startsAt);
  const bonusUnknown = payable.incentiveRequired && payable.incentiveAmountMinor === null;
  const tipsTotal = tips.reduce((sum, tip) => sum + tip.shareMinor, 0);
  const open = queries.find(query => query.status === "OPEN");
  return <div className="product-page worker-page">
    <p><Link href="/worker/pay">← Your pay</Link></p>
    <PageHeader eyebrow={place.name} title={`${day} · ${clock(shift.startsAt)}–${clock(shift.endsAt)}`} />
    <ActionFeedback status={status} />
    <section className="panel" aria-labelledby="shift-pay-title"><h2 id="shift-pay-title">This shift’s pay</h2>
      <dl className="earning-sum">
        <div><dt>Shift earnings<small>From the terms you accepted · version {payable.termsVersion}</small></dt><dd>{amount(payable.baseAmountMinor)}</dd></div>
        {payable.incentiveRequired ? <div><dt>Bonus</dt><dd>{bonusUnknown ? "Not known yet" : amount(payable.incentiveAmountMinor!)}</dd></div> : null}
        {tips.map((tip, index) => <div key={index}><dt>Card tips{tip.block ? ` · ${tip.block}` : ""}<small>Paid separately under the location’s tip policy{tip.payoutStatus === "PAID" ? " · Paid ✓" : tip.payoutStatus ? ` · ${PAYOUT[tip.payoutStatus] ?? tip.payoutStatus}` : " · not released yet"}</small></dt><dd>{money(tip.shareMinor, tip.currencyCode)}</dd></div>)}
        <div className="earning-total"><dt>Total{tips.length ? <small>Shift earnings and tips</small> : null}</dt><dd>{bonusUnknown ? `${amount(finalPayableMinor(payable))} so far` : amount(finalPayableMinor(payable) + tipsTotal)}</dd></div>
      </dl>
      {payout ? <div className="payout-detail">
        <p><StatusBadge tone={payout.status === "PAID" ? "success" : payout.status === "FAILED" ? "warning" : "neutral"}>{PAYOUT[payout.status] ?? payout.status}</StatusBadge>{payout.status === "PAID" && payout.paidAt ? <> PayPal confirmed {dateTime(payout.paidAt, tz)} ({tz})</> : null}</p>
        {payout.providerCurrency !== payout.currencyCode ? <p className="note">{money(payout.amountMinor, payout.currencyCode)} sent through PayPal Sandbox as {labelledMoney(payout.providerAmountMinor, payout.providerCurrency)}{payout.fxRateMicros ? `, at ECB ${(payout.fxRateMicros / 1_000_000).toFixed(4)} ${payout.currencyCode === "ZAR" ? "rand" : payout.currencyCode} per ${payout.providerCurrency === "USD" ? "US dollar" : payout.providerCurrency}${payout.fxRateSource?.includes(":") ? ` (${payout.fxRateSource.split(":")[1]})` : ""}, locked when the payment was created` : ""}.</p> : null}
        {tips.filter(tip => tip.fxRateMicros && tip.providerCurrency).map((tip, index) => <p className="note" key={index}>Tips sent as {labelledMoney(tip.providerAmountMinor!, tip.providerCurrency!)} at ECB {(tip.fxRateMicros! / 1_000_000).toFixed(4)}{tip.paypalBatchId ? ` · batch ${tip.paypalBatchId}` : ""}.</p>)}
        {payout.paypalBatchId ? <p className="note">PayPal batch <code>{payout.paypalBatchId}</code></p> : null}
        {payout.status === "PROCESSING" && payout.paypalStatus === "UNCLAIMED" ? <p>Claim this payment by signing in to PayPal with your saved email.</p> : null}
      </div> : <p className="note">{payable.status === "APPROVED" ? "Approved. It hasn’t been sent to PayPal yet." : "Not approved yet, so nothing has been sent."}</p>}
      {checks.length ? <><h3>What the Pay Agent checked <StatusBadge tone="predictive">AI</StatusBadge></h3><ul className="pay-agent-checklist">{checks.map(item => <li key={item.text}><span aria-hidden="true">{item.ok ? "✓" : "!"}</span> {item.text}</li>)}</ul></> : null}
    </section>
    <section className="panel" id="query" aria-labelledby="query-title"><h2 id="query-title">Query this shift’s pay</h2>
      {queries.filter(query => query.status === "ANSWERED").map(query => <article className="record-row" key={query.id}><div><strong>{PAY_QUERY_TOPIC_LABEL[query.topic as PayQueryTopic] ?? query.topic}</strong><p>{query.message}</p><p><strong>Answer:</strong> {query.answer}</p><small>{query.answeredAt ? dateTime(query.answeredAt, tz) : ""}</small></div></article>)}
      {open ? <p role="status">You asked: “{open.message}”. The Pay Agent has set out what’s recorded for this shift and passed it to the Owner, who answers in your Inbox.</p>
        : scope.demo ? <p className="note">Questions are sent by signed-in workers.</p>
        : <form action={raisePayQueryAction} className="workspace-form"><input type="hidden" name="payableId" value={payable.id} />
          <fieldset><legend>What’s it about?</legend>{PAY_QUERY_TOPICS.map(topic => <label key={topic}><input type="radio" name="topic" value={topic} required /> {PAY_QUERY_TOPIC_LABEL[topic]}</label>)}</fieldset>
          <label>Your question<textarea name="message" maxLength={1000} required rows={3} /></label>
          <button className="primary-button">Send to the Owner</button>
          <p className="note">The Pay Agent sets out what’s already recorded for this shift (its checks and the PayPal status) for the Owner. It can’t change any amount, and neither can this question.</p></form>}
    </section>
  </div>;
}
