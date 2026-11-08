import { rand } from "@/app/components/format";
import { DataLabel, PageHeader, StatePanel } from "@/app/components/product-ui";
import type { ForecastResult } from "@/server/intelligence/forecast";

function money(value: number, currency: string) {
  if (currency === "ZAR") return rand(value);
  return new Intl.NumberFormat(currency === "GBP" ? "en-GB" : "en-US", { style: "currency", currency }).format(value / 100);
}
const SOURCE = {
  PAYPAL_SANDBOX: { kind: "fact", label: "Historical fact · verified PayPal Sandbox sales", records: "PayPal sandbox reconciled records" },
  DEMO_SEEDED: { kind: "demo", label: "Demo / seeded · not PayPal verified", records: "DEMO / SEEDED" },
  REFERENCE: { kind: "demo", label: "Reference history · synthetic, not provider sales", records: "REFERENCE / SYNTHETIC" },
  IMPORTED: { kind: "fact", label: "Imported sales history · not provider-verified", records: "IMPORTED" },
  ZETTLE: { kind: "fact", label: "Earlier connected-account sales", records: "CONNECTED ACCOUNT" },
  SQUARE: { kind: "fact", label: "Square Sandbox sales · connected seller", records: "SQUARE SANDBOX" },
} as const;
const UNAVAILABLE = {
  NO_ELIGIBLE_HISTORY: "No eligible completed sales in the 56-day lookback. No forecast or staffing recommendation has been invented.",
  NO_STAFFING_POLICY_FOR_CURRENCY: "This single-day demonstration worker estimate is defined in USD and this location’s sales history is not, so it is not calculated. Labour hours for the planning week are shown under Planning week staffing.",
} as const;

export function ManagerForecast({
  result,
  error,
}: {
  result: ForecastResult | null;
  error?: string;
}) {
  return (
    <>
      <PageHeader
        eyebrow="Forecast & Staffing"
        title="Demand and recommended staffing"
        description="Review the factual sales history, demand forecast and staffing recommendation before taking action."
      />
      {!result || result.status === "UNAVAILABLE" ? (
        <StatePanel title="Forecast unavailable" tone="warning">
          <p>{error ?? UNAVAILABLE[result?.status === "UNAVAILABLE" ? result.reason : "NO_ELIGIBLE_HISTORY"]}</p>
        </StatePanel>
      ) : (
        <>
          <section className="panel">
            <DataLabel kind={SOURCE[result.source].kind}>{SOURCE[result.source].label}</DataLabel>
            <h2>{result.outletName} · {result.targetDate}</h2>
            <p>{result.timezone} · {result.staffing.policy.tradingHours}-hour trading day · {result.currency}</p>
            <p className="note">{result.source === "PAYPAL_SANDBOX"
              ? "Uses completed, reconciled PayPal sandbox sales only. Seeded transactions are excluded."
              : result.source === "IMPORTED" ? `Imported history; forecast for ${result.targetDate} from comparable weekdays in that history. This is not a live forecast.`
              : `Synthetic history; forecast for ${result.targetDate} from comparable weekdays in that history. This is not a live forecast.`}</p>
          </section>
          <section className="status-grid forecast-grid" aria-label="Forecast and staffing">
            <article><DataLabel kind="predictive">Forecast</DataLabel><span>Expected sales</span><strong>{money(result.forecastSalesMinor, result.currency)}</strong><small>Demand estimate; not a team sales target</small></article>
            <article><DataLabel kind="predictive">Forecast range</DataLabel><span>Planning range</span><strong>{money(result.lowerSalesMinor, result.currency)}–{money(result.upperSalesMinor, result.currency)}</strong><small>{result.support} evidence support · not a calibrated confidence interval</small></article>
            <article><span>Recommended workers</span><strong>{result.staffing.workers}</strong><small>Minimum opening coverage: {result.staffing.policy.minimumWorkers}</small></article>
            <article><span>Recommended worker delta</span><strong>{result.staffing.workerDelta > 0 ? "+" : ""}{result.staffing.workerDelta}</strong><small>Versus {result.staffing.policy.comparisonWorkers} workers — comparison assumption, not a saved plan</small></article>
          </section>
          <section className="panel">
            <h2>Why this staffing level?</h2>
            <p>{money(result.forecastSalesMinor, result.currency)} ÷ ({money(result.staffing.policy.salesMinorPerLabourHour, result.currency)} sales per labour hour × {result.staffing.policy.tradingHours} hours), rounded up, with at least {result.staffing.policy.minimumWorkers} workers.</p>
            <p className="note">This illustrative capacity policy assumes each worker covers the full trading day. It is not an individual quota, wage calculation, or staffing schedule.</p>
            <h3>Manager action</h3>
            <p>{result.action}</p>
          </section>
          <section className="panel">
            <DataLabel kind="fact">Historical fact</DataLabel>
            <h2>Historical evidence</h2>
            <p>{result.eligibleTransactions} eligible transactions across {result.eligibleDays} observed days. {result.evidence.length} days selected using {result.basis === "SAME_WEEKDAY" ? "the same weekday" : "the sparse-history fallback"}.</p>
            <div className="history-scroll">
              <table className="history-table">
                <caption>Selected daily totals · {SOURCE[result.source].records}</caption>
                <thead><tr><th scope="col">Local date</th><th scope="col">Transactions</th><th scope="col">Recorded sales</th><th scope="col">Used in forecast</th><th scope="col">Recency weight</th></tr></thead>
                <tbody>{result.evidence.map((day) => <tr key={day.date}><th scope="row">{day.date}</th><td>{day.transactions}</td><td>{money(day.salesMinor, result.currency)}</td><td>{money(day.usedSalesMinor, result.currency)}</td><td>{day.weight}</td></tr>)}</tbody>
              </table>
            </div>
          </section>
          <details className="panel">
            <summary>Reasoning and limits</summary>
            <ul>{result.drivers.map((driver) => <li key={driver}>{driver}</li>)}</ul>
            <p className="note">History cutoff: {result.dataAsOf}. Generated: {result.generatedAt}. Method: {result.methodVersion}. Policy: {result.staffing.policy.version}.</p>
            <p className="note">No weather, events, promotions, labour availability or service-time measurements are included. Confirm capacity and data completeness before acting.</p>
          </details>
        </>
      )}
    </>
  );
}
