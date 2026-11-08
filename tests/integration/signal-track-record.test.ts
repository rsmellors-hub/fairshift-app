import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { entitled } from "../helpers/onboarding";
import { configureFixture, hours, ingestTimedBills } from "../helpers/workload";
import type { Scope } from "@/server/auth/access";
import { ingestCommerceObservations } from "@/server/commerce/ingestion";
import { demandContextSignals, localIntelligenceOutcomes, memberships, organisations, outlets, subscriptions, users } from "@/server/db/schema";
import type { LocalDiscoveryProvider } from "@/server/integrations/openai/web-discovery";
import { addStructuredSignal } from "@/server/intelligence/demand-context-service";
import { shiftDate } from "@/server/intelligence/forecast";
import type { DiscoveredSignal } from "@/server/intelligence/local-intelligence-contract";
import { runLocalDiscovery } from "@/server/intelligence/local-intelligence-service";
import { getWeeklyStaffing } from "@/server/intelligence/staffing";
import { directionOf, recordTrackRecord } from "@/server/intelligence/track-record";
import { TrackRecord } from "@/app/components/track-record";
import { DemandContextPanel } from "@/app/manager/demand-context";
import { OwnerTips } from "@/app/owner/tips";
import type { OwnerTipView } from "@/server/tips/view";

vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); }, notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// Discovery runs on Mon 14 Dec 2026; Wednesday 16 Dec is measured on Thursday 17 Dec. Every sale here
// is a synthetic fixture and every model answer a fixture.
const RUN_AT = new Date("2026-12-14T06:00:00Z"), MEASURE_AT = new Date("2026-12-17T06:00:00Z"), WEDNESDAY = "2026-12-16";
beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];

async function location(db: Db, organisationId: string, name: string) {
  const outletId = randomUUID();
  await db.insert(outlets).values({ id: outletId, organisationId, name, timezone: "Africa/Johannesburg", city: "Johannesburg", province: "Gauteng", country: "South Africa" });
  await configureFixture(db, { organisationId, outletId, policy: null, trading: [{ start: 480, end: 1200 }], coverage: [hours(8, 20, 1)] });
  return outletId;
}
// Synthetic reference bills at 13:10 local: a steady count each day, and an optional different day.
function referenceBills(db: Db, organisationId: string, outletId: string, through: string, perDay: (date: string) => number) {
  return ingestCommerceObservations(db, { organisationId, source: "REFERENCE", sourceSystem: "fixture-reference", now: MEASURE_AT, observations: Array.from({ length: 56 }, (_, i) => shiftDate(through, -i)).flatMap(date =>
    Array.from({ length: perDay(date) }, (_, n) => ({ outletId, sourceTransactionId: `${date}:${n}`, occurredAt: `${date}T11:10:00Z`, currencyCode: "ZAR", grossAmountMinor: 9_000, status: "COMPLETED" }))) });
}
const signal = (overrides: Partial<DiscoveredSignal>): DiscoveredSignal => ({
  location: "Fixture", category: "FESTIVAL_CONCERT_CULTURAL", otherLabel: null, effectType: "DEMAND", name: "Fixture fair", dateFrom: WEDNESDAY, dateTo: WEDNESDAY, startTime: null, endTime: null,
  dateCertainty: "FIXED", shiftBlocks: ["AFTERNOON"], roles: ["FOH"], direction: "UP", sizeBand: "MINOR", severity: null, closureLikely: false, confidence: "MEDIUM", sourceTier: "NEWS",
  reasoning: "A fixture fair nearby brings afternoon walk-ins to the cafe.", sourceUrl: "https://news.example.com/fair", sourceTitle: "Fair", ...overrides,
});
const provider = (signals: DiscoveredSignal[]): LocalDiscoveryProvider => ({ provider: "OPENAI", model: "fixture-model", discover: vi.fn(async () => ({ responseId: "resp_fixture", responseModel: "fixture-model", text: JSON.stringify({ coverage: [], signals }), searches: [], consultedUrls: signals.map(row => row.sourceUrl), citedUrls: [] })) });
const pages = async () => ({ outcome: "REACHABLE" as const, httpStatus: 200 });

