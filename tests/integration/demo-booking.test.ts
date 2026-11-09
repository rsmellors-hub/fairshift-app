import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { entitled } from "../helpers/onboarding";
import { resolveScope, type Scope } from "@/server/auth/access";
import { auditEvents, departments, localIntelligenceDecisions, memberships, workPolicies, notificationDeliveries, notifications, shiftOffers, shifts, subscriptions, users, workAllocations, workers } from "@/server/db/schema";
import { ensureDemoBooking, isSyntheticEmail } from "@/server/demo/booking";
import { JOBS, runDueJobs } from "@/server/scheduler/feeds";
import { changeAssignment, createRequirement } from "@/server/scheduling/operations";
import { demoConfig } from "@/server/demo/config";
import { resetDemo } from "@/server/demo/fixtures";
import { DEMO_ACCOUNTS, provisionSaDemo } from "@/server/demo/provision";
import { JUDGE_ACCOUNTS, provisionJudgeAccounts } from "@/server/demo/judges";
import { ensureDemoRules } from "@/server/demo/settings-seed";
import { enterDemo } from "@/server/demo/session";
import { checkPassword } from "@/server/auth/identity";
import { randomUUID } from "node:crypto";
import { affectedShifts, sendEarlyNotice } from "@/server/intelligence/early-notice";
import { getWeeklyStaffing } from "@/server/intelligence/staffing";
import { DisruptionAlerts } from "@/app/owner/disruption-alerts";
import { renderToStaticMarkup } from "react-dom/server";
import { SA_REFERENCE_LOCATIONS, SA_REFERENCE_ORGANISATION } from "@/server/reference/sa-reference";

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
    // The subscription record checkout starts from, granting nothing until PayPal reports ACTIVE.
    const record = () => db.select().from(subscriptions).where(eq(subscriptions.organisationId, ORG));
    expect(await record()).toEqual([expect.objectContaining({ status: "UNCONFIGURED", providerId: null, planId: null, verifiedAt: null })]);
    await provisionSaDemo(db, { now: NOW, range: RANGE });
    expect(await record()).toHaveLength(1);

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

// Public demo visitors are simulated (Owner decision, 9 November 2026); signed-in accounts of the demo
// business, judges among them, send the DEMO early notice for real, in the app.
async function signedInOwner(db: Db, membershipId: string): Promise<Scope> {
  const [owner] = await db.select().from(memberships).where(eq(memberships.id, membershipId));
  return resolveScope(db, owner.userId, owner.id, ROSEBANK);
}

