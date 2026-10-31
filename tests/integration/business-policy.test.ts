import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { entitled } from "../helpers/onboarding";
import type { Scope } from "@/server/auth/access";
import { auditEvents, labourPolicies, organisations, outlets, regularStaffCoverage, subscriptions, users } from "@/server/db/schema";
import { ingestCommerceObservations } from "@/server/commerce/ingestion";
import { clearLabourPolicy, getStaffingConfiguration, MAX_SALES_MINOR_PER_LABOUR_HOUR, setLabourPolicy, setRegularCoverage } from "@/server/intelligence/business-policy";
import { shiftDate } from "@/server/intelligence/forecast";
import { getWeeklyStaffing } from "@/server/intelligence/staffing";

type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];
const NOW = new Date("2026-10-25T10:00:00Z");
async function company(db: Db, locations = 2) {
  const organisationId = randomUUID();
  await db.insert(organisations).values({ id: organisationId, name: "Any business", country: "Ireland" });
  await db.insert(subscriptions).values({ id: randomUUID(), organisationId, requestId: randomUUID() });
  await entitled(db, organisationId);
  const rows = Array.from({ length: locations }, (_, i) => ({ id: randomUUID(), organisationId, name: `Shop ${i}`, timezone: "Europe/Dublin" }));
  await db.insert(outlets).values(rows);
  const userId = randomUUID();
  await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: "Owner", passwordHash: "x", emailVerifiedAt: NOW });
  const owner = (locationId = rows[0].id): Scope => ({ userId, organisationId, locationId, role: "OWNER", organisationName: "Any business", locationName: "Shop" });
  return { organisationId, rows, owner };
}
// £1,000 a day for 56 days to 20 Sep 2026.
async function history(db: Db, organisationId: string, outletIds: string[], currencyCode = "EUR") {
  await ingestCommerceObservations(db, { organisationId, source: "IMPORTED", sourceSystem: "till", now: NOW, observations: outletIds.flatMap(outletId => Array.from({ length: 56 }, (_, i) => ({
    outletId, sourceTransactionId: `D${i}`, occurredAt: `${shiftDate("2026-09-20", -i)}T12:00:00+00:00`, currencyCode, grossAmountMinor: 100_000, status: "COMPLETED" }))) });
}
const EUR = (minor: number) => ({ currencyCode: "EUR", salesMinorPerLabourHour: minor });

