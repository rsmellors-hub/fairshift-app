import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import { getConfigurationStatus } from "@/server/config/env";
import { deploymentMode, sandboxOrganisationId } from "@/server/config/deployment";
import { getDatabase, type Database } from "@/server/db/client";
import { externalFeeds, localIntelligenceRuns, memberships, organisations, outlets, scheduledJobs, subscriptions, users } from "@/server/db/schema";
import { isEntitled } from "@/server/billing/entitlement";
import { ensureDemoBooking, ensureDemoOpenOffer } from "@/server/demo/booking";
import { DEMO_ACCOUNTS } from "@/server/demo/provision";
import { JUDGE_ACCOUNTS } from "@/server/demo/judges";
import { advanceOfferRounds } from "@/server/scheduling/shift-suggestions";
import { refreshProcessingPayouts, type PayoutClientSource } from "@/server/payments/work-payouts";
import { getPayPalPayoutClient } from "@/server/integrations/paypal/factory";
import { ensureDemoRules } from "@/server/demo/settings-seed";
import { getStaffingAssessmentProvider, type StaffingAssessmentProvider } from "@/server/integrations/openai/staffing-assessment";
import { generateStaffingAssessment, NoPlanningEvidenceError } from "@/server/intelligence/ai-staffing";
import { getWeeklyStaffing } from "@/server/intelligence/staffing";
import { planningChanged } from "@/server/intelligence/planning-cache";
import { demoConfig } from "@/server/demo/config";
import { ECB_DAILY_URL, ECB_FEED, fetchEcbDailyQuote, recordEcbQuote } from "@/server/fx/reference-rates";
import { getLocalDiscoveryProvider, type LocalDiscoveryProvider } from "@/server/integrations/openai/web-discovery";
import { fetchOpenMeteoHourly } from "@/server/integrations/open-meteo/forecast";
import { refreshLocationWeather, type FetchHourly } from "@/server/intelligence/demand-context-service";
import type { RunKind } from "@/server/intelligence/local-intelligence-contract";
import { discoverWithRetryRule, mayRetry, recheckUnreachableSources } from "@/server/intelligence/local-intelligence-service";
import { createSourceChecker, type SourceChecker } from "@/server/intelligence/local-intelligence-sources";
import { refreshHolidayFeed } from "@/server/reference/public-holiday-feed";
import { recordTrackRecord } from "@/server/intelligence/track-record";
import { provisionSaReferenceBusiness } from "@/server/reference/sa-provision";
import { SA_REFERENCE_ORGANISATION } from "@/server/reference/sa-reference";
import { localDate, shiftDate, startOfLocalDay } from "@/server/intelligence/forecast";

// Keeps the demo's real feeds current without anyone opening a page: weather for every demo location,
// the South African holiday feed, the ECB reference rate and the AI's local discovery. Each job's last
// run is stored, so a restart neither repeats a job that isn't due nor forgets one that is, and a lease
// means two servers never run one job at once. A failed job keeps the last good data and tries again
// later. Nothing here loops on a failure, and the AI jobs stop at the daily call cap.

const HOUR = 3_600_000, MINUTE = 60_000;
const TICK_MS = 10 * MINUTE;

// AI discovery cadence (Owner decision, 8 November 2026): one call per demo location at about 05:00
// and about 17:00 South African time, ten a day for five locations. The 05:00 run searches every
// category for the coming days; the 17:00 run is the short-notice check. The feeds above keep their own
// intervals and never count toward the AI cap. A slot missed while the server was down is caught up
// only while it is recent, so a run never lands at an unrelated time of day.
export const AI_SLOT_TIME_ZONE = "Africa/Johannesburg";
const SLOT_GRACE_MS = 3 * HOUR;
export type Slot = { minute: number; timeZone: string; graceMs: number };

