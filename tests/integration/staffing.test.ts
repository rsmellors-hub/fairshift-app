import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import type { Scope } from "@/server/auth/access";
import { requireScope } from "@/server/auth/request";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { organisations, outletTradingHours, outlets, regularCoverageWindows, shifts } from "@/server/db/schema";
import { shiftDate } from "@/server/intelligence/forecast";
import { getWeeklyStaffing } from "@/server/intelligence/staffing";
import { calculateDayWorkload, type TransactionSlot } from "@/server/intelligence/workload";
import { provisionReferenceHistory } from "@/server/reference/provision";
import { REFERENCE_DATASET, REFERENCE_STORE_CODES, REFERENCE_WORKLOAD_POLICY, referenceCoverage, referenceDates, referenceTradingHours, referenceTransactions } from "@/server/reference/uk-hospitality";
import { allocateAssignment, changeAssignment, createDepartment, createRequirement, createWorkPolicy, offerAssignment, respondToAssignment } from "@/server/scheduling/operations";
import { OwnerWeeklyForecast } from "@/app/owner/weekly-forecast";
import { OwnerOverview } from "@/app/owner/overview";
import { OwnerWorkspace } from "@/app/owner/workspace";
import { ManagerWorkspace } from "@/app/manager/workspace";
import { getOwnerOverview, ownerStaffingSummary } from "@/server/product/owner-overview";
import { getWeeklyForecast } from "@/server/intelligence/weekly";
import { createActivatedTeamMember } from "../helpers/workers";

