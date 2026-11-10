import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { entitled } from "../helpers/onboarding";
import { resolveScope, type Scope } from "@/server/auth/access";
import { saveWorkerAvailability, workerRespond } from "@/server/auth/operations";
import { requireScope } from "@/server/auth/request";
import { inviteMember, redeemInvitation } from "@/server/auth/tenancy";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { auditEvents, memberships, organisations, outlets, shiftOffers, shifts, subscriptions, users, workAcceptances, workAllocations, workers } from "@/server/db/schema";
import { shiftInteraction } from "@/server/domain/shift-change";
import { importAttributedSales } from "@/server/performance/attribution";
import { getAllocationSchedule } from "@/server/scheduling/allocations";
import { allocateAssignment, changeAssignment, confirmWork, createDepartment, createRequirement, createWorkPolicy, offerAssignment, rescheduleShift } from "@/server/scheduling/operations";
import { rescheduleShiftAction } from "@/app/schedule-actions";
import ManagerAreaPage from "@/app/manager/[area]/page";
import { ManagerWorkspace } from "@/app/manager/workspace";
import { WorkerWorkspace } from "@/app/worker/workspace";
import { payoutProgress } from "@/app/components/payment-progress";

vi.mock("@/server/auth/request", () => ({ requireScope: vi.fn() }));
vi.mock("@/server/db/client", () => ({ getDatabase: vi.fn() }));
vi.mock("@/server/config/env", () => ({ getConfigurationStatus: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); }, notFound: () => { throw new Error("NOT_FOUND"); }, useRouter: () => ({ refresh() {} }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const NOW = new Date("2026-01-15T12:00:00Z");
const START = "2026-01-19T09:00:00Z", END = "2026-01-19T17:00:00Z";
const LATER = { startsAt: new Date("2026-01-19T12:00:00Z"), endsAt: new Date("2026-01-19T20:00:00Z") };
beforeEach(() => { vi.useFakeTimers({ now: NOW, toFake: ["Date"] }); });
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];
let n = 0;
async function user(db: Db) {
  const id = randomUUID(), email = `s${++n}-${randomUUID().slice(0, 6)}@example.test`;
  await db.insert(users).values({ id, email, name: "Person", passwordHash: "x", emailVerifiedAt: new Date() });
  return { id, email };
}
async function business(db: Db, locations = ["Leeds"]) {
  const organisationId = randomUUID();
  await db.insert(organisations).values({ id: organisationId, name: "Any Retail", country: "United Kingdom" });
  await db.insert(subscriptions).values({ id: randomUUID(), organisationId, requestId: randomUUID() });
  await entitled(db, organisationId);
  const rows = locations.map(name => ({ id: randomUUID(), organisationId, name, timezone: "Europe/London", country: "United Kingdom" }));
  await db.insert(outlets).values(rows);
  const owner = await user(db), ownerMembership = randomUUID();
  await db.insert(memberships).values({ id: ownerMembership, userId: owner.id, organisationId, role: "OWNER" });
  const ownerAt = (i = 0) => resolveScope(db, owner.id, ownerMembership, rows[i].id);
  const manager = async (i = 0) => {
    const person = await user(db);
    const { token } = await inviteMember(db, await ownerAt(i), { role: "MANAGER", email: person.email, firstName: "Morgan", surname: "Manager", telephone: "+441130000000" });
    return resolveScope(db, person.id, (await redeemInvitation(db, person.id, { token })).id);
  };
  const worker = async (by: Scope, firstName = "Casey") => {
    const person = await user(db);
    const { token } = await inviteMember(db, by, { role: "TEAM_MEMBER", email: person.email, firstName, surname: "Worker", telephone: "+441130000001" });
    return resolveScope(db, person.id, (await redeemInvitation(db, person.id, { token })).id);
  };
  return { organisationId, rows, ownerAt, manager, worker };
}
async function setup(db: Db) {
  const c = await business(db), manager = await c.manager(), worker = await c.worker(manager), owner = await c.ownerAt();
  const [department] = await createDepartment(db, "Sales floor", owner);
  const [policy] = await createWorkPolicy(db, { earningsModel: "HOURLY", rateMinor: 1_300, incentiveTargetMinor: 65_000, incentiveBonusMinor: 2_500 }, "Casual with bonus", owner);
  const shift = (start = START, end = END, requiredHeadcount = 1) => createRequirement(db, { departmentId: department.id, policyId: policy.id, startsAt: new Date(start), endsAt: new Date(end), requiredHeadcount }, manager);
  return { c, manager, worker, owner, shift };
}
type Ctx = Awaited<ReturnType<typeof setup>>;
const accepted = async (db: Db, s: Ctx, shiftId: string, version = 1) => { const offer = await offerAssignment(db, shiftId, s.worker.workerId!, s.manager); await workerRespond(db, s.worker, offer.id, version, "ACCEPTED", true); return offer; };
const allocated = async (db: Db, s: Ctx, shiftId: string) => { const offer = await accepted(db, s, shiftId); await allocateAssignment(db, offer.id, s.manager); return offer; };
const move = (scope: Scope, shiftId: string, over: Record<string, unknown> = {}) => ({ shiftId, expectedTermsVersion: 1, ...LATER, source: "DRAG", acknowledgeReacceptance: false, ...over });
const withDb = async (run: (db: Db) => Promise<void>) => { const t = await createTestDatabase(); try { await run(t.db); } finally { await t.close(); } };
const row = async (db: Db, id: string) => (await db.select().from(shifts).where(eq(shifts.id, id)))[0];
const page = (db: Db, scope: Scope) => { vi.mocked(requireScope).mockResolvedValue(scope); vi.mocked(getDatabase).mockReturnValue(db); vi.mocked(getConfigurationStatus).mockReturnValue({ databaseConfigured: true, aiConfigured: false, paypalPayoutConfigured: true } as ReturnType<typeof getConfigurationStatus>); };

describe("the rule for changing a shift", () => {
  const later = new Date("2030-01-01T00:00:00Z"), open = { status: "PUBLISHED", endsAt: later };
  it("depends on who has responded", () => {
    expect(shiftInteraction(open, [], NOW)).toBe("MOVE");
    expect(shiftInteraction(open, [{ offerStatus: "DECLINED" }], NOW)).toBe("MOVE");
    expect(shiftInteraction(open, [{ offerStatus: "OFFERED" }], NOW)).toBe("MOVE_WITH_REACCEPTANCE");
    expect(shiftInteraction(open, [{ offerStatus: "ACCEPTED" }], NOW)).toBe("MOVE_WITH_REACCEPTANCE");
    expect(shiftInteraction(open, [{ offerStatus: "OFFERED", allocationState: "REACCEPTANCE_REQUIRED" }], NOW)).toBe("MOVE_WITH_REACCEPTANCE");
    expect(shiftInteraction(open, [{ offerStatus: "ACCEPTED", allocationState: "ALLOCATED" }, { offerStatus: "OFFERED" }], NOW)).toBe("CHANGE_ONLY");
    expect(shiftInteraction(open, [{ offerStatus: "ACCEPTED", allocationState: "ALLOCATED", confirmedAt: NOW }], NOW)).toBe("LOCKED");
    expect(shiftInteraction({ status: "CANCELLED", endsAt: later }, [], NOW)).toBe("LOCKED");
    expect(shiftInteraction({ status: "PUBLISHED", endsAt: NOW }, [], NOW)).toBe("LOCKED");
  });
});

describe("changing a shift from the schedule", () => {
  it("moves a shift nobody has been offered, with the pay worked out by the server and an audit record", () => withDb(async db => {
    const s = await setup(db), shift = await s.shift();
    expect(await rescheduleShift(db, s.manager, move(s.manager, shift.id, { ...{ startsAt: LATER.startsAt, endsAt: new Date("2026-01-19T22:00:00Z") } }))).toEqual({ termsVersion: 2, changed: true });
    expect(await row(db, shift.id)).toMatchObject({ expectedEarningsMinor: 13_000, guaranteedBasePayMinor: 13_000, termsVersion: 2 });
    const [event] = await db.select().from(auditEvents).where(eq(auditEvents.action, "SHIFT_RESCHEDULED"));
    expect(event.metadata).toMatchObject({ source: "DRAG", interaction: "MOVE", fromTermsVersion: 1, termsVersion: 2 });
  }));
  it("needs confirmation to move an open offer, and the old terms can no longer be accepted", () => withDb(async db => {
    const s = await setup(db), shift = await s.shift(), offer = await offerAssignment(db, shift.id, s.worker.workerId!, s.manager);
    await expect(rescheduleShift(db, s.manager, move(s.manager, shift.id))).rejects.toMatchObject({ feedback: "schedule-needs-confirmation" });
    expect((await row(db, shift.id)).termsVersion).toBe(1);
    await rescheduleShift(db, s.manager, move(s.manager, shift.id, { acknowledgeReacceptance: true }));
    await expect(workerRespond(db, s.worker, offer.id, 1, "ACCEPTED", true)).rejects.toMatchObject({ feedback: "terms-changed" });
    await workerRespond(db, s.worker, offer.id, 2, "ACCEPTED", true);
  }));
  it("returns an acceptance to the worker when accepted terms move, and it can't be allocated on the old terms", () => withDb(async db => {
    const s = await setup(db), shift = await s.shift(), offer = await accepted(db, s, shift.id);
    await rescheduleShift(db, s.manager, move(s.manager, shift.id, { acknowledgeReacceptance: true }));
    expect((await db.select().from(shiftOffers).where(eq(shiftOffers.id, offer.id)))[0].status).toBe("OFFERED");
    await expect(allocateAssignment(db, offer.id, s.manager)).rejects.toThrow("Accept the offer before allocation");
  }));
  it("refuses to drag an allocated shift, even with a forged acknowledgement", () => withDb(async db => {
    const s = await setup(db), shift = await s.shift(), offer = await allocated(db, s, shift.id);
    await expect(rescheduleShift(db, s.manager, move(s.manager, shift.id, { acknowledgeReacceptance: true }))).rejects.toMatchObject({ feedback: "schedule-allocated" });
    const after = await row(db, shift.id);
    expect(after.startsAt.toISOString()).toBe(new Date(START).toISOString());
    expect(after.termsVersion).toBe(1);
    expect((await db.select().from(workAllocations).where(eq(workAllocations.offerId, offer.id)))[0].state).toBe("ALLOCATED");
  }));
  it("Change shift on allocated work needs acknowledgement, requires reacceptance, and keeps the accepted record unchanged", () => withDb(async db => {
    const s = await setup(db), shift = await s.shift(), offer = await allocated(db, s, shift.id);
    const before = await db.select().from(workAcceptances).where(eq(workAcceptances.offerId, offer.id));
    await expect(rescheduleShift(db, s.manager, move(s.manager, shift.id, { source: "CHANGE" }))).rejects.toMatchObject({ feedback: "schedule-needs-confirmation" });
    await rescheduleShift(db, s.manager, move(s.manager, shift.id, { source: "CHANGE", acknowledgeReacceptance: true }));
    expect((await db.select().from(workAllocations).where(eq(workAllocations.offerId, offer.id)))[0].state).toBe("REACCEPTANCE_REQUIRED");
    expect((await db.select().from(shiftOffers).where(eq(shiftOffers.id, offer.id)))[0].status).toBe("OFFERED");
    expect(await db.select().from(workAcceptances).where(eq(workAcceptances.offerId, offer.id))).toEqual(before);
    await expect(confirmWork(db, offer.id, s.manager)).rejects.toThrow("Accepted work required");
    const schedule = await getAllocationSchedule(db, s.manager, NOW);
    expect(schedule.events.find(event => event.id === offer.id)?.state).toBe("Changed · awaiting new acceptance");
  }));
  it("locks finished and reviewed work", () => withDb(async db => {
    const s = await setup(db), shift = await s.shift(), offer = await allocated(db, s, shift.id);
    vi.setSystemTime(new Date("2026-01-20T12:00:00Z"));
    await expect(rescheduleShift(db, s.manager, move(s.manager, shift.id, { source: "CHANGE", acknowledgeReacceptance: true, startsAt: new Date("2026-01-25T09:00:00Z"), endsAt: new Date("2026-01-25T17:00:00Z") }))).rejects.toMatchObject({ feedback: "schedule-locked" });
    await confirmWork(db, offer.id, s.manager);
    await expect(rescheduleShift(db, s.manager, move(s.manager, shift.id, { source: "CHANGE", acknowledgeReacceptance: true, startsAt: new Date("2026-01-25T09:00:00Z"), endsAt: new Date("2026-01-25T17:00:00Z") }))).rejects.toMatchObject({ feedback: "schedule-locked" });
  }));
  it("refuses a stale view, a removed shift, the past and an impossible duration", () => withDb(async db => {
    const s = await setup(db), shift = await s.shift();
    await changeAssignment(db, s.manager, shift.id, LATER);
    await expect(rescheduleShift(db, s.manager, move(s.manager, shift.id, { startsAt: new Date(START), endsAt: new Date(END) }))).rejects.toMatchObject({ feedback: "schedule-stale" });
    const current = { expectedTermsVersion: 2 };
    await expect(rescheduleShift(db, s.manager, move(s.manager, shift.id, { ...current, startsAt: new Date("2026-01-10T09:00:00Z"), endsAt: new Date("2026-01-10T17:00:00Z") }))).rejects.toMatchObject({ feedback: "schedule-past" });
    await expect(rescheduleShift(db, s.manager, move(s.manager, shift.id, { ...current, startsAt: new Date(END), endsAt: new Date(START) }))).rejects.toMatchObject({ feedback: "invalid-duration" });
    await changeAssignment(db, s.manager, shift.id, { cancel: true });
    await expect(rescheduleShift(db, s.manager, move(s.manager, shift.id, current))).rejects.toMatchObject({ feedback: "schedule-locked" });
  }));
  it("notices an offer sent or accepted since the schedule was opened", () => withDb(async db => {
    const s = await setup(db), shift = await s.shift();
    const seen = (await getAllocationSchedule(db, s.manager, NOW)).events[0];
    expect(seen.interaction).toBe("MOVE");
    await offerAssignment(db, shift.id, s.worker.workerId!, s.manager);
    await expect(rescheduleShift(db, s.manager, move(s.manager, seen.shiftId))).rejects.toMatchObject({ feedback: "schedule-needs-confirmation" });
  }));
  it("refuses times that overlap a worker's accepted shift or a day they can't work", () => withDb(async db => {
    const s = await setup(db), first = await s.shift(), second = await s.shift("2026-01-20T09:00:00Z", "2026-01-20T17:00:00Z");
    await accepted(db, s, first.id);
    await offerAssignment(db, second.id, s.worker.workerId!, s.manager);
    await expect(rescheduleShift(db, s.manager, move(s.manager, second.id, { acknowledgeReacceptance: true }))).rejects.toMatchObject({ feedback: "worker-working" });
    expect((await row(db, second.id)).startsAt.toISOString()).toBe("2026-01-20T09:00:00.000Z");
    await saveWorkerAvailability(db, s.worker, [null, null, "UNAVAILABLE", null, null, null, null]);
    await expect(rescheduleShift(db, s.manager, move(s.manager, second.id, { acknowledgeReacceptance: true, startsAt: new Date("2026-01-21T09:00:00Z"), endsAt: new Date("2026-01-21T17:00:00Z") }))).rejects.toMatchObject({ feedback: "worker-unavailable" });
  }));
  it("refuses when a worker on the shift has left", () => withDb(async db => {
    const s = await setup(db), shift = await s.shift();
    await accepted(db, s, shift.id);
    await db.update(workers).set({ status: "INACTIVE" }).where(eq(workers.id, s.worker.workerId!));
    await expect(rescheduleShift(db, s.manager, move(s.manager, shift.id, { acknowledgeReacceptance: true }))).rejects.toMatchObject({ feedback: "schedule-conflict" });
  }));
  it("ignores everything but the time: a forged event can't set pay, worker, location or a smaller shift", () => withDb(async db => {
    const s = await setup(db), shift = await s.shift();
    for (const forged of [{ rateMinor: 999_999 }, { workerId: randomUUID() }, { outletId: s.c.rows[0].id }, { guaranteedBasePayMinor: 1 }, { termsVersion: 9 }, { requiredHeadcount: 0 }]) {
      await expect(rescheduleShift(db, s.manager, move(s.manager, shift.id, forged))).rejects.toMatchObject({ feedback: "schedule-invalid" });
    }
    await expect(rescheduleShift(db, s.manager, move(s.manager, "not-a-uuid"))).rejects.toMatchObject({ feedback: "schedule-invalid" });
    await expect(rescheduleShift(db, s.manager, move(s.manager, shift.id, { startsAt: "2026-01-19T12:00:00Z" }))).rejects.toMatchObject({ feedback: "schedule-invalid" });
    expect(await row(db, shift.id)).toMatchObject({ expectedEarningsMinor: 10_400, termsVersion: 1, requiredHeadcount: 1 });
  }));
});

describe("who can see and change the schedule", () => {
  it("another location's or tenant's manager can't change a shift, and a worker can't either", () => withDb(async db => {
    const s = await setup(db), shift = await s.shift();
    const multi = await business(db, ["York", "Hull"]), york = await multi.manager(0), hull = await multi.manager(1);
    await expect(rescheduleShift(db, york, move(york, shift.id))).rejects.toMatchObject({ feedback: "schedule-unavailable" });
    await expect(rescheduleShift(db, s.worker, move(s.worker, shift.id))).rejects.toThrow("Access denied");
    const [dep] = await createDepartment(db, "Floor", await multi.ownerAt(0));
    const [pol] = await createWorkPolicy(db, { earningsModel: "HOURLY", rateMinor: 1_300 }, "Casual", await multi.ownerAt(0));
    const yorkShift = await createRequirement(db, { departmentId: dep.id, policyId: pol.id, startsAt: new Date(START), endsAt: new Date(END), requiredHeadcount: 1 }, york);
    await expect(rescheduleShift(db, hull, move(hull, yorkShift.id))).rejects.toMatchObject({ feedback: "schedule-unavailable" });
    expect((await row(db, shift.id)).termsVersion).toBe(1);
    expect((await row(db, yorkShift.id)).termsVersion).toBe(1);
  }));
  it("the schedule holds only this location's workers and shifts, and no provider identifiers", () => withDb(async db => {
    const s = await setup(db), shift = await s.shift(), other = await business(db, ["York", "Hull"]), hull = await other.manager(1), stranger = await other.worker(hull, "Stranger");
    await allocated(db, s, shift.id);
    const schedule = await getAllocationSchedule(db, s.manager, NOW);
    expect(schedule.resources.map(row => row.id)).toEqual([s.worker.workerId]);
    expect(JSON.stringify(schedule)).not.toMatch(new RegExp(`Stranger|${stranger.workerId}|paypalBatch|PPB|attributionCode|@example`));
  }));
  it("shows unfilled places as FairShift's own row, not a worker, and only for real capacity", () => withDb(async db => {
    const s = await setup(db), shift = await s.shift(START, END, 2);
    await allocated(db, s, shift.id);
    const schedule = await getAllocationSchedule(db, s.manager, NOW);
    expect(schedule.resources[0]).toEqual({ id: "open-places", name: "Places to fill" });
    // Its time can't be dragged, because the shift is allocated; the open place can still be offered.
    expect(schedule.events.find(event => event.kind === "GAP")).toMatchObject({ state: "1 place to fill", interaction: "CHANGE_ONLY", timeMovable: false, resizable: false, offerable: true, fillHref: expect.stringContaining("/manager/fill?date=2026-01-19") });
    expect(schedule.events.find(event => event.kind === "OFFER")).toMatchObject({ state: "Allocated", draggable: false, resizable: false, bonusLabel: "£25.00 bonus at £650.00 attributed sales" });
  }));
  it("the action reads wall-clock times at the location, refuses a clock-change time, and returns the refusal", () => withDb(async db => {
    const s = await setup(db), shift = await s.shift("2027-03-27T09:00:00Z", "2027-03-27T17:00:00Z");
    page(db, s.manager);
    const change = { shiftId: shift.id, expectedTermsVersion: 1, source: "DRAG" as const, acknowledgeReacceptance: false };
    expect(await rescheduleShiftAction({ ...change, startsAt: "2027-03-28T01:30", endsAt: "2027-03-28T09:00" })).toMatchObject({ ok: false, code: "time-nonexistent" });
    expect((await row(db, shift.id)).termsVersion).toBe(1);
    expect(await rescheduleShiftAction({ ...change, startsAt: "2027-07-01T09:00", endsAt: "2027-07-01T17:00" })).toEqual({ ok: true, changed: true });
    expect((await row(db, shift.id)).startsAt.toISOString()).toBe("2027-07-01T08:00:00.000Z");
    expect(await rescheduleShiftAction({ ...change, startsAt: "2027-07-02T09:00", endsAt: "2027-07-02T17:00" })).toMatchObject({ ok: false, code: "schedule-stale" });
  }));
});

describe("Manager pages", () => {
  const area = async (db: Db, scope: Scope, name: string, search: Record<string, string> = {}) => { page(db, scope); return renderToStaticMarkup(await ManagerAreaPage({ params: Promise.resolve({ area: name }), searchParams: Promise.resolve(search) })); };
  it("keeps Forecast, Fill, Allocate and Review as separate pages on one visible journey", () => withDb(async db => {
    const s = await setup(db), shift = await s.shift();
    await allocated(db, s, shift.id);
    for (const name of ["plan", "fill", "allocations", "review"]) expect(await area(db, s.manager, name)).toContain('aria-label="Manager journey"');
    const fill = await area(db, s.manager, "fill"), allocations = await area(db, s.manager, "allocations");
    expect(fill).toContain("Work to fill");
    expect(fill).not.toContain("Weekly schedule");
    expect(allocations).toContain("Weekly schedule");
    expect(allocations).not.toContain("Work to fill");
    await expect(area(db, s.manager, "fill-shifts")).rejects.toThrow("REDIRECT:/manager/fill");
    vi.mocked(requireScope).mockRejectedValue(new Error("Access denied."));
    await expect(ManagerAreaPage({ params: Promise.resolve({ area: "allocations" }), searchParams: Promise.resolve({}) })).rejects.toThrow("Access denied");
  }));
});

describe("what the Worker sees of their shift", () => {
  const view = async (db: Db, scope: Scope, area: "home" | "shifts" | "pay") => { page(db, scope); return renderToStaticMarkup(await WorkerWorkspace({ area })); };
  it("shows their own target and truthful progress: none yet isn't zero, and reaching it isn't a confirmed bonus", () => withDb(async db => {
    const s = await setup(db), shift = await s.shift(), other = await s.c.worker(s.manager, "Other");
    await allocated(db, s, shift.id);
    let page1 = await view(db, s.worker, "home");
    for (const text of ["Your shift target", "No sales recorded yet", "Imported · not provider-verified", "£25.00 if you reach your target"]) expect(page1).toContain(text);
    expect(page1).not.toContain("£0.00");
    vi.setSystemTime(new Date("2026-01-19T12:00:00Z"));
    const [{ attributionCode: mine }] = await db.select({ attributionCode: workers.attributionCode }).from(workers).where(eq(workers.id, s.worker.workerId!));
    await importAttributedSales(db, s.manager, `transaction_id,attribution_code,occurred_at,amount,currency\nT1-secret,${mine},2026-01-19T10:00:00Z,700.00,GBP`);
    page1 = await view(db, s.worker, "home");
    for (const text of ["On shift now", "Target of £650.00 reached", "£700.00", "£25.00 · to be confirmed", 'aria-valuenow="100"']) expect(page1).toContain(text);
    expect(page1).not.toMatch(/T1-secret|leaderboard|customer/i);
    expect(await view(db, other, "home")).not.toContain("Your shift target");
  }));
  it("never marks a payout Paid before PayPal says so", () => {
    const last = (status: string, paypalStatus?: string) => payoutProgress("APPROVED", { status, paypalStatus }).steps.at(-1);
    for (const status of ["SUBMITTING", "PROCESSING", "RECONCILIATION_REQUIRED", "FAILED", "NOT_SENT"]) expect(last(status)).toEqual({ label: "PayPal confirms payment", state: "todo" });
    expect(last("PROCESSING", "ONHOLD")?.state).toBe("todo");
    expect(payoutProgress("APPROVED", { status: "PROCESSING", paypalStatus: "ONHOLD" }).note).toContain("Held at PayPal");
    expect(payoutProgress("APPROVED", { status: "FAILED" }).steps[2].state).toBe("problem");
    expect(last("PAID")).toEqual({ label: "Paid", state: "done" });
    expect(payoutProgress("PENDING_REVIEW", null).steps.every(step => step.state === "todo")).toBe(true);
  });
  it("sorts earnings into earned, pending and paid, with base, bonus and total", () => withDb(async db => {
    const s = await setup(db), shift = await s.shift(), offer = await allocated(db, s, shift.id);
    vi.setSystemTime(new Date("2026-01-20T12:00:00Z"));
    await confirmWork(db, offer.id, s.manager);
    const page1 = await view(db, s.worker, "pay");
    for (const text of [">Earned<", ">Pending<", "Paid so far", "Base pay", "£104.00", "Not known yet", "so far", "Awaiting approval"]) expect(page1).toContain(text);
    expect(page1).not.toMatch(/>\s*Paid\s*</);
  }));
});

describe("the Manager's plan", () => {
  it("has no separate state: shift changes reach the Worker's offer through the same record", () => withDb(async db => {
    const s = await setup(db), shift = await s.shift();
    await offerAssignment(db, shift.id, s.worker.workerId!, s.manager);
    await rescheduleShift(db, s.manager, move(s.manager, shift.id, { acknowledgeReacceptance: true }));
    page(db, s.worker);
    expect(renderToStaticMarkup(await WorkerWorkspace({ area: "shifts" }))).toContain("12:00 to 20:00");
    page(db, s.manager);
    expect(renderToStaticMarkup(await ManagerWorkspace({ area: "fill" }))).toContain("version 2");
  }));
});
