import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { entitled } from "../helpers/onboarding";
import { ALL_DAY, hours, ingestTimedBills } from "../helpers/workload";
import type { Scope } from "@/server/auth/access";
import { auditEvents, labourPolicies, organisations, outletTradingHours, outlets, regularCoverageWindows, subscriptions, users, workloadPolicies } from "@/server/db/schema";
import { clearWorkloadPolicy, getStaffingConfiguration, setRegularCoverage, setTradingHours, setWorkloadPolicy } from "@/server/intelligence/business-policy";
import { getWeeklyStaffing } from "@/server/intelligence/staffing";

type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];
const NOW = new Date("2026-10-25T10:00:00Z");
async function company(db: Db, locations = 2) {
  const organisationId = randomUUID();
  await db.insert(organisations).values({ id: organisationId, name: "Any business", country: "Ireland" });
  await db.insert(subscriptions).values({ id: randomUUID(), organisationId, requestId: randomUUID() });
  await entitled(db, organisationId);
  const rows = Array.from({ length: locations }, (_, i) => ({ id: randomUUID(), organisationId, name: `Venue ${i}`, timezone: "Europe/Dublin" }));
  await db.insert(outlets).values(rows);
  const userId = randomUUID();
  await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: "Owner", passwordHash: "x", emailVerifiedAt: NOW });
  const owner = (locationId = rows[0].id): Scope => ({ userId, organisationId, locationId, role: "OWNER", organisationName: "Any business", locationName: "Venue" });
  return { organisationId, rows, owner };
}
// Ten bills a day at 12:10 local for 56 days to 20 Sep 2026, in Dublin summer time. Test-fixture history.
const history = (db: Db, organisationId: string, outletId: string) => ingestTimedBills(db, { organisationId, outletId, currencyCode: "EUR", through: "2026-09-20", bills: () => 10, at: "11:10:00Z", now: NOW, sourceSystem: "till" });
const POLICY = (transactionsPerStaffHour: number, minimumStaffWhileOpen = 0) => ({ transactionsPerStaffHour, minimumStaffWhileOpen }); // Test-fixture values.
const ALL_WEEK = <T,>(value: T) => Array(7).fill(value) as T[];
const NOON = 12 * 60;

