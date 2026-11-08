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

// Fixtures only: no PayPal, OpenAI or web page is contacted.
const NOW = new Date("2026-10-21T08:00:00Z");
beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const provider = (responseId: string): LocalDiscoveryProvider => ({ provider: "OPENAI", model: "fixture-model", discover: vi.fn(async () => ({ responseId, responseModel: "fixture-model", text: JSON.stringify({ coverage: [], signals: [] }), searches: [], consultedUrls: [], citedUrls: [] })) });

describe("Proof panel", () => {
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
