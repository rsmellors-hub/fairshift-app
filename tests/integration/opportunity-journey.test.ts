import { sandboxFixture } from "../helpers/sandbox";
import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { entitled } from "../helpers/onboarding";
import { resolveScope, type Scope } from "@/server/auth/access";
import { saveWorkerAvailability, savePayoutDestination, workerRespond } from "@/server/auth/operations";
import { requireScope } from "@/server/auth/request";
import { inviteMember, redeemInvitation } from "@/server/auth/tenancy";
import { ingestCommerceObservations } from "@/server/commerce/ingestion";
import { createLocation } from "@/server/billing/locations";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { memberships, organisations, outlets, shiftOffers, shifts, subscriptions, users, workAcceptances, workAllocations, workPayables, workPayouts, workPolicies, workers } from "@/server/db/schema";
import { getPayPalPayoutClient } from "@/server/integrations/paypal/factory";
import { setRegularCoverage, setTradingHours, setWorkloadPolicy } from "@/server/intelligence/business-policy";
import { shiftDate } from "@/server/intelligence/forecast";
import { approveWorkPayable, refreshWorkPayout, submitWorkPayout } from "@/server/payments/work-payouts";
import { allocateAssignment, changeAssignment, confirmWork, createDepartment, createRequirement, createWorkPolicy, getOperations, offerAssignment, respondToAssignment } from "@/server/scheduling/operations";
import { allocateAssignmentAction, createRequirementAction, offerAssignmentAction, respondAssignmentAction, saveAvailabilityAction } from "@/app/operations-actions";
import { ManagerWorkspace } from "@/app/manager/workspace";
import { OwnerWorkspace } from "@/app/owner/workspace";
import { WorkerWorkspace } from "@/app/worker/workspace";

vi.mock("@/server/auth/request", () => ({ requireScope: vi.fn() }));
vi.mock("@/server/db/client", () => ({ getDatabase: vi.fn() }));
vi.mock("@/server/config/env", () => ({ getConfigurationStatus: vi.fn() }));
vi.mock("@/server/integrations/paypal/factory", () => ({ getPayPalPayoutClient: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); }, notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// Thursday 15 Jan 2026, GMT in London. The next seven local days start tomorrow.
const NOW = new Date("2026-01-15T12:00:00Z");
beforeEach(() => { vi.useFakeTimers({ now: NOW, toFake: ["Date"] }); });
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); vi.resetAllMocks(); });

type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];
let n = 0;
async function user(db: Db, email = `u${++n}-${randomUUID().slice(0, 6)}@example.test`) {
  const id = randomUUID();
  await db.insert(users).values({ id, email, name: "Person", passwordHash: "x", emailVerifiedAt: new Date() });
  return { id, email };
}
// A business set up as the product sets one up: invited Manager and Worker redeem real invitations.
async function business(db: Db, input: { timezone?: string; country?: string; locations?: string[] } = {}) {
  const organisationId = randomUUID(), { timezone = "Europe/London", country = "United Kingdom", locations = ["Leeds Briggate"] } = input;
  if (!process.env.FAIRSHIFT_SANDBOX_ORGANISATION_ID) sandboxFixture(organisationId);
  await db.insert(organisations).values({ id: organisationId, name: "Any Retail", country });
  await db.insert(subscriptions).values({ id: randomUUID(), organisationId, requestId: randomUUID() });
  await entitled(db, organisationId);
  const rows = locations.map(name => ({ id: randomUUID(), organisationId, name, timezone, country }));
  await db.insert(outlets).values(rows);
  const owner = await user(db);
  const ownerMembership = randomUUID();
  await db.insert(memberships).values({ id: ownerMembership, userId: owner.id, organisationId, role: "OWNER" });
  const ownerScope = await resolveScope(db, owner.id, ownerMembership, rows[0].id);
  const manager = async (locationIndex = 0) => {
    const person = await user(db);
    const scope = await resolveScope(db, owner.id, ownerMembership, rows[locationIndex].id);
    const { token } = await inviteMember(db, scope, { role: "MANAGER", email: person.email, firstName: "Morgan", surname: "Manager", telephone: "+441130000000" });
    const membership = await redeemInvitation(db, person.id, { token });
    return resolveScope(db, person.id, membership.id);
  };
  const worker = async (managerScope: Scope, firstName = "Casey") => {
    const person = await user(db);
    const { token } = await inviteMember(db, managerScope, { role: "TEAM_MEMBER", email: person.email, firstName, surname: `Worker${++n}`, telephone: "+441130000001" });
    const membership = await redeemInvitation(db, person.id, { token });
    return resolveScope(db, person.id, membership.id);
  };
  return { organisationId, rows, ownerScope, manager, worker };
}
// £13.00 an hour: at or above the FairShift demo minimum (21-and-over rate) for these dates (FS-WAGE-INTEL-DEC-002).
async function terms(db: Db, owner: Scope, rate = 1_300) {
  const [department] = await createDepartment(db, "Sales floor", owner);
  const [policy] = await createWorkPolicy(db, { earningsModel: "HOURLY", rateMinor: rate }, "Casual hourly", owner);
  return { department, policy };
}
function form(values: Record<string, string>) { const result = new FormData(); for (const [k, v] of Object.entries(values)) result.set(k, v); return result; }
function pages(db: Db) {
  vi.mocked(getDatabase).mockReturnValue(db);
  vi.mocked(getConfigurationStatus).mockReturnValue({ databaseConfigured: true, aiConfigured: false, paypalPayoutConfigured: true } as ReturnType<typeof getConfigurationStatus>);
}
const as = (scope: Scope) => vi.mocked(requireScope).mockResolvedValue(scope);
const render = async (scope: Scope, element: () => Promise<React.ReactNode>) => { as(scope); return renderToStaticMarkup(await element()); };
const act = async (scope: Scope, action: (f: FormData) => Promise<unknown>, values: Record<string, string>) => {
  as(scope);
  const outcome = await action(form(values)).catch((error: Error) => error.message);
  return String(outcome);
};
const future = (hours: number, base = "2026-01-19T09:00:00Z") => new Date(Date.parse(base) + hours * 3_600_000);
const shiftAt = (db: Db, scope: Scope, t: { department: { id: string }; policy: { id: string } }, start = 0, length = 8, headcount = 3) =>
  createRequirement(db, { departmentId: t.department.id, policyId: t.policy.id, startsAt: future(start), endsAt: future(start + length), requiredHeadcount: headcount }, scope);

