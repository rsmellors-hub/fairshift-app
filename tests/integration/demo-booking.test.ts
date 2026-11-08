import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { entitled } from "../helpers/onboarding";
import { activateWorker } from "../helpers/workers";
import { resolveScope, type Scope } from "@/server/auth/access";
import { auditEvents, memberships, notificationDeliveries, notifications, shiftOffers, shifts, subscriptions, workAllocations, workers } from "@/server/db/schema";
import { isSyntheticEmail } from "@/server/demo/booking";
import { demoConfig } from "@/server/demo/config";
import { resetDemo } from "@/server/demo/fixtures";
import { DEMO_ACCOUNTS, provisionSaDemo } from "@/server/demo/provision";
import { affectedShifts, sendEarlyNotice } from "@/server/intelligence/early-notice";
import { getWeeklyStaffing } from "@/server/intelligence/staffing";
import { SA_REFERENCE_LOCATIONS, SA_REFERENCE_ORGANISATION } from "@/server/reference/sa-reference";
import { allocateAssignment, createRequirement, createTeamMember, offerAssignment, respondToAssignment } from "@/server/scheduling/operations";

vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); }, notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// The DEMO early notice's booked shift (Owner instruction, 8 November 2026): demo setup and Reset demo
// always leave a booked casual shift at Rosebank for tomorrow, by the Johannesburg date, so the notice
// works on any day of judging. 1 December 2026, 08:00 in Johannesburg: tomorrow is 2 December.
const NOW = new Date("2026-12-01T06:00:00Z");
const RANGE = { from: "2026-11-24", through: "2026-11-30" };
const ORG = SA_REFERENCE_ORGANISATION.id;
const ROSEBANK = SA_REFERENCE_LOCATIONS.find(row => row.code === "SA01")!.id;
const TZ = "Africa/Johannesburg";
type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("FAIRSHIFT_DEPLOYMENT_MODE", "HOSTED_SANDBOX_DEMO"); vi.stubEnv("FAIRSHIFT_SANDBOX_ORGANISATION_ID", ORG);
  vi.stubEnv("PAYPAL_ENV", "sandbox"); vi.stubEnv("PAYPAL_ENVIRONMENT", "sandbox");
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

// Demo setup, with the business made entitled as its approved PayPal Sandbox subscription would.
async function setUp(db: Db, now = NOW) {
  await provisionSaDemo(db, { now, range: RANGE });
  await db.insert(subscriptions).values({ id: randomUUID(), organisationId: ORG, requestId: randomUUID() });
  await entitled(db, ORG);
  const result = await provisionSaDemo(db, { now, range: RANGE });
  vi.stubEnv("FAIRSHIFT_PUBLIC_DEMO", "enabled"); vi.stubEnv("FAIRSHIFT_DEMO_ORGANISATION_ID", ORG);
  vi.stubEnv("FAIRSHIFT_DEMO_OWNER_MEMBERSHIP_ID", result.memberships.OWNER); vi.stubEnv("FAIRSHIFT_DEMO_MANAGER_MEMBERSHIP_ID", result.memberships.MANAGER!); vi.stubEnv("FAIRSHIFT_DEMO_WORKER_MEMBERSHIP_ID", result.memberships.WORKER!);
  return result;
}
// The public demo's Owner persona, as requireScope resolves it for a demo session.
async function demoOwner(db: Db, membershipId: string): Promise<Scope> {
  const [owner] = await db.select().from(memberships).where(eq(memberships.id, membershipId));
  return { ...(await resolveScope(db, owner.userId, owner.id, ROSEBANK)), demo: { persona: "OWNER", group: "judge-1" } };
}
const demoAlert = async (db: Db, scope: Scope, at = NOW) => {
  const outlet = (await getWeeklyStaffing(db, scope, at)).outlets.find(row => row.outletId === ROSEBANK)!;
  return { outlet, signal: outlet.localIntelligence!.alerts.find(signal => signal.demo)! };
};
const readAlertFor = (db: Db, scope: Scope, at = NOW) => async (outletId: string, signalKey: string) => {
  const outlet = (await getWeeklyStaffing(db, scope, at)).outlets.find(row => row.outletId === outletId);
  const signal = outlet?.localIntelligence?.alerts.find(row => row.key === signalKey);
  return outlet && signal ? { signal, outletId, outletName: outlet.outletName, timezone: outlet.timezone } : null;
};
const liveBookings = (db: Db) => db.select({ shiftId: shifts.id, shiftDate: shifts.shiftDate, startsAt: shifts.startsAt, endsAt: shifts.endsAt, rateMinor: shifts.rateMinor, currencyCode: shifts.currencyCode, workerId: shiftOffers.workerId, offer: shiftOffers.status, allocation: workAllocations.state })
  .from(workAllocations).innerJoin(shiftOffers, eq(shiftOffers.id, workAllocations.offerId)).innerJoin(shifts, eq(shifts.id, shiftOffers.shiftId))
  .where(and(eq(shifts.outletId, ROSEBANK), eq(shifts.status, "PUBLISHED")));

