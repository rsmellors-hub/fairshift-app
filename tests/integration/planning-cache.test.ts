import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { entitled } from "../helpers/onboarding";
import { configureFixture, hours, ingestTimedBills } from "../helpers/workload";
import type { Scope } from "@/server/auth/access";
import { memberships, organisations, outlets, subscriptions, users } from "@/server/db/schema";
import { planningChanged } from "@/server/intelligence/planning-cache";
import { getWeeklyStaffing } from "@/server/intelligence/staffing";

// Day 6, Step 2: the demo business's computed week is reused between requests while nothing it reads has
// changed, and recalculated after any write made through FairShift. Other businesses are never cached.
const NOW = new Date("2026-12-14T06:00:00Z");
beforeEach(() => { vi.stubEnv("FAIRSHIFT_PLANNING_CACHE", "on"); });
afterEach(() => { vi.unstubAllEnvs(); });

async function business(db: Awaited<ReturnType<typeof createTestDatabase>>["db"], demo: boolean) {
  const organisationId = randomUUID(), outletId = randomUUID(), userId = randomUUID();
  await db.insert(organisations).values({ id: organisationId, name: "Cache group", country: "South Africa" });
  await db.insert(subscriptions).values({ id: randomUUID(), organisationId, requestId: randomUUID() });
  await entitled(db, organisationId);
  await db.insert(outlets).values({ id: outletId, organisationId, name: "One", timezone: "Africa/Johannesburg", country: "South Africa" });
  await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: "Owner", passwordHash: "x", emailVerifiedAt: NOW });
  await db.insert(memberships).values({ id: randomUUID(), userId, organisationId, role: "OWNER" });
  await ingestTimedBills(db, { organisationId, outletId, currencyCode: "ZAR", through: "2026-12-13", bills: () => 20, at: "09:10:00Z", now: NOW, billMinor: 9_000 });
  await configureFixture(db, { organisationId, outletId, policy: { transactionsPerStaffHour: 4, minimumStaffWhileOpen: 1 }, trading: [{ start: 8 * 60, end: 20 * 60 }], coverage: [hours(8, 20, 1)] });
  if (demo) { vi.stubEnv("FAIRSHIFT_DEPLOYMENT_MODE", "HOSTED_SANDBOX_DEMO"); vi.stubEnv("FAIRSHIFT_SANDBOX_ORGANISATION_ID", organisationId); vi.stubEnv("PAYPAL_ENVIRONMENT", "sandbox"); }
  const scope: Scope = { userId, organisationId, locationId: outletId, role: "OWNER", organisationName: "Cache group", locationName: "One" };
  return { scope };
}

describe("planning cache", () => {
  it("reuses the demo business's week until something changes, refreshes in the background after a minute, and is kept per database", async () => {
    const { db, close } = await createTestDatabase();
    try {
      const { scope } = await business(db, true);
      const select = vi.spyOn(db, "select");
      const first = await getWeeklyStaffing(db, scope, NOW);
      const afterFirst = select.mock.calls.length;
      expect(afterFirst).toBeGreaterThan(5);
      const again = await getWeeklyStaffing(db, scope, new Date(NOW.getTime() + 1_000));
      expect(again).toBe(first);
      expect(select.mock.calls.length).toBe(afterFirst);
      // A write made through FairShift (any server action or scheduler job) invalidates it.
      planningChanged();
      const recalculated = await getWeeklyStaffing(db, scope, new Date(NOW.getTime() + 2_000));
      expect(recalculated).not.toBe(first);
      expect(recalculated.outlets[0].days).toEqual(first.outlets[0].days);
      // After five minutes the cached week is served at once, and recalculated behind it.
      const before = select.mock.calls.length;
      const stale = await getWeeklyStaffing(db, scope, new Date(NOW.getTime() + 2_000 + 5 * 60_000 + 1_000));
      expect(stale).toBe(recalculated);
      await vi.waitFor(() => expect(select.mock.calls.length).toBeGreaterThan(before));
      // Another database never sees this one's week.
      const other = await createTestDatabase();
      try { await expect(getWeeklyStaffing(other.db, scope, NOW)).resolves.toMatchObject({ outlets: [] }); } finally { await other.close(); }
    } finally { await close(); }
  });

  it("never caches another business's week", async () => {
    const { db, close } = await createTestDatabase();
    try {
      const { scope } = await business(db, false);
      const select = vi.spyOn(db, "select");
      await getWeeklyStaffing(db, scope, NOW);
      const once = select.mock.calls.length;
      await getWeeklyStaffing(db, scope, NOW);
      expect(select.mock.calls.length).toBe(once * 2);
    } finally { await close(); }
  });
});
