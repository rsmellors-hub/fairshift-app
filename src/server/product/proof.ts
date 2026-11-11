import { and, desc, eq, inArray } from "drizzle-orm";
import type { Scope } from "@/server/auth/access";
import type { DatabaseSession } from "@/server/db/client";
import { aiStaffingAssessments, demandContextFeeds, demandContextProposals, localIntelligenceOutcomes, localIntelligenceRuns, localIntelligenceSignals, outlets, payAgentEvents, subscriptions, tipAgentEvents, workPayouts } from "@/server/db/schema";
import { commercialPlan, configuredPlan, planSelection, TRIAL_DAYS } from "@/server/billing/plans";
import { getLiveFeedStatus } from "@/server/intelligence/live-feeds";
import { isDemoOrganisation } from "@/server/demo/organisation";
import { SA_REFERENCE_ORGANISATION } from "@/server/reference/sa-reference";
import { payoutRefusal } from "@/server/domain/payout-refusal";
import { storedSignalStatus } from "@/server/intelligence/local-intelligence-contract";

// PayPal & AI records (the Proof panel): what an Owner can check is real, for their own business. Read-only,
// and it holds no secret, token, recipient or contact detail: provider identifiers, statuses, AI
// response identifiers with their decisions, AI-found sources with what was searched, feed times, and
// which data is synthetic.

export const LOCAL_SUBSCRIPTION_FIXTURE = "LOCAL-RUNTIME-FIXTURE";

// The catalogue terms of a subscription's plan, only when its plan ID is the one configured for that
// choice now (the current USD trial plans). An earlier GBP plan shows its ID and status, no terms.
function currentPlanTerms(row: { planId: string | null; tier: string | null; billingPeriod: string | null }) {
  const choice = planSelection.safeParse({ tier: row.tier, billingPeriod: row.billingPeriod });
  if (!choice.success || !row.planId || configuredPlan(choice.data) !== row.planId) return null;
  const terms = commercialPlan(choice.data);
  return { name: terms.name, amount: terms.amount, currency: terms.currency, homeAmount: terms.homeAmount, interval: terms.interval, trialDays: TRIAL_DAYS };
}

