import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../helpers/database";
import type { Scope } from "@/server/auth/access";
import { organisations, outlets, saleTransactions } from "@/server/db/schema";
import { getOwnerOverview } from "@/server/product/owner-overview";
import { provisionReferenceHistory, referencePrefix } from "@/server/reference/provision";
import { REFERENCE_STORE_CODES, referenceDates, referenceTransactions } from "@/server/reference/uk-retail";
import { OwnerOverview } from "@/app/owner/overview";

type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];
const window = { from: "2025-12-20", through: "2025-12-28" };

async function company(db: Db, timezone = "Europe/London") {
  const organisationId = randomUUID();
  await db.insert(organisations).values({ id: organisationId, name: "Reference test company" });
  const rows = REFERENCE_STORE_CODES.map((code, i) => ({ id: randomUUID(), organisationId, name: `Store ${i + 1}`, timezone }));
  await db.insert(outlets).values(rows);
  const mapping = Object.fromEntries(REFERENCE_STORE_CODES.map((code, i) => [code, rows[i].id])) as Record<typeof REFERENCE_STORE_CODES[number], string>;
  const scope: Scope = { userId: randomUUID(), organisationId, locationId: rows[0].id, role: "OWNER", organisationName: "Reference test company", locationName: rows[0].name };
  return { organisationId, rows, mapping, scope };
}
const expectedRows = (from: string, through: string) =>
  REFERENCE_STORE_CODES.reduce((sum, code) => sum + referenceDates(from, through).reduce((n, date) => n + referenceTransactions(code, date).length, 0), 0);

