import { sandboxFixture } from "../helpers/sandbox";
import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { entitled } from "../helpers/onboarding";
import { resolveScope, type Scope } from "@/server/auth/access";
import { savePayoutDestination, workerRespond } from "@/server/auth/operations";
import { requireFinancialScope, requireScope } from "@/server/auth/request";
import { inviteMember, redeemInvitation } from "@/server/auth/tenancy";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { attributedSales, memberships, organisations, outlets, subscriptions, users, workAcceptances, workPayables, workPayouts, workPerformanceResults, workPolicies, workers } from "@/server/db/schema";
import { approveWorkPayable, refreshWorkPayout, submitWorkPayout } from "@/server/payments/work-payouts";
import { confirmWorkPerformance, getLocationPerformance, importAttributedSales } from "@/server/performance/attribution";
import { getWorkOutcomes } from "@/server/intelligence/commerce-labour";
import { getOwnerOverview } from "@/server/product/owner-overview";
import { allocateAssignment, confirmWork, createDepartment, createRequirement, createWorkPolicy, offerAssignment } from "@/server/scheduling/operations";
import { approvePayableAction, confirmPerformanceAction, createPolicyAction, importAttributedSalesAction } from "@/app/operations-actions";
import { ManagerWorkspace } from "@/app/manager/workspace";
import { OwnerWorkspace } from "@/app/owner/workspace";
import { WorkerWorkspace } from "@/app/worker/workspace";

vi.mock("@/server/auth/request", () => ({ requireScope: vi.fn(), requireFinancialScope: vi.fn() }));
vi.mock("@/server/db/client", () => ({ getDatabase: vi.fn() }));
vi.mock("@/server/config/env", () => ({ getConfigurationStatus: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); }, notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const BEFORE = new Date("2026-01-15T12:00:00Z"), AFTER = new Date("2026-01-20T12:00:00Z");
beforeEach(() => { vi.useFakeTimers({ now: BEFORE, toFake: ["Date"] }); });
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); vi.resetAllMocks(); });

