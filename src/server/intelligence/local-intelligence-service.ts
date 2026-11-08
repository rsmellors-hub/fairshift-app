import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { assertRole, type Scope } from "@/server/auth/access";
import { requireEntitlement } from "@/server/billing/entitlement";
import type { Database, DatabaseSession } from "@/server/db/client";
import { auditEvents, externalFeeds, localIntelligenceDecisions, localIntelligenceOutcomes, localIntelligenceRuns, localIntelligenceSignals, outletTradingHours, outlets } from "@/server/db/schema";
import { UserFacingError } from "@/server/domain/errors";
import { AiProviderError } from "@/server/integrations/openai/staffing-assessment";
import type { DiscoveryResponse, LocalDiscoveryProvider } from "@/server/integrations/openai/web-discovery";
import { localDate, shiftDate, startOfLocalDay } from "@/server/intelligence/forecast";
import {
  blockAdjustments, buildDiscoveryInput, CATEGORY_LABEL, DISCOVERY_INSTRUCTIONS, discoveryJsonSchema, DISRUPTION_CATEGORIES, impactScore, LOCAL_INTEL_OUTPUT_VERSION, LOCAL_INTEL_POLICY_VERSION,
  locationProfileSchema, signalKey, sourceDecision, validateDiscoveryOutput, type AppliableSignal, type BlockAdjustment, type InfluenceCategory, type LocationProfile, type ProfileSource, type RunKind, type SignalStatus,
} from "@/server/intelligence/local-intelligence-contract";
import { consultedBy, type SourceCheck, type SourceChecker } from "@/server/intelligence/local-intelligence-sources";
import { blockRisks, capacityAlerts, type BlockRisk } from "@/server/intelligence/disruptions";
import { parseClock, tradingWindowsSchema, type PlanningBlock, type TradingWindow } from "@/server/intelligence/workload";
import { holidayFeedKey, holidayLookup, isSouthAfrica } from "@/server/reference/public-holiday-feed";

// Runs and reads local intelligence. A model is called only by the schedule (or an operator's script),
// one request per run, inside a daily cap per organisation that every run counts toward, whatever
// started it. Whatever it returns is validated and its sources checked before anything is stored as a
// signal; a failure is recorded and changes nothing.

export const LOCAL_INTEL_DAILY_CAP_DEFAULT = 20;
const MAX_TOOL_CALLS: Readonly<Record<RunKind, number>> = { DAILY: 10, DISRUPTIONS: 5 };
// A run still marked as running after this long was interrupted.
const RUN_INTERRUPTED_MINUTES = 15;

export function dailyCallCap(env: Record<string, string | undefined> = process.env) {
  const value = Number(env.FAIRSHIFT_LOCAL_INTEL_DAILY_CAP);
  return env.FAIRSHIFT_LOCAL_INTEL_DAILY_CAP && Number.isInteger(value) && value >= 0 && value <= 200 ? value : LOCAL_INTEL_DAILY_CAP_DEFAULT;
}

const profileSchema = locationProfileSchema;
export function profileOf(row: { locationProfile: unknown; locationProfileSource: string | null }): (LocationProfile & { source: ProfileSource }) | null {
  const parsed = profileSchema.safeParse(row.locationProfile);
  return parsed.success && (row.locationProfileSource === "OWNER" || row.locationProfileSource === "DEMO_SEED") ? { ...parsed.data, source: row.locationProfileSource } : null;
}

async function tradingLookup(db: DatabaseSession, outletId: string) {
  const trading = await db.select().from(outletTradingHours).where(eq(outletTradingHours.outletId, outletId));
  return (date: string): TradingWindow[] | null => {
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay() || 7;
    const windows = trading.find(row => row.isoWeekday === weekday)?.windows;
    return windows ? tradingWindowsSchema.parse(windows) : null;
  };
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const i = next++; results[i] = await fn(items[i]); } }));
  return results;
}

export type RunRow = typeof localIntelligenceRuns.$inferSelect;
export type SignalRow = typeof localIntelligenceSignals.$inferSelect;
export type DiscoveryOutcome = { status: "COMPLETED" | "FAILED" | "CAPPED" | "UNAVAILABLE"; run: RunRow | null };