describe("AI signal track record", () => {
  it("compares each applied direction with the day's synthetic sales in the hours it covered, once", async () => {
    const { db, close } = await createTestDatabase();
    const organisationId = randomUUID();
    await db.insert(organisations).values({ id: organisationId, name: "Fixture group", country: "South Africa" });
    const outletId = await location(db, organisationId, "Fixture");
    await referenceBills(db, organisationId, outletId, WEDNESDAY, date => date === WEDNESDAY ? 30 : 20);
    await runLocalDiscovery(db, { organisationId, outletId }, { kind: "DAILY", trigger: "MANUAL", provider: provider([
      signal({}),
      signal({ name: "Fixture storm warning", category: "EXTREME_WEATHER", direction: "DOWN", sourceUrl: "https://weather.example.com/storm" }),
      signal({ name: "Fixture breakfast promotion", category: "COMMEMORATIVE_COMMERCIAL", shiftBlocks: ["MORNING"], sourceUrl: "https://promo.example.com/" }),
      signal({ name: "Fixture Friday market", dateFrom: "2026-12-18", dateTo: "2026-12-18", sourceUrl: "https://market.example.com/" }),
    ]), checkSource: pages, now: RUN_AT });
    expect(await recordTrackRecord(db, { organisationId, outletId }, MEASURE_AT)).toEqual({ recorded: 3, waiting: 0 });
    const rows = await db.select().from(localIntelligenceOutcomes).where(eq(localIntelligenceOutcomes.outletId, outletId));
    const byKey = Object.fromEntries(await Promise.all(rows.map(async row => [row.predictedDirection + (row.baselineMilliTransactions ? "" : "-morning"), row])));
    expect(byKey.UP).toMatchObject({ targetDate: WEDNESDAY, baselineMilliTransactions: 20_000, actualMilliTransactions: 30_000, actualDirection: "UP", matched: true, measuredAgainst: "SYNTHETIC_REFERENCE" });
    expect(byKey.DOWN).toMatchObject({ actualDirection: "UP", matched: false });
    expect(byKey["UP-morning"]).toMatchObject({ baselineMilliTransactions: 0, actualMilliTransactions: 0, actualDirection: "FLAT", matched: false });
    // Measured once; the Friday signal waits for its day.
    expect(await recordTrackRecord(db, { organisationId, outletId }, MEASURE_AT)).toEqual({ recorded: 0, waiting: 0 });
    // Outcomes are evidence and can't be edited.
    await expect(db.update(localIntelligenceOutcomes).set({ matched: true }).where(eq(localIntelligenceOutcomes.outletId, outletId))).rejects.toThrow();
    // A day without recorded sales yet waits; nothing is guessed.
    const quiet = await location(db, organisationId, "Fixture quiet");
    await referenceBills(db, organisationId, quiet, "2026-12-15", () => 20);
    await runLocalDiscovery(db, { organisationId, outletId: quiet }, { kind: "DAILY", trigger: "MANUAL", provider: provider([signal({ location: "Fixture quiet" })]), checkSource: pages, now: RUN_AT });
    expect(await recordTrackRecord(db, { organisationId, outletId: quiet }, MEASURE_AT)).toEqual({ recorded: 0, waiting: 1 });
    const outlet = (await getWeeklyStaffing(db, { userId: randomUUID(), organisationId, locationId: outletId, role: "OWNER", organisationName: "Fixture group", locationName: "Fixture" }, MEASURE_AT)).outlets.find(row => row.outletId === outletId)!;
    expect(outlet.localIntelligence!.trackRecord).toHaveLength(3);
    const html = renderToStaticMarkup(TrackRecord({ rows: outlet.localIntelligence!.trackRecord }));
    expect(html).toContain("Measured against synthetic history");
    expect(html).toContain("1 of 3 applied directions matched");
    expect(html).toContain("not the AI’s accuracy");
    expect([directionOf(1000, 1010), directionOf(1000, 1030), directionOf(1000, 950), directionOf(0, 0)]).toEqual(["FLAT", "UP", "DOWN", "FLAT"]);
    await close();
  });
});