vi.mock("@/server/auth/request", () => ({ requireScope: vi.fn() }));
vi.mock("@/server/db/client", () => ({ getDatabase: vi.fn() }));
vi.mock("@/server/config/env", () => ({ getConfigurationStatus: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];
// Sunday 25 Oct 2026 in London; the planning week is Mon 26 Oct – Sun 1 Nov 2026.
const NOW = new Date("2026-10-25T10:00:00Z");
const WEEK = Array.from({ length: 7 }, (_, i) => shiftDate("2026-10-26", i));

async function referenceCompany(db: Db, from = "2026-09-21") {
  const organisationId = randomUUID();
  await db.insert(organisations).values({ id: organisationId, name: "Staffing company", country: "United Kingdom" });
  const rows = REFERENCE_STORE_CODES.map((code, i) => ({ id: randomUUID(), organisationId, name: `${i + 1} ${code} venue`, timezone: "Europe/London" }));
  await db.insert(outlets).values(rows);
  const mapping = Object.fromEntries(REFERENCE_STORE_CODES.map((code, i) => [code, rows[i].id])) as Record<typeof REFERENCE_STORE_CODES[number], string>;
  await provisionReferenceHistory(db, { organisationId, outlets: mapping, from, through: "2026-10-18" });
  const owner: Scope = { userId: randomUUID(), organisationId, locationId: rows[0].id, role: "OWNER", organisationName: "Staffing company", locationName: rows[0].name };
  return { organisationId, rows, mapping, owner };
}

// A published casual shift at one location, with an operational scope for it.
async function casualShift(db: Db, scope: { organisationId: string; locationId: string }, startsAt: string, endsAt: string, headcount = 4) {
  const [department] = await createDepartment(db, `Sales floor ${randomUUID().slice(0, 6)}`, scope);
  const [policy] = await createWorkPolicy(db, { earningsModel: "HOURLY", rateMinor: 1_200 }, "Casual hourly", scope);
  return createRequirement(db, { departmentId: department.id, policyId: policy.id, startsAt: new Date(startsAt), endsAt: new Date(endsAt), requiredHeadcount: headcount }, scope);
}
let n = 0;
const casualWorker = async (db: Db, scope: { organisationId: string; locationId: string }) =>
  (await createActivatedTeamMember(db, { firstName: "Casual", surname: `Worker ${++n}`, telephone: "+441132000000", email: `casual${n}@example.test` }, scope)).worker;
async function allocated(db: Db, scope: { organisationId: string; locationId: string }, shiftId: string) {
  const worker = await casualWorker(db, scope);
  const offer = await offerAssignment(db, shiftId, worker.id, scope);
  await respondToAssignment(db, worker.id, offer.id, 1, "ACCEPTED", true, scope);
  await allocateAssignment(db, offer.id, scope);
  return offer;
}

describe("coverage-aware weekly staffing", () => {
  it("derives a five-location week by time of day from transactions and the reference policy, with no stored outputs", async () => {
    const t = await createTestDatabase();
    try {
      const c = await referenceCompany(t.db);
      const staffing = await getWeeklyStaffing(t.db, c.owner, NOW);
      expect(staffing.outlets).toHaveLength(5);
      for (const [i, outlet] of staffing.outlets.entries()) {
        const code = REFERENCE_STORE_CODES[i];
        expect(outlet).toMatchObject({ currency: "GBP", policy: { ...REFERENCE_WORKLOAD_POLICY, source: "REFERENCE", level: "ORGANISATION", version: "organisation-v1" }, regularCoverage: "REFERENCE", tradingHours: "REFERENCE", timezone: "Europe/London",
          evidence: { source: "REFERENCE", kind: "HISTORICAL", dataThrough: "2026-10-18", ageDays: 8, dataset: REFERENCE_DATASET.version } });
        expect(outlet.days.map(day => day.planningDate)).toEqual(WEEK);
        // Independent derivation: generator bills → time slots → the pure calculation.
        const slots = new Map<string, TransactionSlot>();
        for (const date of referenceDates("2026-09-21", "2026-10-18")) for (const bill of referenceTransactions(code, date)) {
          const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(bill.occurredAt).map(part => [part.type, part.value]));
          const minute = Number(parts.hour) * 60 + Math.floor(Number(parts.minute) / 15) * 15;
          const row = slots.get(`${date}:${minute}`) ?? { date, minute, transactions: 0, salesMinor: 0 };
          row.transactions++; row.salesMinor += bill.amountMinor;
          slots.set(`${date}:${minute}`, row);
        }
        for (const day of outlet.days) {
          const weekday = new Date(`${day.planningDate}T12:00:00Z`).getUTCDay() || 7;
          const expected = calculateDayWorkload({ date: day.planningDate, timezone: "Europe/London", trading: referenceTradingHours(code)[weekday - 1], coverage: referenceCoverage(code)[weekday - 1], policy: REFERENCE_WORKLOAD_POLICY, slots: [...slots.values()], dataThrough: "2026-10-18", allocated: [] });
          expect(day).toMatchObject({ requiredMinutes: expected.requiredMinutes, regularMinutes: expected.regularMinutes, casualGapMinutes: expected.remainingMinutes, expectedMilliTransactions: expected.expectedMilliTransactions, periods: expected.periods, unavailable: null });
        }
      }
      expect(staffing.consolidated).toMatchObject({ currency: "GBP", firstDate: WEEK[0], lastDate: WEEK[6] });
      expect(staffing.consolidated!.totals.casualGapMinutes).toBe(staffing.outlets.reduce((sum, outlet) => sum + outlet.totals!.casualGapMinutes, 0));
      expect(await getWeeklyStaffing(t.db, c.owner, NOW)).toEqual(staffing);

      // Reloading the reference input keeps one row per venue weekday; no outputs are persisted.
      const before = await t.db.select().from(regularCoverageWindows).orderBy(regularCoverageWindows.id);
      expect(before).toHaveLength(35);
      expect(before.every(row => row.source === "REFERENCE" && row.organisationId === c.organisationId)).toBe(true);
      expect(await t.db.select().from(outletTradingHours)).toHaveLength(35);
      await provisionReferenceHistory(t.db, { organisationId: c.organisationId, outlets: c.mapping, from: "2026-10-12", through: "2026-10-18" });
      expect((await t.db.select().from(regularCoverageWindows).orderBy(regularCoverageWindows.id)).map(row => [row.id, row.outletId, row.isoWeekday, row.windows]))
        .toEqual(before.map(row => [row.id, row.outletId, row.isoWeekday, row.windows]));
      // Sales dates are never rewritten to look current.
      expect((await t.db.execute(sql`select max(occurred_at) < '2026-10-19' as historical from sale_transactions`)).rows[0]).toMatchObject({ historical: true });

      // The planning week follows the injected clock; evidence keeps its own date.
      const later = await getWeeklyStaffing(t.db, c.owner, new Date("2027-03-01T10:00:00Z"));
      expect(later.outlets[0].days[0].planningDate).toBe("2027-03-02");
      expect(later.outlets[0].evidence).toMatchObject({ dataThrough: "2026-10-18" });
    } finally { await t.close(); }
  }, 240_000);

  it("counts only allocated casual shifts of the same organisation, location and local date", async () => {
    const t = await createTestDatabase();
    try {
      const c = await referenceCompany(t.db, "2026-09-21");
      const uk01 = { organisationId: c.organisationId, locationId: c.mapping.UK01 };
      const uk02 = { organisationId: c.organisationId, locationId: c.mapping.UK02 };
      const baseline = (await getWeeklyStaffing(t.db, c.owner, NOW)).outlets.find(row => row.outletId === uk01.locationId)!;
      expect(baseline.days.every(day => day.allocatedCasualMinutes === 0)).toBe(true);

      // Tue 27 Oct 09:00–17:00 GMT at a venue open 07:00–17:00: offered, accepted-not-allocated, declined and allocated workers.
      const shift = await casualShift(t.db, uk01, "2026-10-27T09:00:00Z", "2026-10-27T17:00:00Z");
      const offered = await casualWorker(t.db, uk01);
      await offerAssignment(t.db, shift.id, offered.id, uk01);
      const accepted = await casualWorker(t.db, uk01);
      const acceptedOffer = await offerAssignment(t.db, shift.id, accepted.id, uk01);
      await respondToAssignment(t.db, accepted.id, acceptedOffer.id, 1, "ACCEPTED", true, uk01);
      const declined = await casualWorker(t.db, uk01);
      const declinedOffer = await offerAssignment(t.db, shift.id, declined.id, uk01);
      await respondToAssignment(t.db, declined.id, declinedOffer.id, 1, "DECLINED", false, uk01);
      const day = async () => (await getWeeklyStaffing(t.db, c.owner, NOW)).outlets.find(row => row.outletId === uk01.locationId)!.days[1];
      expect((await day()).allocatedCasualMinutes).toBe(0); // offered, accepted and declined do not count
      await allocateAssignment(t.db, acceptedOffer.id, uk01);
      const covered = await day();
      expect(covered).toMatchObject({ planningDate: "2026-10-27", allocatedCasualMinutes: 480 });
      // Eight casual hours can't all be used where they aren't needed: never below the true remainder.
      expect(covered.casualGapMinutes).toBeGreaterThanOrEqual(baseline.days[1].casualGapMinutes! - 480);
      expect(covered.casualGapMinutes).toBeLessThan(baseline.days[1].casualGapMinutes!);
      expect(covered.coverageMinutes).toBe(baseline.days[1].regularMinutes! + 480);

      // Wrong date (outside the planning week), wrong location, wrong organisation: none count for UK01.
      await allocated(t.db, uk01, (await casualShift(t.db, uk01, "2026-11-10T09:00:00Z", "2026-11-10T17:00:00Z")).id);
      await allocated(t.db, uk02, (await casualShift(t.db, uk02, "2026-10-27T09:00:00Z", "2026-10-27T13:00:00Z")).id);
      const other = await referenceCompany(t.db, "2026-10-12");
      const otherUk01 = { organisationId: other.organisationId, locationId: other.mapping.UK01 };
      await allocated(t.db, otherUk01, (await casualShift(t.db, otherUk01, "2026-10-27T09:00:00Z", "2026-10-27T15:00:00Z")).id);
      const week = await getWeeklyStaffing(t.db, c.owner, NOW);
      expect(week.outlets.find(row => row.outletId === uk01.locationId)!.days.map(row => row.allocatedCasualMinutes)).toEqual([0, 480, 0, 0, 0, 0, 0]);
      // That shift starts before this venue opens at 11:00: only the overlapping two hours count.
      expect(week.outlets.find(row => row.outletId === uk02.locationId)!.days[1].allocatedCasualMinutes).toBe(120);
      expect((await getWeeklyStaffing(t.db, other.owner, NOW)).outlets.find(row => row.outletId === otherUk01.locationId)!.days[1].allocatedCasualMinutes).toBe(360);

      // A material change requires re-acceptance, and cancellation closes the work: neither stays covered.
      await changeAssignment(t.db, uk01, shift.id, { startsAt: new Date("2026-10-27T10:00:00Z"), endsAt: new Date("2026-10-27T18:00:00Z") });
      const [changed] = await t.db.select().from(shifts).where(eq(shifts.id, shift.id));
      expect(changed.shiftDate).toBe("2026-10-27");
      expect(changed.termsVersion).toBe(2);
      expect((await day()).allocatedCasualMinutes).toBe(0);
      await changeAssignment(t.db, uk01, shift.id, { cancel: true });
      expect((await day()).allocatedCasualMinutes).toBe(0);
    } finally { await t.close(); }
  }, 240_000);

  it("scopes staffing to the organisation and the manager's location, and refuses team members", async () => {
    const t = await createTestDatabase();
    try {
      const c = await referenceCompany(t.db, "2026-10-12");
      const otherId = randomUUID();
      await t.db.insert(organisations).values({ id: otherId, name: "Other company" });
      expect((await getWeeklyStaffing(t.db, { ...c.owner, organisationId: otherId }, NOW)).outlets).toEqual([]);
      const manager = await getWeeklyStaffing(t.db, { ...c.owner, role: "MANAGER", locationId: c.mapping.UK03 }, NOW);
      expect(manager.outlets.map(row => row.outletId)).toEqual([c.mapping.UK03]);
      expect((await getWeeklyStaffing(t.db, { ...c.owner, organisationId: otherId, role: "MANAGER", locationId: c.mapping.UK03 }, NOW)).outlets).toEqual([]);
      await expect(getWeeklyStaffing(t.db, { ...c.owner, role: "TEAM_MEMBER" }, NOW)).rejects.toThrow("Access denied");
      // Coverage rows cannot be attached to another organisation's location, or hold a non-list.
      await expect(t.db.insert(regularCoverageWindows).values({ id: randomUUID(), organisationId: otherId, outletId: c.mapping.UK02, isoWeekday: 1, windows: [], source: "REFERENCE" })).rejects.toThrow();
      await t.db.delete(regularCoverageWindows).where(eq(regularCoverageWindows.outletId, c.mapping.UK01));
      await expect(t.db.insert(regularCoverageWindows).values({ id: randomUUID(), organisationId: c.organisationId, outletId: c.mapping.UK01, isoWeekday: 1, windows: { bad: true }, source: "REFERENCE" })).rejects.toThrow();
    } finally { await t.close(); }
  }, 240_000);

  it("shows locations without forecast or coverage as unavailable, not zero, and keeps the forecast when coverage fails", async () => {
    const t = await createTestDatabase();
    try {
      const c = await referenceCompany(t.db, "2026-10-12");
      const empty = randomUUID();
      await t.db.insert(outlets).values({ id: empty, organisationId: c.organisationId, name: "0 New venue", timezone: "Europe/London" });
      const staffing = await getWeeklyStaffing(t.db, c.owner, NOW);
      const missing = staffing.outlets.find(row => row.outletId === empty)!;
      expect(missing.days.every(day => day.unavailable === "NO_FORECAST" && day.forecastSalesMinor === null && day.casualGapMinutes === null)).toBe(true);
      expect(missing.totals).toBeNull();
      expect(staffing.consolidated).toBeNull();
      let html = renderToStaticMarkup(createElement(OwnerWeeklyForecast, { weekly: await getWeeklyForecast(t.db, c.owner, NOW), staffing }));
      expect(html).toContain("No forecast, so no staff requirement");
      expect(html).toContain("5 of 6 locations have a complete staffing week.");
      // A fully covered location truly shows 0 h; a location with no forecast never does.
      expect(html).not.toContain(">£0<");
      const emptyRow = html.match(/<strong>0 New venue<\/strong><\/th>(.*?)<\/tr>/)![1];
      expect(emptyRow).toContain("Unavailable");
      expect(emptyRow).not.toContain(">0 h<");

      vi.mocked(getDatabase).mockReturnValue(t.db);
      vi.mocked(getConfigurationStatus).mockReturnValue({ databaseConfigured: true } as ReturnType<typeof getConfigurationStatus>);
      vi.mocked(requireScope).mockResolvedValue(c.owner);
      await t.db.delete(outlets).where(eq(outlets.id, empty));
      await t.db.execute(sql`alter table regular_coverage_windows rename to regular_coverage_windows_offline`);
      await expect(getWeeklyStaffing(t.db, c.owner, NOW)).rejects.toThrow();
      html = renderToStaticMarkup(await OwnerWorkspace({ area: "forecast" }));
      expect(html).toContain("Expected sales by location");
      expect(html).toContain("Staffing could not be loaded");
      expect(html).toContain("Coverage could not be loaded. No gap has been assumed.");
      expect(html).not.toMatch(/>0 h</);
    } finally { await t.close(); }
  }, 240_000);

  it("renders Owner and single-location Manager staffing in GBP with the reference assumption and no created-shift claims", async () => {
    const t = await createTestDatabase();
    try {
      const c = await referenceCompany(t.db);
      vi.mocked(getDatabase).mockReturnValue(t.db);
      vi.mocked(getConfigurationStatus).mockReturnValue({ databaseConfigured: true } as ReturnType<typeof getConfigurationStatus>);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
      vi.mocked(requireScope).mockResolvedValue(c.owner);
      let html = renderToStaticMarkup(await OwnerWorkspace({ area: "forecast" }));
      for (const text of ["Planning week", "Mon, 26 Oct 2026 – Sun, 1 Nov 2026", "Historical evidence through Sun, 18 Oct 2026", "Commercial", "Operational", "Staffing and opportunity", "Expected sales by location", "Expected transactions by location", "Casual requirement by location",
        "Required staff capacity", "Regular coverage", "Allocated casual coverage", "Spare cover at one time doesn’t offset a shortage at another",
        "Workload policy: 7 transactions per staff hour, at least 2 staff while open, the reference company’s configured policy", "No shifts have been created or offered", "standing cover (synthetic input)"]) expect(html).toContain(text);
      expect(html).not.toContain("$");
      expect(html).not.toMatch(/live demand|real-time|optimal|workers required|AI says|shifts created/i);

      const staffing = await getWeeklyStaffing(t.db, c.owner, NOW);
      html = renderToStaticMarkup(createElement(OwnerOverview, { data: await getOwnerOverview(t.db, c.owner), staffing: ownerStaffingSummary(staffing) }));
      expect(html).toContain(`Planning week 26 Oct – 1 Nov 2026`);
      expect(html).toContain(`approx. ${staffing.consolidated!.totals.indicativeShifts} shifts to fill`);
      expect(html).toContain("approx.");

      const manager: Scope = { ...c.owner, role: "MANAGER", locationId: c.mapping.UK04, locationName: c.rows[3].name };
      vi.mocked(requireScope).mockResolvedValue(manager);
      html = renderToStaticMarkup(await ManagerWorkspace({ area: "plan" }));
      const uk04 = staffing.outlets.find(row => row.outletId === c.mapping.UK04)!;
      expect(html).toContain("Planning week Mon, 26 Oct 2026 – Sun, 1 Nov 2026");
      expect(html).toContain("Historical evidence through Sun, 18 Oct 2026 (8 days before the planning week)");
      expect(html).toContain(`Approx. ${uk04.totals!.indicativeShifts} shifts to fill · none created`);
      for (const text of ["Where casual cover is needed", "By time of day", "Expected transactions", "/manager/fill?date=", "&amp;window="]) expect(html).toContain(text);
      expect(html).toContain("needs the most cover");
      expect(html).not.toContain('name="locationId"'); // one authorised location: no selector
      for (const other of c.rows.filter(row => row.id !== c.mapping.UK04)) expect(html).not.toContain(other.name);
    } finally { await t.close(); }
  }, 240_000);
});