// One discovery for one location. Returns CAPPED without calling the model once the organisation's
// runs today reach the cap, and UNAVAILABLE for a location that isn't active in that organisation.
export async function runLocalDiscovery(db: Database, target: { organisationId: string; outletId: string }, options: {
  kind: RunKind; trigger: "SCHEDULE" | "MANUAL"; requestedBy?: string | null; provider: LocalDiscoveryProvider; checkSource: SourceChecker; now?: Date; cap?: number;
}): Promise<DiscoveryOutcome> {
  const now = options.now ?? new Date();
  const [outlet] = await db.select().from(outlets).where(and(eq(outlets.id, target.outletId), eq(outlets.organisationId, target.organisationId), eq(outlets.active, true)));
  if (!outlet) return { status: "UNAVAILABLE", run: null };
  const today = localDate(now, outlet.timezone);
  const [{ count }] = await db.select({ count: sql<number>`count(*)`.mapWith(Number) }).from(localIntelligenceRuns)
    .where(and(eq(localIntelligenceRuns.organisationId, target.organisationId), gte(localIntelligenceRuns.createdAt, startOfLocalDay(today, outlet.timezone))));
  if (count >= (options.cap ?? dailyCallCap())) return { status: "CAPPED", run: null };

  const tradingFor = await tradingLookup(db, outlet.id);
  const [holidayRow] = isSouthAfrica(outlet.country) ? await db.select().from(externalFeeds).where(eq(externalFeeds.feed, holidayFeedKey("ZA"))) : [];
  const lookup = holidayLookup(holidayRow ?? null, "ZA");
  const holidays = isSouthAfrica(outlet.country) ? Array.from({ length: 8 }, (_, i) => shiftDate(today, i)).flatMap(date => { const fact = lookup(date); return fact ? [{ date, name: fact.name, source: fact.sourceLabel }] : []; }) : [];
  const input = buildDiscoveryInput({ runKind: options.kind, today, location: { name: outlet.name, city: outlet.city, province: outlet.province, country: outlet.country, latitude: outlet.latitude, longitude: outlet.longitude, timezone: outlet.timezone },
    profile: profileOf(outlet), tradingFor, holidays });
  // Recorded before the call, so an interrupted run still counts against the cap.
  const [run] = await db.insert(localIntelligenceRuns).values({ id: randomUUID(), organisationId: target.organisationId, outletId: outlet.id, kind: options.kind, trigger: options.trigger, requestedBy: options.requestedBy ?? null,
    windowFrom: input.window.from, windowTo: input.window.to, status: "RUNNING", policyVersion: LOCAL_INTEL_POLICY_VERSION, outputVersion: LOCAL_INTEL_OUTPUT_VERSION, provider: options.provider.provider, model: options.provider.model, input, createdAt: now }).returning();

  let response: DiscoveryResponse | null = null, failureCode: string | null = null;
  try {
    response = await options.provider.discover({ instructions: DISCOVERY_INSTRUCTIONS, input: JSON.stringify(input), schemaName: "fairshift_local_intelligence", schema: discoveryJsonSchema(input), maxToolCalls: MAX_TOOL_CALLS[options.kind],
      userLocation: { country: outlet.country, city: outlet.city, region: outlet.province, timezone: outlet.timezone } });
  } catch (error) { failureCode = error instanceof AiProviderError ? error.code : "PROVIDER_ERROR"; }

  const asked = input.categories.map(row => row.category);
  let rows: (typeof localIntelligenceSignals.$inferInsert)[] = [], coverage: { category: InfluenceCategory; label: string; queries: string[]; outcome: string }[] = [], unparsed = 0;
  if (response) {
    let raw: unknown;
    try { raw = JSON.parse(response.text); } catch { raw = undefined; }
    const validated = validateDiscoveryOutput(raw, { locationKey: input.location.key, window: input.window, categories: asked });
    if (!validated.ok) failureCode = `VALIDATION_${validated.code}`;
    else {
      // Every category asked appears in the log, including any the model didn't report on.
      coverage = asked.map(category => { const entry = validated.coverage.find(row => row.category === category); return entry ? { category, label: entry.label || CATEGORY_LABEL[category], queries: entry.queries, outcome: entry.outcome } : { category, label: CATEGORY_LABEL[category], queries: [], outcome: "NOT_REPORTED" }; });
      unparsed = validated.candidates.filter(candidate => !candidate.signal).length;
      const consulted = response.consultedUrls;
      const checked = await mapLimit(validated.candidates.filter(candidate => candidate.signal), 4, async candidate => {
        const signal = candidate.signal!;
        const check = candidate.rejection ? null : await options.checkSource(signal.sourceUrl).catch((): SourceCheck => ({ outcome: "UNREACHABLE", httpStatus: null, reason: "NETWORK" }));
        const seen = consultedBy(signal.sourceUrl, consulted);
        const decision: { status: SignalStatus; rejection: string | null; note: string | null } = candidate.rejection ? { status: "REJECTED", rejection: candidate.rejection, note: candidate.detail } : sourceDecision(signal, { outcome: check!.outcome, consulted: seen.exact || seen.site, reason: check!.reason });
        return { signal, check, seen, decision };
      });
      rows = checked.map(({ signal, check, seen, decision }) => ({
        id: randomUUID(), runId: run.id, organisationId: target.organisationId, outletId: outlet.id, signalKey: signalKey(signal), status: decision.status, rejectionCode: decision.rejection, serverNote: decision.note,
        category: signal.category, otherLabel: signal.otherLabel?.trim() || null, effectType: signal.effectType, name: signal.name, validFrom: signal.dateFrom, validTo: signal.dateTo,
        startMinute: signal.startTime === null ? null : parseClock(signal.startTime), endMinute: signal.endTime === null ? null : parseClock(signal.endTime),
        dateCertainty: signal.dateCertainty, shiftBlocks: [...new Set(signal.shiftBlocks)], roles: [...new Set(signal.roles)], direction: signal.direction, sizeBand: signal.sizeBand, severity: signal.severity, closureLikely: signal.closureLikely,
        confidence: signal.confidence, sourceTier: signal.sourceTier, reasoning: signal.reasoning, sourceUrl: signal.sourceUrl, sourceTitle: signal.sourceTitle || null,
        sourceCheck: check?.outcome ?? "NOT_CHECKED", sourceHttpStatus: check?.httpStatus ?? null, consultedInSearch: seen.exact ? "EXACT" : seen.site ? "SAME_SITE" : "NO",
        impact: impactScore(signal), createdAt: now,
      }));
    }
  }
  const counts = { found: rows.length + unparsed, accepted: rows.filter(row => row.status === "ACCEPTED").length, unconfirmed: rows.filter(row => row.status === "UNCONFIRMED").length, rejected: rows.filter(row => row.status === "REJECTED").length + unparsed };
  const completed = await db.transaction(async tx => {
    if (rows.length) await tx.insert(localIntelligenceSignals).values(rows);
    const [row] = await tx.update(localIntelligenceRuns).set({ status: failureCode ? "FAILED" : "COMPLETED", failureCode, responseModel: response?.responseModel ?? null, providerResponseId: response?.responseId ?? null,
      coverage, searches: response?.searches ?? [], consultedUrls: response?.consultedUrls ?? [], counts, completedAt: new Date() }).where(eq(localIntelligenceRuns.id, run.id)).returning();
    await tx.insert(auditEvents).values({ id: randomUUID(), organisationId: target.organisationId, outletId: outlet.id, action: failureCode ? "LOCAL_INTELLIGENCE_RUN_FAILED" : "LOCAL_INTELLIGENCE_RUN_COMPLETED", entityType: "local_intelligence_run", entityId: run.id,
      correlationId: `local-intelligence:${outlet.id}`, metadata: { kind: options.kind, trigger: options.trigger, model: options.provider.model, responseModel: row.responseModel, responseId: row.providerResponseId, failureCode, counts } });
    return row;
  });
  if (failureCode) console.error("Local intelligence run did not complete; earlier signals stand.", { outletId: outlet.id, code: failureCode, responseId: response?.responseId ?? null });
  return { status: failureCode ? "FAILED" : "COMPLETED", run: completed };
}