describe("the DEMO early notice", () => {
  it("is sent by a signed-in Owner of the demo business to the booked worker, in the app only, and comes back fresh after Reset demo and re-provisioning", async () => {
    const { db, close } = await createTestDatabase();
    const setup = await setUp(db);
    const visitor = await demoOwner(db, setup.memberships.OWNER);
    const owner = await signedInOwner(db, setup.memberships.OWNER);
    const { signal } = await demoAlert(db, owner);

    expect(await sendEarlyNotice(db, owner, { outletId: ROSEBANK, signalKey: signal.key }, readAlertFor(db, owner), NOW)).toEqual({ sent: 1, workerIds: [setup.workerId] });
    const [notice] = await db.select().from(notifications).where(eq(notifications.kind, "EARLY_SHIFT_NOTICE"));
    expect(notice).toMatchObject({ workerId: setup.workerId, recipientEmail: DEMO_ACCOUNTS.WORKER.email, entityId: setup.booking!.offerId });
    expect(notice.title).toMatch(/^DEMO: Your shift on Wednesday 2 December may not go ahead/);
    // Nothing is emailed by the notice itself: the delivery waits for dispatch, which refuses the demo business.
    expect(await db.select({ status: notificationDeliveries.status, providerMessageId: notificationDeliveries.providerMessageId, attemptedAt: notificationDeliveries.attemptedAt }).from(notificationDeliveries).where(eq(notificationDeliveries.notificationId, notice.id)))
      .toEqual([{ status: "PENDING", providerMessageId: null, attemptedAt: null }]);
    const [audit] = await db.select().from(auditEvents).where(eq(auditEvents.action, "EARLY_SHIFT_NOTICE_SENT"));
    expect(audit.metadata).toMatchObject({ sent: 1, demoScenario: true, publicDemo: null });
    await expect(sendEarlyNotice(db, owner, { outletId: ROSEBANK, signalKey: signal.key }, readAlertFor(db, owner), NOW)).rejects.toMatchObject({ feedback: "early-notice-none" });

    // Reset demo closes the unconfirmed booking and books tomorrow again, so the notice can be shown again.
    const reset = await resetDemo(db, demoConfig(), visitor, NOW);
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
    const later = await resetDemo(db, demoConfig(), visitor, next);
    expect(later.booking).toMatchObject({ date: "2026-12-03", created: true });
    expect((await demoAlert(db, owner, next)).signal.validFrom).toBe("2026-12-03");
    await close();
  });

  it("is simulated for a public demo visitor: no form, and the server sends nothing", async () => {
    const { db, close } = await createTestDatabase();
    const setup = await setUp(db);
    const visitor = await demoOwner(db, setup.memberships.OWNER);
    const { signal, outlet } = await demoAlert(db, visitor);

    const affected = await affectedShifts(db, { organisationId: ORG, outletId: ROSEBANK, timezone: TZ }, signal, NOW);
    expect(affected).toHaveLength(1);
    const card = (alertSignal: typeof signal, demoVisitor: boolean) => renderToStaticMarkup(DisruptionAlerts({ alerts: [{ outletId: ROSEBANK, outletName: "Rosebank", timezone: TZ, signal: alertSignal, affected }], canSend: !demoVisitor, demoVisitor }));
    for (const shown of [signal, { ...signal, demo: false }]) {
      expect(card(shown, true)).toContain("Simulated in the public demo");
      expect(card(shown, true)).not.toContain("<form");
    }
    // A signed-in Owner gets the form.
    expect(card(signal, false)).toContain("Send early notice to 1 casual worker");
    const genuine = async () => ({ signal: { ...signal, demo: false, key: "genuine_closure" }, outletId: ROSEBANK, outletName: outlet.outletName, timezone: TZ });
    await expect(sendEarlyNotice(db, visitor, { outletId: ROSEBANK, signalKey: signal.key }, readAlertFor(db, visitor), NOW)).rejects.toMatchObject({ feedback: "demo-simulated" });
    await expect(sendEarlyNotice(db, visitor, { outletId: ROSEBANK, signalKey: "genuine_closure" }, genuine, NOW)).rejects.toMatchObject({ feedback: "demo-simulated" });
    expect(await db.select().from(notifications).where(eq(notifications.kind, "EARLY_SHIFT_NOTICE"))).toEqual([]);
    await close();
  });
});