describe("reference sales history provisioning", () => {
  it("loads labelled GBP reference history into five explicitly mapped outlets, idempotently", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      const first = await provisionReferenceHistory(t.db, { organisationId: c.organisationId, outlets: c.mapping, ...window });
      const expected = expectedRows(window.from, window.through);
      expect(first).toMatchObject({ provenance: "REFERENCE", currency: "GBP", inserted: expected, expected });
      for (const store of first.stores) expect(store).toMatchObject({ dataThrough: "2025-12-28", transactions: expect.any(Number) });
      expect(first.stores.map(store => store.code)).toEqual([...REFERENCE_STORE_CODES]);

      const again = await provisionReferenceHistory(t.db, { organisationId: c.organisationId, outlets: c.mapping, ...window });
      expect(again).toMatchObject({ inserted: 0, expected });
      const [count] = (await t.db.execute(sql`select count(*)::int as n, count(distinct outlet_id)::int as outlets from sale_transactions`)).rows;
      expect(count).toEqual({ n: expected, outlets: 5 });

      const rows = await t.db.select().from(saleTransactions);
      for (const row of rows) {
        expect(row).toMatchObject({ source: "REFERENCE", currencyCode: "GBP", providerStatus: "REFERENCE", verificationState: "PENDING", reconciliationState: "NOT_RECONCILED",
          paypalOrderId: null, paypalCaptureId: null, paypalCustomId: null, providerCreatedAt: null, reconciledAt: null });
        expect(row.occurredAt).toBeInstanceOf(Date);
        expect(row.internalReference.startsWith("REF:uk-specialty-retail-v1:UK0")).toBe(true);
      }
      // Distinct stores keep distinct histories: no two outlets share identical daily totals.
      const totals = (await t.db.execute(sql`select outlet_id, sum(gross_amount_minor)::bigint as total from sale_transactions group by outlet_id`)).rows;
      expect(new Set(totals.map(row => String(row.total))).size).toBe(5);
    } finally { await t.close(); }
  }, 120_000);

  it("extends history without duplicates and exposes the new data-through date", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      const early = await provisionReferenceHistory(t.db, { organisationId: c.organisationId, outlets: c.mapping, from: "2025-12-20", through: "2025-12-23" });
      expect(early.stores[0].dataThrough).toBe("2025-12-23");
      const later = await provisionReferenceHistory(t.db, { organisationId: c.organisationId, outlets: c.mapping, ...window });
      expect(later.inserted).toBe(expectedRows("2025-12-24", "2025-12-28"));
      expect(later.stores.every(store => store.dataThrough === "2025-12-28")).toBe(true);
    } finally { await t.close(); }
  }, 120_000);

  it("refuses unsafe targeting before writing anything", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      const other = await company(t.db);
      const run = (overrides: object) => provisionReferenceHistory(t.db, { organisationId: c.organisationId, outlets: c.mapping, ...window, ...overrides });
      await expect(run({ outlets: { ...c.mapping, UK05: other.mapping.UK05 } })).rejects.toThrow("UK05: outlet is not part of this organisation");
      await expect(run({ outlets: { ...c.mapping, UK05: c.mapping.UK01 } })).rejects.toThrow("distinct outlet");
      const partial: Partial<typeof c.mapping> = { ...c.mapping };
      delete partial.UK05;
      await expect(run({ outlets: partial })).rejects.toThrow();
      await expect(run({ organisationId: randomUUID() })).rejects.toThrow("Organisation not found");
      await expect(run({ through: "2026-01-04" })).rejects.toThrow("Reference history covers");
      await t.db.update(outlets).set({ active: false }).where(eq(outlets.id, c.mapping.UK02));
      await expect(run({})).rejects.toThrow("UK02: outlet is inactive");
      expect((await t.db.select().from(saleTransactions)).length).toBe(0);
    } finally { await t.close(); }
  }, 120_000);

  it("requires explicit time-zone confirmation and never mixes two reference stores in one outlet", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db, "Africa/Johannesburg");
      const run = (overrides: object = {}) => provisionReferenceHistory(t.db, { organisationId: c.organisationId, outlets: c.mapping, from: "2025-12-27", through: "2025-12-28", ...overrides });
      await expect(run()).rejects.toThrow("UK01: outlet time zone is Africa/Johannesburg");
      await run({ setLondonTimezone: true });
      expect(new Set((await t.db.select().from(outlets).where(eq(outlets.organisationId, c.organisationId))).map(row => row.timezone))).toEqual(new Set(["Europe/London"]));
      const swapped = { ...c.mapping, UK01: c.mapping.UK02, UK02: c.mapping.UK01 };
      await expect(run({ outlets: swapped })).rejects.toThrow("already holds a different reference history");
    } finally { await t.close(); }
  }, 120_000);

  it("enforces reference provenance in the database", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      const base = { internalReference: `${referencePrefix("UK01", c.mapping.UK01)}manual`, outletId: c.mapping.UK01, source: "REFERENCE",
        currencyCode: "GBP", grossAmountMinor: 100, providerStatus: "REFERENCE", occurredAt: new Date() };
      await expect(t.db.insert(saleTransactions).values({ ...base, id: randomUUID(), occurredAt: null })).rejects.toThrow();
      await expect(t.db.insert(saleTransactions).values({ ...base, id: randomUUID(), paypalCaptureId: "CAPTURE" })).rejects.toThrow();
      await expect(t.db.insert(saleTransactions).values({ ...base, id: randomUUID(), verificationState: "VERIFIED" })).rejects.toThrow();
      await expect(t.db.insert(saleTransactions).values({ ...base, id: randomUUID(), providerStatus: "COMPLETED" })).rejects.toThrow();
      await t.db.insert(saleTransactions).values({ ...base, id: randomUUID() });
    } finally { await t.close(); }
  });

  it("shows reference history only to its organisation, labelled, in GBP, with closures unknown", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      const other = await company(t.db);
      await provisionReferenceHistory(t.db, { organisationId: c.organisationId, outlets: c.mapping, ...window });
      expect((await getOwnerOverview(t.db, other.scope)).series).toEqual([]);
      const data = await getOwnerOverview(t.db, c.scope);
      expect(data.series).toHaveLength(1);
      const series = data.series[0];
      expect(series).toMatchObject({ key: "REFERENCE:GBP", source: "REFERENCE", currency: "GBP", start: "2025-12-22", end: "2025-12-28" });
      expect(series.days.find(day => day.date === "2025-12-25")?.amountMinor).toBeNull();
      const expectedTotal = REFERENCE_STORE_CODES.reduce((sum, code) => sum + referenceDates("2025-12-22", "2025-12-28")
        .reduce((n, date) => n + referenceTransactions(code, date).reduce((a, sale) => a + sale.amountMinor, 0), 0), 0);
      expect(series.totalMinor).toBe(expectedTotal);
      expect(series.locations.every(location => location.observedDays === 6)).toBe(true);
      const html = renderToStaticMarkup(createElement(OwnerOverview, { data }));
      expect(html).toContain("Reference sales history");
      expect(html).toContain("not Zettle, PayPal or other provider sales");
      expect(html).toContain("Data through 28 Dec 2025");
      // Dated wording, never "recent", for history that ended long ago.
      expect(html).toContain("Latest recorded sales");
      expect(html).not.toMatch(/Recent (recorded )?sales/);
      expect(html).toContain("£");
      expect(html).not.toContain("$");
      expect(html).not.toMatch(/Zettle sales|live sales|verified sales/i);
    } finally { await t.close(); }
  }, 120_000);
});
