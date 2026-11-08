import { sandboxFixture } from "../helpers/sandbox";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { and, eq, inArray } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { entitled } from "../helpers/onboarding";
import { resolveScope } from "@/server/auth/access";
import { issueSession, tokenHash } from "@/server/auth/identity";
import { savePayoutDestination, workerRespond } from "@/server/auth/operations";
import { requireIdentity, requireScope, selectMembership } from "@/server/auth/request";
import { inviteMember, redeemInvitation } from "@/server/auth/tenancy";
import { connectSquare, syncSquare } from "@/server/commerce/square-connection";
import { mapSquareTeamMember } from "@/server/commerce/square-mapping";
import { getDatabase } from "@/server/db/client";
import { auditEvents, identityTokens, memberships, payAgentEvents, organisations, outlets, sessions, shiftOffers, shifts, subscriptions, users, workAcceptances, workAllocations, workPayables, workPayouts, workPerformanceResults } from "@/server/db/schema";
import { demoConfig } from "@/server/demo/config";
import { DEMO_OPEN_SHIFT_LIMIT, resetDemo } from "@/server/demo/fixtures";
import { enterDemo, switchDemoPersona } from "@/server/demo/session";
import { getPayPalPayoutClient } from "@/server/integrations/paypal/factory";
import type { PayPalPayoutAdapter } from "@/server/integrations/paypal/payout-client";
import type { SquareClient } from "@/server/integrations/square/client";
import { createSquareClient } from "@/server/integrations/square/client";
import { approveWorkPayable, refreshWorkPayout, submitWorkPayout } from "@/server/payments/work-payouts";
import { confirmWorkPerformance, getLocationPerformance } from "@/server/performance/attribution";
import { allocateAssignment, confirmWork, createDepartment, createRequirement, createWorkPolicy, offerAssignment } from "@/server/scheduling/operations";
import { enterDemoAction, exitDemoAction, resetDemoAction, switchDemoPersonaAction } from "@/app/demo/actions";
import DemoPage from "@/app/demo/page";
import Account from "@/app/account/page";
import { generateLocationAssessmentAction } from "@/app/intelligence-actions";
import { inviteAction, requestResetAction, requestVerificationAction, selectMembershipAction, signOutAction } from "@/app/auth-actions";
import { allocateAssignmentAction, approvePayableAction, changeAssignmentAction, confirmPerformanceAction, confirmWorkAction, createPolicyAction, createRequirementAction, offerAssignmentAction, refreshPayoutAction, rejectPayAgentHoldAction, releasePayAgentHoldAction, respondAssignmentAction, retryPayAgentAction, saveAvailabilityAction, sendPayoutAction } from "@/app/operations-actions";
import { rescheduleShiftAction } from "@/app/schedule-actions";
import { saveDemoPayoutDestinationAction } from "@/app/scheduling-actions";
import { prepareDemoShiftAction, recordSquareSandboxSaleAction, refreshSquareSalesAction, syncSquareAction } from "@/app/square-actions";
import { dispatchNotification, notify } from "@/server/notifications/service";
import { proxy } from "@/proxy";
import { REQUEST_METHOD_HEADER } from "@/lib/request-method";

const state = vi.hoisted(() => ({ jar: new Map<string, string>(), method: "GET" as string | null }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (key: string) => state.jar.has(key) ? { value: state.jar.get(key)! } : undefined, set: (key: string, value: string) => state.jar.set(key, value), delete: (key: string) => state.jar.delete(key) }),
  headers: async () => ({ get: (key: string) => key === "x-fairshift-request-method" ? state.method : null }),
}));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); }, notFound: () => { throw new Error("NOT_FOUND"); }, usePathname: () => "/worker", useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/db/client", () => ({ getDatabase: vi.fn() }));
vi.mock("@/server/config/env", async original => ({ ...await original<typeof import("@/server/config/env")>(), getConfigurationStatus: () => ({ databaseConfigured: true, aiConfigured: true, paypalConfigured: true, paypalPayoutConfigured: true }) }));
vi.mock("@/server/integrations/paypal/factory", () => ({ getPayPalPayoutClient: vi.fn() }));
vi.mock("@/server/integrations/square/client", async original => ({ ...await original<typeof import("@/server/integrations/square/client")>(), createSquareClient: vi.fn() }));
vi.mock("@/server/notifications/email", async original => ({ ...await original<typeof import("@/server/notifications/email")>(), getEmailAdapter: () => ({ send: async () => ({ status: "UNCONFIGURED" }) }) }));

vi.setConfig({ testTimeout: 180_000 });
const PREPARED = new Date("2026-01-19T12:00:00Z"), LATER = new Date("2026-01-20T12:00:00Z");
type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];
const withDb = async (run: (db: Db) => Promise<void>) => { const t = await createTestDatabase(); try { vi.mocked(getDatabase).mockReturnValue(t.db); await run(t.db); } finally { await t.close(); } };
const form = (values: Record<string, string>) => { const result = new FormData(); for (const [k, v] of Object.entries(values)) result.set(k, v); return result; };
// Every action ends in a redirect, so a call reports where it went.
const outcome = async (action: () => Promise<unknown>) => { try { await action(); return "returned"; } catch (error) { return (error as Error).message; } };

