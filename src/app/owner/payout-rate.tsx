import { recordManualFxRateAction } from "@/app/fx-actions";
import { FeedLabel } from "@/app/components/source-labels";
import type { FxReferenceRate } from "@/server/fx/reference-rates";
import type { LiveFeedStatus } from "@/server/intelligence/live-feeds";

// The ZAR->USD payout rate under DEC-SA-012: the newest recorded ECB reference rate, whether it is
// fresh enough for payouts, and the Owner's manual fallback for the Sandbox demo organisation.
export function PayoutRatePanel({ rate, fresh, canRecord, feed = null, timeZone = "UTC" }: { rate: FxReferenceRate | null; fresh: boolean; canRecord: boolean; feed?: LiveFeedStatus["ecb"] | null; timeZone?: string }) {
  return <section className="panel" id="payout-rate">
    <h2>Payout exchange rate</h2>
    <p className="panel-lede">PayPal can&apos;t pay out rand, so ZAR earnings are paid in US dollars at the most recent European Central Bank reference rate (EUR/ZAR ÷ EUR/USD). The rate is locked in when a payout is reserved and never re-converted. If no rate from the last three business days is recorded, payouts are blocked.</p>
    {feed ? <p className="note"><FeedLabel source="European Central Bank euro reference rates" updatedAt={feed.updatedAt} stale={feed.status === "STALE" || !fresh} timeZone={timeZone} /> FairShift fetches the ECB file on a schedule and records each new reference date.{feed.lastFailureCode ? " The latest fetch failed, so the last recorded rate stands." : ""}</p> : null}
    {rate ? <dl className="detail-list">
      <div><dt>ECB reference date</dt><dd>{rate.rateDate}</dd></div>
      <div><dt>EUR/ZAR · EUR/USD</dt><dd>{rate.eurZar} · {rate.eurUsd}</dd></div>
      <div><dt>Payout rate</dt><dd>R{(rate.usdZarMicros / 1_000_000).toFixed(6)} per US$1</dd></div>
      <div><dt>Source</dt><dd>{rate.source === "OWNER_MANUAL" ? "Entered by the Owner from the ECB publication" : "ECB daily reference rates"}</dd></div>
      <div><dt>Status</dt><dd>{fresh ? "Current: payouts can use it" : "Older than three business days: payouts are blocked"}</dd></div>
    </dl> : <p>No reference rate is recorded yet, so ZAR payouts are blocked.</p>}
    {canRecord ? <form action={recordManualFxRateAction} className="inline-form" data-demo-write="">
      <p className="note">Only if the ECB file can&apos;t be fetched: enter the ECB&apos;s published rates for one reference date exactly as published. Recorded rates can&apos;t be changed.</p>
      <label>ECB reference date<input name="rateDate" type="date" required /></label>
      <label>EUR/ZAR<input name="eurZar" inputMode="decimal" pattern="[0-9]{1,6}(\.[0-9]{1,6})?" required /></label>
      <label>EUR/USD<input name="eurUsd" inputMode="decimal" pattern="[0-9]{1,6}(\.[0-9]{1,6})?" required /></label>
      <button className="secondary-button">Record ECB rate</button>
    </form> : null}
  </section>;
}