describe("events an Owner enters", () => {
  it("need the link where the event is published, are labelled Owner-entered and never claim to be verified", async () => {
    vi.useFakeTimers({ now: RUN_AT, toFake: ["Date"] });
    const { db, close } = await createTestDatabase();
    const organisationId = randomUUID(), userId = randomUUID();
    await db.insert(organisations).values({ id: organisationId, name: "Fixture group", country: "South Africa" });
    await db.insert(subscriptions).values({ id: randomUUID(), organisationId, requestId: randomUUID() });
    await entitled(db, organisationId);
    await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: "Owner", passwordHash: "x", emailVerifiedAt: RUN_AT });
    await db.insert(memberships).values({ id: randomUUID(), userId, organisationId, role: "OWNER" });
    const outletId = await location(db, organisationId, "Fixture");
    await ingestTimedBills(db, { organisationId, outletId, currencyCode: "ZAR", through: "2026-12-13", bills: () => 20, at: "11:10:00Z", now: RUN_AT });
    await configureFixture(db, { organisationId, outletId, policy: { transactionsPerStaffHour: 4, minimumStaffWhileOpen: 1 }, trading: null, coverage: null });
    const owner: Scope = { userId, organisationId, locationId: outletId, role: "OWNER", organisationName: "Fixture group", locationName: "Fixture" };
    const event = { date: WEDNESDAY, name: "Fixture street festival", start: "10:00", end: "16:00", distanceBand: "UNDER_1KM", attendanceBand: "" };
    await expect(addStructuredSignal(db, owner, "LOCAL_EVENT", { ...event, sourceUrl: "" }, RUN_AT)).rejects.toMatchObject({ feedback: "context-event-source-required" });
    await expect(addStructuredSignal(db, owner, "LOCAL_EVENT", { ...event, sourceUrl: "http://festival.example.com/" }, RUN_AT)).rejects.toMatchObject({ feedback: "context-signal-fields" });
    const row = await addStructuredSignal(db, owner, "LOCAL_EVENT", { ...event, sourceUrl: "https://festival.example.com/2026" }, RUN_AT);
    expect(row).toMatchObject({ provenance: "MANAGER_ENTERED", sourceRef: "https://festival.example.com/2026", sourceLabel: "Owner entered, not independently verified", metadata: expect.objectContaining({ enteredByRole: "OWNER" }) });
    // A Manager's event keeps working without a link.
    expect(await addStructuredSignal(db, { ...owner, role: "MANAGER" }, "LOCAL_EVENT", { ...event, name: "Fixture school fete", sourceUrl: "" }, RUN_AT)).toMatchObject({ sourceRef: null, sourceLabel: "Manager entered, not independently verified" });
    expect(await db.select().from(demandContextSignals)).toHaveLength(2);
    const outlet = (await getWeeklyStaffing(db, owner, RUN_AT)).outlets.find(row => row.outletId === outletId)!;
    const html = renderToStaticMarkup(DemandContextPanel({ outlet, selectedDate: WEDNESDAY, aiConfigured: false, ownerView: true }));
    expect(html).toContain("Owner-entered");
    expect(html).toContain("href=\"https://festival.example.com/2026\"");
    expect(html).toContain("Not independently verified.");
    expect(html).not.toMatch(/\bverified event\b/i);
    // An Owner can't send the event form without its source link.
    expect(html).toMatch(/<input(?=[^>]*name="sourceUrl")(?=[^>]*required="")[^>]*>/);
    await close();
  });
});

describe("demo labels", () => {
  it("label the tips evidence and staff of the demonstration as synthetic and fictional", () => {
    const view = { settings: null, blocks: [], staff: [], imports: [], allocations: [] } as unknown as OwnerTipView;
    const demo = renderToStaticMarkup(OwnerTips({ view, locationName: "Sandton", devLinks: false, demoData: true }));
    expect(demo).toContain("Synthetic demo POS export");
    expect(demo).toContain("Fictional demo staff");
    const real = renderToStaticMarkup(OwnerTips({ view, locationName: "Sandton", devLinks: false }));
    expect(real).not.toContain("Synthetic demo POS export");
    expect(real).not.toContain("Fictional demo staff");
  });
});