export type JobKey = "holidays:ZA" | "ecb:daily" | "weather:demo" | "intel:recheck" | "intel:daily" | "intel:disruptions" | "track:daily" | "demo:booking" | "ai:briefing" | "offers:rounds" | "cache:demo" | "payouts:refresh";
export type JobResult = { ok: boolean; code?: string | null; detail?: Record<string, unknown> };
export type SchedulerDeps = {
  now: () => Date;
  demoOrganisationIds: readonly string[];
  fetchImpl?: typeof fetch;
  fetchHourly?: FetchHourly;
  discovery?: LocalDiscoveryProvider | null;
  // The staffing briefing's model ("What to staff first"); the job runs only with one.
  assessment?: StaffingAssessmentProvider | null;
  checkSource?: SourceChecker;
  // PayPal payout clients for the scheduled status reads; the job runs only with one.
  payoutClient?: PayoutClientSource | null;
  // The AI jobs run only when this is on and a provider is configured.
  aiSchedule: boolean;
  // A pause between one location's model call and the next, so a run never bursts at the provider.
  pauseMs?: number;
  // The pause before the retry rule's one retry (default one minute), and the clock's wait; both for tests.
  retryBackoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
};
// An interval job runs when its interval has passed since its last success; a slot job once per slot.
type Job = { key: JobKey; retryMs: number; leaseMs: number; enabled: (deps: SchedulerDeps) => boolean; run: (db: Database, deps: SchedulerDeps, slotStart: Date | null) => Promise<JobResult> }
  & ({ intervalMs: number; slot?: undefined } | { slot: Slot; intervalMs?: undefined });

async function demoLocations(db: Database, deps: SchedulerDeps) {
  return activeLocations(db, deps.demoOrganisationIds);
}
async function activeLocations(db: Database, organisationIds: readonly string[]) {
  if (!organisationIds.length) return [];
  return db.select({ organisationId: outlets.organisationId, locationId: outlets.id, latitude: outlets.latitude }).from(outlets)
    .where(and(inArray(outlets.organisationId, [...organisationIds]), eq(outlets.active, true))).orderBy(outlets.name);
}

