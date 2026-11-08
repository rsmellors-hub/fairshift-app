import { and, desc, eq, gte, inArray, lte, or } from "drizzle-orm";
import type { DatabaseSession } from "@/server/db/client";
import { demandContextDecisions, demandContextFeeds, demandContextProposals, demandContextSignals, externalFeeds, outlets } from "@/server/db/schema";
import { prepareContextInput, type ContextInput, type HolidayStatus } from "@/server/intelligence/demand-context-contract";
import { DEMAND_CONTEXT_POLICY_VERSION, SCENARIO_ADJUSTMENT_BPS, type DemandScenario } from "@/server/intelligence/demand-context-policy";
import { bankHolidayDivision, bankHolidaySignal, momentumSignal, saPublicHolidaySignal, signalScopeFailure, type ContextSignal, type SignalDirection, type SignalType } from "@/server/intelligence/demand-signals";
import { isSyntheticSource, type DailySales, type SalesSource } from "@/server/intelligence/forecast";
import { venueProfileOf, type VenueProfile } from "@/server/intelligence/venue-profile";
import type { PlanningBlock, TradingWindow } from "@/server/intelligence/workload";
import { feedFreshness, holidayFeedKey, holidayLookup, HOLIDAY_FEED_STALE_HOURS, isSouthAfrica, type FeedFreshness } from "@/server/reference/public-holiday-feed";

// Reads the contextual layer for a location's planning week. Nothing here calls a model or
// writes. If this layer can't be read, planning carries on from the baseline.

export type StoredContext = {
  meta: ReadonlyMap<string, { province: string | null; country: string | null; venueProfile: string | null; venueContextSource: string | null; latitude: number | null; longitude: number | null }>;
  feeds: readonly (typeof demandContextFeeds.$inferSelect)[];
  signals: readonly ContextSignal[];
  proposals: readonly (typeof demandContextProposals.$inferSelect)[];
  decisions: readonly (typeof demandContextDecisions.$inferSelect)[];
  // South Africa's public-holiday feed, when it has been fetched.
  holidayFeed?: typeof externalFeeds.$inferSelect | null;
};

const toSignal = (row: typeof demandContextSignals.$inferSelect): ContextSignal => ({
  id: row.id, organisationId: row.organisationId, outletId: row.outletId, type: row.signalType as SignalType, validFrom: row.validFrom, validTo: row.validTo, period: row.periodStart === null || row.periodEnd === null ? null : { start: row.periodStart, end: row.periodEnd },
  direction: row.direction as SignalDirection, provenance: row.provenance as ContextSignal["provenance"], sourceLabel: row.sourceLabel, sourceRef: row.sourceRef, summary: row.summary,
  metadata: row.metadata as ContextSignal["metadata"], enteredBy: row.enteredBy, createdAt: row.createdAt, withdrawnAt: row.withdrawnAt,
});

export async function loadStoredContext(db: DatabaseSession, organisationId: string, outletIds: readonly string[], firstDate: string, lastDate: string): Promise<StoredContext> {
  const ids = [...outletIds];
  const feeds = await db.select().from(demandContextFeeds).where(and(eq(demandContextFeeds.organisationId, organisationId), inArray(demandContextFeeds.outletId, ids)));
  const feedSignalIds = feeds.flatMap(feed => feed.currentSignalIds as string[]);
  const [meta, signals, proposals, decisions, holidayFeeds] = await Promise.all([
    db.select({ id: outlets.id, province: outlets.province, country: outlets.country, venueProfile: outlets.venueProfile, venueContextSource: outlets.venueContextSource, latitude: outlets.latitude, longitude: outlets.longitude }).from(outlets).where(and(eq(outlets.organisationId, organisationId), inArray(outlets.id, ids))),
    // People's own entries, and each feed's current signals, are read back. Calculated and
    // official signals are derived fresh each time, so a stored copy can never stand in for the
    // current calculation.
    db.select().from(demandContextSignals).where(and(eq(demandContextSignals.organisationId, organisationId), inArray(demandContextSignals.outletId, ids), feedSignalIds.length ? or(eq(demandContextSignals.provenance, "MANAGER_ENTERED"), inArray(demandContextSignals.id, feedSignalIds)) : eq(demandContextSignals.provenance, "MANAGER_ENTERED"))).orderBy(desc(demandContextSignals.createdAt)),
    db.select().from(demandContextProposals).where(and(eq(demandContextProposals.organisationId, organisationId), inArray(demandContextProposals.outletId, ids), gte(demandContextProposals.targetDate, firstDate), lte(demandContextProposals.targetDate, lastDate))).orderBy(desc(demandContextProposals.createdAt)),
    db.select().from(demandContextDecisions).where(and(eq(demandContextDecisions.organisationId, organisationId), inArray(demandContextDecisions.outletId, ids), gte(demandContextDecisions.targetDate, firstDate), lte(demandContextDecisions.targetDate, lastDate))).orderBy(desc(demandContextDecisions.sequence)),
    db.select().from(externalFeeds).where(eq(externalFeeds.feed, holidayFeedKey("ZA"))),
  ]);
  return { meta: new Map(meta.map(row => [row.id, row])), feeds, signals: signals.map(toSignal), proposals, decisions, holidayFeed: holidayFeeds[0] ?? null };
}