let n = 0;
async function person(db: Db) {
  const id = randomUUID(), email = `demo-${++n}-${randomUUID().slice(0, 6)}@example.test`;
  await db.insert(users).values({ id, email, name: "Person", passwordHash: "x", emailVerifiedAt: new Date() });
  return { id, email };
}
async function business(db: Db, name: string) {
  const organisationId = randomUUID();
  await db.insert(organisations).values({ id: organisationId, name, country: "United Kingdom" });
  await db.insert(subscriptions).values({ id: randomUUID(), organisationId, requestId: randomUUID() });
  await entitled(db, organisationId);
  const locationId = randomUUID();
  await db.insert(outlets).values({ id: locationId, organisationId, name: "Northgate", timezone: "Europe/London", country: "United Kingdom" });
  const owner = await person(db), ownerMembership = randomUUID();
  await db.insert(memberships).values({ id: ownerMembership, userId: owner.id, organisationId, role: "OWNER" });
  const ownerScope = await resolveScope(db, owner.id, ownerMembership, locationId);
  const invite = async (role: "MANAGER" | "TEAM_MEMBER") => {
    const member = await person(db);
    const { token } = await inviteMember(db, ownerScope, { role, email: member.email, firstName: "Casey", surname: "Person", telephone: "+441130000000" });
    const membership = await redeemInvitation(db, member.id, { token });
    return { membership, email: member.email, scope: await resolveScope(db, member.id, membership.id) };
  };
  return { organisationId, locationId, ownerMembership, ownerScope, owner, invite };
}

// The demo business, with one earlier shift taken all the way to Paid. Provider clients are fixtures.
async function prepared(db: Db) {
  vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
  const b = await business(db, "Demo retailer");
  sandboxFixture(b.organisationId);
  const manager = await b.invite("MANAGER"), worker = await b.invite("TEAM_MEMBER");
  const [department] = await createDepartment(db, "Sales floor", b.ownerScope);
  const [policy] = await createWorkPolicy(db, { earningsModel: "DAILY", rateMinor: 9_600, incentiveTargetMinor: 20_000, incentiveBonusMinor: 2_500 }, "Golden Path terms", b.ownerScope);
  const square = {
    locations: vi.fn(async () => [{ id: "SQ-LOC", merchant_id: "SQ-MERCHANT", status: "ACTIVE", currency: "GBP" }]),
    teamMembers: vi.fn(async () => [{ id: "TM-A", name: "Sandbox A" }]),
    payments: vi.fn(async () => ({ items: [{ id: "P0", status: "COMPLETED", location_id: "SQ-LOC", created_at: "2026-01-16T15:00:00.000Z", amount_money: { amount: 20_000, currency: "GBP" }, team_member_id: "TM-A" }], cursor: null })),
    refunds: vi.fn(async () => ({ items: [], cursor: null })),
    createSandboxPayment: vi.fn(),
  } as unknown as SquareClient;
  await connectSquare(db, b.ownerScope, { outletId: b.locationId }, square, { applicationId: "fixture-app", accessToken: "fixture-token" });
  await mapSquareTeamMember(db, manager.scope, { workerId: worker.scope.workerId!, teamMemberId: "TM-A" }, square);
  await savePayoutDestination(db, worker.scope, "casey.sandbox@example.test");
  const shift = await createRequirement(db, { departmentId: department.id, policyId: policy.id, startsAt: new Date("2026-01-16T14:00:00Z"), endsAt: new Date("2026-01-16T20:00:00Z"), requiredHeadcount: 1 }, manager.scope);
  const offer = await offerAssignment(db, shift.id, worker.scope.workerId!, manager.scope);
  await workerRespond(db, worker.scope, offer.id, 1, "ACCEPTED", true);
  const allocation = await allocateAssignment(db, offer.id, manager.scope);
  vi.setSystemTime(PREPARED);
  await syncSquare(db, b.ownerScope, b.locationId, square, PREPARED);
  const payable = (await confirmWork(db, offer.id, manager.scope)).payable!;
  await confirmWorkPerformance(db, manager.scope, allocation.id, (await getLocationPerformance(db, manager.scope))[0].attributed);
  await approveWorkPayable(db, manager.scope, payable.id);
  const paypal = {
    createPayout: vi.fn<PayPalPayoutAdapter["createPayout"]>(async () => ({ batchId: "PPB-1", itemId: null, status: "PENDING", batchStatus: "PENDING", itemStatus: null, transactionId: null })),
    getPayout: vi.fn<PayPalPayoutAdapter["getPayout"]>(async batchId => ({ batchId, itemId: "PPI-1", status: "SUCCESS", batchStatus: "SUCCESS", itemStatus: "SUCCESS", transactionId: "PPT-1", itemAmount: { value: "121.00", currency: "GBP" } })),
  };
  await submitWorkPayout(db, paypal, manager.scope, payable.id);
  await refreshWorkPayout(db, paypal, manager.scope, payable.id);
  paypal.createPayout.mockClear(); paypal.getPayout.mockClear();
  vi.mocked(getPayPalPayoutClient).mockReturnValue(paypal as never);
  vi.setSystemTime(LATER);
  vi.stubEnv("FAIRSHIFT_PUBLIC_DEMO", "enabled");
  vi.stubEnv("FAIRSHIFT_DEMO_ORGANISATION_ID", b.organisationId);
  vi.stubEnv("FAIRSHIFT_DEMO_OWNER_MEMBERSHIP_ID", b.ownerMembership);
  vi.stubEnv("FAIRSHIFT_DEMO_MANAGER_MEMBERSHIP_ID", manager.membership.id);
  vi.stubEnv("FAIRSHIFT_DEMO_WORKER_MEMBERSHIP_ID", worker.membership.id);
  return { ...b, manager, worker, department, policy, shift, offer, allocation, payable, paypal, square };
}
type Prepared = Awaited<ReturnType<typeof prepared>>;