describe("opportunity to allocation, across roles", () => {
  it("runs from a staffing requirement to booked work, with every role seeing the same record", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db);
      const location = c.rows[0].id;
      pages(t.db);
      const manager = await c.manager(), worker = await c.worker(manager);
      const pay = await terms(t.db, c.ownerScope);
      // Commerce evidence, labour policy and rota, through the supported business paths.
      await ingestCommerceObservations(t.db, { organisationId: c.organisationId, source: "IMPORTED", sourceSystem: "till", now: NOW, observations: Array.from({ length: 56 }, (_, i) => Array.from({ length: 12 }, (_, n) => ({
        outletId: location, sourceTransactionId: `D${i}:${n}`, occurredAt: `${shiftDate("2026-01-14", -i)}T12:${String(n).padStart(2, "0")}:00Z`, currencyCode: "GBP", grossAmountMinor: 5_000, status: "COMPLETED" }))).flat() });
      // Test-fixture policy and hours, set through the Owner's supported path.
      await setWorkloadPolicy(t.db, c.ownerScope, "ORGANISATION", { transactionsPerStaffHour: 4, minimumStaffWhileOpen: 1 });
      await setTradingHours(t.db, c.ownerScope, Array(7).fill([{ start: 600, end: 1080 }]));
      await setRegularCoverage(t.db, c.ownerScope, Array(7).fill([{ start: 600, end: 1080, headcount: 1 }]));

      // The Manager sees the gap and opens Fill Shifts with its context, on the page of their one location.
      const plan = await render(manager, () => ManagerWorkspace({ area: "plan" }));
      const monday = "2026-01-19";
      expect(plan).toContain(`/manager/fill?date=${monday}&amp;window=12:00-13:00#add-requirement`);
      expect(plan).not.toContain('name="locationId"');
      const context = await render(manager, () => ManagerWorkspace({ area: "fill", date: monday }));
      // 12 bills at 4 per staff hour need 3 h; 1 h of regular cover leaves 2 h, 12:00–13:00 only.
      for (const text of ["FairShift identified a casual requirement for Mon, 19 Jan 2026, 12:00–13:00", "Expected transactions", "12", "Required staff capacity", "3 h", "Regular coverage", "1 h", "Casual requirement", "2 h", "Up to 2 people at once", "this business’s configured policy", "commercial context only", "Sales evidence through", "Nothing is created or offered until you do", `value="${monday}T12:00"`, `value="${monday}T13:00"`, "Europe/London"]) expect(context).toContain(text);
      // The gap stays in view even when the Create panel is closed.
      expect(context.indexOf("FairShift identified")).toBeLessThan(context.indexOf('id="add-requirement"'));
      expect((await getOperations(t.db, manager)).requirements).toEqual([]);

      // A UK Manager's 10:00 is 10:00 in the UK.
      expect(await act(manager, createRequirementAction, { departmentId: pay.department.id, policyId: pay.policy.id, headcount: "2", startsAt: `${monday}T10:00`, endsAt: `${monday}T18:00`, planDate: monday })).toContain("status=saved");
      const [shift] = (await getOperations(t.db, manager)).requirements;
      expect(shift).toMatchObject({ outletId: location, startsAt: new Date(`${monday}T10:00:00Z`), endsAt: new Date(`${monday}T18:00:00Z`), shiftDate: monday, currencyCode: "GBP", rateMinor: 1_300, expectedEarningsMinor: 10_400, requiredHeadcount: 2 });

      // The worker appears in the pool, and an offer is sent.
      let page = await render(manager, () => ManagerWorkspace({ area: "fill", date: monday }));
      expect(page).toContain("Availability not provided");
      expect(page).toContain("expected earnings per worker");
      expect(page).toContain("£104.00");
      expect(await act(manager, offerAssignmentAction, { shiftId: shift.id, workerId: worker.workerId!, planDate: monday })).toContain("status=saved");
      const [offer] = await t.db.select().from(shiftOffers).where(eq(shiftOffers.shiftId, shift.id));
      expect(offer).toMatchObject({ workerId: worker.workerId, status: "OFFERED" });

      // The Worker sees those exact terms, in location time, before accepting.
      let shiftsPage = await render(worker, () => WorkerWorkspace({ area: "shifts" }));
      for (const text of ["New offer", "Sales floor", "Leeds Briggate", "Monday 19 January", "10:00 to 18:00", "£104.00", "You’ll earn this", "£13.00 an hour × 8 hours", "Accept shift", "Decline", "your manager confirms who is working"]) expect(shiftsPage).toContain(text);
      for (const hidden of ["labour gap", "payable", "coverage", "allocation", "Terms version"]) expect(shiftsPage.toLowerCase()).not.toContain(hidden.toLowerCase());
      const home = await render(worker, () => WorkerWorkspace({ area: "home" }));
      for (const text of ["You have a new shift offer", "£104.00", "Payment setup incomplete"]) expect(home).toContain(text);

      // Live state leads Home: inbox notices about offers already answered must not outrank it.
      for (const hidden of ["New work assignment offer", "invited to FairShift"]) expect(home).not.toContain(hidden);

      // Accepting is a response, not a booking. Rate, currency and earnings cannot be supplied.
      expect(await act(worker, respondAssignmentAction, { offerId: offer.id, termsVersion: "1", response: "ACCEPTED" })).toContain("status=error");
      expect(await act(worker, respondAssignmentAction, { offerId: offer.id, termsVersion: "1", response: "ACCEPTED", acknowledged: "yes", rateMinor: "99999", currencyCode: "USD", expectedEarningsMinor: "1" })).toContain("status=saved");
      const [acceptance] = await t.db.select().from(workAcceptances).where(eq(workAcceptances.offerId, offer.id));
      expect(acceptance.snapshot).toMatchObject({ assignmentId: shift.id, rateMinor: 1_300, currencyCode: "GBP", expectedEarningsMinor: 10_400, startsAt: shift.startsAt.toISOString() });
      expect(await t.db.select().from(workAllocations)).toEqual([]);
      shiftsPage = await render(worker, () => WorkerWorkspace({ area: "shifts" }));
      expect(shiftsPage).toContain("You’re not booked yet");
      expect(shiftsPage).toContain("Waiting for your manager");
      expect(shiftsPage).not.toContain("Accept shift");

      // The Manager sees the acceptance and finalises it.
      page = await render(manager, () => ManagerWorkspace({ area: "fill" }));
      expect(page).toContain("Accepted · ready to allocate");
      expect(await render(manager, () => ManagerWorkspace({ area: "overview" }))).toContain("Finalise");
      expect(await act(manager, allocateAssignmentAction, { offerId: offer.id })).toContain("status=saved");
      expect(await act(manager, allocateAssignmentAction, { offerId: offer.id })).toContain("status=saved");
      const allocations = await t.db.select().from(workAllocations).where(eq(workAllocations.offerId, offer.id));
      expect(allocations).toHaveLength(1);
      expect(allocations[0]).toMatchObject({ acceptanceId: acceptance.id, state: "ALLOCATED", confirmedAt: null });
      expect(await render(manager, () => ManagerWorkspace({ area: "fill" }))).toContain("Allocated");

      // The Worker finds booked work again, and it is not called completed or paid.
      shiftsPage = await render(worker, () => WorkerWorkspace({ area: "shifts" }));
      for (const text of ["You’re booked", "Monday 19 January", "10:00 to 18:00", "£104.00"]) expect(shiftsPage).toContain(text);
      expect(shiftsPage).not.toContain("Finished");
      expect(await render(worker, () => WorkerWorkspace({ area: "home" }))).toContain("Your next shift");

      // Allocated labour reduces the gap the Manager started from: same underlying record.
      expect(await render(manager, () => ManagerWorkspace({ area: "fill", date: monday }))).toContain("Allocated casual");
      const owner = await render(c.ownerScope, () => OwnerWorkspace({ area: "forecast" }));
      expect(owner).toContain("as configured for this location");
      expect(await t.db.select().from(workPayables)).toEqual([]);
    } finally { await t.close(); }
  });

  it.each([
    { label: "UK winter", timezone: "Europe/London", country: "United Kingdom", wall: "2026-01-19T10:00", instant: "2026-01-19T10:00:00.000Z", shown: "10:00 to 12:00" },
    { label: "UK summer", timezone: "Europe/London", country: "United Kingdom", wall: "2026-07-14T10:00", instant: "2026-07-14T09:00:00.000Z", shown: "10:00 to 12:00" },
    { label: "South Africa", timezone: "Africa/Johannesburg", country: "South Africa", wall: "2026-07-14T10:00", instant: "2026-07-14T08:00:00.000Z", shown: "10:00 to 12:00" },
  ])("stores and shows a shift at local time: $label", async ({ timezone, country, wall, instant, shown }) => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db, { timezone, country });
      pages(t.db);
      const manager = await c.manager(), worker = await c.worker(manager);
      const pay = await terms(t.db, c.ownerScope);
      const end = wall.replace("T10:00", "T12:00");
      expect(await act(manager, createRequirementAction, { departmentId: pay.department.id, policyId: pay.policy.id, headcount: "1", startsAt: wall, endsAt: end })).toContain("status=saved");
      const [shift] = (await getOperations(t.db, manager)).requirements;
      expect(shift.startsAt.toISOString()).toBe(instant);
      await offerAssignment(t.db, shift.id, worker.workerId!, manager);
      expect(await render(worker, () => WorkerWorkspace({ area: "shifts" }))).toContain(shown);
      const page = await render(manager, () => ManagerWorkspace({ area: "fill" }));
      expect(page).toContain(timezone);
      expect(page).toContain("10:00");
      if (timezone !== "Africa/Johannesburg") expect(page).not.toContain("Johannesburg");
    } finally { await t.close(); }
  });

  it("reports bad times and durations to the Manager, and stores nothing", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db);
      pages(t.db);
      const manager = await c.manager(), pay = await terms(t.db, c.ownerScope);
      const create = (startsAt: string, endsAt: string, policyId = pay.policy.id) => act(manager, createRequirementAction, { departmentId: pay.department.id, policyId, headcount: "1", startsAt, endsAt });
      expect(await create("2026-03-29T01:30", "2026-03-29T05:00")).toContain("status=time-nonexistent");
      expect(await create("2026-10-25T01:30", "2026-10-25T05:00")).toContain("status=time-ambiguous");
      expect(await create("2026-02-31T10:00", "2026-02-31T12:00")).toContain("status=time-invalid");
      expect(await create("", "")).toContain("status=time-invalid");
      expect(await create("2026-01-19T12:00", "2026-01-19T10:00")).toContain("status=invalid-duration");
      expect(await create("2026-01-19T12:00", "2026-01-19T12:00")).toContain("status=invalid-duration");
      const [uneven] = await createWorkPolicy(t.db, { earningsModel: "HOURLY", rateMinor: 1_001 }, "Uneven", c.ownerScope);
      expect(await create("2026-01-19T10:00", "2026-01-19T10:07", uneven.id)).toContain("status=earnings-not-whole");
      expect(await create("2026-01-19T10:00", "2026-01-19T12:00", randomUUID())).toContain("status=error");
      expect((await getOperations(t.db, manager)).requirements).toEqual([]);
      const feedback = await render(manager, () => ManagerWorkspace({ area: "fill", status: "time-nonexistent" }));
      expect(feedback).toContain("the clocks go forward then");
    } finally { await t.close(); }
  });

  it("enforces the Owner's pay policy and location currency", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db, { locations: ["Leeds", "York"] }), other = await business(t.db);
      const manager = await c.manager(), pay = await terms(t.db, c.ownerScope), foreign = await terms(t.db, other.ownerScope);
      const york: Scope = { ...c.ownerScope, locationId: c.rows[1].id };
      const window = { startsAt: future(0), endsAt: future(8), requiredHeadcount: 1 };
      await expect(createRequirement(t.db, { ...window, departmentId: pay.department.id, policyId: foreign.policy.id }, manager)).rejects.toThrow(/unavailable/);
      await expect(createRequirement(t.db, { ...window, departmentId: pay.department.id, policyId: pay.policy.id }, york)).rejects.toThrow(/unavailable/);
      const [zero] = await createWorkPolicy(t.db, { earningsModel: "HOURLY", rateMinor: 0 }, "Unpaid", c.ownerScope);
      await expect(createRequirement(t.db, { ...window, departmentId: pay.department.id, policyId: zero.id }, manager)).rejects.toMatchObject({ feedback: "policy-rate" });
      await t.db.update(workPolicies).set({ currencyCode: "USD" }).where(eq(workPolicies.id, pay.policy.id));
      await expect(createRequirement(t.db, { ...window, departmentId: pay.department.id, policyId: pay.policy.id }, manager)).rejects.toMatchObject({ feedback: "policy-currency" });
      // Only the session decides the location: a form cannot pick another.
      pages(t.db);
      await t.db.update(workPolicies).set({ currencyCode: "GBP" }).where(eq(workPolicies.id, pay.policy.id));
      const result = await act(manager, createRequirementAction, { departmentId: pay.department.id, policyId: pay.policy.id, headcount: "1", startsAt: "2026-01-19T10:00", endsAt: "2026-01-19T12:00", locationId: c.rows[1].id, outletId: c.rows[1].id, rateMinor: "1" });
      expect(result).toContain("status=saved");
      expect(await t.db.select().from(shifts)).toEqual([expect.objectContaining({ outletId: manager.locationId, rateMinor: 1_300 })]);
    } finally { await t.close(); }
  });
});