// Retry rule (Owner decision, 8 November 2026): one more call, after a pause, only when the provider
// answered HTTP 429 or never answered at all. A call that got any other answer, including one that
// succeeded, is never repeated. The retry is a run of its own, so it counts against the daily cap.
export const RETRYABLE_FAILURES: readonly string[] = ["HTTP_429", "TIMEOUT", "NETWORK_ERROR"];
export const RETRY_BACKOFF_MS = 60_000;

// Whether a call may have its one retry: a 429, a timeout or a failed connection, or a run that was
// interrupted mid-call (still marked as running long after it began), which FairShift never heard back from.
export function mayRetry(run: Pick<RunRow, "status" | "failureCode" | "createdAt">, now: Date) {
  if (run.status === "FAILED") return RETRYABLE_FAILURES.includes(run.failureCode ?? "");
  return run.status === "RUNNING" && now.getTime() - run.createdAt.getTime() > RUN_INTERRUPTED_MINUTES * 60_000;
}

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// One location's discovery under the retry rule. `earlier` holds calls already made for the same
// purpose, oldest first (a scheduled pass resumed after a restart), so there are never more than two
// calls in all: the call and its one retry. Returns the outcome of each call made here.
export async function discoverWithRetryRule(db: Database, target: { organisationId: string; outletId: string }, options: Omit<Parameters<typeof runLocalDiscovery>[2], "now"> & {
  earlier?: readonly RunRow[]; clock?: () => Date; backoffMs?: number; sleep?: (ms: number) => Promise<void>;
}): Promise<DiscoveryOutcome[]> {
  const { earlier = [], clock = () => new Date(), backoffMs = RETRY_BACKOFF_MS, sleep = pause, ...call } = options;
  const last = earlier.at(-1);
  if (earlier.length >= 2 || (last && !mayRetry(last, clock()))) return [];
  const outcomes: DiscoveryOutcome[] = [];
  if (!last) {
    const first = await runLocalDiscovery(db, target, { ...call, now: clock() });
    outcomes.push(first);
    if (first.status !== "FAILED" || !first.run || !mayRetry(first.run, clock())) return outcomes;
  }
  await sleep(backoffMs);
  outcomes.push(await runLocalDiscovery(db, target, { ...call, now: clock() }));
  return outcomes;
}

