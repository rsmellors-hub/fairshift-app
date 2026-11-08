import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { configureFixture } from "../helpers/workload";
import { demandContextFeeds, externalFeeds, fxReferenceRates, localIntelligenceRuns, organisations, outlets, scheduledJobs } from "@/server/db/schema";
import type { LocalDiscoveryProvider } from "@/server/integrations/openai/web-discovery";
import { getLiveFeedStatus } from "@/server/intelligence/live-feeds";
import { runDueJobs, type SchedulerDeps } from "@/server/scheduler/feeds";

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

  it("runs the AI jobs only when switched on, one location at a time, inside the daily cap", async () => {
    const { db, close } = await createTestDatabase();
    const { organisationId } = await demoBusiness(db);
    vi.stubEnv("FAIRSHIFT_LOCAL_INTEL_DAILY_CAP", "1");
    const discover = vi.fn(async () => ({ responseId: "resp_fixture", responseModel: "fixture-model", text: JSON.stringify({ coverage: [], signals: [] }), searches: [], consultedUrls: [], citedUrls: [] }));
    const discovery: LocalDiscoveryProvider = { provider: "OPENAI", model: "fixture-model", discover };
    const result = outcomes(await runDueJobs(db, deps(organisationId, T0, feeds().fetchImpl, { aiSchedule: true, discovery, checkSource: async () => ({ outcome: "REACHABLE", httpStatus: 200 }) })));
    expect(result["intel:daily"]).toBe("RAN_OK");
    expect(discover).toHaveBeenCalledTimes(1);
    expect((await db.select().from(scheduledJobs).where(eq(scheduledJobs.job, "intel:daily")))[0].lastResult).toEqual({ COMPLETED: 1, CAPPED: 1 });
    expect(await db.select().from(localIntelligenceRuns)).toHaveLength(1);
    // A retry after a partial failure calls the model only for a location still without a fresh daily run.
    await db.update(scheduledJobs).set({ lastSuccessAt: null, lastFailureCode: null }).where(eq(scheduledJobs.job, "intel:daily"));
    expect(outcomes(await runDueJobs(db, deps(organisationId, at(5), feeds().fetchImpl, { aiSchedule: true, discovery, checkSource: async () => ({ outcome: "REACHABLE", httpStatus: 200 }) })))["intel:daily"]).toBe("RAN_OK");
    expect((await db.select().from(scheduledJobs).where(eq(scheduledJobs.job, "intel:daily")))[0].lastResult).toEqual({ FRESH: 1, CAPPED: 1 });
    expect(discover).toHaveBeenCalledTimes(1);
    await close();
  });
});
