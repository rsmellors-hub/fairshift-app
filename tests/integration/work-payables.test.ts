import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { entitled } from "../helpers/onboarding";
import type { Scope } from "@/server/auth/access";
import { requireScope } from "@/server/auth/request";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { getPayPalPayoutClient } from "@/server/integrations/paypal/factory";
import { auditEvents, memberships, organisations, outlets, shiftIncentives, shiftOffers, shifts, subscriptions, users, workAcceptances, workAllocations, workPayables, workPolicies, workers } from "@/server/db/schema";
import { allocateAssignment, changeAssignment, confirmWork, createDepartment, createRequirement, createWorkPolicy, getOperations, offerAssignment, respondToAssignment } from "@/server/scheduling/operations";
import { getWorkerWorkspace } from "@/server/product/workspace";
import { BasePayableUnavailableError } from "@/server/domain/work-payable";
import { DEMO_ORGANISATION_ID, DEMO_OUTLET_ID } from "@/server/constants";
import { ManagerWorkspace } from "@/app/manager/workspace";
import { WorkerWorkspace } from "@/app/worker/workspace";
import { OwnerWorkspace } from "@/app/owner/workspace";
import { confirmWorkAction } from "@/app/operations-actions";
import { createActivatedTeamMember } from "../helpers/workers";

vi.mock("@/server/auth/request", () => ({ requireScope: vi.fn() }));
vi.mock("@/server/db/client", () => ({ getDatabase: vi.fn() }));
vi.mock("@/server/config/env", () => ({ getConfigurationStatus: vi.fn() }));
vi.mock("@/server/integrations/paypal/factory", () => ({ getPayPalPayoutClient: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); }, notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
afterEach(() => vi.resetAllMocks());

type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];
type Policy = { earningsModel: "HOURLY" | "DAILY"; rateMinor: number } | { earningsModel: "COMMISSION"; commissionBps: number; commissionBasis: "VERIFIED_ATTRIBUTED_SALES" };
// Tue 20 Oct 2026, 09:00 in London: in the past, so the scheduled work has ended.
const START = Date.parse("2026-10-20T08:00:00Z");
const at = (hours: number) => new Date(START + hours * 3_600_000);
// Not yet worked, and inside the verified wage reference (the 2027–28 demo minimum is £13.21).
const FUTURE = Date.parse("2028-03-10T09:00:00Z");
// £13.00 an hour: at or above the FairShift demo minimum (21-and-over rate) for these dates (FS-WAGE-INTEL-DEC-002).
const HOURLY_13 = { earningsModel: "HOURLY", rateMinor: 1_300 } as const;

let n = 0;
async function user(db: Db) {
  const id = randomUUID();
  await db.insert(users).values({ id, email: `user${++n}-${id.slice(0, 6)}@example.test`, name: "Test user", passwordHash: "test", emailVerifiedAt: new Date() });
  return id;
}
async function company(db: Db, locations = 1, country = "United Kingdom") {
  const organisationId = randomUUID();
  await db.insert(organisations).values({ id: organisationId, name: `${country} company`, country });
  await db.insert(subscriptions).values({ id: randomUUID(), organisationId, requestId: randomUUID() });
  await entitled(db, organisationId);
  const rows = Array.from({ length: locations }, (_, i) => ({ id: randomUUID(), organisationId, name: `Store ${i + 1}`, timezone: "Europe/London" }));
  await db.insert(outlets).values(rows);
  const scopes: Scope[] = [];
  for (const row of rows) scopes.push({ userId: await user(db), organisationId, locationId: row.id, role: "MANAGER", organisationName: `${country} company`, locationName: row.name });
  return { organisationId, scopes };
}
async function terms(db: Db, scope: Scope, policy: Policy = HOURLY_13, startsAt = at(0), endsAt = at(6), headcount = 3) {
  const [department] = await createDepartment(db, `Sales floor ${randomUUID().slice(0, 6)}`, scope);
  const [created] = await createWorkPolicy(db, policy, "Casual terms", scope);
  const shift = await createRequirement(db, { departmentId: department.id, policyId: created.id, startsAt, endsAt, requiredHeadcount: headcount }, scope);
  return { policy: created, shift };
}
const member = async (db: Db, scope: Scope) =>
  (await createActivatedTeamMember(db, { firstName: "Casual", surname: `Worker ${++n}`, telephone: "+441132000000", email: `casual${n}@example.test` }, scope)).worker;