describe("business labour policy", () => {
  it("applies the organisation default, a location override, and no silent default", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      const [a, b] = c.rows.map(row => row.id);
      await history(t.db, c.organisationId, [a, b]);
      const staffing = async () => { const s = await getWeeklyStaffing(t.db, c.owner(), NOW); return (id: string) => s.outlets.find(o => o.outletId === id)!; };

      // No policy: forecast exists, required labour is unavailable, not zero and not £100.
      let at = await staffing();
      expect(at(a).policy).toBeNull();
      expect(at(a).days[0]).toMatchObject({ forecastSalesMinor: 100_000, requiredMinutes: null, casualGapMinutes: null, unavailable: "NO_LABOUR_POLICY" });

      const first = await setLabourPolicy(t.db, c.owner(), "ORGANISATION", EUR(7_500));
      expect(first).toMatchObject({ version: 1, outletId: null, status: "ACTIVE", source: "CONFIGURED", salesMinorPerLabourHour: 7_500, createdBy: c.owner().userId });
      at = await staffing();
      expect(at(a).policy).toMatchObject({ version: "organisation-v1", salesMinorPerLabourHour: 7_500, level: "ORGANISATION" });
      expect(at(a).days[0].requiredMinutes).toBe(810); // 1000/75 = 13.33 h, rounded up to 15 minutes

      await setLabourPolicy(t.db, c.owner(b), "LOCATION", EUR(18_000));
      at = await staffing();
      expect(at(a).days[0].requiredMinutes).toBe(810);
      expect(at(b).policy).toMatchObject({ version: "location-v1", level: "LOCATION", salesMinorPerLabourHour: 18_000 });
      expect(at(b).days[0].requiredMinutes).toBe(345); // 1000/180 = 5.56 h

      // A new version replaces the old, which is kept; a repeat adds nothing.
      await setLabourPolicy(t.db, c.owner(), "ORGANISATION", EUR(10_000));
      expect((await setLabourPolicy(t.db, c.owner(), "ORGANISATION", EUR(10_000))).version).toBe(2);
      const versions = await t.db.select().from(labourPolicies).where(eq(labourPolicies.organisationId, c.organisationId));
      expect(versions.filter(row => row.outletId === null).map(row => [row.version, row.status]).sort()).toEqual([[1, "SUPERSEDED"], [2, "ACTIVE"]]);
      at = await staffing();
      expect(at(a).days[0].requiredMinutes).toBe(600);

      // Removing the override returns to the default; removing that leaves nothing.
      await clearLabourPolicy(t.db, c.owner(b), "LOCATION");
      at = await staffing();
      expect(at(b).policy).toMatchObject({ version: "organisation-v2" });
      await clearLabourPolicy(t.db, c.owner(), "ORGANISATION");
      at = await staffing();
      expect(at(a).days[0]).toMatchObject({ requiredMinutes: null, unavailable: "NO_LABOUR_POLICY" });
      expect((await t.db.select().from(auditEvents)).map(event => event.action).filter(action => action.startsWith("LABOUR_POLICY"))).toEqual(expect.arrayContaining(["LABOUR_POLICY_SET", "LABOUR_POLICY_CLEARED"]));
    } finally { await t.close(); }
  });

  it("never converts or borrows across currencies", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      const [a, b] = c.rows.map(row => row.id);
      await history(t.db, c.organisationId, [a, b]);
      await setLabourPolicy(t.db, c.owner(), "ORGANISATION", { currencyCode: "GBP", salesMinorPerLabourHour: 10_000 });
      let s = await getWeeklyStaffing(t.db, c.owner(), NOW);
      expect(s.outlets.every(o => o.policy === null && o.days[0].unavailable === "LABOUR_POLICY_CURRENCY_MISMATCH" && o.days[0].requiredMinutes === null)).toBe(true);
      // An override in the right currency fixes only its location.
      await setLabourPolicy(t.db, c.owner(b), "LOCATION", EUR(10_000));
      s = await getWeeklyStaffing(t.db, c.owner(), NOW);
      expect(s.outlets.find(o => o.outletId === b)!.days[0].requiredMinutes).toBe(600);
      expect(s.outlets.find(o => o.outletId === a)!.days[0].requiredMinutes).toBeNull();
      expect((await getStaffingConfiguration(t.db, c.owner())).evidenceCurrency).toBe("EUR");
    } finally { await t.close(); }
  });

  it("rejects invalid policy values and stores nothing", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      for (const invalid of [EUR(0), EUR(-100), EUR(1.5), EUR(MAX_SALES_MINOR_PER_LABOUR_HOUR + 1), { currencyCode: "eur", salesMinorPerLabourHour: 100 }, { currencyCode: "EURO", salesMinorPerLabourHour: 100 }, { currencyCode: "ZZZ", salesMinorPerLabourHour: 100 }, { currencyCode: "JPY", salesMinorPerLabourHour: 100 }, { currencyCode: "EUR" }, { ...EUR(100), source: "REFERENCE" }]) {
        await expect(setLabourPolicy(t.db, c.owner(), "ORGANISATION", invalid)).rejects.toThrow();
      }
      expect(await t.db.select().from(labourPolicies)).toEqual([]);
      expect((await setLabourPolicy(t.db, c.owner(), "ORGANISATION", EUR(MAX_SALES_MINOR_PER_LABOUR_HOUR))).salesMinorPerLabourHour).toBe(MAX_SALES_MINOR_PER_LABOUR_HOUR);
    } finally { await t.close(); }
  });

  it("enforces Owner authority and tenant boundaries on the server", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db), other = await company(t.db);
      const [a] = c.rows.map(row => row.id);
      await history(t.db, c.organisationId, [a]);
      await setLabourPolicy(t.db, c.owner(), "ORGANISATION", EUR(10_000));
      await setRegularCoverage(t.db, c.owner(), Array(7).fill(120));
      const before = { policies: await t.db.select().from(labourPolicies), coverage: await t.db.select().from(regularStaffCoverage) };
      const denied: Scope[] = [{ ...c.owner(), role: "MANAGER" }, { ...c.owner(), role: "TEAM_MEMBER", workerId: randomUUID() }];
      for (const scope of denied) {
        await expect(setLabourPolicy(t.db, scope, "ORGANISATION", EUR(1))).rejects.toThrow("Access denied.");
        await expect(setLabourPolicy(t.db, scope, "LOCATION", EUR(1))).rejects.toThrow("Access denied.");
        await expect(clearLabourPolicy(t.db, scope, "ORGANISATION")).rejects.toThrow("Access denied.");
        await expect(setRegularCoverage(t.db, scope, Array(7).fill(0))).rejects.toThrow("Access denied.");
        await expect(getStaffingConfiguration(t.db, scope)).rejects.toThrow("Access denied.");
      }
      // Another organisation's Owner pointing at this location is refused.
      const forged = other.owner(a);
      await expect(setLabourPolicy(t.db, forged, "LOCATION", EUR(1))).rejects.toThrow("Location unavailable.");
      await expect(clearLabourPolicy(t.db, forged, "LOCATION")).rejects.toThrow("Location unavailable.");
      await expect(setRegularCoverage(t.db, forged, Array(7).fill(0))).rejects.toThrow("Location unavailable.");
      await expect(getStaffingConfiguration(t.db, forged)).rejects.toThrow("Location unavailable.");
      expect(await t.db.select().from(labourPolicies)).toEqual(before.policies);
      expect(await t.db.select().from(regularStaffCoverage)).toEqual(before.coverage);
      // Another business's policy is never applied, and its data never read.
      await history(t.db, other.organisationId, [other.rows[0].id]);
      expect((await getWeeklyStaffing(t.db, other.owner(), NOW)).outlets[0].policy).toBeNull();
      // A manager consumes the resolved policy for their own location only.
      const manager = await getWeeklyStaffing(t.db, { ...c.owner(), role: "MANAGER" }, NOW);
      expect(manager.outlets.map(o => o.outletId)).toEqual([a]);
      expect(manager.outlets[0].policy).toMatchObject({ salesMinorPerLabourHour: 10_000 });
    } finally { await t.close(); }
  });
});