// FairShift's own source check can fail for a moment: a slow official site, a dropped connection. A
// signal rejected only because its page couldn't be reached is checked once more, later, with no model
// call. If the page answers now, a new row records the same finding with the new check and a note
// saying so; the rejected row stays exactly as it was. A second failure is final.
export async function recheckUnreachableSources(db: Database, organisationIds: readonly string[], checkSource: SourceChecker, now = new Date()) {
  if (!organisationIds.length) return { checked: 0, admitted: 0 };
  const runs = await db.select().from(localIntelligenceRuns).where(and(inArray(localIntelligenceRuns.organisationId, [...organisationIds]), eq(localIntelligenceRuns.status, "COMPLETED"), gte(localIntelligenceRuns.createdAt, new Date(now.getTime() - 2 * 86_400_000))));
  const current = [...new Set(runs.map(row => row.outletId))].flatMap(outletId => currentRuns(runs.filter(row => row.outletId === outletId)));
  if (!current.length) return { checked: 0, admitted: 0 };
  const rows = await db.select().from(localIntelligenceSignals).where(inArray(localIntelligenceSignals.runId, current.map(row => row.id)));
  const candidates = rows.filter(row => row.status === "REJECTED" && row.rejectionCode === "SOURCE_UNREACHABLE" && !rows.some(other => other.runId === row.runId && other.signalKey === row.signalKey && other.status !== "REJECTED"));
  if (!candidates.length) return { checked: 0, admitted: 0 };
  const attempted = new Set((await db.select({ id: auditEvents.entityId }).from(auditEvents).where(and(eq(auditEvents.action, "LOCAL_INTELLIGENCE_SOURCE_RECHECKED"), inArray(auditEvents.entityId, candidates.map(row => row.id))))).map(row => row.id));
  let checked = 0, admitted = 0;
  for (const row of candidates.filter(candidate => !attempted.has(candidate.id))) {
    const check = await checkSource(row.sourceUrl).catch((): SourceCheck => ({ outcome: "UNREACHABLE", httpStatus: null, reason: "NETWORK" }));
    const decision = sourceDecision({ sourceTier: row.sourceTier as DiscoveredSignalTier }, { outcome: check.outcome, consulted: row.consultedInSearch !== "NO", reason: check.reason });
    checked++;
    await db.transaction(async tx => {
      if (decision.status !== "REJECTED") {
        await tx.insert(localIntelligenceSignals).values({ ...row, id: randomUUID(), status: decision.status, rejectionCode: null, sourceCheck: check.outcome, sourceHttpStatus: check.httpStatus, createdAt: now,
          serverNote: `FairShift’s first check of this page failed; it checked again on ${now.toISOString().slice(0, 16).replace("T", " ")} UTC and the page answered.${decision.note ? ` ${decision.note}` : ""}` });
        const [run] = await tx.select({ counts: localIntelligenceRuns.counts }).from(localIntelligenceRuns).where(eq(localIntelligenceRuns.id, row.runId));
        const counts = (run?.counts ?? {}) as Record<string, number>;
        await tx.update(localIntelligenceRuns).set({ counts: { ...counts, [decision.status === "ACCEPTED" ? "accepted" : "unconfirmed"]: (counts[decision.status === "ACCEPTED" ? "accepted" : "unconfirmed"] ?? 0) + 1, rejected: Math.max(0, (counts.rejected ?? 0) - 1), rechecked: (counts.rechecked ?? 0) + 1 } }).where(eq(localIntelligenceRuns.id, row.runId));
        admitted++;
      }
      await tx.insert(auditEvents).values({ id: randomUUID(), organisationId: row.organisationId, outletId: row.outletId, action: "LOCAL_INTELLIGENCE_SOURCE_RECHECKED", entityType: "local_intelligence_signal", entityId: row.id,
        correlationId: `local-intelligence:${row.outletId}`, metadata: { outcome: check.outcome, httpStatus: check.httpStatus, reason: check.reason ?? null, status: decision.status } });
    });
  }
  return { checked, admitted };
}
type DiscoveredSignalTier = Parameters<typeof sourceDecision>[0]["sourceTier"];