export async function getProofPanel(db: DatabaseSession, scope: Pick<Scope, "organisationId" | "role">, now = new Date()) {
  // Every business's Owner sees its own records (design, 10 Nov 2026: "PayPal & AI records"); everything
  // below is read by organisation. Only the demo business carries the synthetic-data notes.
  if (scope.role !== "OWNER") return null;
  const organisationId = scope.organisationId;
  const locations = await db.select({ id: outlets.id, name: outlets.name, timezone: outlets.timezone }).from(outlets).where(eq(outlets.organisationId, organisationId)).orderBy(outlets.name);
  const ids = locations.map(row => row.id);
  const [payouts, subscription, payAgent, tipAgent, runs, proposals, assessments, weather, outcomes, feeds] = await Promise.all([
    db.select({ id: workPayouts.id, kind: workPayouts.tipLineId, outletId: workPayouts.outletId, status: workPayouts.status, paypalStatus: workPayouts.paypalStatus, paypalBatchStatus: workPayouts.paypalBatchStatus,
      paypalBatchId: workPayouts.paypalBatchId, paypalItemId: workPayouts.paypalItemId, paypalTransactionId: workPayouts.paypalTransactionId, amountMinor: workPayouts.amountMinor, currencyCode: workPayouts.currencyCode,
      providerAmountMinor: workPayouts.providerAmountMinor, providerCurrency: workPayouts.providerCurrency, fxRateSource: workPayouts.fxRateSource, createdAt: workPayouts.createdAt, statusCheckedAt: workPayouts.statusCheckedAt, paidAt: workPayouts.paidAt, senderEmail: workPayouts.senderEmail,
      // Read only to derive whether PayPal refused the payout, and its reason; not returned.
      lastError: workPayouts.lastError })
      .from(workPayouts).where(eq(workPayouts.organisationId, organisationId)).orderBy(desc(workPayouts.createdAt)).limit(50),
    db.select({ providerId: subscriptions.providerId, planId: subscriptions.planId, status: subscriptions.status, tier: subscriptions.tier, billingPeriod: subscriptions.billingPeriod, verifiedAt: subscriptions.verifiedAt }).from(subscriptions).where(eq(subscriptions.organisationId, organisationId)),
    db.select({ id: payAgentEvents.id, outletId: payAgentEvents.outletId, status: payAgentEvents.status, decision: payAgentEvents.decision, reasonCode: payAgentEvents.reasonCode, summary: payAgentEvents.summary, responseId: payAgentEvents.responseId, responseModel: payAgentEvents.responseModel, dryRun: payAgentEvents.dryRun, createdAt: payAgentEvents.createdAt })
      .from(payAgentEvents).where(eq(payAgentEvents.organisationId, organisationId)).orderBy(desc(payAgentEvents.createdAt)).limit(50),
    db.select({ id: tipAgentEvents.id, outletId: tipAgentEvents.outletId, status: tipAgentEvents.status, decision: tipAgentEvents.decision, reasonCode: tipAgentEvents.reasonCode, summary: tipAgentEvents.summary, responseId: tipAgentEvents.responseId, responseModel: tipAgentEvents.responseModel, dryRun: tipAgentEvents.dryRun, createdAt: tipAgentEvents.createdAt })
      .from(tipAgentEvents).where(eq(tipAgentEvents.organisationId, organisationId)).orderBy(desc(tipAgentEvents.createdAt)).limit(50),
    db.select().from(localIntelligenceRuns).where(eq(localIntelligenceRuns.organisationId, organisationId)).orderBy(desc(localIntelligenceRuns.createdAt)).limit(40),
    db.select({ id: demandContextProposals.id, outletId: demandContextProposals.outletId, targetDate: demandContextProposals.targetDate, status: demandContextProposals.status, scenario: demandContextProposals.scenario, failureCode: demandContextProposals.failureCode, responseId: demandContextProposals.providerResponseId, responseModel: demandContextProposals.responseModel, createdAt: demandContextProposals.createdAt })
      .from(demandContextProposals).where(eq(demandContextProposals.organisationId, organisationId)).orderBy(desc(demandContextProposals.createdAt)).limit(30),
    db.select({ id: aiStaffingAssessments.id, outletId: aiStaffingAssessments.outletId, status: aiStaffingAssessments.status, failureCode: aiStaffingAssessments.failureCode, responseId: aiStaffingAssessments.providerResponseId, responseModel: aiStaffingAssessments.responseModel, createdAt: aiStaffingAssessments.createdAt })
      .from(aiStaffingAssessments).where(eq(aiStaffingAssessments.organisationId, organisationId)).orderBy(desc(aiStaffingAssessments.createdAt)).limit(20),
    ids.length ? db.select({ outletId: demandContextFeeds.outletId, feed: demandContextFeeds.feed, lastSuccessAt: demandContextFeeds.lastSuccessAt, lastFailureCode: demandContextFeeds.lastFailureCode }).from(demandContextFeeds).where(inArray(demandContextFeeds.outletId, ids)) : Promise.resolve([]),
    db.select().from(localIntelligenceOutcomes).where(eq(localIntelligenceOutcomes.organisationId, organisationId)).orderBy(desc(localIntelligenceOutcomes.targetDate)).limit(100),
    getLiveFeedStatus(db, now),
  ]);
  const runIds = runs.map(row => row.id);
  const signals = runIds.length ? await db.select({ id: localIntelligenceSignals.id, runId: localIntelligenceSignals.runId, name: localIntelligenceSignals.name, category: localIntelligenceSignals.category, otherLabel: localIntelligenceSignals.otherLabel,
    effectType: localIntelligenceSignals.effectType, status: localIntelligenceSignals.status, rejectionCode: localIntelligenceSignals.rejectionCode, sourceUrl: localIntelligenceSignals.sourceUrl, sourceTier: localIntelligenceSignals.sourceTier, sourceCheck: localIntelligenceSignals.sourceCheck,
    sourceHttpStatus: localIntelligenceSignals.sourceHttpStatus, serverNote: localIntelligenceSignals.serverNote, consultedInSearch: localIntelligenceSignals.consultedInSearch, reasoning: localIntelligenceSignals.reasoning, validFrom: localIntelligenceSignals.validFrom, validTo: localIntelligenceSignals.validTo })
    .from(localIntelligenceSignals).where(and(eq(localIntelligenceSignals.organisationId, organisationId), inArray(localIntelligenceSignals.runId, runIds))) : [];
  const nameOf = (id: string | null) => locations.find(row => row.id === id)?.name ?? "—";
  return {
    timezone: locations[0]?.timezone ?? "UTC", nameOf,
    payouts: payouts.map(({ lastError, ...row }) => ({ ...row, kind: row.kind ? "TIP" as const : "WORK" as const, refusal: payoutRefusal({ status: row.status, paypalBatchId: row.paypalBatchId, lastError }) })),
    subscription: subscription[0] ? { ...subscription[0], fixture: subscription[0].providerId === LOCAL_SUBSCRIPTION_FIXTURE, plan: currentPlanTerms(subscription[0]) } : null,
    payAgent, tipAgent, proposals, assessments,
    // A signal shows how it reads now: one stored as accepted on a restricted page is unconfirmed.
    runs: runs.map(run => ({ ...run, signals: signals.filter(signal => signal.runId === run.id).map(signal => ({ ...signal, status: storedSignalStatus(signal).status })) })),
    // A forecast older than six hours, or whose last fetch failed, is stale.
    weather: weather.filter(row => row.feed === "WEATHER").map(row => ({ ...row, stale: !row.lastSuccessAt || now.getTime() - row.lastSuccessAt.getTime() >= 6 * 3_600_000 || !!row.lastFailureCode })),
    events: weather.filter(row => row.feed === "EVENTS"),
    outcomes, feeds,
    // The fictional demo business shows the DEMO capacity scenario (src/server/demo/capacity-scenario.ts).
    demoScenario: organisationId === SA_REFERENCE_ORGANISATION.id,
    demo: isDemoOrganisation(organisationId),
  };
}
export type ProofPanel = NonNullable<Awaited<ReturnType<typeof getProofPanel>>>;