describe("the business's workload policy", () => {
  it("applies the organisation default, a location override, and no silent default", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      const [a, b] = c.rows.map(row => row.id);
      for (const id of [a, b]) { await history(t.db, c.organisationId, id); await setTradingHours(t.db, c.owner(id), ALL_WEEK(ALL_DAY)); }
      const staffing = async () => { const s = await getWeeklyStaffing(t.db, c.owner(), NOW); return (id: string) => s.outlets.find(o => o.outletId === id)!; };
      const noon = (id: string, at: Awaited<ReturnType<typeof staffing>>) => at(id).days[0].blocks.find(block => block.start === NOON)!;

      // No policy: demand exists, required staff is unavailable, not zero and not a default.
      let at = await staffing();
      expect(at(a).policy).toBeNull();
      expect(at(a).days[0]).toMatchObject({ expectedMilliTransactions: 10_000, requiredMinutes: null, casualGapMinutes: null, unavailable: "NO_WORKLOAD_POLICY" });

      const first = await setWorkloadPolicy(t.db, c.owner(), "ORGANISATION", POLICY(8));
      expect(first).toMatchObject({ version: 1, outletId: null, status: "ACTIVE", source: "CONFIGURED", transactionsPerStaffHour: 8, createdBy: c.owner().userId });
      at = await staffing();
      expect(at(a).policy).toMatchObject({ version: "organisation-v1", transactionsPerStaffHour: 8, level: "ORGANISATION" });
      expect(noon(a, at).requiredMinutes).toBe(75); // 10/8 = 1.25 h

      await setWorkloadPolicy(t.db, c.owner(b), "LOCATION", POLICY(20));
      at = await staffing();
      expect(noon(a, at).requiredMinutes).toBe(75);
      expect(at(b).policy).toMatchObject({ version: "location-v1", level: "LOCATION", transactionsPerStaffHour: 20 });
      expect(noon(b, at).requiredMinutes).toBe(30);

      // A new version replaces the old, which is kept; a repeat adds nothing.
      await setWorkloadPolicy(t.db, c.owner(), "ORGANISATION", POLICY(10));
      expect((await setWorkloadPolicy(t.db, c.owner(), "ORGANISATION", POLICY(10))).version).toBe(2);
      const versions = await t.db.select().from(workloadPolicies).where(eq(workloadPolicies.organisationId, c.organisationId));
      expect(versions.filter(row => row.outletId === null).map(row => [row.version, row.status]).sort()).toEqual([[1, "SUPERSEDED"], [2, "ACTIVE"]]);
      at = await staffing();
      expect(noon(a, at).requiredMinutes).toBe(60);

      // Removing the override returns to the default; removing that leaves nothing.
      await clearWorkloadPolicy(t.db, c.owner(b), "LOCATION");
      at = await staffing();
      expect(at(b).policy).toMatchObject({ version: "organisation-v2" });
      await clearWorkloadPolicy(t.db, c.owner(), "ORGANISATION");
      at = await staffing();
      expect(at(a).days[0]).toMatchObject({ requiredMinutes: null, unavailable: "NO_WORKLOAD_POLICY" });
      expect((await t.db.select().from(auditEvents)).map(event => event.action).filter(action => action.startsWith("WORKLOAD_POLICY"))).toEqual(expect.arrayContaining(["WORKLOAD_POLICY_SET", "WORKLOAD_POLICY_CLEARED"]));
      // The database keeps versions immutable and retained.
      await expect(t.db.update(workloadPolicies).set({ transactionsPerStaffHour: 99 }).where(eq(workloadPolicies.organisationId, c.organisationId))).rejects.toThrow();
      await expect(t.db.delete(workloadPolicies).where(eq(workloadPolicies.organisationId, c.organisationId))).rejects.toThrow();
    } finally { await t.close(); }
  });

  it("minimum cover applies while open, and a configured zero differs from no policy", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db, 1);
      const a = c.rows[0].id;
      await history(t.db, c.organisationId, a);
      await setTradingHours(t.db, c.owner(), ALL_WEEK([hours(9, 11), hours(12, 13)].map(({ start, end }) => ({ start, end }))));
      await setRegularCoverage(t.db, c.owner(), ALL_WEEK([]));
      await setWorkloadPolicy(t.db, c.owner(), "ORGANISATION", POLICY(10, 0));
      expect((await getWeeklyStaffing(t.db, c.owner(), NOW)).outlets[0].days[0].blocks.map(block => block.requiredMinutes)).toEqual([0, 0, 60]);
      await setWorkloadPolicy(t.db, c.owner(), "ORGANISATION", POLICY(10, 2));
      expect((await getWeeklyStaffing(t.db, c.owner(), NOW)).outlets[0].days[0].blocks.map(block => block.requiredMinutes)).toEqual([120, 120, 120]);
    } finally { await t.close(); }
  });

  it("rejects invalid policy values and stores nothing", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      for (const invalid of [POLICY(0), POLICY(-1), POLICY(1.5), POLICY(1001), POLICY(10, -1), POLICY(10, 101), POLICY(10, 0.5), { transactionsPerStaffHour: 10 }, { minimumStaffWhileOpen: 1 }, { ...POLICY(10), source: "REFERENCE" }, null, "ten"]) {
        await expect(setWorkloadPolicy(t.db, c.owner(), "ORGANISATION", invalid)).rejects.toThrow();
      }
      expect(await t.db.select().from(workloadPolicies)).toEqual([]);
      expect((await setWorkloadPolicy(t.db, c.owner(), "ORGANISATION", POLICY(1000, 100))).transactionsPerStaffHour).toBe(1000);
    } finally { await t.close(); }
  });

  it("enforces Owner authority and tenant boundaries on the server", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db), other = await company(t.db);
      const [a] = c.rows.map(row => row.id);
      await history(t.db, c.organisationId, a);
      await setWorkloadPolicy(t.db, c.owner(), "ORGANISATION", POLICY(10));
      await setTradingHours(t.db, c.owner(), ALL_WEEK(ALL_DAY));
      await setRegularCoverage(t.db, c.owner(), ALL_WEEK([hours(9, 11)]));
      const before = { policies: await t.db.select().from(workloadPolicies), trading: await t.db.select().from(outletTradingHours), coverage: await t.db.select().from(regularCoverageWindows) };
      const denied: Scope[] = [{ ...c.owner(), role: "MANAGER" }, { ...c.owner(), role: "TEAM_MEMBER", workerId: randomUUID() }];
      for (const scope of denied) {
        await expect(setWorkloadPolicy(t.db, scope, "ORGANISATION", POLICY(1))).rejects.toThrow("Access denied.");
        await expect(setWorkloadPolicy(t.db, scope, "LOCATION", POLICY(1))).rejects.toThrow("Access denied.");
        await expect(clearWorkloadPolicy(t.db, scope, "ORGANISATION")).rejects.toThrow("Access denied.");
        await expect(setTradingHours(t.db, scope, ALL_WEEK([]))).rejects.toThrow("Access denied.");
        await expect(setRegularCoverage(t.db, scope, ALL_WEEK([]))).rejects.toThrow("Access denied.");
        await expect(getStaffingConfiguration(t.db, scope)).rejects.toThrow("Access denied.");
      }
      // Another organisation's Owner pointing at this location is refused.
      const forged = other.owner(a);
      await expect(setWorkloadPolicy(t.db, forged, "LOCATION", POLICY(1))).rejects.toThrow("Location unavailable.");
      await expect(clearWorkloadPolicy(t.db, forged, "LOCATION")).rejects.toThrow("Location unavailable.");
      await expect(setTradingHours(t.db, forged, ALL_WEEK([]))).rejects.toThrow("Location unavailable.");
      await expect(setRegularCoverage(t.db, forged, ALL_WEEK([]))).rejects.toThrow("Location unavailable.");
      await expect(getStaffingConfiguration(t.db, forged)).rejects.toThrow("Location unavailable.");
      expect(await t.db.select().from(workloadPolicies)).toEqual(before.policies);
      expect(await t.db.select().from(outletTradingHours)).toEqual(before.trading);
      expect(await t.db.select().from(regularCoverageWindows)).toEqual(before.coverage);
      // The database refuses rows attached to another organisation's location.
      await expect(t.db.insert(workloadPolicies).values({ id: randomUUID(), organisationId: other.organisationId, outletId: a, version: 1, ...POLICY(1), source: "CONFIGURED" })).rejects.toThrow();
      await expect(t.db.insert(outletTradingHours).values({ id: randomUUID(), organisationId: other.organisationId, outletId: a, isoWeekday: 1, windows: [], source: "CONFIGURED" })).rejects.toThrow();
      await expect(t.db.insert(regularCoverageWindows).values({ id: randomUUID(), organisationId: other.organisationId, outletId: a, isoWeekday: 1, windows: [], source: "CONFIGURED" })).rejects.toThrow();
      // Another business's policy is never applied, and its data never read.
      await history(t.db, other.organisationId, other.rows[0].id);
      expect((await getWeeklyStaffing(t.db, other.owner(), NOW)).outlets[0].policy).toBeNull();
      // A manager consumes the resolved policy for their own location only.
      const manager = await getWeeklyStaffing(t.db, { ...c.owner(), role: "MANAGER" }, NOW);
      expect(manager.outlets.map(o => o.outletId)).toEqual([a]);
      expect(manager.outlets[0].policy).toMatchObject({ transactionsPerStaffHour: 10 });
    } finally { await t.close(); }
  });

  it("keeps the retired revenue policy table readable and out of the active path", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db, 1);
      await history(t.db, c.organisationId, c.rows[0].id);
      await t.db.insert(labourPolicies).values({ id: randomUUID(), organisationId: c.organisationId, version: 1, currencyCode: "EUR", salesMinorPerLabourHour: 10_000, source: "CONFIGURED" });
      expect(await t.db.select().from(labourPolicies)).toHaveLength(1);
      await setTradingHours(t.db, c.owner(), ALL_WEEK(ALL_DAY));
      await setRegularCoverage(t.db, c.owner(), ALL_WEEK([]));
      // An old revenue rate alone never produces a staffing figure.
      expect((await getWeeklyStaffing(t.db, c.owner(), NOW)).outlets[0].days[0]).toMatchObject({ requiredMinutes: null, unavailable: "NO_WORKLOAD_POLICY" });
    } finally { await t.close(); }
  });
});

