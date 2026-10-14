import Link from "next/link";

import type { ForecastResult } from "@/server/intelligence/forecast";
import type { AiAssessmentResult } from "@/server/integrations/openai/operational-intelligence";

function money(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value / 100);
}

export function ManagerForecast({
  result,
  aiResult,
  error,
}: {
  result: ForecastResult | null;
  aiResult?: AiAssessmentResult | null;
  error?: string;
}) {
  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand"><span>F</span><strong>FairShift</strong></div>
        <Link href="/">PayPal integration evidence</Link>
      </header>
      <section className="panel">
        <span className="eyebrow">Manager · operational intelligence</span>
        <h1>Demand → staffing decision</h1>
        <p>FairShift — operational intelligence for hourly businesses.</p>
        <p className="method-note">Deterministic demand and staffing baseline · separate AI-assisted operational interpretation.</p>
      </section>
      {!result || result.status === "UNAVAILABLE" ? (
        <section className="panel" role="status">
          <h2>Forecast unavailable</h2>
          <p>{error ?? "No eligible completed sales in the 56-day lookback. No forecast or staffing recommendation has been invented."}</p>
          <p className="method-note">After configuring PostgreSQL and applying migrations, optionally run <code>pnpm db:seed-demo</code> for clearly labelled synthetic history.</p>
        </section>
      ) : (
        <>
          <section className="panel">
            <strong className="sandbox-banner">{result.source === "DEMO_SEEDED" ? "DEMO / SEEDED — NOT PAYPAL-VERIFIED" : "PAYPAL SANDBOX — VERIFIED TRANSACTION INPUTS"}</strong>
            <h2>{result.outletName} · {result.targetDate}</h2>
            <p>{result.timezone} · {result.staffing.policy.tradingHours}-hour trading day · USD</p>
            <p className="method-note">{result.source === "DEMO_SEEDED"
              ? "Fixed synthetic scenario for 15 October 2026. This is not a live forecast."
              : "Uses completed, reconciled PayPal sandbox sales only. Seeded transactions are excluded."}</p>
          </section>
          <section className="status-grid forecast-grid" aria-label="Forecast and staffing">
            <article><span>Expected sales</span><strong>{money(result.forecastSalesMinor)}</strong><small>Demand estimate; not a team sales target</small></article>
            <article><span>Planning range</span><strong>{money(result.lowerSalesMinor)}–{money(result.upperSalesMinor)}</strong><small>{result.support} evidence support · not a calibrated confidence interval</small></article>
            <article><span>Recommended workers</span><strong>{result.staffing.workers}</strong><small>Minimum opening coverage: {result.staffing.policy.minimumWorkers}</small></article>
            <article><span>Recommended worker delta</span><strong>{result.staffing.workerDelta > 0 ? "+" : ""}{result.staffing.workerDelta}</strong><small>Versus {result.staffing.policy.comparisonWorkers} workers — comparison assumption, not a saved plan</small></article>
          </section>
          <section className="panel">
            <h2>Why this staffing level?</h2>
            <p>{money(result.forecastSalesMinor)} ÷ ({money(result.staffing.policy.salesMinorPerLabourHour)} sales per labour hour × {result.staffing.policy.tradingHours} hours), rounded up, with at least {result.staffing.policy.minimumWorkers} workers.</p>
            <p className="method-note">This illustrative capacity policy assumes each worker covers the full trading day. It is not an individual quota, wage calculation, or staffing schedule.</p>
            <h3>Manager action</h3>
            <p>{result.action}</p>
          </section>
          <section className="panel" aria-label="AI operational assessment">
            <span className="eyebrow">AI operational assessment</span>
            <h2>Operational interpretation</h2>
            {aiResult?.status === "AVAILABLE" ? (
              <>
                <strong className="sandbox-banner">REAL AI · OPENAI · {aiResult.model}</strong>
                <div className="status-grid forecast-grid">
                  <article>
                    <span>Demand outlook</span>
                    <strong>{aiResult.assessment.demandOutlook.replaceAll("_", " ")}</strong>
                    <small>AI interpretation of the deterministic evidence</small>
                  </article>
                  <article>
                    <span>Signal quality</span>
                    <strong>{aiResult.assessment.signalQuality}</strong>
                    <small>Evidence-quality assessment, not forecast confidence</small>
                  </article>
                  <article>
                    <span>Staffing assessment</span>
                    <strong>{aiResult.assessment.staffingAssessment.replaceAll("_", " ")}</strong>
                    <small>The AI cannot replace the deterministic worker count</small>
                  </article>
                </div>
                <h3>Assessment</h3>
                <p>{aiResult.assessment.summary}</p>
                <h3>Manager action</h3>
                <p>{aiResult.assessment.managerAction}</p>
                <p className="method-note">
                  AI provides bounded decision support only. The deterministic forecast and staffing baseline above remain unchanged, and manager judgement is required.
                </p>
              </>
            ) : aiResult?.status === "NOT_CONFIGURED" ? (
              <>
                <strong className="sandbox-banner">AI · NOT CONFIGURED</strong>
                <p>OpenAI operational assessment is not configured. The deterministic forecast and staffing baseline remain available.</p>
              </>
            ) : (
              <>
                <strong className="sandbox-banner">AI · UNAVAILABLE</strong>
                <p>AI operational assessment is temporarily unavailable. No AI assessment has been fabricated; use the deterministic evidence above.</p>
              </>
            )}
          </section>
          <section className="panel">
            <h2>Historical evidence</h2>
            <p>{result.eligibleTransactions} eligible transactions across {result.eligibleDays} observed days. {result.evidence.length} days selected using {result.basis === "SAME_WEEKDAY" ? "the same weekday" : "the sparse-history fallback"}.</p>
            <div className="history-scroll">
              <table className="history-table">
                <caption>Selected daily totals · {result.source === "DEMO_SEEDED" ? "DEMO / SEEDED" : "PayPal sandbox reconciled records"}</caption>
                <thead><tr><th scope="col">Local date</th><th scope="col">Transactions</th><th scope="col">Recorded sales</th><th scope="col">Used in forecast</th><th scope="col">Recency weight</th></tr></thead>
                <tbody>{result.evidence.map((day) => <tr key={day.date}><th scope="row">{day.date}</th><td>{day.transactions}</td><td>{money(day.salesMinor)}</td><td>{money(day.usedSalesMinor)}</td><td>{day.weight}</td></tr>)}</tbody>
              </table>
            </div>
          </section>
          <section className="panel">
            <h2>Reasoning and limits</h2>
            <ul>{result.drivers.map((driver) => <li key={driver}>{driver}</li>)}</ul>
            <p className="method-note">History cutoff: {result.dataAsOf}. Generated: {result.generatedAt}. Method: {result.methodVersion}. Policy: {result.staffing.policy.version}.</p>
            <p className="method-note">No weather, events, promotions, labour availability or service-time measurements are included. Confirm capacity and data completeness before acting.</p>
          </section>
        </>
      )}
    </main>
  );
}