// --- Reading -------------------------------------------------------------------------------------

export type TrackRecordRow = typeof localIntelligenceOutcomes.$inferSelect & { name: string };
export type StoredLocalIntelligence = { runs: readonly RunRow[]; signals: readonly SignalRow[]; decisions: readonly (typeof localIntelligenceDecisions.$inferSelect)[]; outcomes?: readonly TrackRecordRow[] };

export async function loadLocalIntelligence(db: DatabaseSession, organisationId: string, outletIds: readonly string[], firstDate: string, lastDate: string, now = new Date()): Promise<StoredLocalIntelligence> {
  if (!outletIds.length) return { runs: [], signals: [], decisions: [], outcomes: [] };
  const ids = [...outletIds];
  // The latest week of runs is enough to find each location's current daily and short-notice runs.
  const runs = await db.select().from(localIntelligenceRuns).where(and(eq(localIntelligenceRuns.organisationId, organisationId), inArray(localIntelligenceRuns.outletId, ids), gte(localIntelligenceRuns.createdAt, new Date(now.getTime() - 7 * 86_400_000))))
    .orderBy(desc(localIntelligenceRuns.createdAt)).limit(400);
  const current = ids.flatMap(id => currentRuns(runs.filter(row => row.outletId === id))).map(row => row.id);
  const [signals, decisions, outcomes] = await Promise.all([
    current.length ? db.select().from(localIntelligenceSignals).where(inArray(localIntelligenceSignals.runId, current)) : Promise.resolve([] as SignalRow[]),
    db.select().from(localIntelligenceDecisions).where(and(eq(localIntelligenceDecisions.organisationId, organisationId), inArray(localIntelligenceDecisions.outletId, ids), gte(localIntelligenceDecisions.targetDate, firstDate), sql`${localIntelligenceDecisions.targetDate} <= ${lastDate}`)).orderBy(desc(localIntelligenceDecisions.sequence)),
    db.select({ outcome: localIntelligenceOutcomes, name: localIntelligenceSignals.name }).from(localIntelligenceOutcomes).innerJoin(localIntelligenceSignals, eq(localIntelligenceSignals.id, localIntelligenceOutcomes.signalId))
      .where(and(eq(localIntelligenceOutcomes.organisationId, organisationId), inArray(localIntelligenceOutcomes.outletId, ids))).orderBy(desc(localIntelligenceOutcomes.targetDate)).limit(200),
  ]);
  return { runs, signals, decisions, outcomes: outcomes.map(row => ({ ...row.outcome, name: row.name })) };
}

// A location's current runs: its latest completed daily run, and a later short-notice run if there is
// one. A short-notice run replaces the daily run's findings in its own categories only.
export function currentRuns(runs: readonly RunRow[]) {
  const ordered = [...runs].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const daily = ordered.find(row => row.status === "COMPLETED" && row.kind === "DAILY") ?? null;
  const disruptions = ordered.find(row => row.status === "COMPLETED" && row.kind === "DISRUPTIONS" && (!daily || row.createdAt > daily.createdAt)) ?? null;
  return [daily, disruptions].filter((row): row is RunRow => !!row);
}