describe("demo setup books tomorrow's casual shift at Rosebank", () => {
  it("waits for the subscription, then invites the demo team and books tomorrow 10:00–14:00 on the demo terms, once however often it runs", async () => {
    const { db, close } = await createTestDatabase();
    const before = await provisionSaDemo(db, { now: NOW, range: RANGE });
    expect(before).toMatchObject({ organisationId: ORG, entitled: false, memberships: { MANAGER: null, WORKER: null }, booking: null });
    expect(await liveBookings(db)).toEqual([]);

    const result = await setUp(db);
    expect(result).toMatchObject({ entitled: true, booking: { date: "2026-12-02", created: true, workerId: result.workerId } });
    expect(Object.values(result.memberships).every(Boolean)).toBe(true);
    const [worker] = await db.select().from(workers).where(eq(workers.id, result.workerId!));
    expect(worker).toMatchObject({ email: DEMO_ACCOUNTS.WORKER.email, workerType: "CASUAL", locationId: ROSEBANK });
    expect(isSyntheticEmail(worker.email)).toBe(true);
    expect(await liveBookings(db)).toEqual([{ shiftId: result.booking!.shiftId, shiftDate: "2026-12-02", startsAt: new Date("2026-12-02T08:00:00Z"), endsAt: new Date("2026-12-02T12:00:00Z"),
      rateMinor: 4_500, currencyCode: "ZAR", workerId: result.workerId, offer: "ACCEPTED", allocation: "ALLOCATED" }]);

    // Running demo setup again keeps everything as it is.
    const again = await provisionSaDemo(db, { now: NOW, range: RANGE });
    expect(again.memberships).toEqual(result.memberships);
    expect(again.booking).toMatchObject({ shiftId: result.booking!.shiftId, created: false });
    expect(await liveBookings(db)).toHaveLength(1);

    // The DEMO scenario's early notice lists it.
    const { signal } = await demoAlert(db, await demoOwner(db, result.memberships.OWNER));
    expect((await affectedShifts(db, { organisationId: ORG, outletId: ROSEBANK, timezone: TZ }, signal, NOW)).map(row => row.shiftId)).toEqual([result.booking!.shiftId]);
    await close();
  });
});

