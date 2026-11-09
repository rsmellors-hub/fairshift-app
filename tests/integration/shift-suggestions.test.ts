import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/server/intelligence/sales-history", async importOriginal => ({ ...await importOriginal<typeof import("@/server/intelligence/sales-history")>(), syntheticHistoryAllowed: () => true }));
import { createTestDatabase } from "../helpers/database";
import { entitled } from "../helpers/onboarding";
import { configureFixture, hours, ingestTimedBills } from "../helpers/workload";
import { createActivatedTeamMember } from "../helpers/workers";
import type { Scope } from "@/server/auth/access";
import { auditEvents, memberships, offerRounds, organisations, outlets, shiftOffers, subscriptions, users, workers } from "@/server/db/schema";
import { getWeeklyStaffing } from "@/server/intelligence/staffing";
import { createDepartment, createWorkPolicy, respondToAssignment } from "@/server/scheduling/operations";
import { cutWindow, suggestShifts } from "@/server/scheduling/shift-rules";
import { advanceOfferRounds, approveSuggestedShift, startOfferRounds } from "@/server/scheduling/shift-suggestions";
import { ensureDemoRules } from "@/server/demo/settings-seed";
import { createShiftFromOpportunity } from "@/server/intelligence/opportunity-shifts";
import { prepareAssessmentInput, validateAssessment, AI_OUTPUT_SCHEMA_VERSION } from "@/server/intelligence/ai-staffing-contract";

// Monday 14 Dec 2026, 08:00 Johannesburg; the planning week is Tue 15 – Mon 21 Dec. All fixtures.
const NOW = new Date("2026-12-14T06:00:00Z");
beforeEach(() => { vi.useFakeTimers({ now: NOW, toFake: ["Date"] }); vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];

const RULES = { minMinutes: 240, maxMinutes: 480, preferredMinutes: 360 };
describe("cutting a casual gap into shifts with the location's rules", () => {
  const trading = { open: 8 * 60, close: 22 * 60 + 30 };
  it("cuts near the preferred length, never under the minimum or over the maximum", () => {
    expect(cutWindow({ start: 480, end: 1350 }, RULES, trading)).toEqual([{ start: 480, end: 915 }, { start: 915, end: 1350 }]);
    expect(cutWindow({ start: 600, end: 1200 }, RULES, trading)).toEqual([{ start: 600, end: 900 }, { start: 900, end: 1200 }]);
    expect(cutWindow({ start: 600, end: 960 }, RULES, trading)).toEqual([{ start: 600, end: 960 }]);
    for (const length of [240, 300, 420, 481, 600, 720, 870, 1000]) for (const block of cutWindow({ start: 480, end: 480 + length }, RULES, { open: 0, close: 1440 })) {
      expect(block.end - block.start).toBeGreaterThanOrEqual(240); expect(block.end - block.start).toBeLessThanOrEqual(480);
    }
  });
  it("makes a short gap one minimum-length shift, kept inside trading hours", () => {
    expect(cutWindow({ start: 660, end: 720 }, RULES, trading)).toEqual([{ start: 660, end: 900 }]);
    expect(cutWindow({ start: 1290, end: 1350 }, RULES, trading)).toEqual([{ start: 1110, end: 1350 }]);
  });
});

async function business(db: Db) {
  const organisationId = randomUUID(), outletId = randomUUID(), userId = randomUUID();
  await db.insert(organisations).values({ id: organisationId, name: "Fixture cafe group", country: "South Africa" });
  await db.insert(subscriptions).values({ id: randomUUID(), organisationId, requestId: randomUUID() });
  await entitled(db, organisationId);
  await db.insert(outlets).values({ id: outletId, organisationId, name: "Rosebank", timezone: "Africa/Johannesburg", city: "Johannesburg", country: "South Africa" });
  await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: "Fixture Manager", passwordHash: "x", emailVerifiedAt: NOW });
  await db.insert(memberships).values({ id: randomUUID(), userId, organisationId, role: "OWNER" });
  await ingestTimedBills(db, { organisationId, outletId, currencyCode: "ZAR", through: "2026-12-13", bills: () => 30, at: "09:10:00Z", now: NOW, billMinor: 9_000 });
  await configureFixture(db, { organisationId, outletId, policy: { transactionsPerStaffHour: 4, minimumStaffWhileOpen: 1 }, trading: [{ start: 8 * 60, end: 20 * 60 }], coverage: [hours(8, 20, 1)] });
  const scope: Scope = { userId, organisationId, locationId: outletId, role: "MANAGER", organisationName: "Fixture cafe group", locationName: "Rosebank" };
  const site = { organisationId, locationId: outletId };
  const [department] = await createDepartment(db, "Floor", site);
  const [policy] = await createWorkPolicy(db, { earningsModel: "HOURLY", rateMinor: 4_500 }, "Casual floor terms", site);
  const person = async (name: string, wantsMoreHours: boolean) => {
    const { worker } = await createActivatedTeamMember(db, { firstName: name, surname: "Fixture", telephone: "+27110000000", email: `${name.toLowerCase()}.${randomUUID().slice(0, 6)}@example.test` }, site);
    await db.update(workers).set({ wantsMoreHours }).where(eq(workers.id, worker.id));
    return worker.id;
  };
  const outlet = async (at = NOW) => (await getWeeklyStaffing(db, scope, at)).outlets.find(row => row.outletId === outletId)!;
  return { organisationId, outletId, scope, site, department, policy, person, outlet };
}