export type LocalSignalView = AppliableSignal & {
  id: string; runId: string; category: string; categoryLabel: string; otherLabel: string | null; name: string; dateCertainty: string; roles: string[]; severity: string | null; closureLikely: boolean;
  confidence: string; sourceTier: string; reasoning: string; sourceUrl: string; sourceTitle: string | null; sourceCheck: string; consultedInSearch: string; serverNote: string | null; rejectionCode: string | null;
  responseId: string | null; model: string; responseModel: string | null; foundAt: Date;
  // Demand: applied in at least one planning block, or listed (ranked below the top signals, or outside the
  // planning week). Capacity: an Owner alert when severe, else noted. Access: a staff-attendance risk.
  // Unconfirmed: shown, never applied.
  use: "APPLIED" | "LISTED" | "UNCONFIRMED" | "ALERT" | "ATTENDANCE_RISK" | "NOTED";
};
export type RunView = { id: string; kind: string; status: "COMPLETED" | "FAILED" | "RUNNING" | "INTERRUPTED"; failureCode: string | null; responseId: string | null; model: string; responseModel: string | null; createdAt: Date; completedAt: Date | null;
  coverage: { category: string; label: string; queries: string[]; outcome: string }[]; searches: { action: string; queries: string[]; url: string | null }[]; counts: Record<string, number>; rejected: { name: string; code: string | null; note: string | null; sourceUrl: string }[] };
export type LocalDecisionState = "NOT_USED" | "ACCEPTED" | "STALE" | "SCENARIO_ACCEPTED";
export type LocalDay = { date: string; blocks: BlockAdjustment[]; adjusted: BlockAdjustment[]; fingerprint: string; state: LocalDecisionState; decisionId: string | null; decidedAt: Date | null; decidedByRole: string | null;
  // Capacity and access signals on each planning block. They never move demand.
  risks: BlockRisk[];
  preview: { expectedMilliTransactions: number | null; requiredMinutes: number | null; casualGapMinutes: number | null; blocks: PlanningBlock[] } | null };
export type LocalApplied = { decisionId: string; blocks: ReadonlyMap<number, number> };
export type OutletLocalIntelligence = { status: "AVAILABLE" | "UNAVAILABLE"; runs: RunView[]; lastAttempt: RunView | null; signals: LocalSignalView[]; days: LocalDay[]; accepted: ReadonlyMap<string, LocalApplied>;
  // High-severity capacity signals from today on: Owner alerts.
  alerts: LocalSignalView[];
  // Each applied direction against the day's actual (synthetic) sales, newest first.
  trackRecord: TrackRecordRow[] };
export const UNAVAILABLE_LOCAL: OutletLocalIntelligence = { status: "UNAVAILABLE", runs: [], lastAttempt: null, signals: [], days: [], accepted: new Map(), alerts: [], trackRecord: [] };

function runView(row: RunRow, signals: readonly SignalRow[], now: Date): RunView {
  const status = row.status === "RUNNING" && now.getTime() - row.createdAt.getTime() > RUN_INTERRUPTED_MINUTES * 60_000 ? "INTERRUPTED" : row.status as RunView["status"];
  return { id: row.id, kind: row.kind, status, failureCode: row.failureCode, responseId: row.providerResponseId, model: row.model, responseModel: row.responseModel, createdAt: row.createdAt, completedAt: row.completedAt,
    coverage: (row.coverage ?? []) as RunView["coverage"], searches: (row.searches ?? []) as RunView["searches"], counts: (row.counts ?? {}) as Record<string, number>,
    rejected: signals.filter(signal => signal.runId === row.id && signal.status === "REJECTED" && !signals.some(other => other.runId === row.id && other.signalKey === signal.signalKey && other.status !== "REJECTED"))
      .map(signal => ({ name: signal.name, code: signal.rejectionCode, note: signal.serverNote, sourceUrl: signal.sourceUrl })) };
}