describe("location time zone", () => {
  it("refuses a location whose time zone cannot be established, rather than guessing one", async () => {
    const t = await createTestDatabase();
    try {
      const organisationId = randomUUID(), owner = await user(t.db), membership = randomUUID();
      await t.db.insert(organisations).values({ id: organisationId, name: "Elsewhere GmbH", country: "Germany" });
      await t.db.insert(subscriptions).values({ id: randomUUID(), organisationId, requestId: randomUUID() });
      await entitled(t.db, organisationId);
      await t.db.insert(memberships).values({ id: membership, userId: owner.id, organisationId, role: "OWNER" });
      await expect(createLocation(t.db, { userId: owner.id, organisationId, role: "OWNER" } as never, { name: "Berlin" })).rejects.toMatchObject({ feedback: "location-timezone-unknown" });
      expect(await t.db.select().from(outlets).where(eq(outlets.organisationId, organisationId))).toEqual([]);
    } finally { await t.close(); }
  });
});

describe("worker pool and offers", () => {
  it("shows each worker's state and enforces it on the server", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db);
      pages(t.db);
      const manager = await c.manager(), pay = await terms(t.db, c.ownerScope);
      const free = await c.worker(manager, "Free"), away = await c.worker(manager, "Away"), yes = await c.worker(manager, "Yes"), busy = await c.worker(manager, "Busy"), off = await c.worker(manager, "Off");
      const invitedOnly = await inviteMember(t.db, manager, { role: "TEAM_MEMBER", email: "invited@example.test", firstName: "Invited", surname: "Only", telephone: "+441130000002" });
      const [unactivated] = await t.db.select().from(workers).where(eq(workers.email, "invited@example.test"));
      expect(invitedOnly.token).toBeTruthy();
      // Monday 19 Jan is weekday 1.
      await saveWorkerAvailability(t.db, away, ["UNAVAILABLE", null, null, null, null, null, null]);
      await saveWorkerAvailability(t.db, yes, ["AVAILABLE", null, null, null, null, null, null]);
      await t.db.update(workers).set({ status: "INACTIVE" }).where(eq(workers.id, off.workerId!));
      // Busy already has allocated work overlapping the new shift.
      const earlier = await shiftAt(t.db, manager, pay, -2, 4);
      const earlierOffer = await offerAssignment(t.db, earlier.id, busy.workerId!, manager);
      await respondToAssignment(t.db, busy.workerId!, earlierOffer.id, 1, "ACCEPTED", true, busy);
      await allocateAssignment(t.db, earlierOffer.id, manager);
      const shift = await shiftAt(t.db, manager, pay);

      const page = await render(manager, () => ManagerWorkspace({ area: "fill" }));
      const article = page.split("<article").find(a => a.includes(`requirement-${shift.id}`))!;
      const pool = article.slice(article.indexOf("Worker pool"));
      for (const [name, state] of [["Free", "Availability not provided"], ["Away", "Unavailable"], ["Yes", "Available"], ["Busy", "Already working"], ["Invited", "Awaiting activation"], ["Off", "Inactive"]]) {
        expect(pool).toMatch(new RegExp(`<strong>${name}[^<]*</strong><span class="status-badge[^"]*">${state}<`));
      }
      expect(pool.match(/Send offer/g)).toHaveLength(2);
      // The reason a worker is away is never asked for or shown.
      expect(page.toLowerCase()).not.toContain("reason:");

      await expect(offerAssignment(t.db, shift.id, away.workerId!, manager)).rejects.toMatchObject({ feedback: "worker-unavailable" });
      await expect(offerAssignment(t.db, shift.id, busy.workerId!, manager)).rejects.toMatchObject({ feedback: "worker-working" });
      await expect(offerAssignment(t.db, shift.id, unactivated.id, manager)).rejects.toMatchObject({ feedback: "worker-not-activated" });
      await expect(offerAssignment(t.db, shift.id, off.workerId!, manager)).rejects.toThrow(/unavailable/);
      const offer = await offerAssignment(t.db, shift.id, free.workerId!, manager);
      await expect(offerAssignment(t.db, shift.id, free.workerId!, manager)).rejects.toMatchObject({ feedback: "already-offered" });
      expect(await t.db.select().from(shiftOffers).where(eq(shiftOffers.shiftId, shift.id))).toEqual([expect.objectContaining({ id: offer.id })]);
      expect(await act(manager, offerAssignmentAction, { shiftId: shift.id, workerId: away.workerId! })).toContain("status=worker-unavailable");
      await offerAssignment(t.db, shift.id, yes.workerId!, manager);
    } finally { await t.close(); }
  });

  it("checks both days for a shift across midnight, in the location's zone", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db);
      const manager = await c.manager(), pay = await terms(t.db, c.ownerScope), worker = await c.worker(manager);
      await saveWorkerAvailability(t.db, worker, [null, "UNAVAILABLE", null, null, null, null, null]);
      // 22:00 Monday to 02:00 Tuesday, London.
      const night = await createRequirement(t.db, { departmentId: pay.department.id, policyId: pay.policy.id, startsAt: new Date("2026-01-19T22:00:00Z"), endsAt: new Date("2026-01-20T02:00:00Z"), requiredHeadcount: 1 }, manager);
      await expect(offerAssignment(t.db, night.id, worker.workerId!, manager)).rejects.toMatchObject({ feedback: "worker-unavailable" });
      await saveWorkerAvailability(t.db, worker, Array(7).fill(null));
      await offerAssignment(t.db, night.id, worker.workerId!, manager);
      await saveWorkerAvailability(t.db, worker, [null, "UNAVAILABLE", null, null, null, null, null]);
      // Availability set after the offer blocks accepting; declining stays open, with a way forward shown.
      const offer = (await t.db.select().from(shiftOffers).where(eq(shiftOffers.shiftId, night.id)))[0];
      await expect(respondToAssignment(t.db, worker.workerId!, offer.id, 1, "ACCEPTED", true, worker)).rejects.toMatchObject({ feedback: "worker-unavailable" });
      pages(t.db);
      const page = await render(worker, () => WorkerWorkspace({ area: "shifts" }));
      expect(page).toContain("marked this day as unavailable");
      expect(page).toContain("/worker/availability");
      expect(page).not.toContain("Accept shift");
      expect(page).toContain("Decline");
      await respondToAssignment(t.db, worker.workerId!, offer.id, 1, "DECLINED", false, worker);
    } finally { await t.close(); }
  });

  it("keeps casual workers, offers and availability within their own location and tenant", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db, { locations: ["Leeds", "York"] }), other = await business(t.db);
      pages(t.db);
      const leeds = await c.manager(0), york = await c.manager(1), rival = await other.manager();
      const pay = await terms(t.db, c.ownerScope), rivalPay = await terms(t.db, other.ownerScope);
      const leedsWorker = await c.worker(leeds, "Lee"), yorkWorker = await c.worker(york, "Yan"), rivalWorker = await other.worker(rival, "Rio");
      const shift = await shiftAt(t.db, leeds, pay);
      // Workers of another location or tenant cannot be offered, and do not appear in the pool.
      await expect(offerAssignment(t.db, shift.id, yorkWorker.workerId!, leeds)).rejects.toThrow(/unavailable at this location/);
      await expect(offerAssignment(t.db, shift.id, rivalWorker.workerId!, leeds)).rejects.toThrow(/unavailable at this location/);
      const page = await render(leeds, () => ManagerWorkspace({ area: "fill" }));
      expect(page).toContain("Lee ");
      expect(page).not.toContain("Yan ");
      expect(page).not.toContain("Rio ");
      // Managers cannot operate another location's or tenant's shift, even with their own worker.
      await expect(offerAssignment(t.db, shift.id, yorkWorker.workerId!, york)).rejects.toThrow(/unavailable/);
      await expect(offerAssignment(t.db, shift.id, rivalWorker.workerId!, rival)).rejects.toThrow(/unavailable/);
      const offer = await offerAssignment(t.db, shift.id, leedsWorker.workerId!, leeds);
      await respondToAssignment(t.db, leedsWorker.workerId!, offer.id, 1, "ACCEPTED", true, leedsWorker);
      await expect(allocateAssignment(t.db, offer.id, york)).rejects.toThrow(/unavailable/);
      await expect(allocateAssignment(t.db, offer.id, rival)).rejects.toThrow(/unavailable/);
      await expect(createRequirement(t.db, { departmentId: rivalPay.department.id, policyId: rivalPay.policy.id, startsAt: future(0), endsAt: future(8), requiredHeadcount: 1 }, leeds)).rejects.toThrow(/unavailable/);
      expect(await t.db.select().from(workAllocations)).toEqual([]);
      // A worker cannot read or answer another worker's offer.
      await expect(respondToAssignment(t.db, yorkWorker.workerId!, offer.id, 1, "DECLINED", false, yorkWorker)).rejects.toThrow(/unavailable/);
      expect(await act(yorkWorker, respondAssignmentAction, { offerId: offer.id, termsVersion: "1", response: "DECLINED" })).toContain("status=error");
      expect(await t.db.select().from(shiftOffers).where(eq(shiftOffers.id, offer.id))).toEqual([expect.objectContaining({ status: "ACCEPTED" })]);
      expect(await render(yorkWorker, () => WorkerWorkspace({ area: "shifts" }))).not.toContain("Sales floor");
      // Availability belongs to the worker: a manager cannot save it, and another worker changes only their own.
      await expect(saveWorkerAvailability(t.db, leeds, Array(7).fill("AVAILABLE"))).rejects.toThrow("Access denied.");
      for (const bad of [Array(6).fill(null), Array(7).fill("MAYBE"), "x"]) await expect(saveWorkerAvailability(t.db, leedsWorker, bad)).rejects.toThrow();
      expect(await act(leedsWorker, saveAvailabilityAction, { day1: "UNAVAILABLE", day2: "AVAILABLE" })).toContain("status=saved");
      expect((await getOperations(t.db, leeds)).availability).toEqual(expect.arrayContaining([expect.objectContaining({ workerId: leedsWorker.workerId, isoWeekday: 1, state: "UNAVAILABLE" })]));
      expect((await getOperations(t.db, york)).availability.filter(row => row.workerId === leedsWorker.workerId)).toEqual([]);
    } finally { await t.close(); }
  });
});