// Enter as a persona and make that session the browser's.
async function as(db: Db, persona: "OWNER" | "MANAGER" | "WORKER", method: "GET" | "POST" = "POST") {
  const session = await enterDemo(db, demoConfig(), persona);
  state.jar.set("fairshift_session", session.token); state.jar.set("fairshift_demo", "1"); state.method = method;
  return session;
}
const evidence = async (db: Db, p: Prepared) => JSON.stringify({
  shift: await db.select().from(shifts).where(eq(shifts.id, p.shift.id)),
  offer: await db.select().from(shiftOffers).where(eq(shiftOffers.id, p.offer.id)),
  allocation: await db.select().from(workAllocations).where(eq(workAllocations.id, p.allocation.id)),
  payable: await db.select().from(workPayables).where(eq(workPayables.id, p.payable.id)),
  payout: await db.select().from(workPayouts).where(eq(workPayouts.payableId, p.payable.id)),
  performance: await db.select().from(workPerformanceResults).where(eq(workPerformanceResults.shiftId, p.shift.id)),
});
const newShift = (p: Prepared, day = "2026-02-02") => form({ departmentId: p.department.id, policyId: p.policy.id, startsAt: `${day}T14:00`, endsAt: `${day}T20:00`, headcount: "1", planDate: "", planDepartment: "" });
const openShifts = (db: Db, p: Prepared) => db.select().from(shifts).where(and(eq(shifts.outletId, p.locationId), eq(shifts.status, "PUBLISHED")));