// One location's local intelligence for its planning week, from its baseline blocks. Adjustments are
// worked out here from the current signals; they reach staffing only through a manager's decision that
// still matches them, and never on a day with an accepted contextual scenario.
export function resolveLocalIntelligence(input: { outletId: string; stored: StoredLocalIntelligence; days: readonly { planningDate: string; closed: boolean | null; blocks: readonly TradingWindow[] }[]; scenarioDates: ReadonlySet<string>; timeZone?: string; now?: Date }): OutletLocalIntelligence {
  const now = input.now ?? new Date();
  const runs = input.stored.runs.filter(row => row.outletId === input.outletId);
  const current = currentRuns(runs);
  const daily = current.find(row => row.kind === "DAILY"), disruptions = current.find(row => row.kind === "DISRUPTIONS");
  const byRun = new Map(current.map(row => [row.id, row]));
  const rows = input.stored.signals.filter(row => row.outletId === input.outletId && byRun.has(row.runId))
    // A later short-notice run speaks for its own categories.
    .filter(row => !(disruptions && daily && row.runId === daily.id && DISRUPTION_CATEGORIES.includes(row.category as InfluenceCategory)));
  const unique = new Map<string, SignalRow>();
  for (const row of [...rows].sort((a, b) => byRun.get(b.runId)!.createdAt.getTime() - byRun.get(a.runId)!.createdAt.getTime())) if (row.status !== "REJECTED" && !unique.has(row.signalKey)) unique.set(row.signalKey, row);
  const base = [...unique.values()].map(row => {
    const run = byRun.get(row.runId)!;
    return { key: row.signalKey, status: row.status as SignalStatus, effectType: row.effectType, direction: row.direction, sizeBand: row.sizeBand, validFrom: row.validFrom, validTo: row.validTo, startMinute: row.startMinute, endMinute: row.endMinute,
      shiftBlocks: row.shiftBlocks as string[], impact: row.impact, id: row.id, runId: row.runId, category: row.category, categoryLabel: row.category === "OTHER" ? row.otherLabel ?? "Other" : CATEGORY_LABEL[row.category as InfluenceCategory] ?? row.category,
      otherLabel: row.otherLabel, name: row.name, dateCertainty: row.dateCertainty, roles: row.roles as string[], severity: row.severity, closureLikely: row.closureLikely, confidence: row.confidence, sourceTier: row.sourceTier, reasoning: row.reasoning,
      sourceUrl: row.sourceUrl, sourceTitle: row.sourceTitle, sourceCheck: row.sourceCheck, consultedInSearch: row.consultedInSearch, serverNote: row.serverNote, rejectionCode: row.rejectionCode,
      responseId: run.providerResponseId, model: run.model, responseModel: run.responseModel, foundAt: run.completedAt ?? run.createdAt };
  });
  const days: LocalDay[] = input.days.map(day => {
    const blocks = day.closed ? [] : day.blocks.map(block => ({ start: block.start, end: block.end }));
    const result = blockAdjustments(day.planningDate, blocks, base);
    const latest = input.stored.decisions.filter(row => row.outletId === input.outletId && row.targetDate === day.planningDate).sort((a, b) => b.sequence - a.sequence)[0];
    const accepted = latest?.action === "ACCEPTED";
    const matches = accepted && latest.adjustmentFingerprint === result.fingerprint && latest.policyVersion === LOCAL_INTEL_POLICY_VERSION && result.adjusted.length > 0;
    const state: LocalDecisionState = !accepted ? "NOT_USED" : !matches ? "STALE" : input.scenarioDates.has(day.planningDate) ? "SCENARIO_ACCEPTED" : "ACCEPTED";
    return { date: day.planningDate, blocks: result.blocks, adjusted: result.adjusted, fingerprint: result.fingerprint, state, decisionId: accepted ? latest.id : null, decidedAt: accepted ? latest.decidedAt : null, decidedByRole: accepted ? latest.decidedByRole : null,
      risks: blockRisks(day.planningDate, blocks, base), preview: null };
  });
  const applied = new Set(days.flatMap(day => day.blocks.flatMap(block => block.applied)));
  const useOf = (signal: (typeof base)[number]): LocalSignalView["use"] => signal.status === "UNCONFIRMED" ? "UNCONFIRMED"
    : signal.effectType === "CAPACITY" ? (signal.severity === "HIGH" ? "ALERT" : "NOTED") : signal.effectType === "ACCESS" ? "ATTENDANCE_RISK" : applied.has(signal.key) ? "APPLIED" : "LISTED";
  const signals: LocalSignalView[] = base.map((signal): LocalSignalView => ({ ...signal, use: useOf(signal) }))
    .sort((a, b) => b.impact - a.impact || a.validFrom.localeCompare(b.validFrom) || a.key.localeCompare(b.key));
  const accepted = new Map(days.filter(day => day.state === "ACCEPTED").map(day => [day.date, { decisionId: day.decisionId!, blocks: new Map(day.adjusted.map(block => [block.start, block.bps])) }]));
  const runViews = current.map(row => runView(row, input.stored.signals, now));
  const latestAny = [...runs].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  const alerts = capacityAlerts(signals, localDate(now, input.timeZone ?? "UTC"));
  return { status: "AVAILABLE", runs: runViews, lastAttempt: latestAny ? runView(latestAny, input.stored.signals, now) : null, signals, days, accepted, alerts, trackRecord: (input.stored.outcomes ?? []).filter(row => row.outletId === input.outletId) };
}