// The businesses the operational jobs (offer rounds, weather, source rechecks) serve: the demo business,
// and every business with a reconciled active subscription (billing/entitlement.ts) and at least one
// active location. The AI jobs keep to the demo business; other businesses' AI runs stay on demand,
// under AI_LIMITS.
export async function operatingOrganisationIds(db: Database, demoOrganisationIds: readonly string[]) {
  const rows = await db.selectDistinct({ organisationId: subscriptions.organisationId, status: subscriptions.status, verifiedAt: subscriptions.verifiedAt, providerId: subscriptions.providerId, planId: subscriptions.planId })
    .from(subscriptions).innerJoin(outlets, and(eq(outlets.organisationId, subscriptions.organisationId), eq(outlets.active, true)))
    .where(eq(subscriptions.status, "ACTIVE"));
  return [...new Set([...demoOrganisationIds, ...rows.filter(isEntitled).map(row => row.organisationId)])];
}

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// One pass of a slot: each demo location's call, with the retry rule's one retry. The calls this slot
// already made at a location (by a pass that stopped with the server) are found first, so a resumed
// pass never repeats a call that got an answer and never makes more than the call and its retry.
async function discover(db: Database, deps: SchedulerDeps, kind: RunKind, slotStart: Date): Promise<JobResult> {
  const provider = deps.discovery;
  if (!provider) return { ok: false, code: "NOT_CONFIGURED" };
  const checkSource = deps.checkSource ?? createSourceChecker({ fetchImpl: deps.fetchImpl });
  const sleep = deps.sleep ?? wait;
  const tally: Record<string, number> = {};
  const add = (key: string) => { tally[key] = (tally[key] ?? 0) + 1; };
  let called = false;
  for (const location of await demoLocations(db, deps)) {
    const earlier = await db.select().from(localIntelligenceRuns)
      .where(and(eq(localIntelligenceRuns.outletId, location.locationId), eq(localIntelligenceRuns.kind, kind), eq(localIntelligenceRuns.trigger, "SCHEDULE"), gte(localIntelligenceRuns.createdAt, slotStart)))
      .orderBy(asc(localIntelligenceRuns.createdAt));
    if (earlier.length >= 2 || (earlier.length === 1 && !mayRetry(earlier[0], deps.now()))) { add("ALREADY_RUN"); continue; }
    if (called && deps.pauseMs) await sleep(deps.pauseMs);
    called = true;
    const outcomes = await discoverWithRetryRule(db, { organisationId: location.organisationId, outletId: location.locationId },
      { kind, trigger: "SCHEDULE", provider, checkSource, earlier, clock: deps.now, backoffMs: deps.retryBackoffMs, sleep });
    const last = outcomes.at(-1);
    if (!last) { add("ALREADY_RUN"); continue; }
    // A location ends COMPLETED or FAILED by the calls actually made; CAPPED or UNAVAILABLE when none was.
    const made = outcomes.filter(outcome => outcome.status === "COMPLETED" || outcome.status === "FAILED");
    const final = made.at(-1)?.status ?? last.status;
    add(final);
    if (earlier.length + made.length === 2) add("RETRIED");
    if (last.status === "CAPPED") { if (final !== "CAPPED") add("CAPPED"); break; }
  }
  // complete: this pass went through every location (or stopped at the cap), so the slot is done.
  return { ok: !tally.FAILED, code: tally.FAILED ? "SOME_RUNS_FAILED" : null, detail: { ...tally, slot: slotStart.toISOString(), complete: true } };
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
  { key: "weather:demo", intervalMs: 3 * HOUR, retryMs: 30 * MINUTE, leaseMs: 5 * MINUTE, enabled: () => true,
    run: async (db, deps) => {
      const tally: Record<string, number> = {};
      for (const location of await activeLocations(db, await operatingOrganisationIds(db, deps.demoOrganisationIds))) {
        const fetchHourly = deps.fetchHourly ?? (deps.fetchImpl ? (place: { latitude: number; longitude: number }, timeoutMs: number) => fetchOpenMeteoHourly(place, { timeoutMs, fetchImpl: deps.fetchImpl }) : undefined);
        const result = await refreshLocationWeather(db, location, { mode: "EXPLICIT", now: deps.now(), fetchHourly });
        tally[result] = (tally[result] ?? 0) + 1;
      }
      return { ok: !tally.FAILED, code: tally.FAILED ? "SOME_LOCATIONS_FAILED" : null, detail: tally };
    } },
  // The demo story's booked casual shift for tomorrow (src/server/demo/booking.ts), so the DEMO capacity
  // scenario always has a shift to give early notice about, whatever the date. Idempotent: an existing
  // booking is kept. Only the fictional demo business has one.
  { key: "demo:booking", intervalMs: HOUR, retryMs: 15 * MINUTE, leaseMs: 5 * MINUTE, enabled: deps => deps.demoOrganisationIds.length > 0,
    run: async (db, deps) => {
      const config = demoConfig();
      const booked: string[] = [], offered: string[] = [];
      let changed = false;
      for (const organisationId of deps.demoOrganisationIds) {
        // The demo worker: the public demo's Worker persona, or with the public demo off, the same demo
        // account (Ayanda Casual) by its sign-in address, so the booking never moves to another worker.
        const [worker] = config?.organisationId === organisationId
          ? await db.select({ workerId: memberships.workerId }).from(memberships).where(and(eq(memberships.id, config.WORKER), eq(memberships.organisationId, organisationId)))
          : await accountWorker(db, organisationId, DEMO_ACCOUNTS.WORKER.email);
        // The demo business's shift-length and hours rules (Owner decisions, 9 November 2026), once.
        const seeded = await ensureDemoRules(db, organisationId);
        const booking = await ensureDemoBooking(db, { organisationId, workerId: worker?.workerId ?? null, now: deps.now() });
        if (booking) booked.push(booking.date);
        // The Judge Worker's daily open offer, for the day after tomorrow.
        const [judge] = await accountWorker(db, organisationId, JUDGE_ACCOUNTS.WORKER.email);
        const offer = judge?.workerId ? await ensureDemoOpenOffer(db, { organisationId, workerId: judge.workerId, now: deps.now() }) : null;
        if (offer) offered.push(offer.refused ? `${offer.date}:${offer.refused}` : offer.date);
        changed ||= seeded.shiftRulesAdded > 0 || seeded.payTermsAdded > 0 || !!booking?.created || !!offer?.created;
      }
      return { ok: true, detail: { booked, offered, planningChanged: changed } };
    } },
  // "What to staff first" (Day 6, Step 1h): the AI briefing for the demo business and each of its
  // locations, so it is there when anyone opens the page. A briefing is generated only when the
  // figures it reads have changed (a new planning day, new AI findings, an accepted change), never
  // twice for the same evidence, and every call is recorded with its own audit event.
  { key: "ai:briefing", intervalMs: 2 * HOUR, retryMs: 30 * MINUTE, leaseMs: 15 * MINUTE, enabled: deps => deps.aiSchedule && !!deps.assessment && deps.demoOrganisationIds.length > 0,
    run: async (db, deps) => {
      const tally: Record<string, number> = {};
      for (const organisationId of deps.demoOrganisationIds) {
        const [owner] = await db.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.organisationId, organisationId), eq(memberships.role, "OWNER"), eq(memberships.state, "ACTIVE"))).orderBy(asc(memberships.createdAt)).limit(1);
        if (!owner) continue;
        const sites = await db.select({ id: outlets.id }).from(outlets).where(and(eq(outlets.organisationId, organisationId), eq(outlets.active, true))).orderBy(asc(outlets.name));
        if (!sites.length) continue;
        const scopeAt = (locationId: string) => ({ userId: owner.userId, organisationId, locationId, role: "OWNER" as const });
        for (const [kind, locationId] of [["ORGANISATION", sites[0].id] as const, ...sites.map(site => ["LOCATION", site.id] as const)]) {
          try {
            let result = await generateStaffingAssessment(db, scopeAt(locationId), kind, deps.assessment!, deps.now());
            // An answer FairShift's validation rejected gets one immediate second attempt (counted and recorded
            // like the first); a provider failure waits for the next run.
            if (result.generated && result.record.status === "FAILED" && result.record.failureCode?.startsWith("VALIDATION_")) {
              tally.retried = (tally.retried ?? 0) + 1;
              result = await generateStaffingAssessment(db, scopeAt(locationId), kind, deps.assessment!, deps.now());
            }
            const key = result.generated ? (result.record.status === "AVAILABLE" ? "generated" : "failed") : "current";
            tally[key] = (tally[key] ?? 0) + 1;
          } catch (error) { tally[error instanceof NoPlanningEvidenceError ? "noEvidence" : "error"] = (tally[error instanceof NoPlanningEvidenceError ? "noEvidence" : "error"] ?? 0) + 1; }
        }
      }
      return { ok: !tally.error, code: tally.error ? "PARTIAL" : null, detail: tally };
    } },
  // FS-OFFER-ORDER-DEC-001: when a first offer round's window closes with places open, round 2 opens.
  { key: "offers:rounds", intervalMs: 5 * MINUTE, retryMs: 5 * MINUTE, leaseMs: 5 * MINUTE, enabled: () => true,
    run: async (db, deps) => { const result = await advanceOfferRounds(db, await operatingOrganisationIds(db, deps.demoOrganisationIds), deps.now()); return { ok: true, detail: { ...result, planningChanged: result.opened > 0 } }; } },
  // Day 6, Step 2: keeps the demo business's planning week warm in this server's cache, so the first
  // visitor after a restart doesn't wait for months of history to be aggregated. Reads only.
  { key: "cache:demo", intervalMs: 15 * MINUTE, retryMs: 5 * MINUTE, leaseMs: 5 * MINUTE, enabled: deps => deps.demoOrganisationIds.length > 0,
    run: async (db, deps) => ({ ok: true, detail: { warmed: await warmDemoPlanning(db, deps.demoOrganisationIds, deps.now()) } }) },
  // Payouts PayPal accepted and hasn't settled yet, read again every ten minutes (work-payouts.ts). Reads only.
  { key: "payouts:refresh", intervalMs: 10 * MINUTE, retryMs: 10 * MINUTE, leaseMs: 10 * MINUTE, enabled: deps => !!deps.payoutClient,
    run: async (db, deps) => { const result = await refreshProcessingPayouts(db, deps.payoutClient!); return { ok: !result.UNCHANGED_READ_FAILED, code: result.UNCHANGED_READ_FAILED ? "SOME_READS_FAILED" : null, detail: result }; } },
  { key: "intel:recheck", intervalMs: 2 * HOUR, retryMs: 30 * MINUTE, leaseMs: 10 * MINUTE, enabled: () => true,
    run: async (db, deps) => { const result = await recheckUnreachableSources(db, await operatingOrganisationIds(db, deps.demoOrganisationIds), deps.checkSource ?? createSourceChecker({ fetchImpl: deps.fetchImpl }), deps.now()); return { ok: true, detail: result }; } },
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
  // Leases cover a whole pass: five locations, each with a call, a pause and possibly a retry.
  { key: "intel:daily", slot: { minute: 5 * 60, timeZone: AI_SLOT_TIME_ZONE, graceMs: SLOT_GRACE_MS }, retryMs: 30 * MINUTE, leaseMs: 60 * MINUTE,
    enabled: deps => deps.aiSchedule && !!deps.discovery && deps.demoOrganisationIds.length > 0, run: (db, deps, slotStart) => discover(db, deps, "DAILY", slotStart!) },
  { key: "intel:disruptions", slot: { minute: 17 * 60, timeZone: AI_SLOT_TIME_ZONE, graceMs: SLOT_GRACE_MS }, retryMs: 30 * MINUTE, leaseMs: 60 * MINUTE,
    enabled: deps => deps.aiSchedule && !!deps.discovery && deps.demoOrganisationIds.length > 0, run: (db, deps, slotStart) => discover(db, deps, "DISRUPTIONS", slotStart!) },
];