beforeEach(() => { vi.useFakeTimers({ now: new Date("2026-01-15T12:00:00Z"), toFake: ["Date"] }); vi.stubEnv("COMMERCE_CREDENTIAL_KEY", "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE="); state.jar.clear(); state.method = "GET"; });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("demo sessions under concurrency (SHARED-BUT-RESETTABLE)", () => {
  it("1. two sessions enter at once, each with its own server-side session", () => withDb(async db => {
    await prepared(db);
    const [a, b] = await Promise.all([enterDemo(db, demoConfig(), "WORKER"), enterDemo(db, demoConfig(), "OWNER")]);
    expect(a.token).not.toBe(b.token);
    const rows = await db.select().from(sessions).where(inArray(sessions.tokenHash, [tokenHash(a.token), tokenHash(b.token)]));
    expect(rows.map(row => row.demoPersona).sort()).toEqual(["OWNER", "WORKER"]);
    expect(rows[0].demoGroup).not.toBe(rows[1].demoGroup);
    for (const row of rows) expect(row.expiresAt.getTime() - LATER.getTime()).toBe(2 * 3_600_000);
    for (const [session, role] of [[a, "TEAM_MEMBER"], [b, "OWNER"]] as const) { state.jar.set("fairshift_session", session.token); expect((await requireScope(["OWNER", "MANAGER", "TEAM_MEMBER"])).role).toBe(role); }
  }));

  it("2. a worker accepts while another session stays active, and both see the same shared state", () => withDb(async db => {
    const p = await prepared(db);
    const other = await enterDemo(db, demoConfig(), "WORKER");
    await as(db, "MANAGER");
    expect(await outcome(() => createRequirementAction(newShift(p)))).toContain("status=saved");
    const [shift] = (await openShifts(db, p)).filter(row => row.id !== p.shift.id);
    expect(await outcome(() => offerAssignmentAction(form({ shiftId: shift.id, workerId: p.worker.scope.workerId!, planDate: "", planDepartment: "" })))).toContain("status=saved");
    const [offer] = await db.select().from(shiftOffers).where(eq(shiftOffers.shiftId, shift.id));
    await as(db, "WORKER");
    expect(await outcome(() => respondAssignmentAction(form({ offerId: offer.id, termsVersion: String(shift.termsVersion), response: "ACCEPTED", acknowledged: "yes" })))).toContain("status=saved");
    expect((await db.select().from(shiftOffers).where(eq(shiftOffers.id, offer.id)))[0].status).toBe("ACCEPTED");
    state.jar.set("fairshift_session", other.token); state.method = "GET";
    expect((await requireScope(["TEAM_MEMBER"])).demo?.persona).toBe("WORKER");
  }));

  it("3. one session switches persona on the server while another stays Worker, and a repeat or slow switch can't strand it", () => withDb(async db => {
    await prepared(db);
    const stays = await enterDemo(db, demoConfig(), "WORKER");
    const moves = await as(db, "WORKER", "GET");
    await Promise.all([switchDemoPersona(db, demoConfig(), moves.token, "MANAGER"), switchDemoPersona(db, demoConfig(), moves.token, "MANAGER")]);
    state.jar.set("fairshift_session", moves.token);
    expect((await requireScope(["MANAGER"])).demo?.persona).toBe("MANAGER");
    expect(await outcome(() => requireScope(["TEAM_MEMBER"]))).toBe("REDIRECT:/manager?status=demo-read-only");
    const [row] = await db.select().from(sessions).where(eq(sessions.tokenHash, tokenHash(moves.token)));
    expect(row.expiresAt.getTime()).toBe(moves.expiresAt.getTime());
    state.jar.set("fairshift_session", stays.token);
    expect((await requireScope(["TEAM_MEMBER"])).demo?.persona).toBe("WORKER");
    const logged = await db.select().from(auditEvents).where(eq(auditEvents.action, "DEMO_PERSONA_SWITCHED"));
    expect(logged[0]).toMatchObject({ entityType: "demo_session", metadata: { from: "WORKER", persona: "MANAGER" } });
    expect(JSON.stringify(logged)).not.toMatch(/@|userId/);
  }));

  it("4. reset never touches another organisation", () => withDb(async db => {
    const p = await prepared(db), other = await business(db, "Someone else");
    const [department] = await createDepartment(db, "Floor", other.ownerScope);
    const [policy] = await createWorkPolicy(db, { earningsModel: "DAILY", rateMinor: 9_600 }, "Terms", other.ownerScope);
    const shift = await createRequirement(db, { departmentId: department.id, policyId: policy.id, startsAt: new Date("2026-02-02T14:00:00Z"), endsAt: new Date("2026-02-02T20:00:00Z"), requiredHeadcount: 1 }, other.ownerScope);
    await as(db, "MANAGER");
    expect(await outcome(() => resetDemoAction())).toContain("status=demo-reset");
    expect((await db.select().from(shifts).where(eq(shifts.id, shift.id)))[0].status).toBe("PUBLISHED");
    expect((await openShifts(db, p)).filter(row => row.id !== p.shift.id)).toEqual([]);
  }));

  it("5. repeated reset gives the same state, keeps immutable acceptance evidence and keeps the prepared shift", () => withDb(async db => {
    const p = await prepared(db), before = await evidence(db, p);
    await as(db, "MANAGER");
    await createRequirementAction(newShift(p)).catch(() => undefined);
    await createRequirementAction(newShift(p, "2026-02-03")).catch(() => undefined);
    const [accepted, offered] = (await openShifts(db, p)).filter(row => row.id !== p.shift.id);
    for (const shift of [accepted, offered]) await offerAssignmentAction(form({ shiftId: shift.id, workerId: p.worker.scope.workerId!, planDate: "", planDepartment: "" })).catch(() => undefined);
    const [offer] = await db.select().from(shiftOffers).where(eq(shiftOffers.shiftId, accepted.id));
    await workerRespond(db, p.worker.scope, offer.id, accepted.termsVersion, "ACCEPTED", true);
    await allocateAssignment(db, offer.id, p.manager.scope);
    const acceptances = await db.select().from(workAcceptances).where(eq(workAcceptances.offerId, offer.id));
    expect(acceptances).toHaveLength(1);
    const scope = await requireScope(["MANAGER"], { demoWrite: true });
    expect((await resetDemo(db, demoConfig(), scope)).closedShifts).toBe(2);
    const snapshot = async () => ({ all: await db.select().from(shifts), offers: await db.select().from(shiftOffers), evidence: await evidence(db, p) });
    const once = await snapshot();
    expect((await resetDemo(db, demoConfig(), scope)).closedShifts).toBe(0);
    expect(await snapshot()).toEqual(once);
    expect(once.evidence).toBe(before);
    expect((await openShifts(db, p)).filter(row => row.id !== p.shift.id)).toEqual([]);
    expect(await db.select().from(workAcceptances).where(eq(workAcceptances.offerId, offer.id))).toEqual(acceptances);
    expect((await db.select().from(shiftOffers).where(eq(shiftOffers.id, offer.id)))[0].status).toBe("CANCELLED");
    expect((await db.select().from(auditEvents).where(eq(auditEvents.action, "DEMO_RESET"))).map(row => (row.metadata as { closedShifts: number }).closedShifts)).toEqual([2, 0]);
    expect(await outcome(() => createRequirementAction(newShift(p, "2026-02-04")))).toContain("status=saved");
    expect((await openShifts(db, p)).filter(row => row.id !== p.shift.id)).toHaveLength(1);
  }));

  it("demo activity never becomes email, while another organisation's still does", () => withDb(async db => {
    const p = await prepared(db), other = await business(db, "Someone else");
    const send = vi.fn(async () => ({ status: "ACCEPTED" as const, messageId: "m" }));
    const note = async (organisationId: string) => { const id = randomUUID(); await notify(db, { id, organisationId, recipientEmail: "x@example.test", eventKey: `test:${id}`, kind: "SHIFT_OFFER", entityId: id, title: "T", body: "B", href: "/worker" }); return id; };
    await dispatchNotification(db, { send }, await note(p.organisationId));
    expect(send).not.toHaveBeenCalled();
    await dispatchNotification(db, { send }, await note(other.organisationId));
    expect(send).toHaveBeenCalledTimes(1);
  }));
});

