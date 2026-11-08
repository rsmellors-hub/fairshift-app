import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { confirmedWork, payAgentCompany } from "../helpers/pay-agent";
import { sandboxFixture } from "../helpers/sandbox";
import { subscriptions, workPayouts } from "@/server/db/schema";
import type { LocalDiscoveryProvider } from "@/server/integrations/openai/web-discovery";
import { runLocalDiscovery } from "@/server/intelligence/local-intelligence-service";
import { approveWorkPayable } from "@/server/payments/work-payouts";
import { getProofPanel, LOCAL_SUBSCRIPTION_FIXTURE } from "@/server/product/proof";
import { ProofPanelView } from "@/app/owner/proof-panel";
import { labelledMoney, rand } from "@/app/components/format";
import { USD_SANDBOX_PLAN_IDS } from "../helpers/subscription-plans";

// Fixtures only: no PayPal, OpenAI or web page is contacted.
const NOW = new Date("2026-10-21T08:00:00Z");
beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const provider = (responseId: string): LocalDiscoveryProvider => ({ provider: "OPENAI", model: "fixture-model", discover: vi.fn(async () => ({ responseId, responseModel: "fixture-model", text: JSON.stringify({ coverage: [], signals: [] }), searches: [], consultedUrls: [], citedUrls: [] })) });