// --- A manager's decision ------------------------------------------------------------------------

type DecisionScope = Pick<Scope, "userId" | "organisationId" | "locationId" | "role">;
export type LocalDecisionAction = "ACCEPTED" | "WITHDRAWN";

// Uses (or stops using) the AI-found adjustments for one planning day at the session's own location.
// The form supplies only the date, the action and the fingerprint the manager saw: the adjustments are
// worked out again here, and accepting needs them unchanged.
export async function decideLocalAdjustments(db: Database, scope: DecisionScope, input: { date: string; action: LocalDecisionAction; fingerprint?: string }, readDay: (date: string) => Promise<{ day: LocalDay | null; scenarioAccepted: boolean }>, now = new Date()) {
  assertRole(scope as Scope, ["OWNER", "MANAGER"]);
  await requireEntitlement(db, scope.organisationId);
  if (!z.iso.date().safeParse(input.date).success || !["ACCEPTED", "WITHDRAWN"].includes(input.action)) throw new UserFacingError("local-not-found", "That is no longer available.");
  const { day, scenarioAccepted } = await readDay(input.date);
  if (!day) throw new UserFacingError("local-not-found", "That is no longer available.");
  if (input.action === "ACCEPTED") {
    if (!day.adjusted.length) throw new UserFacingError("local-nothing-to-use", "There are no AI-found adjustments for that day.");
    if (day.fingerprint !== input.fingerprint) throw new UserFacingError("local-changed", "The AI-found signals have changed since you looked. Check them again before using them.");
    if (scenarioAccepted) throw new UserFacingError("local-scenario-accepted", "This day already uses an accepted scenario. Withdraw it first, so the same influence isn’t counted twice.");
  }
  return db.transaction(async tx => {
    const [latest] = await tx.select().from(localIntelligenceDecisions).where(and(eq(localIntelligenceDecisions.outletId, scope.locationId), eq(localIntelligenceDecisions.targetDate, input.date))).orderBy(desc(localIntelligenceDecisions.sequence)).limit(1).for("update");
    if (input.action === "WITHDRAWN" && latest?.action !== "ACCEPTED") throw new UserFacingError("local-not-found", "There’s nothing in use to withdraw.");
    if (input.action === "ACCEPTED" && latest?.action === "ACCEPTED" && latest.adjustmentFingerprint === day.fingerprint) return latest;
    const [decision] = await tx.insert(localIntelligenceDecisions).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: scope.locationId, targetDate: input.date, sequence: (latest?.sequence ?? 0) + 1, action: input.action,
      adjustmentFingerprint: input.action === "ACCEPTED" ? day.fingerprint : latest!.adjustmentFingerprint, adjustments: input.action === "ACCEPTED" ? day.adjusted.map(block => ({ start: block.start, end: block.end, bps: block.bps, signalKeys: block.applied })) : latest!.adjustments,
      policyVersion: LOCAL_INTEL_POLICY_VERSION, decidedBy: scope.userId, decidedByRole: scope.role, decidedAt: now }).returning();
    await tx.insert(auditEvents).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: scope.locationId, action: `LOCAL_INTELLIGENCE_${input.action}`, entityType: "local_intelligence_decision", entityId: decision.id,
      correlationId: `local-intelligence:${scope.locationId}`, metadata: { actorUserId: scope.userId, date: input.date, fingerprint: decision.adjustmentFingerprint, adjustments: decision.adjustments } });
    return decision;
  });
}