describe("responses and allocation", () => {
  it("makes every response retry-safe and final, with no state from a repeat", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db);
      const manager = await c.manager(), pay = await terms(t.db, c.ownerScope);
      const a = await c.worker(manager, "A"), b = await c.worker(manager, "B");
      const shift = await shiftAt(t.db, manager, pay);
      const accept = await offerAssignment(t.db, shift.id, a.workerId!, manager), decline = await offerAssignment(t.db, shift.id, b.workerId!, manager);
      // A declined offer can't be allocated, and an unanswered one can't be either.
      await expect(allocateAssignment(t.db, accept.id, manager)).rejects.toThrow(/Accept the offer/);
      const first = await respondToAssignment(t.db, a.workerId!, accept.id, 1, "ACCEPTED", true, a);
      const repeat = await respondToAssignment(t.db, a.workerId!, accept.id, 1, "ACCEPTED", true, a);
      expect(repeat.acceptedAt).toEqual(first.acceptedAt);
      expect(await t.db.select().from(workAcceptances).where(eq(workAcceptances.offerId, accept.id))).toHaveLength(1);
      await expect(respondToAssignment(t.db, a.workerId!, accept.id, 1, "DECLINED", false, a)).rejects.toThrow(/closed/);
      await respondToAssignment(t.db, b.workerId!, decline.id, 1, "DECLINED", false, b);
      await respondToAssignment(t.db, b.workerId!, decline.id, 1, "DECLINED", false, b);
      await expect(respondToAssignment(t.db, b.workerId!, decline.id, 1, "ACCEPTED", true, b)).rejects.toThrow(/closed/);
      await expect(allocateAssignment(t.db, decline.id, manager)).rejects.toThrow(/Accept the offer/);
      expect(await t.db.select().from(workAcceptances).where(eq(workAcceptances.offerId, decline.id))).toEqual([]);
      // Repeated and concurrent allocation leave one allocation.
      await Promise.all([allocateAssignment(t.db, accept.id, manager), allocateAssignment(t.db, accept.id, manager), allocateAssignment(t.db, accept.id, manager)]);
      expect(await t.db.select().from(workAllocations).where(eq(workAllocations.offerId, accept.id))).toHaveLength(1);
      // A wrong terms version or unacknowledged acceptance changes nothing.
      const third = await c.worker(manager, "C");
      const later = await shiftAt(t.db, manager, pay, 24);
      const offer = await offerAssignment(t.db, later.id, third.workerId!, manager);
      await expect(respondToAssignment(t.db, third.workerId!, offer.id, 9, "ACCEPTED", true, third)).rejects.toMatchObject({ feedback: "terms-changed" });
      await expect(respondToAssignment(t.db, third.workerId!, offer.id, 1, "ACCEPTED", false, third)).rejects.toThrow(/acknowledge/);
      expect(await t.db.select().from(workAcceptances).where(eq(workAcceptances.offerId, offer.id))).toEqual([]);
    } finally { await t.close(); }
  });

  it("needs fresh acceptance after a change, and refuses cancelled work and late conflicts", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db);
      pages(t.db);
      const manager = await c.manager(), pay = await terms(t.db, c.ownerScope), worker = await c.worker(manager);
      const shift = await shiftAt(t.db, manager, pay, 0, 8, 1);
      const offer = await offerAssignment(t.db, shift.id, worker.workerId!, manager);
      await respondToAssignment(t.db, worker.workerId!, offer.id, 1, "ACCEPTED", true, worker);
      await allocateAssignment(t.db, offer.id, manager);
      // The Manager moves the shift: the old acceptance stands as evidence but no longer books the worker.
      await changeAssignment(t.db, manager, shift.id, { startsAt: future(1), endsAt: future(9) });
      await expect(allocateAssignment(t.db, offer.id, manager)).rejects.toThrow(/Accept the offer|require acceptance/);
      expect(await render(manager, () => ManagerWorkspace({ area: "fill" }))).toContain("Reacceptance required");
      let page = await render(worker, () => WorkerWorkspace({ area: "shifts" }));
      expect(page).toContain("Details changed");
      expect(page).toContain("The details changed");
      expect(page).toContain("Accept shift");
      expect(await act(worker, respondAssignmentAction, { offerId: offer.id, termsVersion: "1", response: "ACCEPTED", acknowledged: "yes" })).toContain("status=terms-changed");
      await respondToAssignment(t.db, worker.workerId!, offer.id, 2, "ACCEPTED", true, worker);
      expect(await t.db.select().from(workAcceptances).where(eq(workAcceptances.offerId, offer.id))).toHaveLength(2);
      await allocateAssignment(t.db, offer.id, manager);
      expect(await render(worker, () => WorkerWorkspace({ area: "shifts" }))).toContain("You’re booked");

      // Overlapping accepted work stops a second booking at acceptance and at allocation.
      const clash = await shiftAt(t.db, manager, pay, 4, 8, 1);
      await expect(offerAssignment(t.db, clash.id, worker.workerId!, manager)).rejects.toMatchObject({ feedback: "worker-working" });
      // A worker who marks the day unavailable after accepting cannot be allocated to it.
      const another = await c.worker(manager, "Dee"), elsewhere = await shiftAt(t.db, manager, pay, 72, 8, 1);
      const late = await offerAssignment(t.db, elsewhere.id, another.workerId!, manager);
      await respondToAssignment(t.db, another.workerId!, late.id, 1, "ACCEPTED", true, another);
      await saveWorkerAvailability(t.db, another, [null, null, null, null, null, null, null].map((_, i) => i === 3 ? "UNAVAILABLE" : null)); // Thu 22 Jan
      await expect(allocateAssignment(t.db, late.id, manager)).rejects.toMatchObject({ feedback: "worker-unavailable" });
      // An offer for work that has already finished is closed to the worker and refused by the server.
      const tardy = await c.worker(manager, "Fay"), gone = await shiftAt(t.db, manager, pay, 200, 8, 1);
      const expired = await offerAssignment(t.db, gone.id, tardy.workerId!, manager);
      expect(await render(tardy, () => WorkerWorkspace({ area: "shifts" }))).toContain("Accept shift");
      vi.setSystemTime(future(208));
      await expect(workerRespond(t.db, tardy, expired.id, 1, "ACCEPTED", true)).rejects.toMatchObject({ feedback: "shift-ended" });
      expect(await act(tardy, respondAssignmentAction, { offerId: expired.id, termsVersion: "1", response: "ACCEPTED", acknowledged: "yes" })).toContain("status=shift-ended");
      expect(await t.db.select().from(workAcceptances).where(eq(workAcceptances.offerId, expired.id))).toEqual([]);
      const stale = await render(tardy, () => WorkerWorkspace({ area: "shifts" }));
      expect(stale).not.toContain("Accept shift");
      expect(stale).toContain("Closed");
      vi.setSystemTime(NOW);
      // Cancelled work closes its offers.
      const dropped = await c.worker(manager, "Eve"), cancelled = await shiftAt(t.db, manager, pay, 120, 8, 1);
      const closed = await offerAssignment(t.db, cancelled.id, dropped.workerId!, manager);
      await changeAssignment(t.db, manager, cancelled.id, { cancel: true });
      await expect(respondToAssignment(t.db, dropped.workerId!, closed.id, 1, "ACCEPTED", true, dropped)).rejects.toThrow();
      page = await render(dropped, () => WorkerWorkspace({ area: "shifts" }));
      expect(page).not.toContain("Accept shift");
      expect(page).toContain("Closed");
    } finally { await t.close(); }
  });
});

