import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { entitled } from "../helpers/onboarding";
import { configureFixture, hours, ingestTimedBills } from "../helpers/workload";
import { createActivatedTeamMember, createTeamMember } from "../helpers/workers";
import type { Scope } from "@/server/auth/access";
import { requireScope } from "@/server/auth/request";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { memberships, organisations, outlets, shiftOffers, shifts, subscriptions, users, workAllocations, workerAvailability } from "@/server/db/schema";
import { dayOpportunities } from "@/server/intelligence/opportunity";
import { getWeeklyStaffing } from "@/server/intelligence/staffing";
import { getAllocationSchedule, planningRanges } from "@/server/scheduling/allocations";
import { allocateAssignment, createDepartment, createRequirement, createWorkPolicy, respondToAssignment } from "@/server/scheduling/operations";
import { offerFromScheduleAction } from "@/app/schedule-actions";
import { dropRule, FORECAST_RESOURCE, OPEN_PLACES_RESOURCE, REGULAR_RESOURCE } from "@/app/manager/allocation-model";
import { ManagerWorkspace } from "@/app/manager/workspace";

vi.mock("@/server/auth/request", () => ({ requireScope: vi.fn() }));
vi.mock("@/server/db/client", () => ({ getDatabase: vi.fn() }));
vi.mock("@/server/config/env", () => ({ getConfigurationStatus: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); }, notFound: () => { throw new Error("NOT_FOUND"); }, useRouter: () => ({ refresh() {}, push() {} }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// Sunday 25 Oct 2026, London (GMT from today). The planning week is Mon 26 Oct – Sun 1 Nov.
const NOW = new Date("2026-10-25T10:00:00Z");
const FRIDAY = "2026-10-30";
const SHIFT = { startsAt: new Date(`${FRIDAY}T14:00:00Z`), endsAt: new Date(`${FRIDAY}T20:00:00Z`) };
beforeEach(() => { vi.useFakeTimers({ now: NOW, toFake: ["Date"] }); });
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];
// TEST-FIXTURE VALUES ONLY: 12 bills in the 14:00 hour each day, 4 transactions per staff-hour,
// one regular person 12:00–20:00. So 14:00–15:00 needs 3 people: 1 regular, 2 casual.
const FIXTURE_POLICY = { transactionsPerStaffHour: 4, minimumStaffWhileOpen: 1 };
async function business(db: Db, name = "Fixture cafe") {
  const organisationId = randomUUID();
  await db.insert(organisations).values({ id: organisationId, name, country: "United Kingdom" });
  await db.insert(subscriptions).values({ id: randomUUID(), organisationId, requestId: randomUUID() });
  await entitled(db, organisationId);
  const rows = [1, 2].map(i => ({ id: randomUUID(), organisationId, name: `${name} ${i}`, timezone: "Europe/London" }));
  await db.insert(outlets).values(rows);
  const userId = randomUUID();
  await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: "Person", passwordHash: "x", emailVerifiedAt: NOW });
  await db.insert(memberships).values({ id: randomUUID(), userId, organisationId, role: "OWNER" });
  const scope = (locationId = rows[0].id, role: Scope["role"] = "MANAGER"): Scope => ({ userId, organisationId, locationId, role, organisationName: name, locationName: rows.find(row => row.id === locationId)?.name ?? "" });
  // Only the first location has history, policy and regular cover.
  await ingestTimedBills(db, { organisationId, outletId: rows[0].id, through: "2026-10-18", bills: () => 12, at: "13:10:00Z", now: NOW, billMinor: 2_500, sourceSystem: `till-${rows[0].id}` });
  await configureFixture(db, { organisationId, outletId: rows[0].id, policy: FIXTURE_POLICY, trading: [{ start: 12 * 60, end: 20 * 60 }], coverage: [hours(12, 20, 1)] });
  const manager = scope();
  const [department] = await createDepartment(db, "Front of house", manager);
  const [policy] = await createWorkPolicy(db, { earningsModel: "HOURLY", rateMinor: 1_400 }, "Casual", manager);
  const shift = (requiredHeadcount = 2, at = SHIFT) => createRequirement(db, { departmentId: department.id, policyId: policy.id, ...at, requiredHeadcount }, manager);
  const worker = async (firstName: string, locationScope = manager) => (await createActivatedTeamMember(db, { firstName, surname: "Worker", telephone: "+441130000001", email: `${firstName.toLowerCase()}-${randomUUID().slice(0, 6)}@example.test` }, locationScope)).worker;
  return { organisationId, rows, scope, manager, shift, worker };
}
type Ctx = Awaited<ReturnType<typeof business>>;
const withDb = async (run: (db: Db) => Promise<void>) => { const t = await createTestDatabase(); try { await run(t.db); } finally { await t.close(); } };
const as = (db: Db, scope: Scope) => { vi.mocked(requireScope).mockResolvedValue(scope); vi.mocked(getDatabase).mockReturnValue(db); vi.mocked(getConfigurationStatus).mockReturnValue({ databaseConfigured: true, aiConfigured: false, paypalPayoutConfigured: true } as ReturnType<typeof getConfigurationStatus>); };
const plan = async (db: Db, scope: Scope) => planningRanges((await getWeeklyStaffing(db, scope, NOW)).outlets.find(row => row.outletId === scope.locationId) ?? null);
const schedule = async (db: Db, scope: Scope) => getAllocationSchedule(db, scope, NOW, (await plan(db, scope)).ranges);
const offersOn = (db: Db, shiftId: string) => db.select().from(shiftOffers).where(eq(shiftOffers.shiftId, shiftId));
const friday = (ranges: { id: string }[]) => ranges.find(range => range.id === `forecast:${FRIDAY}:14:00-15:00`);
const accept = (db: Db, c: Ctx, offerId: string, workerId: string) => respondToAssignment(db, workerId, offerId, 1, "ACCEPTED", true, c.manager);
const unavailableOn = (db: Db, workerId: string, isoWeekday: number) => db.insert(workerAvailability).values({ id: randomUUID(), workerId, isoWeekday, state: "UNAVAILABLE" });

