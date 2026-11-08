import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { configureFixture } from "../helpers/workload";
import { demandContextFeeds, externalFeeds, fxReferenceRates, localIntelligenceRuns, organisations, outlets, scheduledJobs } from "@/server/db/schema";
import { AiProviderError, type AiFailureCode } from "@/server/integrations/openai/staffing-assessment";
import type { DiscoveryResponse, LocalDiscoveryProvider } from "@/server/integrations/openai/web-discovery";
import { getLiveFeedStatus } from "@/server/intelligence/live-feeds";
import { discoverWithRetryRule, RETRY_BACKOFF_MS } from "@/server/intelligence/local-intelligence-service";
import { JOBS, runDueJobs, type SchedulerDeps } from "@/server/scheduler/feeds";

// Fixture responses for each public feed; no network is used. Times are Monday 9 Nov 2026 in UTC.
const T0 = new Date("2026-11-09T06:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const ECB_XML = `<gesmes:Envelope><Cube><Cube time='2026-11-06'><Cube currency='USD' rate='1.1165'/><Cube currency='ZAR' rate='18.4649'/></Cube></Cube></gesmes:Envelope>`;
const holidays = (year: number) => [{ date: `${year}-12-16`, localName: "Day of Reconciliation", name: "Day of Reconciliation", countryCode: "ZA", types: ["Public"] }];
const hourly = () => { const start = Math.floor(T0.getTime() / 3_600_000) * 3600; const time = Array.from({ length: 8 * 24 }, (_, i) => start + i * 3600); return { hourly: { time, precipitation_probability: time.map(() => 10), precipitation: time.map(() => 0), temperature_2m: time.map(() => 24) } }; };

function feeds(options: { ecbFails?: boolean } = {}) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
    const url = input.toString();
    calls.push(new URL(url).hostname);
    if (url.startsWith("https://www.ecb.europa.eu/")) return options.ecbFails ? new Response("down", { status: 503 }) : new Response(ECB_XML, { status: 200 });
    const holiday = /PublicHolidays\/(\d{4})\/ZA$/.exec(url);
    if (holiday) return new Response(JSON.stringify(holidays(Number(holiday[1]))), { status: 200 });
    if (url.startsWith("https://api.open-meteo.com/")) return new Response(JSON.stringify(hourly()), { status: 200 });
    return new Response("not found", { status: 404 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fairshift-scheduler-")); vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];
async function demoBusiness(db: Db) {
  const organisationId = randomUUID(), withCoordinates = randomUUID(), without = randomUUID();
  await db.insert(organisations).values({ id: organisationId, name: "Fixture demo group", country: "South Africa" });
  await db.insert(outlets).values([
    { id: withCoordinates, organisationId, name: "Rosebank", timezone: "Africa/Johannesburg", country: "South Africa", province: "Gauteng", city: "Johannesburg", latitude: -26.1457, longitude: 28.0437 },
    { id: without, organisationId, name: "No coordinates", timezone: "Africa/Johannesburg", country: "South Africa" },
  ]);
  await configureFixture(db, { organisationId, outletId: withCoordinates, trading: [{ start: 480, end: 1200 }], coverage: null });
  return { organisationId, withCoordinates, without };
}
const deps = (organisationId: string, now: Date, fetchImpl: typeof fetch, extra: Partial<SchedulerDeps> = {}): SchedulerDeps => ({ now: () => now, demoOrganisationIds: [organisationId], fetchImpl, aiSchedule: false, ...extra });
const outcomes = (rows: Awaited<ReturnType<typeof runDueJobs>>) => Object.fromEntries(rows.map(row => [row.key, row.outcome === "RAN" ? (row.ok ? "RAN_OK" : "RAN_FAILED") : row.outcome]));

describe("scheduled feeds", () => {
  it("runs the weather, holiday and ECB jobs on start, and a restart neither repeats nor forgets them", async () => {
    let opened = await createTestDatabase(dir);
    const { organisationId, withCoordinates } = await demoBusiness(opened.db);
    const first = feeds();
    expect(outcomes(await runDueJobs(opened.db, deps(organisationId, T0, first.fetchImpl)))).toEqual({ "holidays:ZA": "RAN_OK", "ecb:daily": "RAN_OK", "weather:demo": "RAN_OK", "intel:recheck": "RAN_OK", "intel:daily": "DISABLED", "intel:disruptions": "DISABLED", "track:daily": "RAN_OK" });
    expect((await opened.db.select().from(fxReferenceRates))[0]).toMatchObject({ rateDate: "2026-11-06", source: "ECB_EUROFXREF_DAILY" });
    expect((await opened.db.select().from(demandContextFeeds).where(eq(demandContextFeeds.outletId, withCoordinates)))[0]).toMatchObject({ feed: "WEATHER", lastSuccessAt: T0 });
    expect((await opened.db.select().from(externalFeeds)).map(row => row.feed).sort()).toEqual(["ECB_EUROFXREF", "HOLIDAYS:ZA"]);
    await opened.close();

    // The server restarts an hour later: nothing is due, so no feed is fetched again.
    opened = await createTestDatabase(dir);
    const second = feeds();
    expect(outcomes(await runDueJobs(opened.db, deps(organisationId, at(60), second.fetchImpl)))).toMatchObject({ "holidays:ZA": "NOT_DUE", "ecb:daily": "NOT_DUE", "weather:demo": "NOT_DUE" });
    expect(second.calls).toEqual([]);
    // Each job comes round again on its own interval.
    expect(outcomes(await runDueJobs(opened.db, deps(organisationId, at(181), second.fetchImpl)))).toMatchObject({ "holidays:ZA": "NOT_DUE", "ecb:daily": "NOT_DUE", "weather:demo": "RAN_OK" });
    expect(outcomes(await runDueJobs(opened.db, deps(organisationId, at(300), second.fetchImpl)))).toMatchObject({ "holidays:ZA": "NOT_DUE", "ecb:daily": "NOT_DUE", "weather:demo": "NOT_DUE" });
    expect(outcomes(await runDueJobs(opened.db, deps(organisationId, at(361), second.fetchImpl)))).toMatchObject({ "holidays:ZA": "NOT_DUE", "ecb:daily": "RAN_OK", "weather:demo": "RAN_OK" });
    expect(outcomes(await runDueJobs(opened.db, deps(organisationId, at(24 * 60 + 1), second.fetchImpl)))).toMatchObject({ "holidays:ZA": "RAN_OK", "ecb:daily": "RAN_OK", "weather:demo": "RAN_OK" });
    await opened.close();
  });

  it("retries a failed ECB fetch after a pause, keeps the payout block and never loops", async () => {
    const { db, close } = await createTestDatabase();
    const { organisationId } = await demoBusiness(db);
    const down = feeds({ ecbFails: true });
    expect(outcomes(await runDueJobs(db, deps(organisationId, T0, down.fetchImpl)))["ecb:daily"]).toBe("RAN_FAILED");
    expect(down.calls.filter(host => host === "www.ecb.europa.eu")).toHaveLength(1);
    expect(await db.select().from(fxReferenceRates)).toEqual([]);
    expect((await db.select().from(externalFeeds).where(eq(externalFeeds.feed, "ECB_EUROFXREF")))[0]).toMatchObject({ lastFailureCode: "FETCH_FAILED", lastSuccessAt: null });
    expect(outcomes(await runDueJobs(db, deps(organisationId, at(10), down.fetchImpl)))["ecb:daily"]).toBe("NOT_DUE");
    expect((await getLiveFeedStatus(db, at(10))).ecb).toMatchObject({ status: "NOT_FETCHED", fresh: false, rate: null });
    const up = feeds();
    expect(outcomes(await runDueJobs(db, deps(organisationId, at(31), up.fetchImpl)))["ecb:daily"]).toBe("RAN_OK");
    expect((await getLiveFeedStatus(db, at(31))).ecb).toMatchObject({ status: "FRESH", fresh: true, rate: { rateDate: "2026-11-06" } });
    await close();
  });

  it("lets only one server run a job at a time, and takes over an abandoned lease", async () => {
    const { db, close } = await createTestDatabase();
    const { organisationId } = await demoBusiness(db);
    await db.insert(scheduledJobs).values({ job: "holidays:ZA", leaseUntil: at(5), lastStartedAt: T0 });
    const source = feeds();
    expect(outcomes(await runDueJobs(db, deps(organisationId, at(1), source.fetchImpl)))["holidays:ZA"]).toBe("LEASED");
    expect(outcomes(await runDueJobs(db, deps(organisationId, at(6), source.fetchImpl)))["holidays:ZA"]).toBe("RAN_OK");
    await close();
  });

  it("flags feeds that have fallen behind as stale", async () => {
    const { db, close } = await createTestDatabase();
    const { organisationId } = await demoBusiness(db);
    await runDueJobs(db, deps(organisationId, T0, feeds().fetchImpl));
    expect((await getLiveFeedStatus(db, at(60))).holidays).toMatchObject({ status: "FRESH", years: ["2026", "2027"] });
    expect((await getLiveFeedStatus(db, at(8 * 24 * 60))).holidays.status).toBe("STALE");
    // Four business days on, the 6 November rate no longer clears the payout rule.
    expect((await getLiveFeedStatus(db, new Date("2026-11-13T06:00:00Z"))).ecb.fresh).toBe(false);
    await close();
  });

});

// AI discovery cadence and retry rule (Owner decision, 8 November 2026): one call per demo location at
// about 05:00 and about 17:00 SAST, a daily cap of 20 calls that manual runs count toward, and one retry
// after a pause only after HTTP 429 or no response. The fixture group has two demo locations, called in
// name order: "No coordinates", then "Rosebank". No provider is reached: the model is a fixture.
describe("AI discovery cadence", () => {
  const sast = (local: string) => new Date(`${local}+02:00`);
  const AI_JOBS = JOBS.filter(job => job.key === "intel:daily" || job.key === "intel:disruptions");
  const ANSWER: DiscoveryResponse = { responseId: "resp_fixture", responseModel: "fixture-model", text: JSON.stringify({ coverage: [], signals: [] }), searches: [], consultedUrls: [], citedUrls: [] };
  // A fixture model: `script` answers each call by its number (1-based); an Error is thrown.
  function model(script: (call: number) => DiscoveryResponse | Error = () => ANSWER) {
    const discover = vi.fn(async (): Promise<DiscoveryResponse> => { const next = script(discover.mock.calls.length); if (next instanceof Error) throw next; return next; });
    return { provider: { provider: "OPENAI", model: "fixture-model", discover } as LocalDiscoveryProvider, discover };
  }
  const reachable = async () => ({ outcome: "REACHABLE" as const, httpStatus: 200 });
  async function tick(db: Db, organisationId: string, now: Date, provider: LocalDiscoveryProvider, sleep = vi.fn(async () => {})) {
    return outcomes(await runDueJobs(db, deps(organisationId, now, feeds().fetchImpl, { aiSchedule: true, discovery: provider, checkSource: reachable, sleep }), AI_JOBS));
  }
  // Every run (or one location's), sorted: runs from one tick share the fixture clock's time.
  const runsOf = async (db: Db, outletId?: string) => (await db.select().from(localIntelligenceRuns)).filter(row => !outletId || row.outletId === outletId)
    .map(row => `${row.kind}:${row.trigger}:${row.status}${row.failureCode ? `:${row.failureCode}` : ""}`).sort();
  const stateOf = async (db: Db, job: string) => (await db.select().from(scheduledJobs).where(eq(scheduledJobs.job, job)))[0];

  it("calls each location once at about 05:00 and 17:00 SAST, never retries a success, and a restart neither repeats nor misses a slot", async () => {
    let opened = await createTestDatabase(dir);
    const { organisationId } = await demoBusiness(opened.db);
    const { provider, discover } = model();
    const sleep = vi.fn(async () => {});
    expect(await tick(opened.db, organisationId, sast("2026-11-09T04:55:00"), provider, sleep)).toEqual({ "intel:daily": "NOT_DUE", "intel:disruptions": "NOT_DUE" });
    expect(discover).not.toHaveBeenCalled();
    expect(await tick(opened.db, organisationId, sast("2026-11-09T05:05:00"), provider, sleep)).toEqual({ "intel:daily": "RAN_OK", "intel:disruptions": "NOT_DUE" });
    expect(discover).toHaveBeenCalledTimes(2);
    await opened.close();

    // The server restarts ten minutes later: the 05:00 slot is done and nothing is called again.
    opened = await createTestDatabase(dir);
    expect(await tick(opened.db, organisationId, sast("2026-11-09T05:15:00"), provider, sleep)).toEqual({ "intel:daily": "NOT_DUE", "intel:disruptions": "NOT_DUE" });
    expect(await tick(opened.db, organisationId, sast("2026-11-09T12:00:00"), provider, sleep)).toEqual({ "intel:daily": "NOT_DUE", "intel:disruptions": "NOT_DUE" });
    expect(discover).toHaveBeenCalledTimes(2);
    expect(await tick(opened.db, organisationId, sast("2026-11-09T17:05:00"), provider, sleep)).toEqual({ "intel:daily": "NOT_DUE", "intel:disruptions": "RAN_OK" });
    expect(await tick(opened.db, organisationId, sast("2026-11-09T21:00:00"), provider, sleep)).toEqual({ "intel:daily": "NOT_DUE", "intel:disruptions": "NOT_DUE" });
    expect(await tick(opened.db, organisationId, sast("2026-11-10T05:02:00"), provider, sleep)).toEqual({ "intel:daily": "RAN_OK", "intel:disruptions": "NOT_DUE" });
    // Two locations, three slots: six calls, and no retry after any of them.
    expect(discover).toHaveBeenCalledTimes(6);
    expect(sleep).not.toHaveBeenCalled();
    expect(await runsOf(opened.db)).toEqual([...Array(4).fill("DAILY:SCHEDULE:COMPLETED"), ...Array(2).fill("DISRUPTIONS:SCHEDULE:COMPLETED")]);
    expect((await stateOf(opened.db, "intel:daily")).lastResult).toEqual({ COMPLETED: 2, slot: "2026-11-10T03:00:00.000Z", complete: true });
    await opened.close();
  });

  it("catches up a slot missed while the server was down only while it is recent", async () => {
    const { provider, discover } = model();
    const late = await createTestDatabase();
    const first = await demoBusiness(late.db);
    expect((await tick(late.db, first.organisationId, sast("2026-11-09T07:30:00"), provider))["intel:daily"]).toBe("RAN_OK");
    await late.close();
    const tooLate = await createTestDatabase();
    const second = await demoBusiness(tooLate.db);
    expect(await tick(tooLate.db, second.organisationId, sast("2026-11-09T08:30:00"), provider)).toEqual({ "intel:daily": "NOT_DUE", "intel:disruptions": "NOT_DUE" });
    expect(discover).toHaveBeenCalledTimes(2);
    await tooLate.close();
  });

  it("after HTTP 429, retries once after a pause and then stops", async () => {
    const { db, close } = await createTestDatabase();
    const { organisationId } = await demoBusiness(db);
    const { provider, discover } = model(() => new AiProviderError("HTTP_429"));
    const sleep = vi.fn(async () => {});
    expect((await tick(db, organisationId, sast("2026-11-09T05:05:00"), provider, sleep))["intel:daily"]).toBe("RAN_FAILED");
    // Two locations, each a call and exactly one retry, each retry after the one-minute pause.
    expect(discover).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls).toEqual([[RETRY_BACKOFF_MS], [RETRY_BACKOFF_MS]]);
    expect(RETRY_BACKOFF_MS).toBe(60_000);
    expect(await runsOf(db)).toEqual(Array(4).fill("DAILY:SCHEDULE:FAILED:HTTP_429"));
    expect(await stateOf(db, "intel:daily")).toMatchObject({ lastFailureCode: "SOME_RUNS_FAILED", lastResult: { FAILED: 2, RETRIED: 2, complete: true } });
    // Later in the slot, and after a restart, nothing more is called.
    expect((await tick(db, organisationId, sast("2026-11-09T05:15:00"), provider, sleep))["intel:daily"]).toBe("NOT_DUE");
    expect((await tick(db, organisationId, sast("2026-11-09T07:55:00"), provider, sleep))["intel:daily"]).toBe("NOT_DUE");
    expect(discover).toHaveBeenCalledTimes(4);
    await close();
  });

  it("stops retrying once a retry succeeds", async () => {
    const { db, close } = await createTestDatabase();
    const { organisationId, withCoordinates, without } = await demoBusiness(db);
    const { provider, discover } = model(call => call === 1 ? new AiProviderError("HTTP_429") : ANSWER);
    expect((await tick(db, organisationId, sast("2026-11-09T05:05:00"), provider))["intel:daily"]).toBe("RAN_OK");
    expect(discover).toHaveBeenCalledTimes(3);
    expect(await runsOf(db, without)).toEqual(["DAILY:SCHEDULE:COMPLETED", "DAILY:SCHEDULE:FAILED:HTTP_429"]);
    expect(await runsOf(db, withCoordinates)).toEqual(["DAILY:SCHEDULE:COMPLETED"]);
    expect((await stateOf(db, "intel:daily")).lastResult).toMatchObject({ COMPLETED: 2, RETRIED: 1, complete: true });
    await close();
  });

  it("retries once after no response, and never after any other answer", async () => {
    const { db, close } = await createTestDatabase();
    const { organisationId, withCoordinates, without } = await demoBusiness(db);
    // No coordinates: a timeout, then a failed connection; Rosebank: an HTTP 500, which is an answer.
    const failures: AiFailureCode[] = ["TIMEOUT", "NETWORK_ERROR", "HTTP_500"];
    const first = model(call => new AiProviderError(failures[call - 1]));
    const sleep = vi.fn(async () => {});
    expect((await tick(db, organisationId, sast("2026-11-09T05:05:00"), first.provider, sleep))["intel:daily"]).toBe("RAN_FAILED");
    expect(first.discover).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(await runsOf(db, without)).toEqual(["DAILY:SCHEDULE:FAILED:NETWORK_ERROR", "DAILY:SCHEDULE:FAILED:TIMEOUT"]);
    expect(await runsOf(db, withCoordinates)).toEqual(["DAILY:SCHEDULE:FAILED:HTTP_500"]);
    // A call that answered with something FairShift can't use is a successful call: never repeated.
    const unusable = model(() => ({ ...ANSWER, text: "not json" }));
    expect((await tick(db, organisationId, sast("2026-11-09T17:05:00"), unusable.provider, sleep))["intel:disruptions"]).toBe("RAN_FAILED");
    expect(unusable.discover).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect((await runsOf(db)).filter(row => row.startsWith("DISRUPTIONS"))).toEqual(Array(2).fill("DISRUPTIONS:SCHEDULE:FAILED:VALIDATION_MALFORMED"));
    await close();
  });

  it("stops at the daily cap: no call beyond it, not even a retry", async () => {
    vi.stubEnv("FAIRSHIFT_LOCAL_INTEL_DAILY_CAP", "3");
    const capped = await createTestDatabase();
    const { organisationId } = await demoBusiness(capped.db);
    const { provider, discover } = model();
    expect((await tick(capped.db, organisationId, sast("2026-11-09T05:05:00"), provider))["intel:daily"]).toBe("RAN_OK");
    expect((await tick(capped.db, organisationId, sast("2026-11-09T17:05:00"), provider))["intel:disruptions"]).toBe("RAN_OK");
    expect(discover).toHaveBeenCalledTimes(3);
    expect((await stateOf(capped.db, "intel:disruptions")).lastResult).toMatchObject({ COMPLETED: 1, CAPPED: 1, complete: true });
    // A new South African day starts a new count.
    expect((await tick(capped.db, organisationId, sast("2026-11-10T05:05:00"), provider))["intel:daily"]).toBe("RAN_OK");
    expect(discover).toHaveBeenCalledTimes(5);
    await capped.close();

    // With one call left, a 429 gets no retry: the retry would pass the cap.
    vi.stubEnv("FAIRSHIFT_LOCAL_INTEL_DAILY_CAP", "1");
    const last = await createTestDatabase();
    const second = await demoBusiness(last.db);
    const limited = model(() => new AiProviderError("HTTP_429"));
    expect((await tick(last.db, second.organisationId, sast("2026-11-09T05:05:00"), limited.provider))["intel:daily"]).toBe("RAN_FAILED");
    expect(limited.discover).toHaveBeenCalledTimes(1);
    expect((await stateOf(last.db, "intel:daily")).lastResult).toMatchObject({ FAILED: 1, CAPPED: 1, complete: true });
    expect(await runsOf(last.db)).toEqual(["DAILY:SCHEDULE:FAILED:HTTP_429"]);
    await last.close();
  });

  it("counts a manual refresh, and its retry, toward the daily cap", async () => {
    vi.stubEnv("FAIRSHIFT_LOCAL_INTEL_DAILY_CAP", "3");
    const first = await createTestDatabase();
    const business = await demoBusiness(first.db);
    const { provider, discover } = model();
    // The operator's manual refresh (scripts/local-intelligence.ts) for Rosebank before the 05:00 run.
    expect((await discoverWithRetryRule(first.db, { organisationId: business.organisationId, outletId: business.withCoordinates }, { kind: "DAILY", trigger: "MANUAL", provider, checkSource: reachable, clock: () => sast("2026-11-09T04:30:00") })).map(row => row.status)).toEqual(["COMPLETED"]);
    // The schedule still makes its own call at each location; the manual one is the cap's third.
    expect((await tick(first.db, business.organisationId, sast("2026-11-09T05:05:00"), provider))["intel:daily"]).toBe("RAN_OK");
    expect((await tick(first.db, business.organisationId, sast("2026-11-09T17:05:00"), provider))["intel:disruptions"]).toBe("RAN_OK");
    expect(discover).toHaveBeenCalledTimes(3);
    expect((await stateOf(first.db, "intel:disruptions")).lastResult).toMatchObject({ CAPPED: 1, complete: true });
    expect(await runsOf(first.db)).toEqual(["DAILY:MANUAL:COMPLETED", "DAILY:SCHEDULE:COMPLETED", "DAILY:SCHEDULE:COMPLETED"]);
    await first.close();

    // A manual refresh that meets a 429 retries once; both calls count, leaving the schedule nothing.
    vi.stubEnv("FAIRSHIFT_LOCAL_INTEL_DAILY_CAP", "2");
    const second = await createTestDatabase();
    const other = await demoBusiness(second.db);
    const busy = model(() => new AiProviderError("HTTP_429"));
    const sleep = vi.fn(async () => {});
    expect((await discoverWithRetryRule(second.db, { organisationId: other.organisationId, outletId: other.withCoordinates }, { kind: "DAILY", trigger: "MANUAL", provider: busy.provider, checkSource: reachable, clock: () => sast("2026-11-09T04:30:00"), sleep })).map(row => row.status)).toEqual(["FAILED", "FAILED"]);
    expect(sleep.mock.calls).toEqual([[RETRY_BACKOFF_MS]]);
    expect((await tick(second.db, other.organisationId, sast("2026-11-09T05:05:00"), busy.provider))["intel:daily"]).toBe("RAN_OK");
    expect(busy.discover).toHaveBeenCalledTimes(2);
    expect((await stateOf(second.db, "intel:daily")).lastResult).toMatchObject({ CAPPED: 1, complete: true });
    await second.close();
  });

  it("resumes a pass the server stopped in only where no call got an answer", async () => {
    const { db, close } = await createTestDatabase();
    const { organisationId, withCoordinates, without } = await demoBusiness(db);
    // The 05:00 pass called "No coordinates" (answered), then stopped mid-call at Rosebank.
    const run = (outletId: string, createdAt: Date, completedAt: Date | null) => ({ id: randomUUID(), organisationId, outletId, kind: "DAILY", trigger: "SCHEDULE", windowFrom: "2026-11-09", windowTo: "2026-11-16",
      status: completedAt ? "COMPLETED" : "RUNNING", policyVersion: "fs-local-intel-policy-v1", outputVersion: "fs-local-intel-output-v1", provider: "OPENAI", model: "fixture-model", input: {}, createdAt, completedAt });
    await db.insert(localIntelligenceRuns).values([run(without, sast("2026-11-09T05:00:20"), sast("2026-11-09T05:01:00")), run(withCoordinates, sast("2026-11-09T05:01:30"), null)]);
    await db.insert(scheduledJobs).values({ job: "intel:daily", lastStartedAt: sast("2026-11-09T05:00:10"), leaseUntil: sast("2026-11-09T06:00:10") });
    const { provider, discover } = model();
    // Its lease still stands for a while: no second server takes it over.
    expect((await tick(db, organisationId, sast("2026-11-09T05:30:00"), provider))["intel:daily"]).toBe("LEASED");
    expect(discover).not.toHaveBeenCalled();
    // Once it lapses, Rosebank's interrupted call gets its one retry; "No coordinates" is not called again.
    expect((await tick(db, organisationId, sast("2026-11-09T06:10:00"), provider))["intel:daily"]).toBe("RAN_OK");
    expect(discover).toHaveBeenCalledTimes(1);
    expect((await stateOf(db, "intel:daily")).lastResult).toMatchObject({ ALREADY_RUN: 1, COMPLETED: 1, RETRIED: 1, complete: true });
    expect((await tick(db, organisationId, sast("2026-11-09T06:20:00"), provider))["intel:daily"]).toBe("NOT_DUE");
    expect(discover).toHaveBeenCalledTimes(1);
    await close();
  });
});