type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];
let n = 0;
async function user(db: Db) {
  const id = randomUUID(), email = `u${++n}-${randomUUID().slice(0, 6)}@example.test`;
  await db.insert(users).values({ id, email, name: "Person", passwordHash: "x", emailVerifiedAt: new Date() });
  return { id, email };
}
async function business(db: Db, input: { name?: string; country?: string; timezone?: string; locations?: string[] } = {}) {
  const organisationId = randomUUID(), { country = "United Kingdom", timezone = "Europe/London", locations = ["Leeds"], name = "Any Retail" } = input;
  if (!process.env.FAIRSHIFT_SANDBOX_ORGANISATION_ID) sandboxFixture(organisationId);
  await db.insert(organisations).values({ id: organisationId, name, country });
  await db.insert(subscriptions).values({ id: randomUUID(), organisationId, requestId: randomUUID() });
  await entitled(db, organisationId);
  const rows = locations.map(location => ({ id: randomUUID(), organisationId, name: location, timezone, country }));
  await db.insert(outlets).values(rows);
  const owner = await user(db), ownerMembership = randomUUID();
  await db.insert(memberships).values({ id: ownerMembership, userId: owner.id, organisationId, role: "OWNER" });
  const ownerScope = await resolveScope(db, owner.id, ownerMembership, rows[0].id);
  const manager = async (i = 0) => {
    const person = await user(db), at = await resolveScope(db, owner.id, ownerMembership, rows[i].id);
    const { token } = await inviteMember(db, at, { role: "MANAGER", email: person.email, firstName: "Morgan", surname: "Manager", telephone: "+441130000000" });
    return resolveScope(db, person.id, (await redeemInvitation(db, person.id, { token })).id);
  };
  const worker = async (by: Scope, firstName = "Casey") => {
    const person = await user(db);
    const { token } = await inviteMember(db, by, { role: "TEAM_MEMBER", email: person.email, firstName, surname: "Worker", telephone: "+441130000001" });
    return resolveScope(db, person.id, (await redeemInvitation(db, person.id, { token })).id);
  };
  const ownerAt = (i: number) => resolveScope(db, owner.id, ownerMembership, rows[i].id);
  return { organisationId, rows, ownerScope, ownerAt, manager, worker };
}
const code = async (db: Db, workerId: string) => (await db.select().from(workers).where(eq(workers.id, workerId)))[0].attributionCode;
async function terms(db: Db, owner: Scope, input: { rate?: number; target?: number | null; bonus?: number | null } = {}) {
  // £13.00 is at or above the FairShift demo minimum on these dates (FS-WAGE-INTEL-DEC-002).
  const { rate = 1_300, target = 65_000, bonus = 2_500 } = input;
  const [department] = await createDepartment(db, "Sales floor", owner);
  const [policy] = await createWorkPolicy(db, { earningsModel: "HOURLY", rateMinor: rate, incentiveTargetMinor: target, incentiveBonusMinor: bonus }, "Casual with bonus", owner);
  return { department, policy };
}
// 09:00–17:00 London on Monday 19 Jan 2026 unless told otherwise; through acceptance and allocation.
async function bookedShift(db: Db, manager: Scope, worker: Scope, pay: Awaited<ReturnType<typeof terms>>, start = "2026-01-19T09:00:00Z", end = "2026-01-19T17:00:00Z") {
  const shift = await createRequirement(db, { departmentId: pay.department.id, policyId: pay.policy.id, startsAt: new Date(start), endsAt: new Date(end), requiredHeadcount: 1 }, manager);
  const offer = await offerAssignment(db, shift.id, worker.workerId!, manager);
  await workerRespond(db, worker, offer.id, 1, "ACCEPTED", true);
  const allocation = await allocateAssignment(db, offer.id, manager);
  return { shift, offer, allocation };
}
const csv = (...rows: [string, string, string, string, string][]) => ["transaction_id,attribution_code,occurred_at,amount,currency", ...rows.map(row => row.join(","))].join("\n");
const form = (values: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(values)) f.set(k, v); return f; };
const pages = (db: Db) => {
  vi.mocked(getDatabase).mockReturnValue(db);
  vi.mocked(getConfigurationStatus).mockReturnValue({ databaseConfigured: true, aiConfigured: false, paypalPayoutConfigured: true } as ReturnType<typeof getConfigurationStatus>);
};
const render = async (scope: Scope, element: () => Promise<React.ReactNode>) => { vi.mocked(requireScope).mockResolvedValue(scope); return renderToStaticMarkup(await element()); };
const act = async (scope: Scope, action: (f: FormData) => Promise<unknown>, values: Record<string, string>) => { vi.mocked(requireScope).mockResolvedValue(scope); vi.mocked(requireFinancialScope).mockResolvedValue(scope); return String(await action(form(values)).catch((error: Error) => error.message)); };
const stubPayPal = () => ({
  createPayout: vi.fn(async () => ({ batchId: "BATCH1", itemId: null, status: "PENDING", batchStatus: "PENDING", itemStatus: null, transactionId: null })),
  getPayout: vi.fn(async (batchId: string) => ({ batchId, itemId: "ITEM1", status: "ONHOLD", batchStatus: "SUCCESS", itemStatus: "ONHOLD", transactionId: "TX1", itemErrorCode: "HELD" })),
});
async function setup(db: Db, input: Parameters<typeof terms>[2] = {}) {
  const c = await business(db), manager = await c.manager(), worker = await c.worker(manager), pay = await terms(db, c.ownerScope, input);
  return { c, manager, worker, pay, code: await code(db, worker.workerId!) };
}
async function finishedWork(db: Db, s: Awaited<ReturnType<typeof setup>>) {
  const booked = await bookedShift(db, s.manager, s.worker, s.pay);
  vi.setSystemTime(AFTER);
  const { payable } = await confirmWork(db, booked.offer.id, s.manager);
  return { ...booked, payable: payable! };
}