describe("trading hours and regular coverage as business data", () => {
  it("separates configured zero, positive cover and not set", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db, 1);
      const a = c.rows[0].id;
      await history(t.db, c.organisationId, a);
      await setWorkloadPolicy(t.db, c.owner(), "ORGANISATION", POLICY(10));
      const week = async () => (await getWeeklyStaffing(t.db, c.owner(), NOW)).outlets[0];
      // Nothing configured: nothing is invented.
      let o = await week();
      expect(o).toMatchObject({ regularCoverage: null, tradingHours: null, totals: null });
      expect(o.days.every(day => day.closed === null && day.unavailable === "TRADING_HOURS_NOT_SET" && day.requiredMinutes === null)).toBe(true);
      // Hours but no cover: required known, gap not.
      await setTradingHours(t.db, c.owner(), ALL_WEEK(ALL_DAY));
      o = await week();
      expect(o.tradingHours).toBe("CONFIGURED");
      expect(o.days.every(day => day.requiredMinutes === 60 && day.regularMinutes === null && day.casualGapMinutes === null && day.unavailable === "REGULAR_COVERAGE_NOT_SET")).toBe(true);
      // Stated zero: the whole requirement is the gap.
      await setRegularCoverage(t.db, c.owner(), ALL_WEEK([]));
      o = await week();
      expect(o.regularCoverage).toBe("CONFIGURED");
      expect(o.days.every(day => day.regularMinutes === 0 && day.casualGapMinutes === 60 && day.indicativeShifts === 1 && day.unavailable === null)).toBe(true);
      // More than needed: zero, never negative.
      await setRegularCoverage(t.db, c.owner(), ALL_WEEK([hours(12, 13, 3)]));
      o = await week();
      expect(o.days.every(day => day.casualGapMinutes === 0 && day.indicativeShifts === 0)).toBe(true);
      // Repeats are stable: one row per weekday.
      await setRegularCoverage(t.db, c.owner(), ALL_WEEK([hours(12, 13, 3)]));
      expect(await t.db.select().from(regularCoverageWindows).where(eq(regularCoverageWindows.outletId, a))).toHaveLength(7);
      // A blanked day goes back to unknown, for that day only.
      await setRegularCoverage(t.db, c.owner(), [[hours(12, 13)], null, [hours(12, 13)], [hours(12, 13)], [hours(12, 13)], [hours(12, 13)], [hours(12, 13)]]);
      await setTradingHours(t.db, c.owner(), [ALL_DAY, ALL_DAY, ALL_DAY, ALL_DAY, ALL_DAY, [], null]);
      o = await week();
      const on = (weekday: number) => o.days.find(day => new Date(`${day.planningDate}T12:00:00Z`).getUTCDay() === weekday)!;
      expect(on(2)).toMatchObject({ regularMinutes: null, casualGapMinutes: null, unavailable: "REGULAR_COVERAGE_NOT_SET" });
      expect(on(6)).toMatchObject({ closed: true, unavailable: null, requiredMinutes: 0 }); // Stated closed.
      expect(on(0)).toMatchObject({ closed: null, unavailable: "TRADING_HOURS_NOT_SET" }); // Not set.
      expect(o.totals).toBeNull();
      const configuration = await getStaffingConfiguration(t.db, c.owner());
      expect(configuration.trading[5]).toMatchObject({ windows: [], source: "CONFIGURED" });
      expect(configuration.trading[6]).toBeNull();
      expect(configuration.coverage[1]).toBeNull();
      for (const invalid of [Array(6).fill([]), Array(8).fill([]), ALL_WEEK(0), ALL_WEEK([{ start: 600, end: 540, headcount: 1 }]), ALL_WEEK([{ start: 540, end: 700, headcount: 1 }, { start: 600, end: 800, headcount: 1 }]), ALL_WEEK([{ start: 540, end: 700, headcount: 0 }]), "x"]) await expect(setRegularCoverage(t.db, c.owner(), invalid)).rejects.toThrow();
      for (const invalid of [Array(6).fill([]), ALL_WEEK(0), ALL_WEEK([{ start: 600, end: 540 }]), ALL_WEEK([{ start: 540, end: 700 }, { start: 600, end: 800 }]), ALL_WEEK([{ start: 545, end: 700 }]), "x"]) await expect(setTradingHours(t.db, c.owner(), invalid)).rejects.toThrow();
    } finally { await t.close(); }
  });
});