describe("the forecast's staffing gap on the Manager's schedule", () => {
  it("draws the Plan page's own casual need and regular cover on their own rows, linked to Fill shifts", () => withDb(async db => {
    const c = await business(db);
    const outlet = (await getWeeklyStaffing(db, c.manager, NOW)).outlets.find(row => row.outletId === c.rows[0].id)!;
    const { ranges, summary } = planningRanges(outlet);
    const window = dayOpportunities(outlet, outlet.days.find(day => day.planningDate === FRIDAY)!)[0];
    expect(window).toMatchObject({ windowStart: "14:00", windowEnd: "15:00", remainingCasualMinutes: 120, peakCasualStaff: 2, state: "OPEN" });
    expect(friday(ranges)).toEqual({ id: `forecast:${FRIDAY}:14:00-15:00`, resourceId: FORECAST_RESOURCE.id, kind: "FORECAST_OPEN", cls: "range-forecast-open",
      startDate: `${FRIDAY}T14:00:00.000Z`, endDate: `${FRIDAY}T15:00:00.000Z`, name: "2 h casual · up to 2", fillHref: `/manager/fill?date=${FRIDAY}&window=14:00-15:00#add-requirement` });
    expect(ranges.filter(range => range.kind === "REGULAR" && range.startDate.startsWith(FRIDAY))).toEqual([expect.objectContaining({ resourceId: REGULAR_RESOURCE.id, name: "Regular ×1", startDate: `${FRIDAY}T12:00:00.000Z`, endDate: `${FRIDAY}T20:00:00.000Z` })]);
    expect(summary).toMatchObject({ firstDate: "2026-10-26", lastDate: "2026-11-01", casualGapMinutes: 7 * 120, acceptedScenarios: 0, source: { source: "IMPORTED", synthetic: false } });
    // The schedule shows these rows first, and no forecast range is ever an event.
    const view = await getAllocationSchedule(db, c.manager, NOW, ranges);
    expect(view.resources.slice(0, 2)).toEqual([FORECAST_RESOURCE, REGULAR_RESOURCE]);
    expect(view.events).toEqual([]);
  }));
  it("a location without a calculable forecast shows no need rather than an invented one", () => withDb(async db => {
    const c = await business(db);
    expect(await plan(db, c.scope(c.rows[1].id))).toEqual({ ranges: [], summary: null });
    expect(planningRanges(null)).toEqual({ ranges: [], summary: null });
  }));
  it("runs the golden path from the gap: shift, drag-to-offer, acceptance, finalised allocation, and only then is the gap filled", () => withDb(async db => {
    const c = await business(db), shift = await c.shift(), alex = await c.worker("Alex"), sam = await c.worker("Sam");
    as(db, c.manager);
    expect(await offerFromScheduleAction({ shiftId: shift.id, workerId: alex.id })).toEqual({ ok: true });
    expect(await offerFromScheduleAction({ shiftId: shift.id, workerId: sam.id })).toEqual({ ok: true });
    expect((await offersOn(db, shift.id)).map(offer => offer.status)).toEqual(["OFFERED", "OFFERED"]);
    // Offers and acceptances don't fill the forecast gap; only finalised allocations do.
    expect(friday((await plan(db, c.manager)).ranges)).toMatchObject({ kind: "FORECAST_OPEN" });
    const [first, second] = await offersOn(db, shift.id);
    await accept(db, c, first.id, first.workerId);
    await accept(db, c, second.id, second.workerId);
    expect(friday((await plan(db, c.manager)).ranges)).toMatchObject({ kind: "FORECAST_OPEN" });
    await allocateAssignment(db, first.id, c.manager);
    await allocateAssignment(db, second.id, c.manager);
    expect(friday((await plan(db, c.manager)).ranges)).toMatchObject({ kind: "FORECAST_FILLED", fillHref: null, name: "Filled by allocated casual" });
    const view = await schedule(db, c.manager);
    expect(view.events.filter(event => event.kind === "OFFER").map(event => event.state)).toEqual(["Allocated", "Allocated"]);
    expect(view.events.some(event => event.kind === "GAP")).toBe(false);
  }));
  it("the Allocations page lists the open times with their provenance, even before any shift exists", () => withDb(async db => {
    const c = await business(db);
    as(db, c.manager);
    const page = renderToStaticMarkup(await ManagerWorkspace({ area: "allocations" }));
    for (const text of ["Weekly schedule", "Forecast casual need", "Imported sales history · not provider-verified", "Planning week Mon 26 Oct – Sun 1 Nov", "Open times · 7", "Fri 30 Oct · 14:00–15:00 · 2 h · up to 2 people", `href="/manager/fill?date=${FRIDAY}&amp;window=14:00-15:00#add-requirement"`, "Offers and acceptances don’t count until they’re allocated"]) expect(page).toContain(text);
    expect(page).not.toContain("No shift allocations yet");
    // The Owner's selected location decides what is shown: the second location has no forecast.
    as(db, c.scope(c.rows[1].id, "OWNER"));
    const other = renderToStaticMarkup(await ManagerWorkspace({ area: "allocations" }));
    expect(other).toContain("No shift allocations yet");
    expect(other).not.toContain("Forecast casual need");
  }));
});