describe("work to approved final payable", () => {
  it("runs one record chain from Owner policy to the payout boundary, with no network", async () => {
    const t = await createTestDatabase(), fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const c = await business(t.db); pages(t.db);
      const manager = await c.manager(), worker = await c.worker(manager), workerCode = await code(t.db, worker.workerId!);
      const [department] = await createDepartment(t.db, "Sales floor", c.ownerScope);
      // The Owner sets the target and bonus; the Manager only picks the policy.
      expect(await act(c.ownerScope, createPolicyAction, { name: "Bonus terms", earningsModel: "HOURLY", rate: "13.00", incentiveTarget: "650.00", incentiveBonus: "25.00" })).toContain("status=saved");
      const [policy] = await t.db.select().from(workPolicies);
      expect(policy).toMatchObject({ incentiveTargetMinor: 65_000, incentiveBonusMinor: 2_500, currencyCode: "GBP" });
      expect(await render(manager, () => ManagerWorkspace({ area: "fill" }))).toContain("£25.00 bonus at £650.00 sales");
      const { shift, offer, allocation } = await bookedShift(t.db, manager, worker, { department, policy }, "2026-01-19T09:00:00Z", "2026-01-19T17:00:00Z");
      expect(shift).toMatchObject({ incentiveBasis: "INDIVIDUAL_ATTRIBUTED_SALES", incentiveTargetMinor: 65_000, incentiveAmountMinor: 2_500 });
      expect((await t.db.select().from(workAcceptances))[0].snapshot).toMatchObject({ incentiveBasis: "INDIVIDUAL_ATTRIBUTED_SALES", incentiveTargetMinor: 65_000, incentiveAmountMinor: 2_500, currencyCode: "GBP", expectedEarningsMinor: 10_400 });
      // The Owner's later changes reach none of it.
      await t.db.update(workPolicies).set({ rateMinor: 9_999, incentiveTargetMinor: 1, incentiveBonusMinor: 999_999 }).where(eq(workPolicies.id, policy.id));
      vi.setSystemTime(AFTER);
      const { payable } = await confirmWork(t.db, offer.id, manager);
      expect(payable).toMatchObject({ baseAmountMinor: 10_400, incentiveRequired: true, incentiveAmountMinor: null, status: "PENDING_REVIEW" });
      // No evidence yet: nothing reads as zero, and approval is blocked.
      let review = await render(manager, () => ManagerWorkspace({ area: "review" }));
      for (const text of ["None imported yet", "Not complete yet", "Imported · not provider-verified", "Confirm sales results first", "Sales results needed"]) expect(review).toContain(text);
      expect(review).not.toContain("Approve £");
      expect(await act(manager, approvePayableAction, { payableId: payable!.id })).toContain("status=performance-required");
      expect((await render(worker, () => WorkerWorkspace({ area: "earnings" })))).toContain("aren’t final yet");
      // Import through the Manager action, then confirm.
      expect(await act(manager, importAttributedSalesAction, { rows: csv(["T1", workerCode, "2026-01-19T10:00:00Z", "400.00", "GBP"], ["T2", workerCode, "2026-01-19T16:59:59Z", "300.00", "GBP"]) })).toContain("importResult=2.0.0");
      review = await render(manager, () => ManagerWorkspace({ area: "review" }));
      expect(review).toContain("£700.00");
      // A posted amount cannot change the outcome; the seen values only guard against late sales.
      expect(await act(manager, confirmPerformanceAction, { allocationId: allocation.id, complete: "yes", seenCount: "2", seenMinor: "70000", earnedMinor: "999999", salesMinor: "1", incentiveAmountMinor: "999999", finalPayable: "1" })).toContain("status=saved");
      const [result] = await t.db.select().from(workPerformanceResults);
      expect(result).toMatchObject({ salesCount: 2, salesMinor: 70_000, targetMinor: 65_000, bonusMinor: 2_500, earnedMinor: 2_500, evidenceProvenance: "IMPORTED_NOT_PROVIDER_VERIFIED" });
      review = await render(manager, () => ManagerWorkspace({ area: "review" }));
      for (const text of ["Confirmed for payment", "Imported · not provider-verified", "target reached", "£129.00", "£104.00 base + £25.00 bonus", "Approve £129.00"]) expect(review).toContain(text);
      // Confirmation never upgrades the evidence.
      for (const row of await t.db.select().from(attributedSales)) expect(row.verificationState).toBe("UNVERIFIED");
      // Approve exactly the final amount, however often, and whatever is posted.
      vi.mocked(requireScope).mockResolvedValue(manager);
      expect(await act(manager, approvePayableAction, { payableId: payable!.id, approvedAmountMinor: "1", incentiveAmountMinor: "1" })).toContain("status=saved");
      expect(await act(manager, approvePayableAction, { payableId: payable!.id })).toContain("status=saved");
      const [approved] = await t.db.select().from(workPayables);
      expect(approved).toMatchObject({ status: "APPROVED", baseAmountMinor: 10_400, incentiveAmountMinor: 2_500, approvedAmountMinor: 12_900, currencyCode: "GBP" });
      // The payout boundary receives that amount, once.
      await savePayoutDestination(t.db, worker, "casey@example.test");
      const adapter = stubPayPal();
      await Promise.allSettled([submitWorkPayout(t.db, adapter, manager, approved.id), submitWorkPayout(t.db, adapter, manager, approved.id)]);
      await submitWorkPayout(t.db, adapter, manager, approved.id).catch(() => undefined);
      expect(adapter.createPayout).toHaveBeenCalledTimes(1);
      expect(adapter.createPayout).toHaveBeenCalledWith(expect.objectContaining({ amount: "129.00", currency: "GBP" }));
      expect(await t.db.select().from(workPayouts)).toEqual([expect.objectContaining({ amountMinor: 12_900, currencyCode: "GBP" })]);
      expect(await refreshWorkPayout(t.db, adapter, manager, approved.id)).toMatchObject({ status: "PROCESSING", paypalStatus: "ONHOLD", paidAt: null });
      expect(await render(c.ownerScope, () => OwnerWorkspace({ area: "payments" }))).toContain("£129.00");
      // The Worker sees their own result; held is not paid.
      const earnings = await render(worker, () => WorkerWorkspace({ area: "earnings" }));
      for (const text of ["Your sales", "£700.00", "£650.00", "reached", "Base earnings", "£104.00", "Bonus earned", "£25.00", "Total earnings", "£129.00", "Action required", "haven’t been checked by a sales provider"]) expect(earnings).toContain(text);
      expect(earnings).not.toMatch(/T1|T2|Zettle|VERIFIED/);
      expect(earnings).not.toMatch(/>\s*Paid\s*</);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); await t.close(); }
  });

  it("shows the Worker the incentive economics before accepting", async () => {
    const t = await createTestDatabase();
    try {
      const s = await setup(t.db); pages(t.db);
      const shift = await createRequirement(t.db, { departmentId: s.pay.department.id, policyId: s.pay.policy.id, startsAt: new Date("2026-01-19T09:00:00Z"), endsAt: new Date("2026-01-19T17:00:00Z"), requiredHeadcount: 1 }, s.manager);
      await offerAssignment(t.db, shift.id, s.worker.workerId!, s.manager);
      const page = await render(s.worker, () => WorkerWorkspace({ area: "shifts" }));
      for (const text of ["£104.00", "£25.00 bonus", "your own sales for this shift reach £650.00", "Up to", "£129.00", "Accept shift"]) expect(page).toContain(text);
      expect(page).not.toMatch(/team|commission/i);
    } finally { await t.close(); }
  });

  it("keeps base-only work unchanged: no performance step, approved at base", async () => {
    const t = await createTestDatabase();
    try {
      const s = await setup(t.db, { target: null, bonus: null }); pages(t.db);
      const { payable, allocation } = await finishedWork(t.db, s);
      expect(payable).toMatchObject({ incentiveRequired: false, incentiveAmountMinor: null });
      expect(await getLocationPerformance(t.db, s.manager)).toEqual([]);
      await expect(confirmWorkPerformance(t.db, s.manager, allocation.id, { count: 0, minor: 0 })).rejects.toThrow("Work unavailable");
      expect((await importAttributedSales(t.db, s.manager, csv(["T1", s.code, "2026-01-19T10:00:00Z", "5.00", "GBP"]), AFTER)).rejected[0].reason).toBe("NO_MATCHING_SHIFT");
      expect(await approveWorkPayable(t.db, s.manager, payable.id)).toMatchObject({ approvedAmountMinor: 10_400 });
      expect(await render(s.worker, () => WorkerWorkspace({ area: "earnings" }))).not.toContain("Bonus");
    } finally { await t.close(); }
  });
});