// The most recent time the slot's local clock time came round, at or before now.
export function latestSlotStart(now: Date, slot: Pick<Slot, "minute" | "timeZone">) {
  const at = (date: string) => new Date(startOfLocalDay(date, slot.timeZone).getTime() + slot.minute * MINUTE);
  const today = localDate(now, slot.timeZone);
  const todays = at(today);
  return todays.getTime() <= now.getTime() ? todays : at(shiftDate(today, -1));
}

type JobRow = typeof scheduledJobs.$inferSelect;
export function isDue(job: Pick<Job, "intervalMs" | "retryMs" | "slot">, row: JobRow | undefined, now: Date) {
  if (job.slot) {
    const start = latestSlotStart(now, job.slot);
    // Too late to count as this slot's run: wait for the next one.
    if (now.getTime() - start.getTime() > job.slot.graceMs) return false;
    if (!row?.lastStartedAt || row.lastStartedAt < start) return true;
    // A pass began in this slot and never finished: the server stopped. It resumes once the lease lapses.
    if (!row.lastFinishedAt || row.lastFinishedAt < row.lastStartedAt) return true;
    // A pass that went through every location is done until the next slot; one cut short by an error
    // resumes after a pause, and skips the locations already called.
    return (row.lastResult as { complete?: unknown } | null)?.complete !== true && now.getTime() - row.lastFinishedAt.getTime() >= job.retryMs;
  }
  if (!row) return true;
  if (row.lastFailureCode && row.lastFinishedAt && now.getTime() - row.lastFinishedAt.getTime() < job.retryMs) return false;
  return !row.lastSuccessAt || now.getTime() - row.lastSuccessAt.getTime() >= (job.intervalMs ?? 0);
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
    try { result = await job.run(db, deps, job.slot ? latestSlotStart(now, job.slot) : null); } catch (error) { result = { ok: false, code: error instanceof Error ? error.name : "ERROR" }; }
    const finished = deps.now();
    await db.update(scheduledJobs).set({ leaseUntil: null, lastFinishedAt: finished, ...(result.ok ? { lastSuccessAt: finished, lastFailureCode: null } : { lastFailureCode: result.code ?? "FAILED" }), lastResult: result.detail ?? {} })
      .where(eq(scheduledJobs.job, job.key));
    // Jobs that write what the planning week reads tell the planning cache (planning-cache.ts); a job can
    // say it changed nothing. Reads-only jobs (cache warming, the AI briefing, ECB rates) never do.
    if (PLANNING_JOBS.has(job.key) && result.detail?.planningChanged !== false) planningChanged();
    results.push({ key: job.key, outcome: "RAN", ok: result.ok, code: result.code ?? null });
  }
  return results;
}