describe("forged demo requests", () => {
  it("6-9 and 22. only the persona name is read; organisation, user, membership and role in a request are ignored", () => withDb(async db => {
    const p = await prepared(db), other = await business(db, "Someone else");
    expect(await outcome(() => enterDemoAction(form({ persona: "ADMIN" })))).toBe("REDIRECT:/demo?status=unavailable");
    expect(await outcome(() => enterDemoAction(form({ persona: "" })))).toBe("REDIRECT:/demo?status=unavailable");
    await expect(enterDemo(db, demoConfig(), "owner")).rejects.toThrow();
    await expect(enterDemo(db, demoConfig(), { persona: "OWNER" })).rejects.toThrow();
    expect(state.jar.has("fairshift_session")).toBe(false);
    expect(await outcome(() => enterDemoAction(form({ persona: "WORKER", organisationId: other.organisationId, userId: other.owner.id, membershipId: other.ownerMembership, email: other.owner.email, role: "OWNER" })))).toBe("REDIRECT:/worker");
    state.method = "GET";
    expect(await requireScope(["TEAM_MEMBER"])).toMatchObject({ organisationId: p.organisationId, userId: p.worker.scope.userId, role: "TEAM_MEMBER" });
    // Forged location: a cookie naming another organisation's location is refused.
    await as(db, "OWNER", "GET");
    state.jar.set("fairshift_location", other.locationId);
    await expect(requireScope(["OWNER"])).rejects.toThrow("Access denied");
    // A manager's location never comes from the request at all.
    await as(db, "MANAGER", "GET");
    state.jar.set("fairshift_location", other.locationId);
    expect((await requireScope(["MANAGER"])).locationId).toBe(p.locationId);
  }));

  it("the method header comes from the proxy, and a client can't choose it", async () => {
    const response = proxy(new NextRequest("http://localhost/worker", { method: "POST", headers: { [REQUEST_METHOD_HEADER]: "GET" } }));
    expect(response.headers.get(`x-middleware-request-${REQUEST_METHOD_HEADER}`)).toBe("POST");
  });

  it("a plain form POST and a missing method header both count as writes", () => withDb(async db => {
    await prepared(db);
    await as(db, "MANAGER", "POST");
    expect(await outcome(() => requireScope(["MANAGER"]))).toBe("REDIRECT:/manager?status=demo-read-only");
    state.method = null;
    expect(await outcome(() => requireScope(["MANAGER"]))).toBe("REDIRECT:/manager?status=demo-read-only");
    state.method = "GET";
    expect((await requireScope(["MANAGER"])).demo?.persona).toBe("MANAGER");
  }));
});