// The hourly rebuild (scheduler job demo:booking and demo entry) keeps whatever a judge did to
// tomorrow's booking until Reset demo: it books a date at most once, and never notifies anyone.
describe("the hourly demo booking rebuild", () => {
  const hourly = (db: Db, at = NOW) => runDueJobs(db as never, { now: () => at, demoOrganisationIds: [ORG], aiSchedule: false, fetchImpl: (async () => { throw new Error("offline"); }) as typeof fetch }, JOBS.filter(job => job.key === "demo:booking"));
  const created = (db: Db) => db.select().from(auditEvents).where(eq(auditEvents.action, "DEMO_BOOKING_CREATED"));
  const tomorrowShifts = (db: Db) => db.select({ id: shifts.id, status: shifts.status }).from(shifts).where(and(eq(shifts.outletId, ROSEBANK), eq(shifts.shiftDate, "2026-12-02")));

  it("creates tomorrow's booking only when there is none, and never a second one however often it runs", async () => {
    const { db, close } = await createTestDatabase();
    const setup = await setUp(db);
    expect(await created(db)).toHaveLength(1);
    for (const minutes of [0, 61, 122]) expect((await hourly(db, new Date(NOW.getTime() + minutes * 60_000)))[0]).toMatchObject({ key: "demo:booking", outcome: "RAN", ok: true });
    for (let i = 0; i < 3; i++) expect(await ensureDemoBooking(db, { organisationId: ORG, now: NOW })).toMatchObject({ shiftId: setup.booking!.shiftId, created: false });
    expect(await tomorrowShifts(db)).toHaveLength(1);
    expect(await created(db)).toHaveLength(1);
    await close();
  });

  it("keeps an early notice a judge sent, and never sends or repeats a notification", async () => {
    const { db, close } = await createTestDatabase();
    const setup = await setUp(db);
    const owner = await signedInOwner(db, setup.memberships.OWNER);
    const { signal } = await demoAlert(db, owner);
    await sendEarlyNotice(db, owner, { outletId: ROSEBANK, signalKey: signal.key }, readAlertFor(db, owner), NOW);
    const [offerBefore] = await db.select().from(shiftOffers).where(eq(shiftOffers.id, setup.booking!.offerId));
    const notificationsBefore = await db.select().from(notifications);
    await hourly(db, new Date(NOW.getTime() + 61 * 60_000));
    await ensureDemoBooking(db, { organisationId: ORG, now: NOW });
    await enterDemo(db, demoConfig(), "OWNER", NOW);
    const [offerAfter] = await db.select().from(shiftOffers).where(eq(shiftOffers.id, setup.booking!.offerId));
    expect(offerAfter).toEqual(offerBefore);
    // Nothing new was notified, and the early notice went once.
    expect(await db.select().from(notifications)).toEqual(notificationsBefore);
    expect(await db.select({ id: notifications.id }).from(notifications).where(eq(notifications.kind, "EARLY_SHIFT_NOTICE"))).toHaveLength(1);
    // The affected-shift list still shows the notice as sent, so the Owner isn't asked again.
    expect((await affectedShifts(db, { organisationId: ORG, outletId: ROSEBANK, timezone: TZ }, signal, NOW))[0].noticeAt).not.toBeNull();
    await close();
  });

  it("doesn't undo a judge's cancellation or a judge's own shift for tomorrow; only Reset demo books again", async () => {
    const { db, close } = await createTestDatabase();
    const setup = await setUp(db);
    const owner = await signedInOwner(db, setup.memberships.OWNER);
    await changeAssignment(db, { organisationId: ORG, locationId: ROSEBANK }, setup.booking!.shiftId, { cancel: true });
    await hourly(db, new Date(NOW.getTime() + 61 * 60_000));
    await enterDemo(db, demoConfig(), "MANAGER", NOW);
    expect(await ensureDemoBooking(db, { organisationId: ORG, now: NOW })).toBeNull();
    expect(await tomorrowShifts(db)).toEqual([{ id: setup.booking!.shiftId, status: "CANCELLED" }]);
    expect(await liveBookings(db)).toEqual([]);
    // Reset demo is the one thing that books tomorrow again.
    const reset = await resetDemo(db, demoConfig(), owner, NOW);
    expect(reset.booking).toMatchObject({ created: true, date: "2026-12-02" });
    expect(await liveBookings(db)).toHaveLength(1);

    // A day later, a judge has already put their own shift on the new tomorrow: the rebuild leaves it be.
    const next = new Date("2026-12-02T06:00:00Z");
    vi.setSystemTime(next);
    const [booked] = await db.select({ policyId: shifts.policyId, departmentId: shifts.departmentId }).from(shifts).where(eq(shifts.id, reset.booking!.shiftId));
    await createRequirement(db, { departmentId: booked.departmentId!, policyId: booked.policyId!, startsAt: new Date("2026-12-03T08:00:00Z"), endsAt: new Date("2026-12-03T12:00:00Z"), requiredHeadcount: 1 }, { organisationId: ORG, locationId: ROSEBANK });
    expect(await ensureDemoBooking(db, { organisationId: ORG, now: next })).toBeNull();
    expect(await db.select({ id: shifts.id }).from(shifts).where(and(eq(shifts.outletId, ROSEBANK), eq(shifts.shiftDate, "2026-12-03")))).toHaveLength(1);
    await close();
  });
});