describe("evidence truthfulness", () => {
  it("separates missing evidence from a confirmed zero, which earns nothing and can be approved", async () => {
    const t = await createTestDatabase();
    try {
      const s = await setup(t.db); pages(t.db);
      const { payable, allocation } = await finishedWork(t.db, s);
      await expect(approveWorkPayable(t.db, s.manager, payable.id)).rejects.toMatchObject({ feedback: "performance-required" });
      const pending = await render(s.worker, () => WorkerWorkspace({ area: "earnings" }));
      expect(pending).toContain("Not known yet");
      expect(pending).not.toContain("Your sales value");
      expect(pending).not.toContain("Total earnings");
      expect(await render(s.manager, () => ManagerWorkspace({ area: "review" }))).toContain("this worker made no attributed sales");
      await confirmWorkPerformance(t.db, s.manager, allocation.id, { count: 0, minor: 0 });
      expect(await t.db.select().from(workPerformanceResults)).toEqual([expect.objectContaining({ salesCount: 0, salesMinor: 0, earnedMinor: 0 })]);
      expect(await approveWorkPayable(t.db, s.manager, payable.id)).toMatchObject({ incentiveAmountMinor: 0, approvedAmountMinor: 10_400 });
      const earnings = await render(s.worker, () => WorkerWorkspace({ area: "earnings" }));
      for (const text of ["Your sales", "not reached", "Total earnings", "£104.00"]) expect(earnings).toContain(text);
    } finally { await t.close(); }
  });

  it("refuses to confirm sales that arrived after the page opened, and locks them afterwards", async () => {
    const t = await createTestDatabase();
    try {
      const s = await setup(t.db); pages(t.db);
      const { allocation } = await finishedWork(t.db, s);
      await importAttributedSales(t.db, s.manager, csv(["T1", s.code, "2026-01-19T10:00:00Z", "100.00", "GBP"]), AFTER);
      for (const seen of [{ count: 0, minor: 0 }, { count: 1, minor: 99_999 }, { count: NaN, minor: NaN }]) await expect(confirmWorkPerformance(t.db, s.manager, allocation.id, seen)).rejects.toMatchObject({ feedback: "sales-changed" });
      expect(await t.db.select().from(workPerformanceResults)).toEqual([]);
      const first = await confirmWorkPerformance(t.db, s.manager, allocation.id, { count: 1, minor: 10_000 });
      // Results are final: later sales can't move them, and a repeat confirmation returns the same record.
      const late = await importAttributedSales(t.db, s.manager, csv(["T2", s.code, "2026-01-19T11:00:00Z", "900.00", "GBP"]), AFTER);
      expect(late).toMatchObject({ imported: 0, rejected: [{ reason: "RESULTS_FINAL" }] });
      expect(await confirmWorkPerformance(t.db, s.manager, allocation.id, { count: 9, minor: 9 })).toEqual(first);
      expect(await t.db.select().from(workPerformanceResults)).toHaveLength(1);
      expect(await act(s.manager, importAttributedSalesAction, { rows: "not a file" })).toContain("status=import-format");
    } finally { await t.close(); }
  });

  it("does not double-count repeats, and refuses a changed transaction, bad values and the wrong currency", async () => {
    const t = await createTestDatabase();
    try {
      const s = await setup(t.db); pages(t.db);
      const { allocation } = await finishedWork(t.db, s);
      const rows = csv(["T1", s.code, "2026-01-19T10:00:00Z", "100.00", "GBP"], ["T1", s.code, "2026-01-19T10:00:00Z", "100.00", "GBP"]);
      expect(await importAttributedSales(t.db, s.manager, rows, AFTER)).toMatchObject({ imported: 1, duplicates: 1, rejected: [] });
      expect(await importAttributedSales(t.db, s.manager, rows, AFTER)).toMatchObject({ imported: 0, duplicates: 2, rejected: [] });
      const bad = await importAttributedSales(t.db, s.manager, csv(
        ["T1", s.code, "2026-01-19T10:00:00Z", "999.00", "GBP"], // changed
        ["T2", s.code, "2026-01-19T11:00:00Z", "-5.00", "GBP"], // negative
        ["T3", s.code, "2026-01-19T11:00:00Z", "5.00", "USD"], // currency
        ["T4", s.code, "2026-01-19T08:59:59Z", "5.00", "GBP"], // before the shift
        ["T5", s.code, "2026-01-19T17:00:00Z", "5.00", "GBP"], // the end is not in the shift
        ["T6", "FS-NOBODY", "2026-01-19T11:00:00Z", "5.00", "GBP"], // unknown
        ["T7", s.code, "2026-01-30T11:00:00Z", "5.00", "GBP"], // future
      ), AFTER);
      expect(bad.rejected.map(row => row.reason)).toEqual(["TRANSACTION_CHANGED", "INVALID_ROW", "WRONG_CURRENCY", "NO_MATCHING_SHIFT", "NO_MATCHING_SHIFT", "UNKNOWN_CODE", "IN_THE_FUTURE"]);
      expect(await t.db.select().from(attributedSales)).toHaveLength(1);
      expect(await confirmWorkPerformance(t.db, s.manager, allocation.id, { count: 1, minor: 10_000 })).toMatchObject({ salesMinor: 10_000 });
      // The action reports each rejected line in plain words.
      const url = await act(s.manager, importAttributedSalesAction, { rows: csv(["T9", "FS-NOBODY", "2026-01-19T11:00:00Z", "5.00", "GBP"]) });
      const importResult = url.split("importResult=")[1].split("#")[0];
      const page = await render(s.manager, () => ManagerWorkspace({ area: "review", importResult }));
      expect(page).toContain("Line 2: no worker at this location has that attribution code");
      expect(await render(s.manager, () => ManagerWorkspace({ area: "review", importResult: "<script>" }))).not.toContain("&lt;script");
    } finally { await t.close(); }
  });

  it("attaches sales to the right worker and shift only", async () => {
    const t = await createTestDatabase();
    try {
      const s = await setup(t.db), other = await s.c.worker(s.manager, "Dee"), otherCode = await code(t.db, other.workerId!);
      const a = await bookedShift(t.db, s.manager, s.worker, s.pay);
      const b = await bookedShift(t.db, s.manager, s.worker, s.pay, "2026-01-20T09:00:00Z", "2026-01-20T17:00:00Z");
      const c = await bookedShift(t.db, s.manager, other, s.pay);
      vi.setSystemTime(new Date("2026-01-21T12:00:00Z"));
      for (const booked of [a, b, c]) await confirmWork(t.db, booked.offer.id, s.manager);
      await importAttributedSales(t.db, s.manager, csv(["M1", s.code, "2026-01-19T10:00:00Z", "700.00", "GBP"], ["T1", s.code, "2026-01-20T10:00:00Z", "10.00", "GBP"], ["O1", otherCode, "2026-01-19T10:00:00Z", "20.00", "GBP"]));
      const view = await getLocationPerformance(t.db, s.manager);
      const of = (booked: typeof a) => view.find(item => item.allocationId === booked.allocation.id)!.attributed;
      expect(of(a)).toEqual({ count: 1, minor: 70_000 });
      expect(of(b)).toEqual({ count: 1, minor: 1_000 });
      expect(of(c)).toEqual({ count: 1, minor: 2_000 });
      expect(await confirmWorkPerformance(t.db, s.manager, b.allocation.id, of(b))).toMatchObject({ earnedMinor: 0, workerId: s.worker.workerId });
      // One shift confirmed, one not: each shows its own state, and only its own figures.
      pages(t.db);
      let page = await render(s.worker, () => WorkerWorkspace({ area: "earnings" }));
      expect(page.match(/Your sales value/g)).toHaveLength(1);
      expect(page.match(/aren’t final yet/g)).toHaveLength(1);
      expect(page).toContain("£10.00");
      expect(page).not.toContain("£700.00");
      expect(await confirmWorkPerformance(t.db, s.manager, a.allocation.id, of(a))).toMatchObject({ earnedMinor: 2_500, workerId: s.worker.workerId });
      page = await render(s.worker, () => WorkerWorkspace({ area: "earnings" }));
      expect(page.match(/Your sales value/g)).toHaveLength(2);
      for (const text of ["£10.00", "£700.00"]) expect(page).toContain(text);
      expect(page).not.toContain("£20.00");
    } finally { await t.close(); }
  });
});

