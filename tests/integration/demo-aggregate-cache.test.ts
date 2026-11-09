import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { ingestTimedBills } from "../helpers/workload";
import { organisations, outlets } from "@/server/db/schema";
import { loadDailySales, loadTransactionSlots } from "@/server/intelligence/sales-history";

// Day 6, Step 2: the demo business's synthetic aggregates are kept between requests while its history is
// unchanged (and for at most five minutes), so Overview doesn't re-aggregate months of rows each time.
// Any new row is a new version. Other businesses' figures are always read fresh.
const NOW = new Date("2026-12-14T06:00:00Z");
async function business(db: Awaited<ReturnType<typeof createTestDatabase>>["db"]) {
  const organisationId = randomUUID(), outletId = randomUUID();
  await db.insert(organisations).values({ id: organisationId, name: "Cache fixture" });
  await db.insert(outlets).values({ id: outletId, organisationId, name: "One", timezone: "Africa/Johannesburg" });
  await ingestTimedBills(db, { organisationId, outletId, currencyCode: "ZAR", through: "2026-12-13", bills: () => 4, at: "09:10:00Z", now: NOW, billMinor: 5_000, days: 14 });
  return { organisationId, outletId };
}

describe("demo aggregate cache", () => {
  it("reuses the demo business's aggregates until its history changes, and never caches another business's", async () => {
    const { db, close } = await createTestDatabase();
    try {
      const b = await business(db);
      const select = vi.spyOn(db, "select");
      const first = await loadDailySales(db, b.organisationId, undefined, true);
      const callsAfterFirst = select.mock.calls.length;
      const again = await loadDailySales(db, b.organisationId, undefined, true);
      expect(again).toEqual(first);
      // Only the version probe ran the second time.
      expect(select.mock.calls.length - callsAfterFirst).toBe(1);
      // A new day of history is a new version: read again, and it includes the new rows.
      await ingestTimedBills(db, { organisationId: b.organisationId, outletId: b.outletId, currencyCode: "ZAR", through: "2026-12-14", bills: () => 4, at: "09:10:00Z", now: new Date("2026-12-14T12:00:00Z"), billMinor: 5_000, days: 1 });
      const fresh = await loadDailySales(db, b.organisationId, undefined, true);
      const direct = await loadDailySales(db, b.organisationId, undefined, false);
      expect(fresh).toEqual(direct);
      expect(fresh.length).toBe(first.length + 1);
      // Slots are cached the same way, keyed by their own range.
      const slots = await loadTransactionSlots(db, b.outletId, "REFERENCE", "ZAR", "2026-12-01", "2026-12-14", b.organisationId);
      const before = select.mock.calls.length;
      expect(await loadTransactionSlots(db, b.outletId, "REFERENCE", "ZAR", "2026-12-01", "2026-12-14", b.organisationId)).toEqual(slots);
      expect(select.mock.calls.length - before).toBe(1);
      // Without demo authority nothing is cached: every call reads the database.
      const plain = select.mock.calls.length;
      await loadDailySales(db, b.organisationId, undefined, false);
      await loadDailySales(db, b.organisationId, undefined, false);
      expect(select.mock.calls.length - plain).toBe(2);
      // A separate database never sees another's cached figures.
      const other = await createTestDatabase();
      try { expect(await loadDailySales(other.db, b.organisationId, undefined, true)).toEqual([]); } finally { await other.close(); }
    } finally { await close(); }
  });
});
