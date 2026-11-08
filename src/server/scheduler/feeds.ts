import { and, desc, eq, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import { getConfigurationStatus } from "@/server/config/env";
import { deploymentMode, sandboxOrganisationId } from "@/server/config/deployment";
import { getDatabase, type Database } from "@/server/db/client";
import { externalFeeds, localIntelligenceRuns, organisations, outlets, scheduledJobs } from "@/server/db/schema";
import { demoConfig } from "@/server/demo/config";
import { ECB_DAILY_URL, ECB_FEED, fetchEcbDailyQuote, recordEcbQuote } from "@/server/fx/reference-rates";
import { getLocalDiscoveryProvider, type LocalDiscoveryProvider } from "@/server/integrations/openai/web-discovery";
import { fetchOpenMeteoHourly } from "@/server/integrations/open-meteo/forecast";
import { refreshLocationWeather, type FetchHourly } from "@/server/intelligence/demand-context-service";
import type { RunKind } from "@/server/intelligence/local-intelligence-contract";
import { recheckUnreachableSources, runLocalDiscovery } from "@/server/intelligence/local-intelligence-service";
import { createSourceChecker, type SourceChecker } from "@/server/intelligence/local-intelligence-sources";
import { refreshHolidayFeed } from "@/server/reference/public-holiday-feed";
import { recordTrackRecord } from "@/server/intelligence/track-record";
import { provisionSaReferenceBusiness } from "@/server/reference/sa-provision";
import { SA_REFERENCE_ORGANISATION } from "@/server/reference/sa-reference";
import { localDate, shiftDate } from "@/server/intelligence/forecast";

// Keeps the demo's real feeds current without anyone opening a page: weather for every demo location,
// the South African holiday feed, the ECB reference rate and the AI's local discovery. Each job's last
// run is stored, so a restart neither repeats a job that isn't due nor forgets one that is, and a lease
// means two servers never run one job at once. A failed job keeps the last good data and tries again
// later. Nothing here loops on a failure, and the AI jobs stop at the daily call cap.

const HOUR = 3_600_000, MINUTE = 60_000;
const TICK_MS = 10 * MINUTE;

export type JobKey = "holidays:ZA" | "ecb:daily" | "weather:demo" | "intel:recheck" | "intel:daily" | "intel:disruptions" | "track:daily";
export type JobResult = { ok: boolean; code?: string | null; detail?: Record<string, unknown> };
export type SchedulerDeps = {
  now: () => Date;
  demoOrganisationIds: readonly string[];
  fetchImpl?: typeof fetch;
  fetchHourly?: FetchHourly;
  discovery?: LocalDiscoveryProvider | null;
  checkSource?: SourceChecker;
  // The AI jobs run only when this is on and a provider is configured.
  aiSchedule: boolean;
  // A pause between one location's model call and the next, so a run never bursts at the provider.
  pauseMs?: number;
};
type Job = { key: JobKey; intervalMs: number; retryMs: number; leaseMs: number; enabled: (deps: SchedulerDeps) => boolean; run: (db: Database, deps: SchedulerDeps) => Promise<JobResult> };

async function demoLocations(db: Database, deps: SchedulerDeps) {
  if (!deps.demoOrganisationIds.length) return [];
  return db.select({ organisationId: outlets.organisationId, locationId: outlets.id, latitude: outlets.latitude }).from(outlets)
    .where(and(inArray(outlets.organisationId, [...deps.demoOrganisationIds]), eq(outlets.active, true))).orderBy(outlets.name);
}

async function discover(db: Database, deps: SchedulerDeps, kind: RunKind): Promise<JobResult> {
  const provider = deps.discovery;
  if (!provider) return { ok: false, code: "NOT_CONFIGURED" };
  const checkSource = deps.checkSource ?? createSourceChecker({ fetchImpl: deps.fetchImpl });
  const tally: Record<string, number> = {};
  let called = false;
  for (const location of await demoLocations(db, deps)) {
    // A retry after a partial failure calls the model only for locations still without a fresh daily run.
    if (kind === "DAILY") {
      const [fresh] = await db.select({ createdAt: localIntelligenceRuns.createdAt }).from(localIntelligenceRuns)
        .where(and(eq(localIntelligenceRuns.outletId, location.locationId), eq(localIntelligenceRuns.kind, "DAILY"), eq(localIntelligenceRuns.status, "COMPLETED"))).orderBy(desc(localIntelligenceRuns.createdAt)).limit(1);
      if (fresh && deps.now().getTime() - fresh.createdAt.getTime() < 20 * HOUR) { tally.FRESH = (tally.FRESH ?? 0) + 1; continue; }
    }
    if (kind === "DISRUPTIONS") {
      // A daily run in the last few hours already covered short-notice news.
      const [recent] = await db.select({ createdAt: localIntelligenceRuns.createdAt }).from(localIntelligenceRuns)
        .where(and(eq(localIntelligenceRuns.outletId, location.locationId), eq(localIntelligenceRuns.status, "COMPLETED"))).orderBy(desc(localIntelligenceRuns.createdAt)).limit(1);
      if (recent && deps.now().getTime() - recent.createdAt.getTime() < 4 * HOUR) { tally.RECENT = (tally.RECENT ?? 0) + 1; continue; }
    }
    if (called && deps.pauseMs) await new Promise(resolve => setTimeout(resolve, deps.pauseMs));
    called = true;
    const outcome = await runLocalDiscovery(db, { organisationId: location.organisationId, outletId: location.locationId }, { kind, trigger: "SCHEDULE", provider, checkSource, now: deps.now() });
    tally[outcome.status] = (tally[outcome.status] ?? 0) + 1;
    if (outcome.status === "CAPPED") break;
  }
  return { ok: !tally.FAILED, code: tally.FAILED ? "SOME_RUNS_FAILED" : null, detail: tally };
}

export const JOBS: readonly Job[] = [
  { key: "holidays:ZA", intervalMs: 24 * HOUR, retryMs: 30 * MINUTE, leaseMs: 5 * MINUTE, enabled: () => true,
    run: async (db, deps) => { const result = await refreshHolidayFeed(db, { countryCode: "ZA", now: deps.now(), fetchImpl: deps.fetchImpl }); return { ok: result === "REFRESHED", code: result === "REFRESHED" ? null : "FAILED" }; } },
  { key: "ecb:daily", intervalMs: 6 * HOUR, retryMs: 30 * MINUTE, leaseMs: 5 * MINUTE, enabled: () => true,
    run: async (db, deps) => {
      const now = deps.now();
      try {
        const quote = await fetchEcbDailyQuote(deps.fetchImpl);
        const { row } = await recordEcbQuote(db, quote, now);
        const payload = { rateDate: quote.rateDate, eurZar: quote.eurZar, eurUsd: quote.eurUsd };
        await db.insert(externalFeeds).values({ feed: ECB_FEED, sourceUrl: ECB_DAILY_URL, lastAttemptAt: now, lastSuccessAt: now, lastFailureCode: null, payload })
          .onConflictDoUpdate({ target: externalFeeds.feed, set: { lastAttemptAt: now, lastSuccessAt: now, lastFailureCode: null, payload } });
        return { ok: true, detail: { rateDate: quote.rateDate, recorded: !!row } };
      } catch {
        await db.insert(externalFeeds).values({ feed: ECB_FEED, sourceUrl: ECB_DAILY_URL, lastAttemptAt: now, lastFailureCode: "FETCH_FAILED", payload: {} })
          .onConflictDoUpdate({ target: externalFeeds.feed, set: { lastAttemptAt: now, lastFailureCode: "FETCH_FAILED" } });
        return { ok: false, code: "FETCH_FAILED" };
      }
    } },
  { key: "weather:demo", intervalMs: 3 * HOUR, retryMs: 30 * MINUTE, leaseMs: 5 * MINUTE, enabled: deps => deps.demoOrganisationIds.length > 0,
    run: async (db, deps) => {
      const tally: Record<string, number> = {};
      for (const location of await demoLocations(db, deps)) {
        const fetchHourly = deps.fetchHourly ?? (deps.fetchImpl ? (place: { latitude: number; longitude: number }, timeoutMs: number) => fetchOpenMeteoHourly(place, { timeoutMs, fetchImpl: deps.fetchImpl }) : undefined);
        const result = await refreshLocationWeather(db, location, { mode: "EXPLICIT", now: deps.now(), fetchHourly });
        tally[result] = (tally[result] ?? 0) + 1;
      }
      return { ok: !tally.FAILED, code: tally.FAILED ? "SOME_LOCATIONS_FAILED" : null, detail: tally };
    } },
  { key: "intel:recheck", intervalMs: 2 * HOUR, retryMs: 30 * MINUTE, leaseMs: 10 * MINUTE, enabled: deps => deps.demoOrganisationIds.length > 0,
    run: async (db, deps) => { const result = await recheckUnreachableSources(db, deps.demoOrganisationIds, deps.checkSource ?? createSourceChecker({ fetchImpl: deps.fetchImpl }), deps.now()); return { ok: true, detail: result }; } },
  { key: "track:daily", intervalMs: 6 * HOUR, retryMs: 30 * MINUTE, leaseMs: 15 * MINUTE, enabled: deps => deps.demoOrganisationIds.length > 0,
    run: async (db, deps) => {
      const tally = { toppedUp: 0, recorded: 0, waiting: 0 };
      // The fictional SA demo business's synthetic history runs on to yesterday, exactly as its generator
      // defines each day, so every completed day has actual (synthetic) sales to measure against. Only an
      // existing demo business is extended: this never creates one.
      if (deps.demoOrganisationIds.includes(SA_REFERENCE_ORGANISATION.id)) {
        const [business] = await db.select({ id: organisations.id }).from(organisations).where(eq(organisations.id, SA_REFERENCE_ORGANISATION.id));
        if (business) tally.toppedUp = (await provisionSaReferenceBusiness(db, { from: shiftDate(localDate(deps.now(), "Africa/Johannesburg"), -7) }, deps.now())).inserted;
      }
      for (const location of await demoLocations(db, deps)) {
        const result = await recordTrackRecord(db, { organisationId: location.organisationId, outletId: location.locationId }, deps.now());
        tally.recorded += result.recorded; tally.waiting += result.waiting;
      }
      return { ok: true, detail: tally };
    } },
  { key: "intel:daily", intervalMs: 24 * HOUR, retryMs: 2 * HOUR, leaseMs: 30 * MINUTE, enabled: deps => deps.aiSchedule && !!deps.discovery && deps.demoOrganisationIds.length > 0, run: (db, deps) => discover(db, deps, "DAILY") },
  { key: "intel:disruptions", intervalMs: 8 * HOUR, retryMs: 2 * HOUR, leaseMs: 30 * MINUTE, enabled: deps => deps.aiSchedule && !!deps.discovery && deps.demoOrganisationIds.length > 0, run: (db, deps) => discover(db, deps, "DISRUPTIONS") },
];

type JobRow = typeof scheduledJobs.$inferSelect;
export function isDue(job: Pick<Job, "intervalMs" | "retryMs">, row: JobRow | undefined, now: Date) {
  if (!row) return true;
  if (row.lastFailureCode && row.lastFinishedAt && now.getTime() - row.lastFinishedAt.getTime() < job.retryMs) return false;
  return !row.lastSuccessAt || now.getTime() - row.lastSuccessAt.getTime() >= job.intervalMs;
}

export type TickOutcome = { key: JobKey; outcome: "RAN" | "NOT_DUE" | "LEASED" | "DISABLED"; ok?: boolean; code?: string | null };

// Runs every due job once, one after another. Safe to call from any number of servers.
export async function runDueJobs(db: Database, deps: SchedulerDeps, jobs: readonly Job[] = JOBS): Promise<TickOutcome[]> {
  const results: TickOutcome[] = [];
  for (const job of jobs) {
    if (!job.enabled(deps)) { results.push({ key: job.key, outcome: "DISABLED" }); continue; }
    const now = deps.now();
    const [row] = await db.select().from(scheduledJobs).where(eq(scheduledJobs.job, job.key));
    if (!isDue(job, row, now)) { results.push({ key: job.key, outcome: "NOT_DUE" }); continue; }
    await db.insert(scheduledJobs).values({ job: job.key }).onConflictDoNothing();
    const [claimed] = await db.update(scheduledJobs).set({ leaseUntil: new Date(now.getTime() + job.leaseMs), lastStartedAt: now })
      .where(and(eq(scheduledJobs.job, job.key), or(isNull(scheduledJobs.leaseUntil), lt(scheduledJobs.leaseUntil, now)))).returning();
    if (!claimed) { results.push({ key: job.key, outcome: "LEASED" }); continue; }
    let result: JobResult;
    try { result = await job.run(db, deps); } catch (error) { result = { ok: false, code: error instanceof Error ? error.name : "ERROR" }; }
    const finished = deps.now();
    await db.update(scheduledJobs).set({ leaseUntil: null, lastFinishedAt: finished, ...(result.ok ? { lastSuccessAt: finished, lastFailureCode: null } : { lastFailureCode: result.code ?? "FAILED" }), lastResult: result.detail ?? {} })
      .where(eq(scheduledJobs.job, job.key));
    results.push({ key: job.key, outcome: "RAN", ok: result.ok, code: result.code ?? null });
  }
  return results;
}

export function demoOrganisationIds() {
  return [...new Set([sandboxOrganisationId(), demoConfig()?.organisationId].filter((id): id is string => !!id))];
}
// The AI jobs are on in the isolated hosted demo unless switched off, and elsewhere only when switched on.
export function aiScheduleEnabled(env: Record<string, string | undefined> = process.env) {
  const setting = env.FAIRSHIFT_LOCAL_INTELLIGENCE_SCHEDULE;
  return setting === "on" || (setting !== "off" && deploymentMode() === "HOSTED_SANDBOX_DEMO");
}

let started = false;
// From src/instrumentation.ts. Never blocks the server from starting.
export function startScheduledFeeds() {
  if (started || process.env.NEXT_PHASE === "phase-production-build" || process.env.FAIRSHIFT_SCHEDULED_FEEDS === "off" || !getConfigurationStatus().databaseConfigured) return;
  started = true;
  const db = getDatabase();
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const organisations = demoOrganisationIds();
      const ai = aiScheduleEnabled();
      await runDueJobs(db, { now: () => new Date(), demoOrganisationIds: organisations, aiSchedule: ai, discovery: ai ? getLocalDiscoveryProvider() : null, pauseMs: 30_000 });
    } catch (error) {
      console.error("Scheduled feeds did not complete; the last good data stands.", { error: error instanceof Error ? error.name : "unknown" });
    } finally { running = false; }
  };
  void tick();
  setInterval(() => void tick(), TICK_MS).unref();
}

export async function jobStates(db: Database) {
  return db.select().from(scheduledJobs).where(isNotNull(scheduledJobs.job));
}
