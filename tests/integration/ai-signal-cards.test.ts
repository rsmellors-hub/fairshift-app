import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { entitled } from "../helpers/onboarding";
import { configureFixture, hours, ingestTimedBills } from "../helpers/workload";
import type { Scope } from "@/server/auth/access";
import { auditEvents, localIntelligenceDecisions, localIntelligenceSignalDecisions, memberships, organisations, outlets, subscriptions, users, workers } from "@/server/db/schema";
import type { LocalDiscoveryProvider } from "@/server/integrations/openai/web-discovery";
import type { DiscoveredSignal } from "@/server/intelligence/local-intelligence-contract";
import { decideLocalAdjustments, decideSignal, runLocalDiscovery } from "@/server/intelligence/local-intelligence-service";
import type { SourceCheck } from "@/server/intelligence/local-intelligence-sources";
import { getWeeklyStaffing } from "@/server/intelligence/staffing";
import { AiThisWeek, PlanSignalCards } from "@/app/components/ai-signals";

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


// Day 6, Step 1: AI findings are visible as cards with their source, effect and state; an Owner or Manager
// accepts or dismisses them, and every choice is recorded with who and when.
describe("AI signal cards", () => {
  it("show a kept finding with its source and hours, then who accepted it, and a dismissal takes it out of the forecast", async () => {
    const { db, close } = await createTestDatabase();
    const { organisationId, outletId, scope } = await saBusiness(db);
    await runLocalDiscovery(db, { organisationId, outletId }, { kind: "DAILY", trigger: "MANUAL", provider: provider(() => [found(), found({ name: "Fixture rumour", sourceTier: "UNCONFIRMED", sourceUrl: "https://social.example.com/x" })]), checkSource: pages(), now: NOW });
    let outlet = await outletOf(db, scope);
    const signal = outlet.localIntelligence!.signals.find(row => row.name === "Fixture match at the nearby stadium")!;
    expect(signal.use).toBe("APPLIED");
    let owner = renderToStaticMarkup(AiThisWeek({ outlets: [outlet] }));
    for (const text of ["Local signals this week", "Rosebank: Fixture match at the nearby stadium", "https://tickets.example.com/fixture-match", "More customers, +10%", "Proposed: not used until accepted", "Fri, 18 Dec 2026", "1 unconfirmed"]) expect(owner).toContain(text);
    const plan = renderToStaticMarkup(PlanSignalCards({ outlet, act: true }));
    expect(plan).toContain("Would change Fri, 18 Dec 2026 08:00");
    expect(plan).toContain(">Accept</button>");
    expect(plan).toContain(">Dismiss</button>");

    // Accept: the day it changes uses the adjustments, and the card says who and when.
    const day = outlet.localIntelligence!.days.find(row => row.date === FRIDAY)!;
    await decideLocalAdjustments(db, scope, { date: FRIDAY, action: "ACCEPTED", fingerprint: day.fingerprint }, readDay(db, scope), NOW);
    outlet = await outletOf(db, scope);
    owner = renderToStaticMarkup(AiThisWeek({ outlets: [outlet] }));
    expect(owner).toMatch(/Accepted by Owner 14 Dec 2026, 08:00/);
    expect(outlet.days.find(row => row.planningDate === FRIDAY)!.local).toBeTruthy();

    // Dismiss: it moves nothing, the accepted day no longer matches, and the choice is recorded.
    await decideSignal(db, scope, { signalKey: signal.key, action: "DISMISSED" }, async key => (await outletOf(db, scope)).localIntelligence!.signals.find(row => row.key === key) ?? null, NOW);
    outlet = await outletOf(db, scope);
    const dismissed = outlet.localIntelligence!.signals.find(row => row.key === signal.key)!;
    expect(dismissed.use).toBe("DISMISSED");
    expect(outlet.localIntelligence!.days.find(row => row.date === FRIDAY)!.adjusted).toEqual([]);
    expect(outlet.localIntelligence!.days.find(row => row.date === FRIDAY)!.state).toBe("STALE");
    expect(outlet.days.find(row => row.planningDate === FRIDAY)!.local).toBeUndefined();
    expect(renderToStaticMarkup(PlanSignalCards({ outlet, act: true }))).toContain("Dismissed by Owner 14 Dec 2026, 08:00");
    expect((await db.select().from(auditEvents).where(eq(auditEvents.action, "LOCAL_SIGNAL_DISMISSED")))[0].metadata).toMatchObject({ actorUserId: scope.userId, signalKey: signal.key });
    // Dismissing twice changes nothing; bringing it back makes it apply again.
    await decideSignal(db, scope, { signalKey: signal.key, action: "DISMISSED" }, async key => (await outletOf(db, scope)).localIntelligence!.signals.find(row => row.key === key) ?? null, NOW);
    expect(await db.select().from(localIntelligenceSignalDecisions)).toHaveLength(1);
    await decideSignal(db, scope, { signalKey: signal.key, action: "RESTORED" }, async key => (await outletOf(db, scope)).localIntelligence!.signals.find(row => row.key === key) ?? null, NOW);
    expect((await outletOf(db, scope)).localIntelligence!.signals.find(row => row.key === signal.key)!.use).toBe("APPLIED");
    // Decisions are records: never edited or deleted.
    await expect(db.update(localIntelligenceSignalDecisions).set({ action: "DISMISSED" })).rejects.toThrow();
    await expect(db.delete(localIntelligenceSignalDecisions)).rejects.toThrow();
    expect(await db.select().from(localIntelligenceDecisions)).toHaveLength(1);
    await close();
  });

  it("can't dismiss an unconfirmed finding, and a public demo visitor sees the action as simulated", async () => {
    const { db, close } = await createTestDatabase();
    const { organisationId, outletId, scope } = await saBusiness(db);
    await runLocalDiscovery(db, { organisationId, outletId }, { kind: "DAILY", trigger: "MANUAL", provider: provider(() => [found(), found({ name: "Fixture rumour", sourceTier: "UNCONFIRMED", sourceUrl: "https://social.example.com/x" })]), checkSource: pages(), now: NOW });
    const outlet = await outletOf(db, scope);
    const rumour = outlet.localIntelligence!.signals.find(row => row.use === "UNCONFIRMED")!;
    await expect(decideSignal(db, scope, { signalKey: rumour.key, action: "DISMISSED" }, async () => rumour, NOW)).rejects.toMatchObject({ feedback: "local-not-found" });
    await expect(decideSignal(db, { ...scope, role: "TEAM_MEMBER" as never }, { signalKey: rumour.key, action: "DISMISSED" }, async () => rumour, NOW)).rejects.toThrow();
    const visitor = renderToStaticMarkup(PlanSignalCards({ outlet, act: false, simulated: true }));
    expect(visitor).toContain("Simulated in the public demo");
    expect(visitor).not.toContain("<form");
    await close();
  });

  it("says plainly when AI searched and found nothing that changes the forecast, with the real search times", async () => {
    const { db, close } = await createTestDatabase();
    const { organisationId, outletId, scope } = await saBusiness(db);
    await runLocalDiscovery(db, { organisationId, outletId }, { kind: "DAILY", trigger: "MANUAL", provider: provider(() => []), checkSource: pages(), now: NOW });
    const html = renderToStaticMarkup(AiThisWeek({ outlets: [await outletOf(db, scope)] }));
    expect(html).toContain("AI checked 1 location at 08:00");
    expect(html).toContain("nothing changes your forecast");
    // Before any search, it says so instead of showing an empty box.
    const { db: empty, close: closeEmpty } = await createTestDatabase();
    const fresh = await saBusiness(empty);
    expect(renderToStaticMarkup(AiThisWeek({ outlets: [await outletOf(empty, fresh.scope)] }))).toContain("AI hasn’t searched around any location yet");
    await closeEmpty();
    await close();
  });
});