describe("boundaries", () => {
  it("keeps other workers, locations and tenants out", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db, { locations: ["Leeds", "York"] }), rival = await business(t.db); pages(t.db);
      const leeds = await c.manager(0), york = await c.manager(1), rivalManager = await rival.manager();
      const a = await c.worker(leeds, "Ada"), b = await c.worker(leeds, "Bea"), yorkWorker = await c.worker(york, "Yan");
      const pay = await terms(t.db, c.ownerScope), aCode = await code(t.db, a.workerId!), bCode = await code(t.db, b.workerId!), yorkCode = await code(t.db, yorkWorker.workerId!);
      const first = await bookedShift(t.db, leeds, a, pay), second = await bookedShift(t.db, leeds, b, pay);
      vi.setSystemTime(AFTER);
      const { payable } = await confirmWork(t.db, first.offer.id, leeds);
      await confirmWork(t.db, second.offer.id, leeds);
      await importAttributedSales(t.db, leeds, csv(["A1", aCode, "2026-01-19T10:00:00Z", "700.00", "GBP"], ["B1", bCode, "2026-01-19T10:00:00Z", "33.00", "GBP"]));
      // Another location or tenant can neither attribute to, see, confirm nor approve this work.
      for (const stranger of [york, rivalManager]) {
        expect((await importAttributedSales(t.db, stranger, csv(["X1", aCode, "2026-01-19T10:30:00Z", "5.00", "GBP"]))).rejected[0].reason).toBe("UNKNOWN_CODE");
        expect(await getLocationPerformance(t.db, stranger)).toEqual([]);
        await expect(confirmWorkPerformance(t.db, stranger, first.allocation.id, { count: 1, minor: 70_000 })).rejects.toThrow("Work unavailable");
        await expect(approveWorkPayable(t.db, stranger, payable!.id)).rejects.toThrow("Payable unavailable");
      }
      expect((await importAttributedSales(t.db, leeds, csv(["Y1", yorkCode, "2026-01-19T10:00:00Z", "5.00", "GBP"]))).rejected[0].reason).toBe("UNKNOWN_CODE");
      expect(await render(york, () => ManagerWorkspace({ area: "review" }))).not.toContain("Ada ");
      // A worker can't import or confirm, and posted worker or location IDs are ignored.
      await expect(importAttributedSales(t.db, a, csv(["W1", aCode, "2026-01-19T10:30:00Z", "999.00", "GBP"]))).rejects.toThrow("Access denied");
      await expect(confirmWorkPerformance(t.db, a, first.allocation.id, { count: 1, minor: 70_000 })).rejects.toThrow("Access denied");
      await expect(getLocationPerformance(t.db, a)).rejects.toThrow("Access denied");
      await importAttributedSales(t.db, leeds, csv(["P1", aCode, "2026-01-19T11:00:00Z", "1.00", "GBP"]));
      expect((await t.db.select().from(attributedSales).where(eq(attributedSales.providerTransactionId, "P1")))[0]).toMatchObject({ outletId: c.rows[0].id, workerId: a.workerId, verificationState: "UNVERIFIED" });
      await confirmWorkPerformance(t.db, leeds, first.allocation.id, { count: 2, minor: 70_100 });
      await confirmWorkPerformance(t.db, leeds, second.allocation.id, { count: 1, minor: 3_300 });
      // Each Worker sees only their own figures; no transaction ID or code appears.
      const pageA = await render(a, () => WorkerWorkspace({ area: "earnings" })), pageB = await render(b, () => WorkerWorkspace({ area: "earnings" }));
      expect(pageA).toContain("£701.00"); expect(pageA).not.toContain("£33.00");
      expect(pageB).toContain("£33.00"); expect(pageB).not.toContain("£701.00");
      for (const page of [pageA, pageB]) expect(page).not.toMatch(/A1|B1|P1|FS-[0-9A-F]{8}|Leeds store revenue/);
      expect(await render(a, () => WorkerWorkspace({ area: "home" }))).not.toContain("£33.00");
    } finally { await t.close(); }
  });

  it("lets the database refuse an edited result or incentive, and an approval that disagrees", async () => {
    const t = await createTestDatabase();
    try {
      const s = await setup(t.db);
      const { payable, allocation } = await finishedWork(t.db, s);
      // An incentive with no confirmed result is refused.
      await expect(t.db.update(workPayables).set({ incentiveAmountMinor: 2_500 }).where(eq(workPayables.id, payable.id))).rejects.toThrow();
      await expect(t.db.update(workPayables).set({ status: "APPROVED", approvedAt: new Date(), approvedBy: s.manager.userId, approvedAmountMinor: 10_400, approvedCurrencyCode: "GBP" }).where(eq(workPayables.id, payable.id))).rejects.toThrow();
      await importAttributedSales(t.db, s.manager, csv(["T1", s.code, "2026-01-19T10:00:00Z", "700.00", "GBP"]));
      const result = await confirmWorkPerformance(t.db, s.manager, allocation.id, { count: 1, minor: 70_000 });
      await expect(t.db.update(workPerformanceResults).set({ earnedMinor: 0 }).where(eq(workPerformanceResults.id, result.id))).rejects.toThrow();
      await expect(t.db.delete(workPerformanceResults).where(eq(workPerformanceResults.id, result.id))).rejects.toThrow();
      await expect(t.db.update(workPayables).set({ incentiveAmountMinor: 999_999 }).where(eq(workPayables.id, payable.id))).rejects.toThrow();
      await expect(t.db.update(workPayables).set({ incentiveRequired: false }).where(eq(workPayables.id, payable.id))).rejects.toThrow();
      await expect(t.db.update(workPayables).set({ status: "APPROVED", approvedAt: new Date(), approvedBy: s.manager.userId, approvedAmountMinor: 10_400, approvedCurrencyCode: "GBP" }).where(eq(workPayables.id, payable.id))).rejects.toThrow();
      // A policy can't mix a bonus with commission, or set half of one.
      for (const input of [{ earningsModel: "COMMISSION", commissionBps: 500, commissionBasis: "VERIFIED_ATTRIBUTED_SALES", incentiveTargetMinor: 100, incentiveBonusMinor: 100 }, { earningsModel: "HOURLY", rateMinor: 1_200, incentiveTargetMinor: 100 }, { earningsModel: "HOURLY", rateMinor: 1_200, incentiveTargetMinor: 0, incentiveBonusMinor: 100 }, { earningsModel: "HOURLY", rateMinor: 1_200, incentiveTargetMinor: 100, incentiveBonusMinor: -1 }]) {
        await expect(createWorkPolicy(t.db, input, "Bad", s.c.ownerScope)).rejects.toMatchObject({ feedback: "policy-incentive" });
      }
    } finally { await t.close(); }
  });
});

