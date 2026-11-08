import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { entitled } from "../helpers/onboarding";
import { configureFixture, hours, ingestTimedBills } from "../helpers/workload";
import type { Scope } from "@/server/auth/access";
import { auditEvents, externalFeeds, localIntelligenceRuns, localIntelligenceSignals, memberships, organisations, outlets, subscriptions, users, workers } from "@/server/db/schema";
import { AiProviderError } from "@/server/integrations/openai/staffing-assessment";
import type { DiscoveryRequest, LocalDiscoveryProvider } from "@/server/integrations/openai/web-discovery";
import { loadStoredContext, resolveOutletContext } from "@/server/intelligence/demand-context";
import type { DiscoveredSignal } from "@/server/intelligence/local-intelligence-contract";
import { decideLocalAdjustments, recheckUnreachableSources, runLocalDiscovery } from "@/server/intelligence/local-intelligence-service";
import type { SourceCheck } from "@/server/intelligence/local-intelligence-sources";
import { getWeeklyStaffing } from "@/server/intelligence/staffing";
import { holidayFeedKey } from "@/server/reference/public-holiday-feed";
import { LocalIntelligencePanel } from "@/app/manager/local-intelligence";
import { DisruptionAlerts } from "@/app/owner/disruption-alerts";
import { affectedShifts, sendEarlyNotice } from "@/server/intelligence/early-notice";
import { activateWorker } from "../helpers/workers";
import { allocateAssignment, createDepartment, createRequirement, createTeamMember, createWorkPolicy, offerAssignment, respondToAssignment } from "@/server/scheduling/operations";
import { notifications, shiftOffers, shifts, workAllocations } from "@/server/db/schema";

vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); }, notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// Monday 14 Dec 2026, 08:00 in Johannesburg. The planning week is Tue 15 – Mon 21 Dec and the
// discovery window Mon 14 – Mon 21 Dec. Every model answer and web page here is a fixture.
const NOW = new Date("2026-12-14T06:00:00Z");
const FRIDAY = "2026-12-18";
beforeEach(() => { vi.useFakeTimers({ now: NOW, toFake: ["Date"] }); vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];
async function saBusiness(db: Db) {
  const organisationId = randomUUID(), outletId = randomUUID();
  await db.insert(organisations).values({ id: organisationId, name: "Fixture cafe group", country: "South Africa" });
  await db.insert(subscriptions).values({ id: randomUUID(), organisationId, requestId: randomUUID() });
  await entitled(db, organisationId);
  await db.insert(outlets).values({ id: outletId, organisationId, name: "Rosebank", timezone: "Africa/Johannesburg", city: "Johannesburg", province: "Gauteng", country: "South Africa", latitude: -26.1457, longitude: 28.0437,
    locationProfile: { area: "Rosebank, Johannesburg", venueType: "Fast-casual cafe near offices", typicalCustomers: "Office workers and shoppers" }, locationProfileSource: "DEMO_SEED" });
  const userId = randomUUID();
  await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: "Owner", passwordHash: "x", emailVerifiedAt: NOW });
  await db.insert(memberships).values({ id: randomUUID(), userId, organisationId, role: "OWNER" });
  // A worker whose details must never reach the model.
  await db.insert(workers).values({ id: randomUUID(), organisationId, locationId: outletId, displayName: "Zanele Fixtureworker", email: "zanele.fixture@example.test", attributionCode: "ZF01", workerType: "CASUAL", status: "ACTIVE" } as never);
  await ingestTimedBills(db, { organisationId, outletId, currencyCode: "ZAR", through: "2026-12-13", bills: () => 30, at: "11:10:00Z", now: NOW, billMinor: 9_000 });
  await configureFixture(db, { organisationId, outletId, policy: { transactionsPerStaffHour: 4, minimumStaffWhileOpen: 1 }, trading: [{ start: 8 * 60, end: 20 * 60 }], coverage: [hours(8, 20, 1)] });
  const scope: Scope = { userId, organisationId, locationId: outletId, role: "MANAGER", organisationName: "Fixture cafe group", locationName: "Rosebank" };
  return { organisationId, outletId, scope };
}