describe("judges' accounts and a signed-in Reset demo (Owner decision, 9 November 2026)", () => {
  it("creates an Owner, the Rosebank Manager and a Rosebank casual worker with Sandbox pay, once, and only resets passwords when asked", async () => {
    const { db, close } = await createTestDatabase();
    await setUp(db);
    // The demo worker's PayPal Sandbox destination, as demo setup on hosted has it.
    await db.update(workers).set({ paypalPayoutEmail: "sb-demo@personal.example.com" }).where(eq(workers.email, DEMO_ACCOUNTS.WORKER.email));
    const passwords = { OWNER: "o".repeat(24), MANAGER: "m".repeat(24), WORKER: "w".repeat(24) };
    const first = await provisionJudgeAccounts(db, passwords, { now: NOW });
    expect(first.created.sort()).toEqual(["MANAGER", "OWNER", "WORKER"]);
    const rows = await db.select({ email: users.email, role: memberships.role, outletId: memberships.outletId, hash: users.passwordHash }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.organisationId, ORG));
    for (const role of ["OWNER", "MANAGER", "WORKER"] as const) {
      const row = rows.find(item => item.email === JUDGE_ACCOUNTS[role].email)!;
      expect(row.role).toBe(role === "WORKER" ? "TEAM_MEMBER" : role);
      expect(await checkPassword(passwords[role], row.hash)).toBe(true);
    }
    const [judgeWorker] = await db.select().from(workers).where(eq(workers.id, first.workerId!));
    expect(judgeWorker).toMatchObject({ locationId: ROSEBANK, workerType: "CASUAL", paypalPayoutEmail: "sb-demo@personal.example.com" });
    // Running it again keeps the accounts and their passwords.
    const again = await provisionJudgeAccounts(db, { OWNER: "x".repeat(24), MANAGER: "y".repeat(24), WORKER: "z".repeat(24) }, { now: NOW });
    expect(again.created).toEqual([]);
    expect(again.memberships).toEqual(first.memberships);
    const [owner] = await db.select({ hash: users.passwordHash }).from(users).where(eq(users.email, JUDGE_ACCOUNTS.OWNER.email));
    expect(await checkPassword(passwords.OWNER, owner.hash)).toBe(true);
    await expect(provisionJudgeAccounts(db, { OWNER: "short", MANAGER: "y".repeat(24), WORKER: "z".repeat(24) })).rejects.toThrow();
    await close();
  });

  it("lets a signed-in account of the demo business reset it, returning the AI story to its start, but no other business", async () => {
    const { db, close } = await createTestDatabase();
    const setup = await setUp(db);
    const owner = await signedInOwner(db, setup.memberships.OWNER);
    await db.insert(localIntelligenceDecisions).values({ id: randomUUID(), organisationId: ORG, outletId: ROSEBANK, targetDate: "2026-12-04", sequence: 1, action: "ACCEPTED", adjustmentFingerprint: "a".repeat(64), adjustments: [], policyVersion: "v", decidedBy: owner.userId, decidedByRole: "OWNER", decidedAt: NOW });
    const reset = await resetDemo(db, demoConfig(), owner, NOW);
    expect(reset).toMatchObject({ withdrawnDays: 1, restoredSignals: 0 });
    const decisions = await db.select().from(localIntelligenceDecisions);
    expect(decisions.map(row => [row.sequence, row.action]).sort()).toEqual([[1, "ACCEPTED"], [2, "WITHDRAWN"]]);
    const [audit] = await db.select().from(auditEvents).where(eq(auditEvents.action, "DEMO_RESET"));
    expect(audit.metadata).toMatchObject({ signedIn: true, actorUserId: owner.userId, withdrawnDays: 1 });
    vi.stubEnv("FAIRSHIFT_DEMO_ORGANISATION_ID", randomUUID());
    await expect(resetDemo(db, demoConfig(), owner, NOW)).rejects.toThrow();
    await close();
  });

  it("books tomorrow's demo shift when a visitor enters, if the day has rolled over", async () => {
    const { db, close } = await createTestDatabase();
    await setUp(db);
    const next = new Date("2026-12-02T06:00:00Z");
    vi.setSystemTime(next);
    await enterDemo(db, demoConfig(), "OWNER", next);
    expect((await liveBookings(db)).map(row => row.shiftDate)).toContain("2026-12-03");
    await close();
  });
});

describe("demo settings seed", () => {
  it("gives every demo location the demo's casual role and hourly terms once, so a suggested shift can be approved anywhere", async () => {
    const { db, close } = await createTestDatabase();
    await setUp(db);
    await ensureDemoRules(db, ORG);
    const terms = await db.select({ outletId: workPolicies.outletId, model: workPolicies.earningsModel, rate: workPolicies.rateMinor, currency: workPolicies.currencyCode }).from(workPolicies).where(eq(workPolicies.name, "Casual floor terms"));
    expect(terms.map(row => row.outletId).sort()).toEqual(SA_REFERENCE_LOCATIONS.map(row => row.id).sort());
    expect(terms.every(row => row.model === "HOURLY" && row.rate === 4_500 && row.currency === "ZAR")).toBe(true);
    expect((await db.select({ id: departments.id }).from(departments).where(eq(departments.name, "Floor"))).length).toBe(SA_REFERENCE_LOCATIONS.length);
    await close();
  });
});

describe("synthetic addresses", () => {
  it("recognises only reserved test domains", () => {
    for (const email of ["casual.rosebank@jacaranda-demo.example.test", "a@example.com", "b@sub.example.org", "c@x.invalid", "d@host.localhost", "e@something.example"]) expect(isSyntheticEmail(email)).toBe(true);
    for (const email of ["real.person@gmail.com", "x@example.co.za", "y@testing.com", "z@notexample.com", "", null, undefined]) expect(isSyntheticEmail(email)).toBe(false);
  });
});