describe("no knowledge of any particular business", () => {
  // Nothing about the outcome may come from a constant: change every input and every output follows.
  it.each([
    { name: "Target met", rows: [["300.00"], ["400.00"]], target: 65_000, bonus: 2_500, rate: 1_300, count: 2, sales: 70_000, earned: 2_500, final: 12_900 },
    { name: "Same sales, higher target", rows: [["300.00"], ["400.00"]], target: 70_001, bonus: 2_500, rate: 1_300, count: 2, sales: 70_000, earned: 0, final: 10_400 },
    { name: "Replacement evidence", rows: [["10.50"], ["0.25"], ["1.00"]], target: 1_175, bonus: 333, rate: 1_250, count: 3, sales: 1_175, earned: 333, final: 10_333 },
    { name: "Unrelated business, evidence just short", rows: [["11.74"]], target: 1_175, bonus: 1, rate: 1_500, count: 1, sales: 1_174, earned: 0, final: 12_000 },
  ])("follows the evidence: $name", async ({ rows, target, bonus, rate, count, sales, earned, final }) => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db, { name: `Unrelated Co ${randomUUID().slice(0, 4)}`, locations: [`Site ${randomUUID().slice(0, 4)}`] });
      const manager = await c.manager(), worker = await c.worker(manager, `Name${randomUUID().slice(0, 4)}`), pay = await terms(t.db, c.ownerScope, { rate, target, bonus });
      const workerCode = await code(t.db, worker.workerId!);
      const { allocation, offer } = await bookedShift(t.db, manager, worker, pay);
      vi.setSystemTime(AFTER);
      const { payable } = await confirmWork(t.db, offer.id, manager);
      await importAttributedSales(t.db, manager, csv(...rows.map(([amount], i) => [`R${i}`, workerCode, `2026-01-19T1${i}:00:00Z`, amount, "GBP"] as [string, string, string, string, string])));
      expect(await confirmWorkPerformance(t.db, manager, allocation.id, { count, minor: sales })).toMatchObject({ salesCount: count, salesMinor: sales, earnedMinor: earned });
      expect(await approveWorkPayable(t.db, manager, payable!.id)).toMatchObject({ approvedAmountMinor: final, incentiveAmountMinor: earned });
    } finally { await t.close(); }
  });

  it("uses the location's own currency and clock", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db, { country: "South Africa", timezone: "Africa/Johannesburg", locations: ["Sandton"] });
      const manager = await c.manager(), worker = await c.worker(manager), pay = await terms(t.db, c.ownerScope), workerCode = await code(t.db, worker.workerId!);
      const currency = pay.policy.currencyCode;
      const { allocation, offer } = await bookedShift(t.db, manager, worker, pay);
      vi.setSystemTime(AFTER);
      await confirmWork(t.db, offer.id, manager);
      // 11:30 in Johannesburg, written with its own offset, is the same instant as 09:30Z.
      expect(await importAttributedSales(t.db, manager, csv(["T1", workerCode, "2026-01-19T11:30:00+02:00", "700.00", currency]))).toMatchObject({ imported: 1 });
      const wrong = currency === "GBP" ? "USD" : "GBP";
      expect((await importAttributedSales(t.db, manager, csv(["T2", workerCode, "2026-01-19T12:00:00+02:00", "1.00", wrong]))).rejected[0].reason).toBe("WRONG_CURRENCY");
      expect(await confirmWorkPerformance(t.db, manager, allocation.id, { count: 1, minor: 70_000 })).toMatchObject({ currencyCode: currency, earnedMinor: 2_500 });
    } finally { await t.close(); }
  });

  it("carries no reference to a business, place, person or amount in its logic", async () => {
    const { readFile } = await import("node:fs/promises");
    for (const file of ["src/server/domain/incentive.ts", "src/server/performance/attribution.ts"]) {
      const source = await readFile(file, "utf8");
      for (const banned of [/Rosebank|Leeds|London|Johannesburg|Alex Morgan|Zettle/, /DEMO_/, /"GBP"|"USD"|"ZAR"/, /65_?000|2_?500|650|\b25\b/]) expect(source, `${file} ${banned}`).not.toMatch(banned);
    }
  });
});