const found = (overrides: Partial<DiscoveredSignal> = {}): DiscoveredSignal => ({
  location: "Rosebank", category: "SPORT", otherLabel: null, effectType: "DEMAND", name: "Fixture match at the nearby stadium", dateFrom: FRIDAY, dateTo: FRIDAY, startTime: null, endTime: null,
  dateCertainty: "FIXED", shiftBlocks: ["MORNING", "AFTERNOON"], roles: ["FOH"], direction: "UP", sizeBand: "MODERATE", severity: null, closureLikely: false,
  confidence: "HIGH", sourceTier: "EVENT_ORGANISER", reasoning: "Supporters pass the cafe at lunchtime, matching its office-worker trade.", sourceUrl: "https://tickets.example.com/fixture-match", sourceTitle: "Fixture match", ...overrides,
});
function provider(signals: () => DiscoveredSignal[], consulted: string[] = []): LocalDiscoveryProvider & { discover: ReturnType<typeof vi.fn> } {
  return { provider: "OPENAI", model: "fixture-model", discover: vi.fn(async () => ({
    responseId: `resp_fixture_${randomUUID().slice(0, 8)}`, responseModel: "fixture-model", searches: [{ action: "search", queries: ["Rosebank events this week"], url: null }], citedUrls: [],
    consultedUrls: consulted.length ? consulted : signals().map(row => row.sourceUrl),
    text: JSON.stringify({ coverage: [{ category: "SPORT", label: "Sport", queries: ["Rosebank sport"], outcome: "FOUND" }, { category: "SERVICE_DISRUPTION", label: "Utilities", queries: ["Rosebank water outage"], outcome: "NOTHING_FOUND" }], signals: signals() }),
  })) } as never;
}
const pages = (missing: string[] = []) => vi.fn(async (url: string): Promise<SourceCheck> => missing.includes(url) ? { outcome: "NOT_FOUND", httpStatus: 404 } : { outcome: "REACHABLE", httpStatus: 200 });
const outletOf = async (db: Db, scope: Scope) => (await getWeeklyStaffing(db, scope, NOW)).outlets.find(row => row.outletId === scope.locationId)!;
const readDay = (db: Db, scope: Scope) => async (date: string) => { const outlet = await outletOf(db, scope); return { day: outlet.localIntelligence?.days.find(row => row.date === date) ?? null, scenarioAccepted: !!outlet.demandContext?.accepted.has(date) }; };

