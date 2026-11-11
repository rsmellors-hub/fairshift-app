import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/server/intelligence/sales-history", async importOriginal => ({ ...await importOriginal<typeof import("@/server/intelligence/sales-history")>(), syntheticHistoryAllowed: () => true }));
import { createTestDatabase } from "../helpers/database";
import { entitled } from "../helpers/onboarding";
import { configureFixture, hours, ingestTimedBills } from "../helpers/workload";
import { createActivatedTeamMember } from "../helpers/workers";
import type { Scope } from "@/server/auth/access";
import { memberships, offerRounds, organisations, outlets, shiftOffers, subscriptions, users, workers } from "@/server/db/schema";
import { getWeeklyStaffing } from "@/server/intelligence/staffing";
import { createDepartment, createWorkPolicy } from "@/server/scheduling/operations";
import { suggestShifts } from "@/server/scheduling/shift-rules";
import { startOfferRounds } from "@/server/scheduling/shift-suggestions";
import { ensureDemoRules } from "@/server/demo/settings-seed";
import { createShiftFromOpportunity } from "@/server/intelligence/opportunity-shifts";
import { JOBS, operatingOrganisationIds, runDueJobs } from "@/server/scheduler/feeds";

// F4 (12 Nov 2026): offer rounds advance on schedule for every active, entitled business, not only the
// demo business. Monday 14 Dec 2026, 08:00 Johannesburg. Fixtures only; no network.
const NOW = new Date("2026-12-14T06:00:00Z");
beforeEach(() => { vi.useFakeTimers({ now: NOW, toFake: ["Date"] }); vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];

// A business that isn't the demo, with one unfilled round-1 offer whose window closes at NOW + 2 h.
async function businessWithOpenRound(db: Db, options: { entitled: boolean }) {
  const organisationId = randomUUID(), outletId = randomUUID(), userId = randomUUID();
  await db.insert(organisations).values({ id: organisationId, name: "Independent cafe", country: "South Africa" });
  await db.insert(subscriptions).values({ id: randomUUID(), organisationId, requestId: randomUUID() });
  await entitled(db, organisationId);
  await db.insert(outlets).values({ id: outletId, organisationId, name: "Melville", timezone: "Africa/Johannesburg", city: "Johannesburg", country: "South Africa" });
  await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: "Fixture Manager", passwordHash: "x", emailVerifiedAt: NOW });
  await db.insert(memberships).values({ id: randomUUID(), userId, organisationId, role: "OWNER" });
  await ingestTimedBills(db, { organisationId, outletId, currencyCode: "ZAR", through: "2026-12-13", bills: () => 30, at: "09:10:00Z", now: NOW, billMinor: 9_000 });
  await configureFixture(db, { organisationId, outletId, policy: { transactionsPerStaffHour: 4, minimumStaffWhileOpen: 1 }, trading: [{ start: 8 * 60, end: 20 * 60 }], coverage: [hours(8, 20, 1)] });
  await ensureDemoRules(db, organisationId);
  const scope: Scope = { userId, organisationId, locationId: outletId, role: "MANAGER", organisationName: "Independent cafe", locationName: "Melville" };
  const site = { organisationId, locationId: outletId };
  const [department] = await createDepartment(db, "Floor", site);
  const [policy] = await createWorkPolicy(db, { earningsModel: "HOURLY", rateMinor: 4_500 }, "Casual floor terms", site);
  const person = async (name: string, wantsMoreHours: boolean) => {
    const { worker } = await createActivatedTeamMember(db, { firstName: name, surname: "Fixture", telephone: "+27110000000", email: `${name.toLowerCase()}.${randomUUID().slice(0, 6)}@example.test` }, site);
    await db.update(workers).set({ wantsMoreHours }).where(eq(workers.id, worker.id));
    return worker.id;
  };
  await person("Keen", true);
  const other = await person("Other", false);
  const outlet = (await getWeeklyStaffing(db, scope, NOW)).outlets.find(row => row.outletId === outletId)!;
  const [suggestion] = suggestShifts(outlet);
  const shift = await createShiftFromOpportunity(db, { departmentId: department.id, policyId: policy.id, startsAt: new Date(suggestion.startsAt), endsAt: new Date(suggestion.endsAt), requiredHeadcount: 1, date: suggestion.date, window: suggestion.window }, scope, NOW);
  await startOfferRounds(db, scope, shift.id, NOW);
  // Entitlement lapses after the round started: the scheduler no longer serves this business.
  if (!options.entitled) await db.update(subscriptions).set({ status: "SUSPENDED" }).where(eq(subscriptions.organisationId, organisationId));
  return { organisationId, outletId, shiftId: shift.id, other };
}

const offersJob = JOBS.filter(job => job.key === "offers:rounds");
const tick = (db: Db, at: Date, demoOrganisationIds: string[] = []) => runDueJobs(db, { now: () => at, demoOrganisationIds, aiSchedule: false }, offersJob);
const roundsOf = async (db: Db, shiftId: string) => (await db.select().from(offerRounds).where(eq(offerRounds.shiftId, shiftId))).map(row => row.round).sort();

describe("scheduled offer rounds for every business", () => {
  it("opens round 2 for a non-demo business's unfilled shift when round 1's window closes, with no user action", async () => {
    const { db, close } = await createTestDatabase();
    try {
      const b = await businessWithOpenRound(db, { entitled: true });
      // No demo business is configured at all: the job still runs for this business.
      expect(await tick(db, new Date(NOW.getTime() + 60 * 60_000))).toEqual([{ key: "offers:rounds", outcome: "RAN", ok: true, code: null }]);
      expect(await roundsOf(db, b.shiftId)).toEqual([1]);
      // The window has closed by the next tick five minutes after it.
      await tick(db, new Date(NOW.getTime() + 2 * 3_600_000 + 5 * 60_000));
      expect(await roundsOf(db, b.shiftId)).toEqual([1, 2]);
      expect((await db.select().from(shiftOffers).where(eq(shiftOffers.shiftId, b.shiftId))).map(row => row.workerId)).toContain(b.other);
    } finally { await close(); }
  });

  it("leaves a business without an active subscription, or without an active location, alone", async () => {
    const { db, close } = await createTestDatabase();
    try {
      const lapsed = await businessWithOpenRound(db, { entitled: false });
      const closed = await businessWithOpenRound(db, { entitled: true });
      await db.update(outlets).set({ active: false }).where(eq(outlets.id, closed.outletId));
      const demo = randomUUID();
      expect(await operatingOrganisationIds(db, [demo])).toEqual([demo]);
      await tick(db, new Date(NOW.getTime() + 3 * 3_600_000), [demo]);
      expect(await roundsOf(db, lapsed.shiftId)).toEqual([1]);
      expect(await roundsOf(db, closed.shiftId)).toEqual([1]);
    } finally { await close(); }
  });
});