describe("Proof panel", () => {
  it("shows the hosted PayPal records: the subscription on its USD trial plan, and a paid payout from rand to US dollars at the frozen ECB rate", async () => {
    const { db, close } = await createTestDatabase();
    const demo = await payAgentCompany(db, { country: "South Africa" });
    sandboxFixture(demo.organisationId);
    vi.stubEnv("PAYPAL_MULTI_OUTLET_MONTHLY_PLAN_ID", USD_SANDBOX_PLAN_IDS.PAYPAL_MULTI_OUTLET_MONTHLY_PLAN_ID);
    await db.update(subscriptions).set({ providerId: "I-W03RREWEH5VB", planId: USD_SANDBOX_PLAN_IDS.PAYPAL_MULTI_OUTLET_MONTHLY_PLAN_ID, status: "ACTIVE", tier: "MULTI_OUTLET", billingPeriod: "MONTHLY", locationLimit: 5, verifiedAt: NOW })
      .where(eq(subscriptions.organisationId, demo.organisationId));
    const work = await confirmedWork(db, demo.scopes[0]);
    const payable = await approveWorkPayable(db, demo.scopes[0], work.payable!.id);
    expect(payable.approvedCurrencyCode).toBe("ZAR");
    const usd = Math.floor(payable.approvedAmountMinor! * 1_000_000 / 16_538_200), payoutId = randomUUID();
    await db.insert(workPayouts).values({ id: payoutId, payableId: payable.id, organisationId: demo.organisationId, outletId: demo.scopes[0].locationId, workerId: work.worker.id, amountMinor: payable.approvedAmountMinor!, currencyCode: "ZAR",
      providerCurrency: "USD", providerAmountMinor: usd, fxRateMicros: 16_538_200, fxRateSource: "ECB_EUROFXREF_DAILY:2026-11-06", recipient: "sb-recipient@personal.example.com", senderBatchId: "FSWP-B-PROOF", senderItemId: "FSWP-I-PROOF", status: "SUBMITTING", reservedAt: NOW });
    await db.update(workPayouts).set({ status: "PROCESSING", paypalBatchId: "5ZBF3L7XQ4AWA", paypalBatchStatus: "PENDING" }).where(eq(workPayouts.id, payoutId));
    await db.update(workPayouts).set({ status: "PAID", paypalItemId: "LNCVDBR5FJ2PY", paypalStatus: "SUCCESS", paypalBatchStatus: "SUCCESS", paypalTransactionId: "TXPROOF", paidAt: NOW, statusCheckedAt: NOW }).where(eq(workPayouts.id, payoutId));
    const html = renderToStaticMarkup(ProofPanelView({ data: await getProofPanel(db, { organisationId: demo.organisationId, role: "OWNER" }, NOW) }));
    for (const shown of ["I-W03RREWEH5VB", "ACTIVE", "Group Monthly (USD), 30-day trial: 30 days free, then US$69.48 a month (R1,149 incl. VAT)", "PayPal reports a subscription as ACTIVE during its free trial",
      "5ZBF3L7XQ4AWA", "LNCVDBR5FJ2PY", "SUCCESS", "PAID", `${rand(payable.approvedAmountMinor!)}<small> → ${labelledMoney(usd, "USD")} (ECB_EUROFXREF_DAILY:2026-11-06)`]) expect(html).toContain(shown);
    for (const hidden of ["sb-recipient@personal.example.com", "FSWP-B-PROOF", "ZAR 1"]) expect(html).not.toContain(hidden);
    await close();
  });

  it("shows a payout PayPal refused outright as refused, with PayPal's reason, and keeps one PayPal accepted and later failed as reported", async () => {
    const { db, close } = await createTestDatabase();
    const demo = await payAgentCompany(db);
    sandboxFixture(demo.organisationId);
    const record = async (batch: string, outcome: Partial<typeof workPayouts.$inferInsert>) => {
      const work = await confirmedWork(db, demo.scopes[0]);
      const payable = await approveWorkPayable(db, demo.scopes[0], work.payable!.id);
      const payoutId = randomUUID();
      await db.insert(workPayouts).values({ id: payoutId, payableId: payable.id, organisationId: demo.organisationId, outletId: demo.scopes[0].locationId, workerId: work.worker.id, amountMinor: payable.approvedAmountMinor!, currencyCode: payable.approvedCurrencyCode!,
        providerCurrency: payable.approvedCurrencyCode!, providerAmountMinor: payable.approvedAmountMinor!, recipient: "proof.recipient@example.test", senderBatchId: `FSWP-B-${batch}`, senderItemId: `FSWP-I-${batch}`, status: "SUBMITTING", reservedAt: NOW });
      await db.update(workPayouts).set(outcome).where(eq(workPayouts.id, payoutId));
    };
    // Refused outright, as the engine records a PayPal 400 (docs/evidence/paypal-currency-tests.md): no batch.
    await record("REFUSED", { status: "FAILED", statusCheckedAt: NOW, lastError: { code: "VALIDATION_ERROR", httpStatus: 400, debugId: "dbg-proof-refused", outcome: "REJECTED", reason: "Currency is not supported" } });
    // Accepted by PayPal, then failed on the item: not a refusal.
    await record("ACCEPTED", { status: "FAILED", paypalBatchId: "PPBACCEPTEDFAIL", paypalBatchStatus: "SUCCESS", paypalStatus: "FAILED", statusCheckedAt: NOW });
    const proof = await getProofPanel(db, { organisationId: demo.organisationId, role: "OWNER" }, NOW);
    const html = renderToStaticMarkup(ProofPanelView({ data: proof }));
    for (const shown of ["Refused by PayPal: Currency is not supported", "<code>none created</code> / <code>none created</code>", "FAILED<small> · Not paid</small>", "PPBACCEPTEDFAIL"]) expect(html).toContain(shown);
    expect(html.match(/Refused by PayPal/g)).toHaveLength(1);
    expect(html.match(/Not paid/g)).toHaveLength(1);
    expect(html).not.toMatch(/data-label="PayPal status">unknown/);
    // Only the derived reason leaves the server: no error code, debug ID or recipient.
    for (const hidden of ["VALIDATION_ERROR", "dbg-proof-refused", "proof.recipient@example.test", "FSWP-B-"]) expect(html).not.toContain(hidden);
    expect(JSON.stringify(proof!.payouts)).not.toMatch(/lastError|VALIDATION_ERROR|dbg-proof-refused|httpStatus/);
    expect(proof!.payouts.map(row => row.refusal)).toEqual(expect.arrayContaining([{ reason: "Currency is not supported" }, null]));
    await close();
  });

  it("shows the demonstration organisation's own evidence only, and no recipient, token or secret", async () => {
    const { db, close } = await createTestDatabase();
    const demo = await payAgentCompany(db), other = await payAgentCompany(db);
    sandboxFixture(demo.organisationId);
    for (const [company, batch, recipient, response] of [[demo, "PPBDEMOBATCH", "demo.recipient@example.test", "resp_demo_fixture"], [other, "PPBOTHERBATCH", "other.recipient@example.test", "resp_other_fixture"]] as const) {
      const work = await confirmedWork(db, company.scopes[0]);
      // A payout as the engine records one: the manager's approval, a reservation, then PayPal's batch.
      const payable = await approveWorkPayable(db, company.scopes[0], work.payable!.id);
      const payoutId = randomUUID();
      await db.insert(workPayouts).values({ id: payoutId, payableId: payable.id, organisationId: company.organisationId, outletId: company.scopes[0].locationId, workerId: work.worker.id, amountMinor: payable.approvedAmountMinor!, currencyCode: payable.approvedCurrencyCode!,
        providerCurrency: payable.approvedCurrencyCode!, providerAmountMinor: payable.approvedAmountMinor!, recipient, senderBatchId: `FSWP-B-${batch}`, senderItemId: `FSWP-I-${batch}`, status: "SUBMITTING", reservedAt: NOW });
      await db.update(workPayouts).set({ status: "PROCESSING", paypalBatchId: batch, paypalBatchStatus: "PENDING" }).where(eq(workPayouts.id, payoutId));
      await runLocalDiscovery(db, { organisationId: company.organisationId, outletId: company.scopes[0].locationId }, { kind: "DAILY", trigger: "MANUAL", provider: provider(response), checkSource: async () => ({ outcome: "REACHABLE", httpStatus: 200 }), now: NOW });
    }
    await db.update(subscriptions).set({ providerId: LOCAL_SUBSCRIPTION_FIXTURE }).where(eq(subscriptions.organisationId, demo.organisationId));
    const proof = await getProofPanel(db, { organisationId: demo.organisationId, role: "OWNER" }, NOW);
    expect(proof).not.toBeNull();
    const html = renderToStaticMarkup(ProofPanelView({ data: proof }));
    for (const shown of ["PPBDEMOBATCH", "resp_demo_fixture", "local runtime fixture, not a PayPal subscription", "UK (GBP) Sandbox seller", "Synthetic", "Fictional", "Measured against synthetic history"]) expect(html).toContain(shown);
    for (const hidden of ["PPBOTHERBATCH", "resp_other_fixture", "demo.recipient@example.test", "other.recipient@example.test", "FSWP-B-", "Bearer", "sk-"]) expect(html).not.toContain(hidden);
    // Another organisation, and anyone but the Owner, get nothing.
    expect(await getProofPanel(db, { organisationId: other.organisationId, role: "OWNER" }, NOW)).toBeNull();
    expect(await getProofPanel(db, { organisationId: demo.organisationId, role: "MANAGER" }, NOW)).toBeNull();
    expect(renderToStaticMarkup(ProofPanelView({ data: null }))).toContain("for the demonstration organisation only");
    await close();
  });
});