describe("local intelligence", () => {
  it("runs one discovery, checks every source and stores what it found with its coverage log", async () => {
    const { db, close } = await createTestDatabase();
    const { organisationId, outletId } = await saBusiness(db);
    const model = provider(() => [
      found(),
      found({ category: "OTHER", otherLabel: "Night market", name: "Fixture night market", sizeBand: "MINOR", shiftBlocks: ["EVENING"], sourceUrl: "https://market.example.com/", sourceTier: "NEWS" }),
      found({ name: "Fixture rumour of a concert", sourceTier: "UNCONFIRMED", sourceUrl: "https://social.example.com/post" }),
      found({ name: "Fixture event with a dead link", sourceUrl: "https://gone.example.com/page" }),
      found({ name: "Fixture event elsewhere", location: "Sandton" }),
      found({ name: "Fixture water outage", category: "SERVICE_DISRUPTION", effectType: "CAPACITY", direction: null, sizeBand: null, severity: "HIGH", closureLikely: true, sourceTier: "OFFICIAL", sourceUrl: "https://utility.example.gov/notice" }),
    ]);
    const checker = pages(["https://gone.example.com/page"]);
    const outcome = await runLocalDiscovery(db, { organisationId, outletId }, { kind: "DAILY", trigger: "MANUAL", provider: model, checkSource: checker, now: NOW });
    expect(outcome.status).toBe("COMPLETED");
    expect(outcome.run).toMatchObject({ status: "COMPLETED", kind: "DAILY", windowFrom: "2026-12-14", windowTo: "2026-12-21", responseModel: "fixture-model", counts: { found: 6, accepted: 3, unconfirmed: 1, rejected: 2 } });
    expect(outcome.run!.providerResponseId).toMatch(/^resp_fixture_/);
    // Every category asked is in the log, including those the model left out.
    const coverage = outcome.run!.coverage as { category: string; outcome: string }[];
    expect(coverage).toHaveLength(12);
    expect(coverage.find(row => row.category === "SPORT")?.outcome).toBe("FOUND");
    expect(coverage.find(row => row.category === "SERVICE_DISRUPTION")?.outcome).toBe("NOTHING_FOUND");
    expect(coverage.find(row => row.category === "SCHOOL_CALENDAR")?.outcome).toBe("NOT_REPORTED");
    const stored = await db.select().from(localIntelligenceSignals).where(eq(localIntelligenceSignals.runId, outcome.run!.id));
    const byName = (name: string) => stored.find(row => row.name === name)!;
    expect(byName("Fixture match at the nearby stadium")).toMatchObject({ status: "ACCEPTED", sourceCheck: "REACHABLE", consultedInSearch: "EXACT" });
    expect(byName("Fixture night market")).toMatchObject({ status: "ACCEPTED", category: "OTHER", otherLabel: "Night market" });
    expect(byName("Fixture rumour of a concert")).toMatchObject({ status: "UNCONFIRMED" });
    expect(byName("Fixture event with a dead link")).toMatchObject({ status: "REJECTED", rejectionCode: "SOURCE_UNREACHABLE" });
    expect(byName("Fixture event elsewhere")).toMatchObject({ status: "REJECTED", rejectionCode: "WRONG_LOCATION" });
    expect(byName("Fixture water outage")).toMatchObject({ status: "ACCEPTED", effectType: "CAPACITY", severity: "HIGH", closureLikely: true });
    // The wrong-location signal was never checked; every other source was.
    expect(checker).toHaveBeenCalledTimes(5);
    // The model saw the location's public facts and profile, and nothing about its people.
    const request = model.discover.mock.calls[0][0] as DiscoveryRequest;
    expect(request.input).toContain("Fast-casual cafe near offices");
    expect(request.input).not.toMatch(/Zanele|Fixtureworker|zanele\.fixture|ZF01|@example\.test/);
    expect(request.maxToolCalls).toBe(10);
    expect((await db.select().from(auditEvents).where(eq(auditEvents.entityId, outcome.run!.id)))[0]).toMatchObject({ action: "LOCAL_INTELLIGENCE_RUN_COMPLETED" });
    await close();
  });

  it("applies accepted demand signals to the forecast by block, and staffing only once a manager uses them", async () => {
    const { db, close } = await createTestDatabase();
    const { organisationId, outletId, scope } = await saBusiness(db);
    let signals = [found(), found({ name: "Fixture second event", sizeBand: "MINOR", confidence: "MEDIUM", sourceUrl: "https://second.example.com/" }), found({ name: "Fixture third event", direction: "DOWN", sizeBand: "MINOR", confidence: "LOW", sourceTier: "NEWS", sourceUrl: "https://third.example.com/" })];
    await runLocalDiscovery(db, { organisationId, outletId }, { kind: "DAILY", trigger: "MANUAL", provider: provider(() => signals), checkSource: pages(), now: NOW });
    let outlet = await outletOf(db, scope);
    const local = outlet.localIntelligence!.days.find(row => row.date === FRIDAY)!;
    const staffing = outlet.days.find(row => row.planningDate === FRIDAY)!;
    // Two signals shape each morning and afternoon block, the third is listed; evening is untouched.
    expect(local.adjusted.map(block => block.start)).toEqual([480, 540, 600, 660, 720, 780, 840, 900, 960]);
    expect(local.adjusted.every(block => block.bps === 1500 && block.applied.length === 2 && block.listed.length === 1)).toBe(true);
    expect(local.state).toBe("NOT_USED");
    expect(staffing.local).toBeUndefined();
    expect(local.preview!.expectedMilliTransactions!).toBeGreaterThan(staffing.expectedMilliTransactions!);
    expect(outlet.localIntelligence!.signals.map(row => row.use).sort()).toEqual(["APPLIED", "APPLIED", "LISTED"]);

    await expect(decideLocalAdjustments(db, scope, { date: FRIDAY, action: "ACCEPTED", fingerprint: "0".repeat(64) }, readDay(db, scope), NOW)).rejects.toMatchObject({ feedback: "local-changed" });
    await expect(decideLocalAdjustments(db, scope, { date: FRIDAY, action: "ACCEPTED", fingerprint: local.fingerprint }, async () => ({ day: local, scenarioAccepted: true }), NOW)).rejects.toMatchObject({ feedback: "local-scenario-accepted" });
    await decideLocalAdjustments(db, scope, { date: FRIDAY, action: "ACCEPTED", fingerprint: local.fingerprint }, readDay(db, scope), NOW);
    outlet = await outletOf(db, scope);
    const used = outlet.days.find(row => row.planningDate === FRIDAY)!;
    expect(outlet.localIntelligence!.days.find(row => row.date === FRIDAY)!.state).toBe("ACCEPTED");
    expect(used.local?.baseline.expectedMilliTransactions).toBe(staffing.expectedMilliTransactions);
    expect(used.expectedMilliTransactions).toBe(local.preview!.expectedMilliTransactions);
    expect(used.casualGapMinutes!).toBeGreaterThan(staffing.casualGapMinutes!);
    expect(outlet.baselineTotals?.casualGapMinutes).toBe(staffing.casualGapMinutes! + outlet.days.filter(row => row.planningDate !== FRIDAY).reduce((sum, row) => sum + row.casualGapMinutes!, 0));

    // A later run that changes what applies sends the day back to its baseline until it is reviewed.
    signals = [found()];
    await runLocalDiscovery(db, { organisationId, outletId }, { kind: "DAILY", trigger: "SCHEDULE", provider: provider(() => signals), checkSource: pages(), now: new Date(NOW.getTime() + 60_000) });
    outlet = await outletOf(db, scope);
    expect(outlet.localIntelligence!.days.find(row => row.date === FRIDAY)!.state).toBe("STALE");
    expect(outlet.days.find(row => row.planningDate === FRIDAY)!.local).toBeUndefined();
    await decideLocalAdjustments(db, scope, { date: FRIDAY, action: "WITHDRAWN" }, readDay(db, scope), NOW);
    expect((await outletOf(db, scope)).localIntelligence!.days.find(row => row.date === FRIDAY)!.state).toBe("NOT_USED");
    await close();
  });

  it("stops at the daily call cap and records a failed call without losing earlier findings", async () => {
    const { db, close } = await createTestDatabase();
    const { organisationId, outletId, scope } = await saBusiness(db);
    const model = provider(() => [found()]);
    expect((await runLocalDiscovery(db, { organisationId, outletId }, { kind: "DAILY", trigger: "SCHEDULE", provider: model, checkSource: pages(), now: NOW, cap: 2 })).status).toBe("COMPLETED");
    const failing: LocalDiscoveryProvider = { provider: "OPENAI", model: "fixture-model", discover: vi.fn(async () => { throw new AiProviderError("TIMEOUT"); }) };
    const failed = await runLocalDiscovery(db, { organisationId, outletId }, { kind: "DISRUPTIONS", trigger: "SCHEDULE", provider: failing, checkSource: pages(), now: NOW, cap: 2 });
    expect(failed).toMatchObject({ status: "FAILED", run: { status: "FAILED", failureCode: "TIMEOUT", providerResponseId: null } });
    expect((await runLocalDiscovery(db, { organisationId, outletId }, { kind: "DAILY", trigger: "SCHEDULE", provider: model, checkSource: pages(), now: NOW, cap: 2 })).status).toBe("CAPPED");
    expect(model.discover).toHaveBeenCalledTimes(1);
    vi.stubEnv("FAIRSHIFT_LOCAL_INTEL_DAILY_CAP", "0");
    expect((await runLocalDiscovery(db, { organisationId, outletId }, { kind: "DAILY", trigger: "SCHEDULE", provider: model, checkSource: pages(), now: new Date("2026-12-15T06:00:00Z") })).status).toBe("CAPPED");
    const outlet = await outletOf(db, scope);
    expect(outlet.localIntelligence!.signals.map(row => row.name)).toEqual(["Fixture match at the nearby stadium"]);
    expect(outlet.localIntelligence!.lastAttempt).toMatchObject({ status: "FAILED", failureCode: "TIMEOUT" });
    expect(await db.select().from(localIntelligenceRuns)).toHaveLength(2);
    await close();
  });

  it("checks an unreachable source once more later, and admits the finding only if its page answers", async () => {
    const { db, close } = await createTestDatabase();
    const { organisationId, outletId, scope } = await saBusiness(db);
    const model = provider(() => [found(), found({ name: "Fixture dead page", sourceUrl: "https://dead.example.com/" })]);
    const outcome = await runLocalDiscovery(db, { organisationId, outletId }, { kind: "DAILY", trigger: "SCHEDULE", provider: model, checkSource: async () => ({ outcome: "UNREACHABLE", httpStatus: null }), now: NOW });
    expect(outcome.run!.counts).toMatchObject({ accepted: 0, rejected: 2 });
    const later = vi.fn(async (url: string): Promise<SourceCheck> => url === "https://dead.example.com/" ? { outcome: "NOT_FOUND", httpStatus: 404 } : { outcome: "REACHABLE", httpStatus: 200 });
    expect(await recheckUnreachableSources(db, [organisationId], later, NOW)).toEqual({ checked: 2, admitted: 1 });
    const rows = await db.select().from(localIntelligenceSignals).where(eq(localIntelligenceSignals.runId, outcome.run!.id));
    expect(rows.filter(row => row.name === "Fixture match at the nearby stadium").map(row => row.status).sort()).toEqual(["ACCEPTED", "REJECTED"]);
    expect(rows.find(row => row.status === "ACCEPTED")!.serverNote).toContain("checked again");
    expect(rows.filter(row => row.name === "Fixture dead page").map(row => row.status)).toEqual(["REJECTED"]);
    // Each rejection is checked again once only, and no model is called.
    expect(await recheckUnreachableSources(db, [organisationId], later, NOW)).toEqual({ checked: 0, admitted: 0 });
    expect(later).toHaveBeenCalledTimes(2);
    expect(model.discover).toHaveBeenCalledTimes(1);
    const outlet = await outletOf(db, scope);
    expect(outlet.localIntelligence!.signals.map(row => row.name)).toEqual(["Fixture match at the nearby stadium"]);
    expect(outlet.localIntelligence!.runs[0].rejected.map(row => row.name)).toEqual(["Fixture dead page"]);
    expect((await db.select().from(localIntelligenceRuns).where(eq(localIntelligenceRuns.id, outcome.run!.id)))[0].counts).toMatchObject({ accepted: 1, rejected: 1, rechecked: 1 });
    // A judged signal is evidence: it can't be edited afterwards.
    await expect(db.update(localIntelligenceSignals).set({ status: "ACCEPTED" }).where(eq(localIntelligenceSignals.name, "Fixture dead page"))).rejects.toThrow();
    await close();
  });

  it("puts South African public holidays into the context from the live feed, and labels the fallback", async () => {
    const { db, close } = await createTestDatabase();
    const { organisationId, outletId, scope } = await saBusiness(db);
    const holiday = async () => (await outletOf(db, scope)).demandContext!.days.find(row => row.date === "2026-12-16")!;
    // No feed fetched yet: the built-in rules supply it, labelled as the fallback.
    expect((await holiday()).signals.find(row => row.type === "BANK_HOLIDAY")).toMatchObject({ provenance: "HOLIDAY_FALLBACK", summary: expect.stringContaining("Day of Reconciliation") });
    await db.insert(externalFeeds).values({ feed: holidayFeedKey("ZA"), sourceUrl: "https://date.nager.at/api/v3/PublicHolidays/2026/ZA", lastAttemptAt: NOW, lastSuccessAt: NOW, payload: { countryCode: "ZA", years: { 2026: [{ date: "2026-12-16", localName: "Day of Reconciliation", name: "Day of Reconciliation" }, { date: "2026-12-17", localName: "Fixture feed-only holiday", name: "Fixture feed-only holiday" }] } } });
    const day = await holiday();
    expect(day.holidayStatus).toBe("HOLIDAY_ON_DATE");
    expect(day.signals.find(row => row.type === "BANK_HOLIDAY")).toMatchObject({ provenance: "HOLIDAY_FEED", sourceLabel: "Nager.Date public holidays API", sourceRef: "https://date.nager.at/api/v3/PublicHolidays/2026/ZA" });
    expect((await outletOf(db, scope)).demandContext!.days.find(row => row.date === "2026-12-17")!.signals.some(row => row.type === "BANK_HOLIDAY")).toBe(true);
    expect((await outletOf(db, scope)).demandContext!.days.find(row => row.date === "2026-12-15")!.holidayStatus).toBe("NO_HOLIDAY_ON_DATE");
    // The discovery input carries the feed's holidays as known facts.
    const model = provider(() => []);
    await runLocalDiscovery(db, { organisationId, outletId }, { kind: "DAILY", trigger: "MANUAL", provider: model, checkSource: pages(), now: NOW });
    expect(JSON.parse((model.discover.mock.calls[0][0] as DiscoveryRequest).input).knownHolidays).toEqual([{ date: "2026-12-16", name: "Day of Reconciliation", source: "Nager.Date public holidays API" }, { date: "2026-12-17", name: "Fixture feed-only holiday", source: "Nager.Date public holidays API" }]);
    await close();
  });

  it("leaves a UK location's holiday context exactly as it was", async () => {
    const { db, close } = await createTestDatabase();
    const { organisationId } = await saBusiness(db);
    const ukId = randomUUID();
    await db.insert(outlets).values({ id: ukId, organisationId, name: "Fixture London", timezone: "Europe/London", province: "England", country: "United Kingdom" });
    const days = Array.from({ length: 7 }, (_, i) => ({ planningDate: `2026-12-${String(22 + i).padStart(2, "0")}`, expectedMilliTransactions: 1000, lowerMilliTransactions: 800, upperMilliTransactions: 1200, support: "MODERATE" as const, closed: false, blocks: [] }));
    const resolve = async () => resolveOutletContext({ organisationId, outletId: ukId, stored: await loadStoredContext(db, organisationId, [ukId], days[0].planningDate, days[6].planningDate), days, evidence: { source: "IMPORTED", dataThrough: "2026-12-20" }, evidenceDays: [], now: NOW });
    const before = await resolve();
    await db.insert(externalFeeds).values({ feed: holidayFeedKey("ZA"), sourceUrl: "https://date.nager.at/api/v3/PublicHolidays/2026/ZA", lastAttemptAt: NOW, lastSuccessAt: NOW, payload: { countryCode: "ZA", years: { 2026: [{ date: "2026-12-25", localName: "Christmas Day", name: "Christmas Day" }] } } });
    const after = await resolve();
    expect(after.days.map(row => [row.date, row.holidayStatus, row.fingerprint, row.signals.map(signal => signal.provenance)])).toEqual(before.days.map(row => [row.date, row.holidayStatus, row.fingerprint, row.signals.map(signal => signal.provenance)]));
    expect(after.days.find(row => row.date === "2026-12-25")!.signals.find(row => row.type === "BANK_HOLIDAY")).toMatchObject({ provenance: "OFFICIAL_SNAPSHOT", sourceLabel: expect.stringContaining("GOV.UK") });
    await close();
  });

  it("turns a severe capacity signal into an Owner alert and an access signal into a staff-attendance risk, never a demand change", async () => {
    const { db, close } = await createTestDatabase();
    const { organisationId, outletId, scope } = await saBusiness(db);
    const outage = found({ name: "Fixture water outage", category: "SERVICE_DISRUPTION", effectType: "CAPACITY", direction: null, sizeBand: null, severity: "HIGH", closureLikely: true, sourceTier: "OFFICIAL", shiftBlocks: [], sourceUrl: "https://utility.example.gov/outage" });
    const closure = found({ name: "Fixture race route closure", category: "ACCESS_DISRUPTION", effectType: "ACCESS", direction: null, sizeBand: null, severity: "MEDIUM", shiftBlocks: ["AFTERNOON"], sourceTier: "OFFICIAL", sourceUrl: "https://city.example.gov/closures" });
    const rumour = found({ name: "Fixture taxi strike rumour", category: "ACCESS_DISRUPTION", effectType: "ACCESS", direction: null, sizeBand: null, severity: "HIGH", shiftBlocks: [], sourceTier: "UNCONFIRMED", sourceUrl: "https://social.example.com/strike" });
    const minor = found({ name: "Fixture short power maintenance", category: "SERVICE_DISRUPTION", effectType: "CAPACITY", direction: null, sizeBand: null, severity: "LOW", sourceTier: "OFFICIAL", sourceUrl: "https://power.example.gov/notice" });
    await runLocalDiscovery(db, { organisationId, outletId }, { kind: "DAILY", trigger: "MANUAL", provider: provider(() => [outage, closure, rumour, minor]), checkSource: pages(), now: NOW });
    const outlet = await outletOf(db, scope);
    const local = outlet.localIntelligence!;
    expect(local.alerts.map(row => row.name)).toEqual(["Fixture water outage"]);
    expect(Object.fromEntries(local.signals.map(row => [row.name, row.use]))).toEqual({ "Fixture water outage": "ALERT", "Fixture race route closure": "ATTENDANCE_RISK", "Fixture taxi strike rumour": "UNCONFIRMED", "Fixture short power maintenance": "NOTED" });
    const day = local.days.find(row => row.date === FRIDAY)!;
    expect(day.risks.filter(row => row.access.length).map(row => row.start)).toEqual([720, 780, 840, 900, 960]);
    // The outage covers the whole day; the minor maintenance only the morning and afternoon (it is noted, never an alert).
    expect(day.risks.map(row => row.capacity.length)).toEqual([2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1]);
    // None of them moves demand or staffing.
    expect(day.adjusted).toEqual([]);
    expect(outlet.days.find(row => row.planningDate === FRIDAY)!.local).toBeUndefined();
    const alerts = renderToStaticMarkup(DisruptionAlerts({ alerts: local.alerts.map(signal => ({ outletId, outletName: "Rosebank", timezone: "Africa/Johannesburg", signal })) }));
    expect(alerts).toContain("Disruption alerts");
    expect(alerts).toContain("Closure likely");
    expect(alerts).toContain("href=\"https://utility.example.gov/outage\"");
    const panel = renderToStaticMarkup(LocalIntelligencePanel({ outlet, selectedDate: FRIDAY, demo: false }));
    expect(panel).toContain("Attendance risk: Fixture race route closure");
    expect(panel).toContain("likely to stop this location trading");
    expect(panel).toContain("Staff attendance risk");
    expect(renderToStaticMarkup(DisruptionAlerts({ alerts: [] }))).toBe("");
    await close();
  });

  it("recommends an early notice for a likely closure, and sends it only when the Owner confirms, cancelling nothing", async () => {
    const { db, close } = await createTestDatabase();
    const { organisationId, outletId, scope } = await saBusiness(db);
    const site = { organisationId, locationId: outletId };
    const [department] = await createDepartment(db, "Floor", site);
    const [policy] = await createWorkPolicy(db, { earningsModel: "HOURLY", rateMinor: 4_500 }, "Fixture casual terms", site);
    const allocated = async (email: string, startsAt: string, endsAt: string, allocate = true) => {
      const worker = await activateWorker(db, (await createTeamMember(db, { firstName: "Fixture", surname: email.split("@")[0], telephone: "+27110000000", email }, site)).worker.id);
      const shift = await createRequirement(db, { departmentId: department.id, policyId: policy.id, startsAt: new Date(startsAt), endsAt: new Date(endsAt), requiredHeadcount: 1 }, site);
      const offer = await offerAssignment(db, shift.id, worker.id, site);
      if (allocate) { await respondToAssignment(db, worker.id, offer.id, 1, "ACCEPTED", true, site); await allocateAssignment(db, offer.id, site); }
      return { worker, shift, offer };
    };
    const friday = await allocated("friday@example.test", "2026-12-18T08:00:00Z", "2026-12-18T12:00:00Z");
    await allocated("saturday@example.test", "2026-12-19T08:00:00Z", "2026-12-19T12:00:00Z");
    await allocated("offered@example.test", "2026-12-18T10:00:00Z", "2026-12-18T14:00:00Z", false);
    const outage = found({ name: "Fixture water outage", category: "SERVICE_DISRUPTION", effectType: "CAPACITY", direction: null, sizeBand: null, severity: "HIGH", closureLikely: true, sourceTier: "OFFICIAL", shiftBlocks: [], sourceUrl: "https://utility.example.gov/outage" });
    await runLocalDiscovery(db, { organisationId, outletId }, { kind: "DAILY", trigger: "MANUAL", provider: provider(() => [outage]), checkSource: pages(), now: NOW });
    const outlet = await outletOf(db, scope);
    const signal = outlet.localIntelligence!.alerts[0];
    const target = { organisationId, outletId, timezone: "Africa/Johannesburg" };
    // Only the allocated Friday shift is covered: not Saturday's, and not an offer still unanswered.
    expect((await affectedShifts(db, target, signal, NOW)).map(row => row.offerId)).toEqual([friday.offer.id]);
    const before = renderToStaticMarkup(DisruptionAlerts({ alerts: [{ outletId, outletName: "Rosebank", timezone: "Africa/Johannesburg", signal, affected: await affectedShifts(db, target, signal, NOW) }], canSend: true }));
    expect(before).toContain("Send early notice to 1 casual worker");
    expect(before).toContain("cancels nothing and changes no pay");
    expect(renderToStaticMarkup(DisruptionAlerts({ alerts: [{ outletId, outletName: "Rosebank", timezone: "Africa/Johannesburg", signal, affected: await affectedShifts(db, target, signal, NOW) }], canSend: false }))).toContain("turned off in the public demo");

    const readAlert = async () => ({ signal, outletId, outletName: "Rosebank", timezone: "Africa/Johannesburg" });
    await expect(sendEarlyNotice(db, { ...scope, role: "MANAGER" }, { outletId, signalKey: signal.key }, readAlert, NOW)).rejects.toThrow();
    expect(await sendEarlyNotice(db, { ...scope, role: "OWNER" }, { outletId, signalKey: signal.key }, readAlert, NOW)).toEqual({ sent: 1, workerIds: [friday.worker.id] });
    const [notice] = await db.select().from(notifications).where(eq(notifications.kind, "EARLY_SHIFT_NOTICE"));
    expect(notice).toMatchObject({ workerId: friday.worker.id, userId: friday.worker.userId, recipientEmail: "friday@example.test", entityId: friday.offer.id });
    expect(notice.body).toContain("doesn’t cancel your shift");
    expect(notice.body).toContain("https://utility.example.gov/outage");
    // Nothing was cancelled or changed.
    expect((await db.select().from(shifts).where(eq(shifts.id, friday.shift.id)))[0].status).toBe("PUBLISHED");
    expect((await db.select().from(shiftOffers).where(eq(shiftOffers.id, friday.offer.id)))[0].status).toBe("ACCEPTED");
    expect((await db.select().from(workAllocations).where(eq(workAllocations.offerId, friday.offer.id)))[0].state).toBe("ALLOCATED");
    // Each worker hears once per shift and finding.
    await expect(sendEarlyNotice(db, { ...scope, role: "OWNER" }, { outletId, signalKey: signal.key }, readAlert, NOW)).rejects.toMatchObject({ feedback: "early-notice-none" });
    expect(await db.select().from(notifications).where(eq(notifications.kind, "EARLY_SHIFT_NOTICE"))).toHaveLength(1);
    expect(renderToStaticMarkup(DisruptionAlerts({ alerts: [{ outletId, outletName: "Rosebank", timezone: "Africa/Johannesburg", signal, affected: await affectedShifts(db, target, signal, NOW) }], canSend: true }))).toContain("Everyone this affects has had the early notice");
    // A finding that no longer stands sends nothing.
    await expect(sendEarlyNotice(db, { ...scope, role: "OWNER" }, { outletId, signalKey: signal.key }, async () => null, NOW)).rejects.toMatchObject({ feedback: "early-notice-unavailable" });
    expect((await db.select().from(auditEvents).where(eq(auditEvents.action, "EARLY_SHIFT_NOTICE_SENT")))).toHaveLength(1);
    await close();
  });

  it("labels every finding with its source, reasoning and use", async () => {
    const { db, close } = await createTestDatabase();
    const { organisationId, outletId, scope } = await saBusiness(db);
    await runLocalDiscovery(db, { organisationId, outletId }, { kind: "DAILY", trigger: "MANUAL", provider: provider(() => [found(), found({ name: "Fixture rumour", sourceTier: "UNCONFIRMED", sourceUrl: "https://social.example.com/x" })]), checkSource: pages(), now: NOW });
    const html = renderToStaticMarkup(LocalIntelligencePanel({ outlet: await outletOf(db, scope), selectedDate: FRIDAY, demo: false }));
    expect(html).toContain("AI-found");
    expect(html).toContain("href=\"https://tickets.example.com/fixture-match\"");
    expect(html).toContain("Supporters pass the cafe at lunchtime, matching its office-worker trade.");
    expect(html).toContain("Applied to the forecast");
    expect(html).toContain("Unconfirmed: shown, never applied");
    expect(html).toContain("OpenAI fixture-model with web search");
    expect(html).toContain("Coverage log");
    expect(html).toContain("Use these adjustments for staffing");
    expect(renderToStaticMarkup(LocalIntelligencePanel({ outlet: await outletOf(db, scope), selectedDate: FRIDAY, demo: true }))).not.toContain("Use these adjustments for staffing");
    await close();
  });
});