describe("offering a shift by dragging an open place onto a worker", () => {
  it("sends an offer, never an allocation: unaccepted work can't be finalised", () => withDb(async db => {
    const c = await business(db), shift = await c.shift(1), alex = await c.worker("Alex");
    as(db, c.manager);
    expect(await offerFromScheduleAction({ shiftId: shift.id, workerId: alex.id })).toEqual({ ok: true });
    // Owners and Managers only, and closed to the public demo: no demo-write opt-in.
    expect(requireScope).toHaveBeenCalledWith(["OWNER", "MANAGER"]);
    const [offer] = await offersOn(db, shift.id);
    expect(offer).toMatchObject({ workerId: alex.id, status: "OFFERED" });
    expect(await db.select().from(workAllocations)).toEqual([]);
    await expect(allocateAssignment(db, offer.id, c.manager)).rejects.toThrow("Accept the offer before allocation");
    expect(await db.select().from(workAllocations)).toEqual([]);
    const view = await schedule(db, c.manager);
    expect(view.events.find(event => event.id === offer.id)).toMatchObject({ rowId: alex.id, state: "Offered · awaiting response" });
    // Its only place is offered, so the open place can't be offered again.
    expect(view.events.find(event => event.kind === "GAP")).toMatchObject({ offerable: false, rowId: OPEN_PLACES_RESOURCE.id });
  }));
  it("refuses a worker who is unavailable that day, and the schedule is exactly as it was", () => withDb(async db => {
    const c = await business(db), shift = await c.shift(), alex = await c.worker("Alex");
    await unavailableOn(db, alex.id, 5);
    const before = await schedule(db, c.manager);
    // Their Friday is drawn on their row, so the timeline refuses the drop before asking the server.
    expect(before.timeRanges).toContainEqual(expect.objectContaining({ id: `unavailable:${alex.id}:${FRIDAY}`, resourceId: alex.id, kind: "UNAVAILABLE", startDate: `${FRIDAY}T00:00:00.000Z`, endDate: "2026-10-31T00:00:00.000Z" }));
    expect(dropRule(before, before.events.find(event => event.kind === "GAP")!, alex.id)).toEqual({ action: "REFUSE", message: "This worker has marked themselves unavailable for this shift." });
    as(db, c.manager);
    expect(await offerFromScheduleAction({ shiftId: shift.id, workerId: alex.id })).toMatchObject({ ok: false, code: "worker-unavailable" });
    expect(await offersOn(db, shift.id)).toEqual([]);
    expect(await schedule(db, c.manager)).toEqual(before);
  }));
  it("refuses a worker with overlapping accepted work", () => withDb(async db => {
    const c = await business(db), first = await c.shift(1), second = await c.shift(1, { startsAt: new Date(`${FRIDAY}T16:00:00Z`), endsAt: new Date(`${FRIDAY}T19:00:00Z`) }), alex = await c.worker("Alex");
    as(db, c.manager);
    await offerFromScheduleAction({ shiftId: first.id, workerId: alex.id });
    await accept(db, c, (await offersOn(db, first.id))[0].id, alex.id);
    const view = await schedule(db, c.manager);
    expect(dropRule(view, view.events.find(event => event.kind === "GAP" && event.shiftId === second.id)!, alex.id)).toMatchObject({ action: "REFUSE" });
    expect(await offerFromScheduleAction({ shiftId: second.id, workerId: alex.id })).toMatchObject({ ok: false, code: "worker-working" });
    expect(await offersOn(db, second.id)).toEqual([]);
  }));
  it("refuses another location's shift or worker, a worker from another business, and a worker who hasn't activated", () => withDb(async db => {
    const c = await business(db), shift = await c.shift(), other = await business(db, "Elsewhere");
    const second = c.scope(c.rows[1].id), there = await c.worker("Remote", second), stranger = await other.worker("Stranger");
    const unactivated = (await createTeamMember(db, { firstName: "New", surname: "Worker", telephone: "+441130000002", email: `new-${randomUUID().slice(0, 6)}@example.test` }, c.manager)).worker;
    as(db, second);
    expect(await offerFromScheduleAction({ shiftId: shift.id, workerId: there.id })).toMatchObject({ ok: false, code: "offer-refused" });
    as(db, other.manager);
    expect(await offerFromScheduleAction({ shiftId: shift.id, workerId: stranger.id })).toMatchObject({ ok: false, code: "offer-refused" });
    as(db, c.manager);
    expect(await offerFromScheduleAction({ shiftId: shift.id, workerId: there.id })).toMatchObject({ ok: false, code: "offer-refused" });
    expect(await offerFromScheduleAction({ shiftId: shift.id, workerId: stranger.id })).toMatchObject({ ok: false, code: "offer-refused" });
    expect(await offerFromScheduleAction({ shiftId: shift.id, workerId: unactivated.id })).toMatchObject({ ok: false, code: "worker-not-activated" });
    expect(await offersOn(db, shift.id)).toEqual([]);
  }));
  it("can't bypass the Owner's pay terms: below-minimum terms are refused and a forged payload is read as nothing", () => withDb(async db => {
    const c = await business(db), shift = await c.shift(), alex = await c.worker("Alex");
    as(db, c.manager);
    for (const forged of [{ rateMinor: 99_999 }, { guaranteedBasePayMinor: 1 }, { startsAt: "2026-10-31T09:00" }, { locationId: c.rows[1].id }]) {
      expect(await offerFromScheduleAction({ shiftId: shift.id, workerId: alex.id, ...forged } as never)).toMatchObject({ ok: false, code: "offer-invalid" });
    }
    expect(await offerFromScheduleAction({ shiftId: "not-a-uuid", workerId: alex.id })).toMatchObject({ ok: false, code: "offer-invalid" });
    // Terms that fall below the demo minimum can't be offered from the schedule either.
    await db.update(shifts).set({ rateMinor: 500, expectedEarningsMinor: 3_000, guaranteedBasePayMinor: 3_000 }).where(eq(shifts.id, shift.id));
    expect(await offerFromScheduleAction({ shiftId: shift.id, workerId: alex.id })).toMatchObject({ ok: false, code: "wage-below-minimum" });
    expect(await offersOn(db, shift.id)).toEqual([]);
    expect((await db.select().from(shifts).where(eq(shifts.id, shift.id)))[0]).toMatchObject({ rateMinor: 500 });
  }));
  it("never offers more places than the shift has", () => withDb(async db => {
    const c = await business(db), shift = await c.shift(1), alex = await c.worker("Alex"), sam = await c.worker("Sam");
    as(db, c.manager);
    expect(await offerFromScheduleAction({ shiftId: shift.id, workerId: alex.id })).toEqual({ ok: true });
    expect(await offerFromScheduleAction({ shiftId: shift.id, workerId: sam.id })).toMatchObject({ ok: false, code: "offer-refused" });
    expect(await offerFromScheduleAction({ shiftId: shift.id, workerId: alex.id })).toMatchObject({ ok: false, code: "already-offered" });
    expect((await offersOn(db, shift.id)).map(offer => offer.workerId)).toEqual([alex.id]);
  }));
});