describe("payment truthfulness and downstream regression", () => {
  it("is clear about payment setup without claiming any verification", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db);
      pages(t.db);
      const manager = await c.manager(), worker = await c.worker(manager);
      let home = await render(worker, () => WorkerWorkspace({ area: "home" }));
      for (const text of ["Payment setup incomplete", "Add your payment details before your approved earnings can be sent", "/worker/profile#payment-settings", "Nothing needs you right now"]) expect(home).toContain(text);
      await savePayoutDestination(t.db, worker, "casey.paypal@example.test");
      home = await render(worker, () => WorkerWorkspace({ area: "home" }));
      expect(home).not.toContain("Payment setup incomplete");
      const profile = await render(worker, () => WorkerWorkspace({ area: "profile" }));
      expect(profile).toContain("Payment details added");
      expect(profile).toContain("has not checked this email with PayPal");
      expect(profile).not.toContain("attribution");
      expect(profile).toContain("/account");
      expect(await render(worker, () => WorkerWorkspace({ area: "earnings" }))).not.toMatch(/sandbox|incentive/i);
      for (const page of [home, profile]) for (const claim of [/verified/i, /ready to receive/i, /casey\.paypal/]) expect(page).not.toMatch(claim);
    } finally { await t.close(); }
  });

  it("carries accepted terms through confirmation, approval and a held payout, which is never shown as paid", async () => {
    const t = await createTestDatabase();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const c = await business(t.db);
      pages(t.db);
      const manager = await c.manager(), pay = await terms(t.db, c.ownerScope), worker = await c.worker(manager);
      await savePayoutDestination(t.db, worker, "casey@example.test");
      const shift = await shiftAt(t.db, manager, pay);
      const offer = await offerAssignment(t.db, shift.id, worker.workerId!, manager);
      await respondToAssignment(t.db, worker.workerId!, offer.id, 1, "ACCEPTED", true, worker);
      await allocateAssignment(t.db, offer.id, manager);
      // The Owner raises the policy rate after acceptance; accepted pay does not move.
      await t.db.update(workPolicies).set({ rateMinor: 9_999 }).where(eq(workPolicies.id, pay.policy.id));
      await expect(confirmWork(t.db, offer.id, manager)).rejects.toThrow(/not ended/);
      vi.setSystemTime(new Date("2026-01-19T18:00:00Z"));
      const { payable } = await confirmWork(t.db, offer.id, manager);
      expect(payable).toMatchObject({ baseAmountMinor: 10_400, currencyCode: "GBP", rateMinor: 1_300, status: "PENDING_REVIEW" });
      await approveWorkPayable(t.db, manager, payable!.id);
      const adapter = {
        createPayout: vi.fn(async () => ({ batchId: "BATCH1", itemId: null, status: "PENDING", batchStatus: "PENDING", itemStatus: null, transactionId: null })),
        getPayout: vi.fn(async (batchId: string) => ({ batchId, itemId: "ITEM1", status: "ONHOLD", batchStatus: "SUCCESS", itemStatus: "ONHOLD", transactionId: "TX1", itemErrorCode: "PENDING_RECIPIENT_NON_HOLDING_CURRENCY_PAYMENT_PREFERENCE" })),
      };
      vi.mocked(getPayPalPayoutClient).mockReturnValue(adapter as never);
      await submitWorkPayout(t.db, adapter, manager, payable!.id);
      expect(adapter.createPayout).toHaveBeenCalledWith(expect.objectContaining({ amount: "104.00", currency: "GBP" }));
      expect(await refreshWorkPayout(t.db, adapter, manager, payable!.id)).toMatchObject({ status: "PROCESSING", paypalStatus: "ONHOLD", paidAt: null });
      expect(await t.db.select().from(workPayouts)).toHaveLength(1);
      // The worker sees a plain state and a next step, with no provider code and no Paid.
      const earnings = await render(worker, () => WorkerWorkspace({ area: "earnings" }));
      for (const text of ["Action required", "PayPal is holding this payment", "check your PayPal account", "Base pay", "£104.00"]) expect(earnings).toContain(text);
      expect(earnings).not.toContain("PENDING_RECIPIENT");
      expect(earnings).not.toMatch(/>\s*Paid\s*</);
      expect(await render(worker, () => WorkerWorkspace({ area: "home" }))).not.toContain("£104.00 paid");
      // The manager still sees the provider detail.
      expect(await render(manager, () => ManagerWorkspace({ area: "review" }))).toContain("PENDING_RECIPIENT_NON_HOLDING_CURRENCY_PAYMENT_PREFERENCE");
      // Booked work that finished is no longer called upcoming.
      const shiftsPage = await render(worker, () => WorkerWorkspace({ area: "shifts" }));
      expect(shiftsPage).toContain("Finished");
      expect(shiftsPage).not.toContain("You’re booked");
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await t.db.select().from(workAllocations).where(and(eq(workAllocations.offerId, offer.id), eq(workAllocations.state, "ALLOCATED")))).toHaveLength(1);
    } finally { fetchSpy.mockRestore(); await t.close(); }
  });

  it("renders the worker pages for empty, multiple, long-named and small or large earnings states", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db, { locations: ["A very long location name at the far end of the Northern Quarter shopping arcade"] });
      pages(t.db);
      const manager = await c.manager(), worker = await c.worker(manager);
      expect(await render(worker, () => WorkerWorkspace({ area: "shifts" }))).toContain("No shift offers yet");
      const [department] = await createDepartment(t.db, "Weekend visual merchandising and stockroom replenishment assistant", c.ownerScope);
      // Small earnings come from a short shift at a rate an England offer can carry (FS-WAGE-INTEL-DEC-002):
      // £13.00 an hour for 15 minutes is £3.25. A lower rate would be refused, not rendered.
      const [small] = await createWorkPolicy(t.db, { earningsModel: "HOURLY", rateMinor: 1_300 }, "Small", c.ownerScope);
      const [large] = await createWorkPolicy(t.db, { earningsModel: "DAILY", rateMinor: 123_456_789 }, "Large", c.ownerScope);
      for (const [policy, start, length] of [[small, 0, 0.25], [large, 24, 2]] as const) {
        const shift = await createRequirement(t.db, { departmentId: department.id, policyId: policy.id, startsAt: future(start), endsAt: future(start + length), requiredHeadcount: 1 }, manager);
        await offerAssignment(t.db, shift.id, worker.workerId!, manager);
      }
      const page = await render(worker, () => WorkerWorkspace({ area: "shifts" }));
      expect(page.match(/New offer</g)).toHaveLength(2);
      for (const text of ["£3.25", "£1,234,567.89", "Weekend visual merchandising", "Northern Quarter"]) expect(page).toContain(text);
      expect(await render(worker, () => WorkerWorkspace({ area: "home" }))).toContain("You have 2 new shift offers");
      const availability = await render(worker, () => WorkerWorkspace({ area: "availability" }));
      for (const text of ["When can you work?", "Monday", "Sunday", "Unavailable", "Not set", "You don’t need to give a reason"]) expect(availability).toContain(text);
    } finally { await t.close(); }
  });
});