export type AppliedContext = { scenario: DemandScenario; adjustmentBps: number; period: TradingWindow | null; decisionId: string; proposalId: string; policyVersion: string; citedSignalIds: string[] };
export type ContextProposal = { id: string; scenario: DemandScenario; adjustmentBps: number; period: TradingWindow | null; citedSignalIds: string[]; reason: string; provider: string; model: string; responseModel: string | null; createdAt: Date };
export type ContextDecision = { id: string; action: "ACCEPTED" | "DISMISSED" | "WITHDRAWN"; scenario: DemandScenario; adjustmentBps: number; period: TradingWindow | null; decidedAt: Date; decidedByRole: string; proposalId: string };
export type ContextDayState = "NO_SIGNAL" | "READY" | "FAILED" | "PROPOSED" | "ACCEPTED" | "DISMISSED" | "STALE_ACCEPTANCE";
export type ContextDay = {
  date: string; state: ContextDayState;
  signals: ContextSignal[]; holidayStatus: HolidayStatus;
  input: ContextInput | null; fingerprint: string | null;
  proposal: ContextProposal | null;
  failureCode: string | null;
  // An accepted decision made on evidence that has since changed. It no longer applies.
  staleDecision: ContextDecision | null;
  decision: ContextDecision | null;
  // What the proposal would do, from the same calculation. Not applied. Null when none is shown.
  preview: { expectedMilliTransactions: number | null; requiredMinutes: number | null; casualGapMinutes: number | null; blocks: PlanningBlock[] } | null;
};
// What FairShift can say about an automatic feed here. Each state is shown as it is: no
// coordinates or no fetch reads as unknown, never as fine weather or a quiet neighbourhood.
export type FeedState = { status: "NO_COORDINATES" | "NOT_FETCHED" | "FRESH" | "STALE"; fetchedAt: Date | null; ageHours: number | null; lastFailureCode: string | null };
export type OutletDemandContext = { status: "AVAILABLE" | "UNAVAILABLE"; days: ContextDay[]; accepted: ReadonlyMap<string, AppliedContext>; venueProfile: VenueProfile | null; venueContextSource: string | null; weather: FeedState; events: FeedState;
  // South Africa's public-holiday feed as this location's days use it. Absent elsewhere.
  holidays?: FeedFreshness };
export const FEED_STALE_HOURS = 6;
const NOT_FETCHED: FeedState = { status: "NOT_FETCHED", fetchedAt: null, ageHours: null, lastFailureCode: null };
export const UNAVAILABLE_CONTEXT: OutletDemandContext = { status: "UNAVAILABLE", days: [], accepted: new Map(), venueProfile: null, venueContextSource: null, weather: NOT_FETCHED, events: NOT_FETCHED };

const periodOf = (row: { periodStart: number | null; periodEnd: number | null }): TradingWindow | null => row.periodStart === null || row.periodEnd === null ? null : { start: row.periodStart, end: row.periodEnd };