describe("demo and normal sessions stay separate", () => {
  it("10. a normal account can't turn itself into a demo session", () => withDb(async db => {
    const p = await prepared(db), token = await issueSession(db, p.owner.id);
    state.jar.set("fairshift_session", token);
    expect(await outcome(() => switchDemoPersonaAction(form({ persona: "OWNER" })))).toBe("REDIRECT:/demo?status=expired");
    await expect(switchDemoPersona(db, demoConfig(), token, "WORKER")).rejects.toThrow();
    const [row] = await db.select().from(sessions).where(eq(sessions.tokenHash, tokenHash(token)));
    expect(row).toMatchObject({ demoPersona: null, demoGroup: null });
    expect((await requireScope(["OWNER"])).demo).toBeUndefined();
  }));

  it("11. a demo session can't become a normal one", () => withDb(async db => {
    const p = await prepared(db), session = await as(db, "OWNER");
    expect(await outcome(() => selectMembership(p.ownerMembership))).toBe("REDIRECT:/owner?status=demo-read-only");
    expect(await outcome(() => selectMembershipAction(form({ membershipId: p.ownerMembership })))).toBe("REDIRECT:/owner?status=demo-read-only");
    expect(await outcome(() => requireIdentity())).toBe("REDIRECT:/owner?status=demo-read-only");
    expect((await db.select().from(sessions).where(eq(sessions.tokenHash, tokenHash(session.token))))[0].demoPersona).toBe("OWNER");
    expect(await outcome(() => exitDemoAction())).toBe("REDIRECT:/demo");
    expect(state.jar.has("fairshift_session")).toBe(false);
  }));

  it("12. a demo Worker can't reach a Manager page or action", () => withDb(async db => {
    const p = await prepared(db);
    await as(db, "WORKER", "GET");
    expect(await outcome(() => requireScope(["OWNER", "MANAGER"]))).toBe("REDIRECT:/worker?status=demo-read-only");
    state.method = "POST";
    const before = (await db.select().from(shifts)).length;
    expect(await outcome(() => createRequirementAction(newShift(p)))).toBe("REDIRECT:/worker?status=demo-read-only");
    expect(await outcome(() => allocateAssignmentAction(form({ offerId: p.offer.id })))).toBe("REDIRECT:/worker?status=demo-read-only");
    expect(await db.select().from(shifts)).toHaveLength(before);
  }));

  it("13. a demo Manager can't reach an Owner page or action", () => withDb(async db => {
    await prepared(db);
    await as(db, "MANAGER", "GET");
    expect(await outcome(() => requireScope(["OWNER"]))).toBe("REDIRECT:/manager?status=demo-read-only");
    state.method = "POST";
    expect(await outcome(() => createPolicyAction(form({ name: "Forged", earningsModel: "DAILY", rate: "500.00" })))).toBe("REDIRECT:/manager?status=demo-read-only");
    expect(await outcome(() => inviteAction(form({ role: "MANAGER", email: "x@example.test", firstName: "X", surname: "Y", telephone: "+441130000000" })))).toBe("REDIRECT:/manager?status=demo-read-only");
  }));

  it("14. a demo session can't reach account or password operations", () => withDb(async db => {
    const p = await prepared(db);
    await as(db, "OWNER");
    expect(await outcome(() => Account({ searchParams: Promise.resolve({}) }))).toBe("REDIRECT:/owner?status=demo-read-only");
    expect(await outcome(() => requestVerificationAction())).toBe("REDIRECT:/owner?status=demo-read-only");
    expect(await outcome(() => saveDemoPayoutDestinationAction(form({ payoutEmail: "forged@example.test" })))).toContain("REDIRECT:/owner");
    await as(db, "WORKER");
    expect(await outcome(() => saveDemoPayoutDestinationAction(form({ payoutEmail: "forged@example.test" })))).toBe("REDIRECT:/worker?status=demo-read-only");
    expect(await outcome(() => saveAvailabilityAction(form({ day1: "UNAVAILABLE" })))).toBe("REDIRECT:/worker?status=demo-read-only");
    expect(await outcome(() => requestResetAction(form({ email: p.manager.email })))).toBe("REDIRECT:/sign-in?status=reset-requested");
    expect(await db.select().from(identityTokens).where(eq(identityTokens.purpose, "RESET_PASSWORD"))).toHaveLength(0);
    expect(await outcome(() => signOutAction())).toBe("REDIRECT:/sign-in");
  }));
});