describe("recorded work outcomes for the Owner", () => {
  it("sums confirmed pay and attributed evidence by location, counts payables needing approval, and stays inside its tenant and location", async () => {
    const t = await createTestDatabase();
    try {
      const s = await setup(t.db), other = await business(t.db, { locations: ["Elsewhere"] });
      expect(await getWorkOutcomes(t.db, s.c.ownerScope)).toEqual([]);
      const { payable } = await finishedWork(t.db, s);
      expect(await getWorkOutcomes(t.db, s.c.ownerScope)).toMatchObject([{ currency: "GBP", confirmedShifts: 1, confirmedPayMinor: payable.baseAmountMinor, paidMinor: 0, attributedSalesMinor: 0, shiftsWithAttribution: 0 }]);
      expect((await getOwnerOverview(t.db, s.c.ownerScope)).payables).toEqual({ awaitingApproval: 1, needsAttention: 0 });
      expect(await getWorkOutcomes(t.db, other.ownerScope)).toEqual([]);
      expect((await getOwnerOverview(t.db, other.ownerScope)).payables).toEqual({ awaitingApproval: 0, needsAttention: 0 });
      await expect(getWorkOutcomes(t.db, s.worker)).rejects.toThrow("Access denied");
    } finally { await t.close(); }
  }, 120_000);
});