async function allocated(db: Db, scope: Scope, shiftId: string) {
  const worker = await member(db, scope);
  const offer = await offerAssignment(db, shiftId, worker.id, scope);
  await respondToAssignment(db, worker.id, offer.id, 1, "ACCEPTED", true, scope);
  await allocateAssignment(db, offer.id, scope);
  return { worker, offer };
}
const payableCount = async (db: Db) => (await db.select().from(workPayables)).length;
function form(values: Record<string, string>) {
  const result = new FormData();
  for (const [key, value] of Object.entries(values)) result.set(key, value);
  return result;
}

describe("confirmed work and authoritative base payables", () => {
  it("creates exactly one base payable from the accepted hourly GBP terms, without performance, incentives or PayPal", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      const manager = c.scopes[0];
      const { policy, shift } = await terms(t.db, manager);
      expect(policy.currencyCode).toBe("GBP");
      expect(shift).toMatchObject({ currencyCode: "GBP", earningsModel: "HOURLY", rateMinor: 1_300, expectedEarningsMinor: 7_800 });
      const { worker, offer } = await allocated(t.db, manager, shift.id);
      const [acceptance] = await t.db.select().from(workAcceptances).where(eq(workAcceptances.offerId, offer.id));
      expect(acceptance.snapshot).toMatchObject({ currencyCode: "GBP", earningsModel: "HOURLY", rateMinor: 1_300, expectedEarningsMinor: 7_800, termsVersion: 1 });

      // Confirm-as-scheduled: no attendance, timesheet or performance input exists or is needed.
      const result = await confirmWork(t.db, offer.id, manager);
      expect(result.payableState).toBe("CALCULATED");
      expect(result.payable).toMatchObject({
        organisationId: c.organisationId, outletId: manager.locationId, shiftId: shift.id, workerId: worker.id, offerId: offer.id,
        allocationId: result.allocationId, acceptanceId: acceptance.id, termsVersion: 1, calculationMethod: "confirm-as-scheduled-v1",
        earningsModel: "HOURLY", currencyCode: "GBP", rateMinor: 1_300, baseAmountMinor: 7_800, status: "PENDING_REVIEW",
        scheduledStartsAt: at(0), scheduledEndsAt: at(6), confirmedAt: result.confirmedAt, confirmedBy: manager.userId,
      });
      expect(await t.db.select().from(shiftIncentives)).toHaveLength(0);
      // A payable carries no provider or payout identifiers; nothing has been sent.
      expect(Object.keys(result.payable!).filter(key => /paypal|payout|batch|provider|paid/i.test(key))).toEqual([]);

      // Repeats and retries return the same confirmation and payable.
      const again = await confirmWork(t.db, offer.id, manager);
      expect(again.payable).toEqual(result.payable);
      expect(again.confirmedAt).toEqual(result.confirmedAt);
      // Concurrent attempts on another work unit still produce one payable.
      const second = await allocated(t.db, manager, shift.id);
      const attempts = await Promise.all([1, 2, 3].map(() => confirmWork(t.db, second.offer.id, manager)));
      expect(new Set(attempts.map(attempt => attempt.payable!.id)).size).toBe(1);
      expect(await payableCount(t.db)).toBe(2);
      const audit = await t.db.select().from(auditEvents).where(eq(auditEvents.organisationId, c.organisationId));
      expect(audit.filter(event => event.action === "WORK_CONFIRMED")).toHaveLength(2);
      expect(audit.filter(event => event.action === "BASE_PAYABLE_CALCULATED")).toHaveLength(2);
      // The database itself refuses a second payable for the same work unit.
      await expect(t.db.insert(workPayables).values({ ...result.payable!, id: randomUUID() })).rejects.toThrow();
      expect(await payableCount(t.db)).toBe(2);
    } finally { await t.close(); }
  });

  it("pays daily terms as the accepted daily amount", async () => {
    const t = await createTestDatabase();
    try {
      const manager = (await company(t.db)).scopes[0];
      const { shift } = await terms(t.db, manager, { earningsModel: "DAILY", rateMinor: 9_600 }, at(0), at(5.5));
      const { offer } = await allocated(t.db, manager, shift.id);
      expect((await confirmWork(t.db, offer.id, manager)).payable).toMatchObject({ earningsModel: "DAILY", rateMinor: 9_600, baseAmountMinor: 9_600, currencyCode: "GBP" });
    } finally { await t.close(); }
  });

  it("keeps the accepted £13/hour after the Owner policy changes, and never pays unaccepted terms", async () => {
    const t = await createTestDatabase();
    try {
      const manager = (await company(t.db)).scopes[0];
      const { policy, shift } = await terms(t.db, manager);
      const { offer } = await allocated(t.db, manager, shift.id);
      // Owner/Admin later raises the policy and creates new £13/hour terms.
      await t.db.update(workPolicies).set({ rateMinor: 1_400 }).where(eq(workPolicies.id, policy.id));
      const revised = await terms(t.db, manager, { earningsModel: "HOURLY", rateMinor: 1_400 }, at(24), at(30));
      expect(revised.shift).toMatchObject({ rateMinor: 1_400, expectedEarningsMinor: 8_400, currencyCode: "GBP" });
      expect((await confirmWork(t.db, offer.id, manager)).payable).toMatchObject({ rateMinor: 1_300, baseAmountMinor: 7_800, currencyCode: "GBP" });

      // Changing an allocated shift's own terms reopens the offer for reacceptance; it cannot be confirmed.
      const other = await terms(t.db, manager, HOURLY_13, at(48), at(54));
      const changed = await allocated(t.db, manager, other.shift.id);
      await t.db.update(shifts).set({ rateMinor: 1_400, expectedEarningsMinor: 8_400, guaranteedBasePayMinor: 8_400 }).where(eq(shifts.id, other.shift.id));
      await expect(confirmWork(t.db, changed.offer.id, manager)).rejects.toThrow(/Accepted work required/);
      expect((await t.db.select().from(workAllocations).where(eq(workAllocations.offerId, changed.offer.id)))[0].state).toBe("REACCEPTANCE_REQUIRED");
      expect(await payableCount(t.db)).toBe(1);
    } finally { await t.close(); }
  });

  it("creates no payable for offered, accepted-only, declined, cancelled, unfinished or reacceptance-required work", async () => {
    const t = await createTestDatabase();
    try {
      const manager = (await company(t.db)).scopes[0];
      const { shift } = await terms(t.db, manager, HOURLY_13, at(0), at(6), 5);
      const offeredOnly = await offerAssignment(t.db, shift.id, (await member(t.db, manager)).id, manager);
      const acceptedWorker = await member(t.db, manager);
      const acceptedOnly = await offerAssignment(t.db, shift.id, acceptedWorker.id, manager);
      await respondToAssignment(t.db, acceptedWorker.id, acceptedOnly.id, 1, "ACCEPTED", true, manager);
      const declinedWorker = await member(t.db, manager);
      const declined = await offerAssignment(t.db, shift.id, declinedWorker.id, manager);
      await respondToAssignment(t.db, declinedWorker.id, declined.id, 1, "DECLINED", false, manager);
      await expect(confirmWork(t.db, offeredOnly.id, manager)).rejects.toThrow(/Accepted work required/);
      await expect(confirmWork(t.db, acceptedOnly.id, manager)).rejects.toThrow(/Allocate accepted work/);
      await expect(confirmWork(t.db, declined.id, manager)).rejects.toThrow(/Accepted work required/);

      const unfinished = await terms(t.db, manager, { earningsModel: "HOURLY", rateMinor: 1_400 }, new Date(FUTURE), new Date(FUTURE + 6 * 3_600_000));
      const future = await allocated(t.db, manager, unfinished.shift.id);
      await expect(confirmWork(t.db, future.offer.id, manager)).rejects.toThrow(/not ended/);

      const cancelledShift = await terms(t.db, manager, HOURLY_13, at(24), at(30));
      const cancelled = await allocated(t.db, manager, cancelledShift.shift.id);
      await changeAssignment(t.db, manager, cancelledShift.shift.id, { cancel: true });
      // Cancellation closes the offer; the shift itself is no longer confirmable either.
      await expect(confirmWork(t.db, cancelled.offer.id, manager)).rejects.toThrow(/Accepted work required/);

      expect(await payableCount(t.db)).toBe(0);
      expect((await t.db.select().from(workAllocations)).every(allocation => allocation.confirmedAt === null)).toBe(true);
    } finally { await t.close(); }
  });

  it("refuses confirmation and payable access outside the manager's organisation and location", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db, 2);
      const other = await company(t.db);
      const [managerA, managerB] = c.scopes;
      const { shift } = await terms(t.db, managerA);
      const { offer } = await allocated(t.db, managerA, shift.id);
      await expect(confirmWork(t.db, offer.id, other.scopes[0])).rejects.toThrow();
      await expect(confirmWork(t.db, offer.id, managerB)).rejects.toThrow(/unavailable/);
      // A scope naming another organisation's location is refused, not trusted.
      await expect(confirmWork(t.db, offer.id, { ...other.scopes[0], locationId: managerA.locationId })).rejects.toThrow(/Location unavailable/);
      expect(await payableCount(t.db)).toBe(0);
      expect((await t.db.select().from(workAllocations))[0].confirmedAt).toBeNull();

      // The Owner, operating at the location, follows the same organisation scope.
      const owner: Scope = { ...managerA, userId: await user(t.db), role: "OWNER" };
      expect((await confirmWork(t.db, offer.id, owner)).payable).toMatchObject({ baseAmountMinor: 7_800, confirmedBy: owner.userId });
      expect((await getOperations(t.db, managerA)).payables).toHaveLength(1);
      expect((await getOperations(t.db, managerB)).payables).toHaveLength(0);
      expect((await getOperations(t.db, other.scopes[0])).payables).toHaveLength(0);
    } finally { await t.close(); }
  });

  it("shows each worker only their own payable", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      const manager = c.scopes[0];
      const six = await terms(t.db, manager, HOURLY_13, at(0), at(6));
      const eight = await terms(t.db, manager, HOURLY_13, at(0), at(8));
      const a = await allocated(t.db, manager, six.shift.id), b = await allocated(t.db, manager, eight.shift.id);
      const payableA = (await confirmWork(t.db, a.offer.id, manager)).payable!;
      const payableB = (await confirmWork(t.db, b.offer.id, manager)).payable!;
      const view = await getWorkerWorkspace(t.db, { organisationId: c.organisationId, locationId: manager.locationId, workerId: a.worker.id });
      expect(view.assignments).toHaveLength(1);
      expect(view.assignments[0].payable).toMatchObject({ id: payableA.id, baseAmountMinor: 7_800, currencyCode: "GBP", status: "PENDING_REVIEW" });
      expect(Object.keys(view.assignments[0].payable!)).not.toContain("acceptanceId");
      expect(Object.keys(view.assignments[0].payable!)).not.toContain("confirmedBy");
      const json = JSON.stringify(view);
      for (const hidden of [payableB.id, eight.shift.id, b.worker.id, b.offer.id]) expect(json).not.toContain(hidden);
      expect((await getWorkerWorkspace(t.db, { organisationId: c.organisationId, locationId: manager.locationId, workerId: b.worker.id })).assignments[0].payable?.id).toBe(payableB.id);
    } finally { await t.close(); }
  });

  it("blocks confirmation when accepted fixed terms cannot be verified, rather than recording zero", async () => {
    const t = await createTestDatabase();
    try {
      const manager = (await company(t.db)).scopes[0];
      const { shift } = await terms(t.db, manager);
      const worker = await member(t.db, manager);
      const offer = await offerAssignment(t.db, shift.id, worker.id, manager);
      // A legacy-style acceptance whose snapshot lacks the accepted currency and rate.
      const acceptanceId = randomUUID();
      await t.db.insert(workAcceptances).values({ id: acceptanceId, offerId: offer.id, workerId: worker.id, termsVersion: 1, snapshot: { workerId: worker.id, offerId: offer.id, earningsModel: "HOURLY" } });
      await t.db.update(shiftOffers).set({ status: "ACCEPTED", acceptedAt: new Date(), respondedAt: new Date() }).where(eq(shiftOffers.id, offer.id));
      await t.db.insert(workAllocations).values({ id: randomUUID(), offerId: offer.id, acceptanceId });
      const failure = await confirmWork(t.db, offer.id, manager).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(BasePayableUnavailableError);
      expect(failure).toMatchObject({ reason: "INVALID_ACCEPTED_TERMS" });
      expect(await payableCount(t.db)).toBe(0);
      expect((await t.db.select().from(workAllocations))[0].confirmedAt).toBeNull();
      expect((await t.db.select().from(auditEvents)).filter(event => event.action === "WORK_CONFIRMED")).toHaveLength(0);
    } finally { await t.close(); }
  });

  it("confirms commission work without creating a payable, since no verified attribution exists", async () => {
    const t = await createTestDatabase();
    try {
      // Commission has no guaranteed hourly pay, so it can't be offered where the FairShift demo minimum applies.
      const england = (await company(t.db)).scopes[0];
      await expect(terms(t.db, england, { earningsModel: "COMMISSION", commissionBps: 500, commissionBasis: "VERIFIED_ATTRIBUTED_SALES" })).rejects.toMatchObject({ feedback: "wage-not-checkable" });
      // Outside the wage reference, existing commission behaviour is unchanged.
      const manager = (await company(t.db, 1, "South Africa")).scopes[0];
      const { shift } = await terms(t.db, manager, { earningsModel: "COMMISSION", commissionBps: 500, commissionBasis: "VERIFIED_ATTRIBUTED_SALES" });
      expect(shift).toMatchObject({ currencyCode: "USD", expectedEarningsMinor: null });
      const { offer } = await allocated(t.db, manager, shift.id);
      for (let attempt = 0; attempt < 2; attempt++) expect(await confirmWork(t.db, offer.id, manager)).toMatchObject({ payable: null, payableState: "ATTRIBUTION_REQUIRED" });
      expect((await t.db.select().from(workAllocations))[0].confirmedAt).toBeInstanceOf(Date);
      expect(await payableCount(t.db)).toBe(0);
    } finally { await t.close(); }
  });

  it("pays fractional and overnight schedules on their exact accepted duration", async () => {
    const t = await createTestDatabase();
    try {
      const manager = (await company(t.db)).scopes[0];
      const quarter = await terms(t.db, manager, HOURLY_13, at(0), at(6.25));
      expect(quarter.shift.expectedEarningsMinor).toBe(8_125);
      expect((await confirmWork(t.db, (await allocated(t.db, manager, quarter.shift.id)).offer.id, manager)).payable).toMatchObject({ baseAmountMinor: 8_125 });
      // 23:00 BST Sat 24 Oct → 06:00 GMT Sun 25 Oct 2026: eight elapsed hours across the clock change.
      const overnight = await terms(t.db, manager, HOURLY_13, new Date("2026-10-24T22:00:00Z"), new Date("2026-10-25T06:00:00Z"));
      expect((await confirmWork(t.db, (await allocated(t.db, manager, overnight.shift.id)).offer.id, manager)).payable).toMatchObject({ baseAmountMinor: 10_400 });
      // Terms that do not resolve to whole minor units are refused before they can be offered.
      await expect(terms(t.db, manager, { earningsModel: "HOURLY", rateMinor: 1_201 }, at(100), at(100.25))).rejects.toThrow(/whole cents/);
    } finally { await t.close(); }
  });

  it("rejects invalid or cross-tenant payables in the database and keeps financial facts immutable", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db), other = await company(t.db);
      const manager = c.scopes[0];
      const { shift } = await terms(t.db, manager);
      const confirmed = await allocated(t.db, manager, shift.id);
      const payable = (await confirmWork(t.db, confirmed.offer.id, manager)).payable!;
      // A second work unit, confirmed but without a payable yet, to insert against directly.
      const unit = await allocated(t.db, manager, shift.id);
      const confirmedAt = new Date("2026-10-21T09:00:00Z");
      const [allocation] = await t.db.update(workAllocations).set({ confirmedAt }).where(eq(workAllocations.offerId, unit.offer.id)).returning();
      const valid = { ...payable, id: randomUUID(), workerId: unit.worker.id, offerId: unit.offer.id, allocationId: allocation.id, acceptanceId: allocation.acceptanceId, confirmedAt };
      const otherShift = await terms(t.db, other.scopes[0]);
      const otherWorker = await member(t.db, other.scopes[0]);
      for (const invalid of [
        { organisationId: other.organisationId },
        { organisationId: other.organisationId, outletId: other.scopes[0].locationId },
        { shiftId: otherShift.shift.id },
        { workerId: otherWorker.id },
        { acceptanceId: payable.acceptanceId },
        { baseAmountMinor: 7_300 },
        { rateMinor: 1_400, baseAmountMinor: 8_400 },
        { currencyCode: "USD" },
        { earningsModel: "COMMISSION" },
        { status: "PAID" },
        { confirmedAt: new Date() },
      ]) await expect(t.db.insert(workPayables).values({ ...valid, ...invalid })).rejects.toThrow();
      expect(await payableCount(t.db)).toBe(1);
      await t.db.insert(workPayables).values(valid);
      expect(await payableCount(t.db)).toBe(2);

      for (const change of [{ baseAmountMinor: 1 }, { currencyCode: "USD" }, { rateMinor: 1_400 }, { workerId: unit.worker.id }, { status: "PAID" }]) {
        await expect(t.db.update(workPayables).set(change).where(eq(workPayables.id, payable.id))).rejects.toThrow();
      }
      await expect(t.db.delete(workPayables).where(eq(workPayables.id, payable.id))).rejects.toThrow();
      expect((await t.db.select().from(workPayables).where(eq(workPayables.id, payable.id)))[0]).toEqual(payable);
    } finally { await t.close(); }
  });

  it("keeps existing USD locations in USD", async () => {
    const t = await createTestDatabase();
    try {
      const [policy] = await createWorkPolicy(t.db, HOURLY_13, "Demo hourly");
      expect(policy.currencyCode).toBe("USD");
      const [department] = await createDepartment(t.db, "Kitchen");
      expect(await createRequirement(t.db, { departmentId: department.id, policyId: policy.id, startsAt: at(0), endsAt: at(6), requiredHeadcount: 1 })).toMatchObject({ currencyCode: "USD", expectedEarningsMinor: 7_800 });
      const [organisation] = await t.db.select().from(organisations).where(eq(organisations.id, DEMO_ORGANISATION_ID));
      expect(organisation).toBeDefined();
      expect((await getOperations(t.db, { organisationId: DEMO_ORGANISATION_ID, locationId: DEMO_OUTLET_ID })).currency).toBe("USD");
    } finally { await t.close(); }
  });

  it("shows GBP terms, expected earnings and the confirmed payable to the manager, worker and owner, and never claims payment", async () => {
    const t = await createTestDatabase();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const c = await company(t.db);
      const manager = c.scopes[0];
      const { shift } = await terms(t.db, manager);
      const { worker, offer } = await allocated(t.db, manager, shift.id);
      const workerUser = await user(t.db);
      await t.db.update(workers).set({ userId: workerUser }).where(eq(workers.id, worker.id));
      const workerScope: Scope = { ...manager, userId: workerUser, workerId: worker.id, role: "TEAM_MEMBER" };
      const owner: Scope = { ...manager, userId: await user(t.db), role: "OWNER" };
      await t.db.insert(memberships).values({ id: randomUUID(), userId: owner.userId, organisationId: c.organisationId, role: "OWNER" });
      vi.mocked(getDatabase).mockReturnValue(t.db);
      vi.mocked(getConfigurationStatus).mockReturnValue({ databaseConfigured: true } as ReturnType<typeof getConfigurationStatus>);
      const render = async (scope: Scope, element: () => Promise<React.ReactNode>) => { vi.mocked(requireScope).mockResolvedValue(scope); return renderToStaticMarkup(await element()); };
      const noDollars = (html: string) => expect(html).not.toMatch(/\$\s?\d/);
      const noPayment = (html: string) => { expect(html).not.toMatch(/>\s*Paid\s*</); expect(html).not.toMatch(/<button[^>]*>[^<]*\bPay\b/); };

      // Before work is confirmed: GBP terms and expected earnings only.
      const shiftsHtml = await render(workerScope, () => WorkerWorkspace({ area: "shifts" }));
      expect(shiftsHtml).toContain("£13.00 an hour × 6 hours");
      expect(shiftsHtml).toContain("£78.00");
      noDollars(shiftsHtml);
      let earnings = await render(workerScope, () => WorkerWorkspace({ area: "earnings" }));
      expect(earnings).toContain("£78.00 expected");
      expect(earnings).toContain("Awaiting work confirmation");
      expect(earnings).not.toContain("<h3>Earned</h3>");
      noDollars(earnings);
      noDollars(await render(workerScope, () => WorkerWorkspace({ area: "home" })));
      // Allocated, unconfirmed work is visible as allocated and offered for confirmation.
      expect((await getOperations(t.db, manager)).offers[0].allocation).toMatchObject({ state: "ALLOCATED", confirmedAt: null });
      expect((await getWorkerWorkspace(t.db, workerScope)).assignments[0].allocation).toMatchObject({ state: "ALLOCATED", confirmedAt: null });
      let review = await render(manager, () => ManagerWorkspace({ area: "review" }));
      expect(review).toContain("I confirm the scheduled work was performed.");
      expect(review).toContain(worker.displayName);
      expect(review).toContain("No confirmed work awaiting approval");
      noDollars(review);

      // Confirmation through the manager action derives the payable; PayPal is never involved.
      vi.mocked(requireScope).mockResolvedValue(manager);
      await expect(confirmWorkAction(form({ offerId: offer.id }))).rejects.toThrow("status=error");
      expect(await payableCount(t.db)).toBe(0);
      await expect(confirmWorkAction(form({ offerId: offer.id, confirmed: "yes" }))).rejects.toThrow("REDIRECT:/manager/review?status=saved");
      await expect(confirmWorkAction(form({ offerId: offer.id, confirmed: "yes" }))).rejects.toThrow("REDIRECT:/manager/review?status=saved");
      expect(await payableCount(t.db)).toBe(1);
      expect(getPayPalPayoutClient).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();

      review = await render(manager, () => ManagerWorkspace({ area: "review" }));
      for (const text of ["Payments &amp; approvals", "£78.00", "£13.00/hour × 6 hours scheduled", "Awaiting approval", "Approve £78.00", "shows as Paid only after PayPal reports it as successful"]) expect(review).toContain(text);
      // Approval is the only action offered: nothing can be sent before it.
      expect(review).not.toContain("payout with PayPal");
      noDollars(review);
      noPayment(review);
      earnings = await render(workerScope, () => WorkerWorkspace({ area: "earnings" }));
      for (const text of ["<h3>Earned</h3>", "£78.00", "£13.00/hour × 6 hours scheduled", "Awaiting approval", "Awaiting approval", "shows as Paid only after PayPal confirms it"]) expect(earnings).toContain(text);
      noDollars(earnings);
      noPayment(earnings);
      expect(await render(workerScope, () => WorkerWorkspace({ area: "home" }))).toContain("£78.00 confirmed · awaiting approval");
      const policies = await render(owner, () => OwnerWorkspace({ area: "policies" }));
      expect(policies).toContain("Rate (GBP)");
      expect(policies).toContain("£13.00 / hour");
      expect(policies).not.toContain("Rate (USD)");
    } finally { fetchSpy.mockRestore(); await t.close(); }
  });
});