describe("prepared evidence and providers", () => {
  it("15. the prepared completed and paid shift can't be changed by any route", () => withDb(async db => {
    const p = await prepared(db), before = await evidence(db, p), agentEvents = (await db.select().from(payAgentEvents)).length;
    await as(db, "MANAGER");
    expect(await outcome(() => changeAssignmentAction(form({ shiftId: p.shift.id, cancel: "yes", planDate: "", planDepartment: "" })))).toContain("status=demo-protected");
    expect(await outcome(() => changeAssignmentAction(form({ shiftId: p.shift.id, startsAt: "2026-02-02T09:00", endsAt: "2026-02-02T10:00", planDate: "", planDepartment: "" })))).toContain("status=demo-protected");
    expect(await outcome(() => allocateAssignmentAction(form({ offerId: p.offer.id })))).toContain("status=demo-protected");
    expect(await outcome(() => offerAssignmentAction(form({ shiftId: p.shift.id, workerId: p.worker.scope.workerId!, planDate: "", planDepartment: "" })))).toContain("status=demo-protected");
    expect(await rescheduleShiftAction({ shiftId: p.shift.id, expectedTermsVersion: 1, startsAt: "2026-02-02T09:00", endsAt: "2026-02-02T10:00", source: "CHANGE", acknowledgeReacceptance: true })).toMatchObject({ ok: false, code: "demo-protected" });
    for (const action of [
      () => confirmWorkAction(form({ offerId: p.offer.id, confirmed: "yes" })),
      () => confirmPerformanceAction(form({ allocationId: p.allocation.id, complete: "yes", seenCount: "0", seenMinor: "0" })),
      () => approvePayableAction(form({ payableId: p.payable.id })),
      // The Pay Agent's own controls: a public demo visitor can't start, release or reject a settlement.
      () => retryPayAgentAction(form({ payableId: p.payable.id })),
      () => releasePayAgentHoldAction(form({ eventId: randomUUID() })),
      () => rejectPayAgentHoldAction(form({ eventId: randomUUID(), reason: "Demo visitor" })),
    ]) expect(await outcome(action)).toBe("REDIRECT:/manager?status=demo-read-only");
    expect(await db.select().from(payAgentEvents)).toHaveLength(agentEvents);
    expect(p.paypal.createPayout).not.toHaveBeenCalled();
    await as(db, "WORKER");
    expect(await outcome(() => respondAssignmentAction(form({ offerId: p.offer.id, termsVersion: "1", response: "DECLINED", acknowledged: "yes" })))).toContain("status=demo-protected");
    expect(await evidence(db, p)).toBe(before);
    const scope = await requireScope(["TEAM_MEMBER"], { demoWrite: true });
    await resetDemo(db, demoConfig(), scope);
    expect(await evidence(db, p)).toBe(before);
  }));

  it("16-17. the prepared payout can't be resent, and repeated requests never reach PayPal", () => withDb(async db => {
    const p = await prepared(db), before = await evidence(db, p);
    await as(db, "MANAGER");
    for (let i = 0; i < 5; i++) {
      expect(await outcome(() => sendPayoutAction(form({ payableId: p.payable.id })))).toBe("REDIRECT:/manager?status=demo-read-only");
      expect(await outcome(() => refreshPayoutAction(form({ payableId: p.payable.id })))).toBe("REDIRECT:/manager?status=demo-read-only");
    }
    expect(p.paypal.createPayout).not.toHaveBeenCalled();
    expect(p.paypal.getPayout).not.toHaveBeenCalled();
    expect(await db.select().from(workPayouts)).toHaveLength(1);
    expect(await evidence(db, p)).toBe(before);
  }));

  it("18. the public demo can't create Square Sandbox payments or call Square at all", () => withDb(async db => {
    const p = await prepared(db);
    vi.stubEnv("FAIRSHIFT_DEMO_TOOLS", "enabled");
    vi.mocked(createSquareClient).mockReturnValue(p.square);
    vi.mocked(p.square.payments).mockClear();
    await as(db, "MANAGER");
    for (let i = 0; i < 3; i++) expect(await outcome(() => recordSquareSandboxSaleAction(form({ workerId: p.worker.scope.workerId!, amount: "12.50", requestId: randomUUID() })))).toBe("REDIRECT:/manager?status=demo-read-only");
    expect(await outcome(() => prepareDemoShiftAction(form({ workerId: p.worker.scope.workerId!, minutesUntilEnd: "15" })))).toBe("REDIRECT:/manager?status=demo-read-only");
    expect(await outcome(() => refreshSquareSalesAction())).toBe("REDIRECT:/manager?status=demo-read-only");
    await as(db, "OWNER");
    expect(await outcome(() => syncSquareAction(form({ outletId: p.locationId })))).toBe("REDIRECT:/owner?status=demo-read-only");
    expect(p.square.createSandboxPayment).not.toHaveBeenCalled();
    expect(p.square.payments).not.toHaveBeenCalled();
    expect(createSquareClient).not.toHaveBeenCalled();
  }));

  it("AI generation stays outside the demo, so visitors can't spend provider calls", () => withDb(async db => {
    await prepared(db);
    await as(db, "MANAGER");
    expect(await outcome(() => generateLocationAssessmentAction())).toBe("REDIRECT:/manager?status=demo-read-only");
  }));

  it("caps open demo shifts and rate-limits writes per session", () => withDb(async db => {
    const p = await prepared(db);
    await as(db, "MANAGER");
    for (let i = 0; i < DEMO_OPEN_SHIFT_LIMIT - 1; i++) await createRequirementAction(newShift(p, `2026-03-${String(i + 1).padStart(2, "0")}`)).catch(() => undefined);
    expect(await outcome(() => createRequirementAction(newShift(p, "2026-04-01")))).toContain("status=saved");
    expect(await outcome(() => createRequirementAction(newShift(p, "2026-04-02")))).toContain("status=demo-full");
    for (let i = 0; i < 60; i++) await changeAssignmentAction(form({ shiftId: randomUUID(), cancel: "yes", planDate: "", planDepartment: "" })).catch(() => undefined);
    expect(await outcome(() => changeAssignmentAction(form({ shiftId: randomUUID(), cancel: "yes", planDate: "", planDepartment: "" })))).toContain("status=demo-limit");
  }));
});