function feedState(stored: StoredContext, outletId: string, name: "WEATHER" | "EVENTS", hasCoordinates: boolean, now: Date): FeedState {
  const feed = stored.feeds.find(row => row.outletId === outletId && row.feed === name);
  if (!hasCoordinates) return { status: "NO_COORDINATES", fetchedAt: null, ageHours: null, lastFailureCode: null };
  if (!feed?.lastSuccessAt) return { status: "NOT_FETCHED", fetchedAt: null, ageHours: null, lastFailureCode: feed?.lastFailureCode ?? null };
  const ageHours = Math.max(0, (now.getTime() - feed.lastSuccessAt.getTime()) / 3_600_000);
  return { status: ageHours >= FEED_STALE_HOURS || feed.lastFailureCode ? "STALE" : "FRESH", fetchedAt: feed.lastSuccessAt, ageHours, lastFailureCode: feed.lastFailureCode };
}

type BaselineDay = { planningDate: string; expectedMilliTransactions: number | null; lowerMilliTransactions: number | null; upperMilliTransactions: number | null; support: "LOW" | "MODERATE" | null; closed: boolean | null; blocks: PlanningBlock[] };

// One outlet's week of context, worked out from its baseline. An accepted scenario applies only
// when its decision still stands, was made under this policy, and its fingerprint matches the
// evidence now: otherwise the day is back on its baseline and says so.
export function resolveOutletContext(input: {
  organisationId: string; outletId: string; stored: StoredContext; days: readonly BaselineDay[];
  evidence: { source: SalesSource; dataThrough: string } | null; evidenceDays: readonly DailySales[]; now?: Date;
}): OutletDemandContext {
  const { organisationId, outletId, stored, evidence } = input;
  const location = stored.meta.get(outletId) ?? { province: null, country: null, venueProfile: null, venueContextSource: null, latitude: null, longitude: null };
  const venueProfile = venueProfileOf(location.venueProfile);
  const hasCoordinates = location.latitude !== null && location.longitude !== null;
  const division = bankHolidayDivision(location);
  // South Africa: the live holiday feed, with FairShift's rules as the labelled fallback. A UK location
  // keeps its GOV.UK snapshot exactly as before.
  const southAfrican = !division && isSouthAfrica(location.country);
  const saHoliday = southAfrican ? holidayLookup(stored.holidayFeed ?? null, "ZA") : null;
  const momentum = evidence ? momentumSignal({ organisationId, outletId, source: evidence.source, synthetic: isSyntheticSource(evidence.source), days: input.evidenceDays, dataThrough: evidence.dataThrough }) : null;
  // A feed's signals are only as good as the coordinates they were fetched for.
  const storedSignals = stored.signals.filter(signal => signal.outletId === outletId && signal.organisationId === organisationId && (hasCoordinates || signal.provenance === "MANAGER_ENTERED"));
  const accepted = new Map<string, AppliedContext>();
  const days = input.days.map((day): ContextDay => {
    const date = day.planningDate;
    const fact = saHoliday ? saHoliday(date) : undefined;
    const holiday = division ? bankHolidaySignal({ organisationId, outletId, division, date }) : fact ? saPublicHolidaySignal({ organisationId, outletId, fact, updatedAt: stored.holidayFeed?.lastSuccessAt ?? null }) : null;
    const holidayStatus: HolidayStatus = division ? (holiday ? "HOLIDAY_ON_DATE" : "NO_HOLIDAY_ON_DATE") : saHoliday && fact !== undefined ? (fact ? "HOLIDAY_ON_DATE" : "NO_HOLIDAY_ON_DATE") : "NATION_NOT_STATED";
    const scope = { organisationId, outletId, date };
    const signals = [...(momentum ? [momentum] : []), ...(holiday ? [holiday] : []), ...storedSignals].filter(signal => !signalScopeFailure(signal, scope));
    const hasBaseline = !day.closed && !!evidence && day.expectedMilliTransactions !== null && day.lowerMilliTransactions !== null && day.upperMilliTransactions !== null;
    const empty = { date, signals, holidayStatus, proposal: null, failureCode: null, staleDecision: null, decision: null, preview: null };
    if (!hasBaseline) return { ...empty, state: "NO_SIGNAL", input: null, fingerprint: null };
    const prepared = prepareContextInput({ organisationId, outletId, venueProfile, date, blocks: day.blocks, expectedMilliTransactions: day.expectedMilliTransactions!, lowerMilliTransactions: day.lowerMilliTransactions!, upperMilliTransactions: day.upperMilliTransactions!, support: day.support,
      evidence: { source: evidence!.source, synthetic: isSyntheticSource(evidence!.source), dataThrough: evidence!.dataThrough }, signals, holidayStatus });
    const here = <T extends { outletId: string; targetDate: string }>(rows: readonly T[]) => rows.filter(row => row.outletId === outletId && row.targetDate === date);
    const rows = here(stored.proposals), matching = rows.filter(row => row.inputFingerprint === prepared.fingerprint);
    const current = matching.find(row => row.status === "AVAILABLE");
    // The fingerprint matches, so a cited signal no longer current can only be a forecast revised
    // within its bands. It's shown as today's reading. The stored proposal keeps the id it cited.
    const currentForecast = signals.find(signal => signal.type === "WEATHER_FORECAST");
    const citedNow = (ids: string[]) => ids.map(id => signals.some(signal => signal.id === id) || !currentForecast ? id : currentForecast.id);
    const proposal: ContextProposal | null = current ? { id: current.id, scenario: current.scenario as DemandScenario, adjustmentBps: SCENARIO_ADJUSTMENT_BPS[current.scenario as DemandScenario], period: periodOf(current), citedSignalIds: citedNow(current.citedSignalIds as string[]), reason: current.reason!, provider: current.provider, model: current.model, responseModel: current.responseModel, createdAt: current.createdAt } : null;
    const latest = here(stored.decisions)[0];
    const decision: ContextDecision | null = latest ? { id: latest.id, action: latest.action as ContextDecision["action"], scenario: latest.scenario as DemandScenario, adjustmentBps: latest.adjustmentBps, period: periodOf(latest), decidedAt: latest.decidedAt, decidedByRole: latest.decidedByRole, proposalId: latest.proposalId } : null;
    const base = { ...empty, input: prepared.input, fingerprint: prepared.fingerprint, proposal };
    if (latest && latest.action === "ACCEPTED") {
      const stands = latest.inputFingerprint === prepared.fingerprint && latest.policyVersion === DEMAND_CONTEXT_POLICY_VERSION && SCENARIO_ADJUSTMENT_BPS[latest.scenario as DemandScenario] === latest.adjustmentBps;
      if (stands) {
        accepted.set(date, { scenario: latest.scenario as DemandScenario, adjustmentBps: latest.adjustmentBps, period: periodOf(latest), decisionId: latest.id, proposalId: latest.proposalId, policyVersion: latest.policyVersion, citedSignalIds: rows.find(row => row.id === latest.proposalId)?.citedSignalIds as string[] ?? [] });
        return { ...base, state: "ACCEPTED", decision };
      }
      return { ...base, state: "STALE_ACCEPTANCE", staleDecision: decision };
    }
    if (latest?.action === "DISMISSED" && latest.inputFingerprint === prepared.fingerprint) return { ...base, state: "DISMISSED", decision };
    if (proposal) return { ...base, state: "PROPOSED" };
    if (!signals.length) return { ...base, state: "NO_SIGNAL" };
    const failed = matching[0];
    return failed?.status === "FAILED" ? { ...base, state: "FAILED", failureCode: failed.failureCode } : { ...base, state: "READY" };
  });
  return { status: "AVAILABLE", days, accepted, venueProfile, venueContextSource: location.venueContextSource, weather: feedState(stored, outletId, "WEATHER", hasCoordinates, input.now ?? new Date()), events: feedState(stored, outletId, "EVENTS", hasCoordinates, input.now ?? new Date()),
    ...(southAfrican ? { holidays: feedFreshness(stored.holidayFeed, HOLIDAY_FEED_STALE_HOURS, input.now ?? new Date()) } : {}) };
}