// An account's worker record in a business, by its sign-in address.
function accountWorker(db: Database, organisationId: string, email: string) {
  return db.select({ workerId: memberships.workerId }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(users.email, email), eq(memberships.organisationId, organisationId), eq(memberships.state, "ACTIVE"))).limit(1);
}
export function demoOrganisationIds() {
  return [...new Set([sandboxOrganisationId(), demoConfig()?.organisationId].filter((id): id is string => !!id))];
}
// The AI jobs are on in the isolated hosted demo unless switched off, and elsewhere only when switched on.
export function aiScheduleEnabled(env: Record<string, string | undefined> = process.env) {
  const setting = env.FAIRSHIFT_LOCAL_INTELLIGENCE_SCHEDULE;
  return setting === "on" || (setting !== "off" && deploymentMode() === "HOSTED_SANDBOX_DEMO");
}

// The demo business's planning week, for the Owner (every location) and for each location's Manager,
// read once so the planning cache holds it. Reads only.
export async function warmDemoPlanning(db: Database, organisationIds: readonly string[], now: Date) {
  let warmed = 0;
  for (const organisationId of organisationIds) {
    const [owner] = await db.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.organisationId, organisationId), eq(memberships.role, "OWNER"), eq(memberships.state, "ACTIVE"))).orderBy(asc(memberships.createdAt)).limit(1);
    const sites = await db.select({ id: outlets.id }).from(outlets).where(and(eq(outlets.organisationId, organisationId), eq(outlets.active, true))).orderBy(asc(outlets.name));
    if (!owner || !sites.length) continue;
    const base = { userId: owner.userId, organisationId, organisationName: "", locationName: "" };
    await getWeeklyStaffing(db, { ...base, locationId: sites[0].id, role: "OWNER" }, now);
    warmed++;
    for (const site of sites) { await getWeeklyStaffing(db, { ...base, locationId: site.id, role: "MANAGER" }, now); warmed++; }
  }
  return warmed;
}