describe("suggested shifts and the fair offer order", () => {
  it("suggests shifts only with rules, and one click creates one shift and sends round 1 to workers who want more hours", async () => {
    const { db, close } = await createTestDatabase();
    const b = await business(db);
    expect(suggestShifts(await b.outlet())).toEqual([]);
    await ensureDemoRules(db, b.organisationId);
    await ensureDemoRules(db, b.organisationId);
    const suggestions = suggestShifts(await b.outlet());
    expect(suggestions.length).toBeGreaterThan(0);
    const first = suggestions[0];
    expect(first.minutes).toBeGreaterThanOrEqual(240);
    const keen1 = await b.person("Keen", true), keen2 = await b.person("Also", true), other = await b.person("Other", false);

    const result = await approveSuggestedShift(db, b.scope, { key: first.key, departmentId: b.department.id, policyId: b.policy.id }, () => b.outlet(), NOW);
    expect(result).toMatchObject({ round: 1, offered: 2 });
    const offered = await db.select().from(shiftOffers).where(eq(shiftOffers.shiftId, result.shift.id));
    expect(offered.map(row => row.workerId).sort()).toEqual([keen1, keen2].sort());
    expect(offered.map(row => row.workerId)).not.toContain(other);
    const [round] = await db.select().from(offerRounds).where(eq(offerRounds.shiftId, result.shift.id));
    expect(round).toMatchObject({ round: 1 });
    expect(round.criteria).toContain("want more hours");
    expect(round.criteria).toContain("20 h-a-week alert (over 12 weeks)");
    expect(round.closesAt!.getTime()).toBe(NOW.getTime() + 2 * 3_600_000);
    expect((await db.select().from(auditEvents).where(eq(auditEvents.action, "SUGGESTED_SHIFT_APPROVED")))[0].metadata).toMatchObject({ actorUserId: b.scope.userId });
    // A second click never makes a second shift.
    await expect(approveSuggestedShift(db, b.scope, { key: first.key, departmentId: b.department.id, policyId: b.policy.id }, () => b.outlet(), NOW)).rejects.toMatchObject({ feedback: "suggestion-approved" });
    // A suggestion that doesn't exist (or has changed) is refused.
    await expect(approveSuggestedShift(db, b.scope, { key: "2026-12-15T03:00-04:00", departmentId: b.department.id, policyId: b.policy.id }, () => b.outlet(), NOW)).rejects.toMatchObject({ feedback: "opportunity-changed" });
    // Rounds are records.
    await expect(db.delete(offerRounds)).rejects.toThrow();
    await close();
  });

  it("fills with the earliest acceptances, closes the rest, and opens round 2 only when round 1's window closes unfilled", async () => {
    const { db, close } = await createTestDatabase();
    const b = await business(db);
    await ensureDemoRules(db, b.organisationId);
    const keen1 = await b.person("Keen", true), keen2 = await b.person("Also", true), other = await b.person("Other", false);
    const outlet = await b.outlet();
    const [a, c] = suggestShifts(outlet).filter(row => row.headcount >= 1);
    // A one-place shift: the first acceptance fills it and the other offer closes.
    const one = await createShiftFromOpportunity(db, { departmentId: b.department.id, policyId: b.policy.id, startsAt: new Date(a.startsAt), endsAt: new Date(a.endsAt), requiredHeadcount: 1, date: a.date, window: a.window }, b.scope, NOW);
    await startOfferRounds(db, b.scope, one.id, NOW);
    const offers = await db.select().from(shiftOffers).where(eq(shiftOffers.shiftId, one.id));
    const mine = (worker: string) => offers.find(row => row.workerId === worker)!;
    await respondToAssignment(db, keen2, mine(keen2).id, one.termsVersion, "ACCEPTED", true, b.site);
    await expect(respondToAssignment(db, keen1, mine(keen1).id, one.termsVersion, "ACCEPTED", true, b.site)).rejects.toThrow();
    expect((await db.select().from(shiftOffers).where(eq(shiftOffers.id, mine(keen1).id)))[0].status).toBe("CANCELLED");
    // Filled: round 2 never opens.
    expect(await advanceOfferRounds(db, [b.organisationId], new Date(NOW.getTime() + 3 * 3_600_000))).toEqual({ opened: 0 });

    // Another shift nobody takes in round 1: round 2 opens for everyone else once the window closes.
    const two = await createShiftFromOpportunity(db, { departmentId: b.department.id, policyId: b.policy.id, startsAt: new Date(c.startsAt), endsAt: new Date(c.endsAt), requiredHeadcount: 1, date: c.date, window: c.window }, b.scope, NOW);
    await startOfferRounds(db, b.scope, two.id, NOW);
    expect(await advanceOfferRounds(db, [b.organisationId], new Date(NOW.getTime() + 60 * 60_000))).toEqual({ opened: 0 });
    expect(await advanceOfferRounds(db, [b.organisationId], new Date(NOW.getTime() + 2 * 3_600_000 + 1))).toEqual({ opened: 1 });
    const second = await db.select().from(shiftOffers).where(eq(shiftOffers.shiftId, two.id));
    expect(second.map(row => row.workerId)).toContain(other);
    const rounds = await db.select().from(offerRounds).where(eq(offerRounds.shiftId, two.id));
    expect(rounds.map(row => row.round).sort()).toEqual([1, 2]);
    expect(rounds.find(row => row.round === 2)!.closesAt).toBeNull();
    expect(await advanceOfferRounds(db, [b.organisationId], new Date(NOW.getTime() + 4 * 3_600_000))).toEqual({ opened: 0 });
    await close();
  });

  it("goes straight to round 2 for a shift starting within the cut-off, or when no one wants more hours", async () => {
    const { db, close } = await createTestDatabase();
    const b = await business(db);
    await ensureDemoRules(db, b.organisationId);
    await b.person("Keen", true); await b.person("Other", false);
    const [suggestion] = suggestShifts(await b.outlet());
    const soon = new Date(Date.parse(suggestion.startsAt) - 11 * 3_600_000);
    const shift = await createShiftFromOpportunity(db, { departmentId: b.department.id, policyId: b.policy.id, startsAt: new Date(suggestion.startsAt), endsAt: new Date(suggestion.endsAt), requiredHeadcount: 1, date: suggestion.date, window: suggestion.window }, b.scope, NOW);
    expect(await startOfferRounds(db, b.scope, shift.id, soon)).toMatchObject({ round: 2, offered: 2 });
    expect((await db.select().from(offerRounds).where(eq(offerRounds.shiftId, shift.id)))[0].criteria).toContain("starts too soon");
    await close();
  });

  it("lets the AI briefing only order and explain the suggestions FairShift made", async () => {
    const { db, close } = await createTestDatabase();
    const b = await business(db);
    await ensureDemoRules(db, b.organisationId);
    const staffing = await getWeeklyStaffing(db, b.scope, NOW);
    const prepared = prepareAssessmentInput(staffing, "LOCATION");
    const refs = prepared.input.locations[0].suggestions.map(row => row.ref);
    expect(refs.length).toBe(suggestShifts(staffing.outlets[0]).length);
    const base = { schemaVersion: AI_OUTPUT_SCHEMA_VERSION, summary: "Pressure sits in the late morning.", priorities: [], constraints: [], signalCommentary: "Synthetic history.", commercialImplication: "Modest.", suggestionOrder: [] as { ref: string; reason: string }[] };
    expect(validateAssessment({ ...base, suggestionOrder: [{ ref: refs[0], reason: "Covers the late-morning peak first." }] }, prepared.input)).toMatchObject({ ok: true });
    expect(validateAssessment({ ...base, suggestionOrder: [{ ref: "B99", reason: "Invented." }] }, prepared.input)).toMatchObject({ ok: false, code: "UNKNOWN_REFERENCE" });
    expect(validateAssessment({ ...base, suggestionOrder: [{ ref: refs[0], reason: "Covers the gap for 6 hours." }] }, prepared.input)).toMatchObject({ ok: false, code: "NUMBER_IN_TEXT" });
    await close();
  });
});