describe("the public demo's DEMO early notice", () => {
  it("can be sent by the demo Owner persona to the synthetic worker, in the app only, and comes back fresh after Reset demo and re-provisioning", async () => {
    const { db, close } = await createTestDatabase();
    const setup = await setUp(db);
    const owner = await demoOwner(db, setup.memberships.OWNER);
    const { signal } = await demoAlert(db, owner);

    expect(await sendEarlyNotice(db, owner, { outletId: ROSEBANK, signalKey: signal.key }, readAlertFor(db, owner), NOW)).toEqual({ sent: 1, workerIds: [setup.workerId] });
    const [notice] = await db.select().from(notifications).where(eq(notifications.kind, "EARLY_SHIFT_NOTICE"));
    expect(notice).toMatchObject({ workerId: setup.workerId, recipientEmail: DEMO_ACCOUNTS.WORKER.email, entityId: setup.booking!.offerId });
    expect(notice.title).toMatch(/^DEMO: Your shift on Wednesday 2 December may not go ahead/);
    // No email: the delivery is never attempted.
    expect(await db.select({ status: notificationDeliveries.status, providerMessageId: notificationDeliveries.providerMessageId, attemptedAt: notificationDeliveries.attemptedAt }).from(notificationDeliveries).where(eq(notificationDeliveries.notificationId, notice.id)))
      .toEqual([{ status: "PENDING", providerMessageId: null, attemptedAt: null }]);
    const [audit] = await db.select().from(auditEvents).where(eq(auditEvents.action, "EARLY_SHIFT_NOTICE_SENT"));
    expect(audit.metadata).toMatchObject({ sent: 1, demoScenario: true, publicDemo: { persona: "OWNER", group: "judge-1" } });
    await expect(sendEarlyNotice(db, owner, { outletId: ROSEBANK, signalKey: signal.key }, readAlertFor(db, owner), NOW)).rejects.toMatchObject({ feedback: "early-notice-none" });

    // Reset demo closes the unconfirmed booking and books tomorrow again, so the notice can be shown again.
    const reset = await resetDemo(db, demoConfig(), owner, NOW);
    expect(reset.closedShifts).toBeGreaterThanOrEqual(1);
    expect(reset.booking).toMatchObject({ date: "2026-12-02", created: true, workerId: setup.workerId });
    expect(reset.booking!.shiftId).not.toBe(setup.booking!.shiftId);
    expect((await db.select({ status: shifts.status }).from(shifts).where(eq(shifts.id, setup.booking!.shiftId)))[0].status).toBe("CANCELLED");
    expect((await liveBookings(db)).map(row => row.shiftId)).toEqual([reset.booking!.shiftId]);
    expect(await sendEarlyNotice(db, owner, { outletId: ROSEBANK, signalKey: signal.key }, readAlertFor(db, owner), NOW)).toEqual({ sent: 1, workerIds: [setup.workerId] });

    // Re-provisioning keeps the new booking; it is not made twice.
    expect((await provisionSaDemo(db, { now: NOW, range: RANGE })).booking).toMatchObject({ shiftId: reset.booking!.shiftId, created: false });
    expect(await liveBookings(db)).toHaveLength(1);

    // A day later, Reset demo books the new tomorrow (3 December), matching the scenario's date.
    const next = new Date("2026-12-02T06:00:00Z");
    vi.setSystemTime(next);
    const later = await resetDemo(db, demoConfig(), owner, next);
    expect(later.booking).toMatchObject({ date: "2026-12-03", created: true });
    expect((await demoAlert(db, owner, next)).signal.validFrom).toBe("2026-12-03");
    await close();
  });

  it("can't be sent by a demo visitor for a real finding, outside the demo business, or to a worker who isn't synthetic", async () => {
    const { db, close } = await createTestDatabase();
    const setup = await setUp(db);
    const owner = await demoOwner(db, setup.memberships.OWNER);
    const { signal, outlet } = await demoAlert(db, owner);

    // A genuine (non-DEMO) closure alert stays closed to public demo visitors.
    const genuine = async () => ({ signal: { ...signal, demo: false, key: "genuine_closure" }, outletId: ROSEBANK, outletName: outlet.outletName, timezone: TZ });
    await expect(sendEarlyNotice(db, owner, { outletId: ROSEBANK, signalKey: "genuine_closure" }, genuine, NOW)).rejects.toMatchObject({ feedback: "demo-read-only" });
    // A demo session can only act for the configured demo business.
    vi.stubEnv("FAIRSHIFT_DEMO_ORGANISATION_ID", randomUUID());
    await expect(sendEarlyNotice(db, owner, { outletId: ROSEBANK, signalKey: signal.key }, readAlertFor(db, owner), NOW)).rejects.toThrow();
    vi.stubEnv("FAIRSHIFT_DEMO_ORGANISATION_ID", ORG);

    // A worker with a real-looking address, booked tomorrow too, never hears from a demo visitor.
    const site = { organisationId: ORG, locationId: ROSEBANK };
    const real = await createTeamMember(db, { firstName: "Real", surname: "Person", telephone: "+27110000001", email: "real.person@gmail.com" }, site);
    await activateWorker(db, real.worker.id);
    const [booked] = await db.select({ policyId: shifts.policyId, departmentId: shifts.departmentId }).from(shifts).where(eq(shifts.id, setup.booking!.shiftId));
    const shift = await createRequirement(db, { departmentId: booked.departmentId!, policyId: booked.policyId!, startsAt: new Date("2026-12-02T13:00:00Z"), endsAt: new Date("2026-12-02T15:00:00Z"), requiredHeadcount: 1 }, site);
    const offer = await offerAssignment(db, shift.id, real.worker.id, site);
    await respondToAssignment(db, real.worker.id, offer.id, 1, "ACCEPTED", true, site);
    await allocateAssignment(db, offer.id, site);
    expect(await sendEarlyNotice(db, owner, { outletId: ROSEBANK, signalKey: signal.key }, readAlertFor(db, owner), NOW)).toEqual({ sent: 1, workerIds: [setup.workerId] });
    expect((await db.select({ workerId: notifications.workerId }).from(notifications).where(eq(notifications.kind, "EARLY_SHIFT_NOTICE"))).map(row => row.workerId)).toEqual([setup.workerId]);
    await expect(sendEarlyNotice(db, owner, { outletId: ROSEBANK, signalKey: signal.key }, readAlertFor(db, owner), NOW)).rejects.toMatchObject({ feedback: "early-notice-demo-synthetic" });
    await close();
  });
});

describe("synthetic addresses", () => {
  it("recognises only reserved test domains", () => {
    for (const email of ["casual.rosebank@jacaranda-demo.example.test", "a@example.com", "b@sub.example.org", "c@x.invalid", "d@host.localhost", "e@something.example"]) expect(isSyntheticEmail(email)).toBe(true);
    for (const email of ["real.person@gmail.com", "x@example.co.za", "y@testing.com", "z@notexample.com", "", null, undefined]) expect(isSyntheticEmail(email)).toBe(false);
  });
});
