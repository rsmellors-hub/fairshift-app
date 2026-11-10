import type { ProofPanel } from "@/server/product/proof";

// The PayPal & AI records as CSV: one row per PayPal Sandbox payout or subscription and per AI call, with
// its identifiers and outcome. Cells are quoted, and a leading =, +, - or @ is neutralised so a
// spreadsheet never runs it as a formula.
const cell = (value: unknown) => {
  const text = value === null || value === undefined ? "" : value instanceof Date ? value.toISOString() : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
};
const HEAD = ["record", "created_at", "location", "status", "outcome", "provider_reference", "model", "amount_minor", "currency", "provider_amount_minor", "provider_currency", "detail"];

export function recordsCsv(data: ProofPanel) {
  const rows: unknown[][] = [];
  for (const p of data.payouts) rows.push([p.kind === "TIP" ? "PAYPAL_TIP_PAYOUT" : "PAYPAL_WORK_PAYOUT", p.createdAt, data.nameOf(p.outletId), p.status, p.paypalStatus, [p.paypalBatchId, p.paypalItemId].filter(Boolean).join(" / "), "", p.amountMinor, p.currencyCode, p.providerAmountMinor, p.providerCurrency, p.fxRateSource ?? ""]);
  if (data.subscription) rows.push(["PAYPAL_SUBSCRIPTION", data.subscription.verifiedAt, "", data.subscription.status, data.subscription.tier, data.subscription.fixture ? "local fixture" : data.subscription.providerId, "", "", "", "", "", data.subscription.planId]);
  for (const e of data.payAgent) rows.push(["AI_PAY_AGENT", e.createdAt, data.nameOf(e.outletId), e.status, e.decision, e.responseId, e.responseModel, "", "", "", "", [e.reasonCode, e.dryRun ? "dry run" : ""].filter(Boolean).join(" · ")]);
  for (const e of data.tipAgent) rows.push(["AI_TIP_AGENT", e.createdAt, data.nameOf(e.outletId), e.status, e.decision, e.responseId, e.responseModel, "", "", "", "", [e.reasonCode, e.dryRun ? "dry run" : ""].filter(Boolean).join(" · ")]);
  for (const run of data.runs) {
    rows.push(["AI_LOCAL_SIGNALS_SEARCH", run.createdAt, data.nameOf(run.outletId), run.status, `${run.signals.length} findings`, run.providerResponseId ?? "", run.responseModel ?? "", "", "", "", "", run.failureCode ?? ""]);
    for (const signal of run.signals) rows.push(["AI_LOCAL_SIGNAL", run.createdAt, data.nameOf(run.outletId), signal.status, signal.effectType, signal.sourceUrl, "", "", "", "", "", `${signal.name} (${signal.validFrom}–${signal.validTo})`]);
  }
  for (const p of data.proposals) rows.push(["AI_DEMAND_CONTEXT", p.createdAt, data.nameOf(p.outletId), p.status, p.scenario ?? "", p.responseId ?? "", p.responseModel ?? "", "", "", "", "", p.failureCode ?? ""]);
  for (const a of data.assessments) rows.push(["AI_STAFFING_BRIEFING", a.createdAt, data.nameOf(a.outletId), a.status, "", a.responseId ?? "", a.responseModel ?? "", "", "", "", "", a.failureCode ?? ""]);
  return [HEAD, ...rows].map(row => row.map(cell).join(",")).join("\r\n") + "\r\n";
}