describe("demo session lifetime and the feature flag", () => {
  it("19. an expired demo session fails safely, and switching can't revive it", () => withDb(async db => {
    await prepared(db);
    const session = await as(db, "WORKER", "GET");
    vi.setSystemTime(new Date(LATER.getTime() + 2 * 3_600_000 + 1_000));
    expect(await outcome(() => requireScope(["TEAM_MEMBER"]))).toBe("REDIRECT:/demo?status=expired");
    await expect(switchDemoPersona(db, demoConfig(), session.token, "OWNER")).rejects.toThrow();
    expect(await outcome(() => switchDemoPersonaAction(form({ persona: "OWNER" })))).toBe("REDIRECT:/demo?status=expired");
    state.jar.delete("fairshift_demo");
    expect(await outcome(() => requireScope(["TEAM_MEMBER"]))).toBe("REDIRECT:/sign-in");
  }));

  it("20. turning the flag off removes public demo access", () => withDb(async db => {
    await prepared(db);
    const open = renderToStaticMarkup(await DemoPage({ searchParams: Promise.resolve({}) }));
    expect(open).toContain("Start as the Owner");
    expect(open).toContain("prepared demonstration business");
    const judges = "Judges: use this public demo. On this PayPal Sandbox deployment, new business sign-up is limited to the Sandbox demo business, by design";
    expect(open).toContain(judges);
    const session = await as(db, "WORKER", "GET");
    vi.stubEnv("FAIRSHIFT_PUBLIC_DEMO", "");
    expect(demoConfig()).toBeNull();
    const closed = renderToStaticMarkup(await DemoPage({ searchParams: Promise.resolve({}) }));
    expect(closed).toContain("The demo isn’t open right now.");
    expect(closed).not.toContain("Start as the Owner");
    expect(closed).toContain(judges);
    expect(await outcome(() => enterDemoAction(form({ persona: "OWNER" })))).toBe("REDIRECT:/demo?status=unavailable");
    state.jar.set("fairshift_session", session.token);
    expect(await outcome(() => requireScope(["TEAM_MEMBER"]))).toBe("REDIRECT:/demo?status=unavailable");
  }));

  it("21. reset fails closed when demo mode is off, for a normal session, and on incomplete configuration", () => withDb(async db => {
    const p = await prepared(db);
    await as(db, "MANAGER");
    const scope = await requireScope(["MANAGER"], { demoWrite: true });
    await createRequirementAction(newShift(p)).catch(() => undefined);
    const count = (await db.select().from(shifts)).length;
    await expect(resetDemo(db, null, scope)).rejects.toThrow("Access denied");
    await expect(resetDemo(db, demoConfig(), p.manager.scope)).rejects.toThrow("Access denied");
    vi.stubEnv("FAIRSHIFT_PUBLIC_DEMO", "");
    expect(await outcome(() => resetDemoAction())).toBe("REDIRECT:/demo?status=unavailable");
    vi.stubEnv("FAIRSHIFT_PUBLIC_DEMO", "enabled"); vi.stubEnv("FAIRSHIFT_DEMO_WORKER_MEMBERSHIP_ID", "not-a-uuid");
    expect(demoConfig()).toBeNull();
    expect(await db.select().from(shifts)).toHaveLength(count);
  }));

  it("closes the demo if a configured membership isn't what it should be", () => withDb(async db => {
    const p = await prepared(db), other = await business(db, "Someone else");
    vi.stubEnv("FAIRSHIFT_DEMO_OWNER_MEMBERSHIP_ID", other.ownerMembership);
    await expect(enterDemo(db, demoConfig(), "OWNER")).rejects.toThrow();
    vi.stubEnv("FAIRSHIFT_DEMO_OWNER_MEMBERSHIP_ID", p.manager.membership.id);
    expect(demoConfig()).toBeNull();
  }));
});

describe("default deny", () => {
  it("only the named actions opt in to demo writes, and no other server code does", async () => {
    const files = ["auth-actions", "operations-actions", "schedule-actions", "scheduling-actions", "square-actions", "intelligence-actions", "operator/actions"];
    const named: string[] = [];
    for (const file of files) {
      const source = await readFile(`src/app/${file}.ts`, "utf8");
      for (const line of source.split("\n").entries()) if (line[1].includes("demoWrite")) { const before = source.split("\n").slice(0, line[0] + 1).reverse().find(text => /export async function (\w+)/.test(text)); named.push(/export async function (\w+)/.exec(before!)![1]); }
    }
    expect(named.sort()).toEqual(["allocateAssignmentAction", "changeAssignmentAction", "createRequirementAction", "offerAssignmentAction", "rescheduleShiftAction", "respondAssignmentAction", "selectLocationAction"]);
  });
});