describe("regular coverage as business data", () => {
  it("separates configured zero, a positive rota and not set", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db, 1);
      const a = c.rows[0].id;
      await history(t.db, c.organisationId, [a]);
      await setLabourPolicy(t.db, c.owner(), "ORGANISATION", EUR(10_000));
      const week = async () => (await getWeeklyStaffing(t.db, c.owner(), NOW)).outlets[0];
      // Never configured: nothing is invented.
      let o = await week();
      expect(o.regularCoverage).toBeNull();
      expect(o.days.every(day => day.requiredMinutes === 600 && day.regularMinutes === null && day.casualGapMinutes === null && day.unavailable === "REGULAR_COVERAGE_NOT_SET")).toBe(true);
      expect(o.totals).toBeNull();
      // Explicit zero: the whole requirement is the gap.
      await setRegularCoverage(t.db, c.owner(), Array(7).fill(0));
      o = await week();
      expect(o.regularCoverage).toBe("CONFIGURED");
      expect(o.days.every(day => day.regularMinutes === 0 && day.casualGapMinutes === 600 && day.indicativeShifts === 2 && day.unavailable === null)).toBe(true);
      // More coverage than needed: a zero gap, never negative.
      await setRegularCoverage(t.db, c.owner(), Array(7).fill(1_000));
      o = await week();
      expect(o.days.every(day => day.casualGapMinutes === 0 && day.indicativeShifts === 0)).toBe(true);
      expect(o.totals).toMatchObject({ casualGapMinutes: 0 });
      // Repeats are stable: still one row per weekday.
      await setRegularCoverage(t.db, c.owner(), Array(7).fill(1_000));
      expect(await t.db.select().from(regularStaffCoverage).where(eq(regularStaffCoverage.outletId, a))).toHaveLength(7);
      // A blanked day goes back to unknown, for that day only.
      await setRegularCoverage(t.db, c.owner(), [480, null, 480, 480, 480, 480, 480]);
      o = await week();
      const tuesday = o.days.find(day => new Date(`${day.planningDate}T12:00:00Z`).getUTCDay() === 2)!;
      expect(tuesday).toMatchObject({ regularMinutes: null, casualGapMinutes: null, unavailable: "REGULAR_COVERAGE_NOT_SET" });
      expect(o.totals).toBeNull();
      for (const invalid of [Array(6).fill(0), Array(8).fill(0), Array(7).fill(-1), Array(7).fill(1.5), Array(7).fill(1_440_001), "x"]) await expect(setRegularCoverage(t.db, c.owner(), invalid)).rejects.toThrow();
    } finally { await t.close(); }
  });
});