const PLANNING_JOBS: ReadonlySet<JobKey> = new Set(["holidays:ZA", "weather:demo", "intel:recheck", "intel:daily", "intel:disruptions", "track:daily", "demo:booking", "offers:rounds"]);

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
      await runDueJobs(db, { now: () => new Date(), demoOrganisationIds: organisations, aiSchedule: ai, payoutClient: getConfigurationStatus().paypalPayoutConfigured ? getPayPalPayoutClient : null, discovery: ai ? getLocalDiscoveryProvider() : null, assessment: ai ? getStaffingAssessmentProvider() : null, pauseMs: 30_000 });
    } catch (error) {
      console.error("Scheduled feeds did not complete; the last good data stands.", { error: error instanceof Error ? error.name : "unknown" });
    } finally { running = false; }
  };
  // The planning cache is warmed first, straight away, so the first visitor after a deploy doesn't wait for it;
  // the scheduled jobs (some with AI calls) follow.
  void (async () => {
    try { await warmDemoPlanning(db, demoOrganisationIds(), new Date()); }
    catch { console.error("The planning cache could not be warmed; pages compute it on first use."); }
    finally { void tick(); }
  })();
  setInterval(() => void tick(), TICK_MS).unref();
}

export async function jobStates(db: Database) {
  return db.select().from(scheduledJobs).where(isNotNull(scheduledJobs.job));
}
