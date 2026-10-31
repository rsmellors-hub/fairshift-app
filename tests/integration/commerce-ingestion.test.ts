import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { CommerceIngestionError, ingestCommerceObservations, MAX_BATCH_OBSERVATIONS } from "@/server/commerce/ingestion";
import { organisations, outlets, saleTransactions } from "@/server/db/schema";

type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];
const NOW = new Date("2026-10-25T10:00:00Z");
async function company(db: Db) {
  const organisationId = randomUUID(), outletId = randomUUID(), other = randomUUID();
  await db.insert(organisations).values({ id: organisationId, name: "Any business", country: "Ireland" });
  await db.insert(outlets).values([{ id: outletId, organisationId, name: "Main", timezone: "Europe/Dublin" }, { id: other, organisationId, name: "Inactive", timezone: "Europe/Dublin", active: false }]);
  return { organisationId, outletId, inactive: other };
}
const sale = (outletId: string, id: string, overrides: Record<string, unknown> = {}) => ({ outletId, sourceTransactionId: id, occurredAt: "2026-06-01T09:30:00+01:00", currencyCode: "EUR", grossAmountMinor: 1_250, status: "COMPLETED", ...overrides });
const rejects = (promise: Promise<unknown>, code: string) => expect(promise).rejects.toMatchObject({ code });

describe("canonical commerce ingestion", () => {
  it("stores truthful imported provenance and source identity, exactly as given", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      const result = await ingestCommerceObservations(t.db, { organisationId: c.organisationId, source: "IMPORTED", sourceSystem: "till-export", observations: [sale(c.outletId, "T1"), sale(c.outletId, "T2", { grossAmountMinor: 0 })], now: NOW });
      expect(result).toEqual({ source: "IMPORTED", sourceSystem: "till-export", received: 2, inserted: 2, duplicates: 0 });
      const rows = await t.db.select().from(saleTransactions).where(eq(saleTransactions.outletId, c.outletId));
      const first = rows.find(row => row.sourceTransactionId === "T1")!;
      expect(first).toMatchObject({ source: "IMPORTED", sourceSystem: "till-export", providerStatus: "IMPORTED", verificationState: "PENDING", reconciliationState: "NOT_RECONCILED", currencyCode: "EUR", grossAmountMinor: 1_250, paypalCaptureId: null });
      expect(first.occurredAt).toEqual(new Date("2026-06-01T08:30:00Z"));
      // A zero-value sale is a real observation, not a missing one.
      expect(rows.find(row => row.sourceTransactionId === "T2")!.grossAmountMinor).toBe(0);
    } finally { await t.close(); }
  });

  it("is idempotent for identical repeats and refuses conflicting ones, atomically", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      const input = { organisationId: c.organisationId, source: "IMPORTED", sourceSystem: "till", now: NOW };
      await ingestCommerceObservations(t.db, { ...input, observations: [sale(c.outletId, "T1")] });
      expect(await ingestCommerceObservations(t.db, { ...input, observations: [sale(c.outletId, "T1")] })).toMatchObject({ inserted: 0, duplicates: 1 });
      // The same identity repeated inside one batch counts once.
      expect(await ingestCommerceObservations(t.db, { ...input, observations: [sale(c.outletId, "T2"), sale(c.outletId, "T2")] })).toMatchObject({ received: 2, inserted: 1, duplicates: 1 });
      await rejects(ingestCommerceObservations(t.db, { ...input, observations: [sale(c.outletId, "T9"), sale(c.outletId, "T9", { grossAmountMinor: 1 })] }), "CONFLICTING_DUPLICATE");
      // A conflict with stored history rejects the whole batch, including its valid rows.
      await rejects(ingestCommerceObservations(t.db, { ...input, observations: [sale(c.outletId, "NEW"), sale(c.outletId, "T1", { grossAmountMinor: 999 })] }), "CONFLICTING_DUPLICATE");
      await rejects(ingestCommerceObservations(t.db, { ...input, observations: [sale(c.outletId, "NEW"), sale(c.outletId, "T1", { occurredAt: "2026-06-02T09:30:00+01:00" })] }), "CONFLICTING_DUPLICATE");
      const rows = await t.db.select().from(saleTransactions).where(eq(saleTransactions.outletId, c.outletId));
      expect(rows.map(row => row.sourceTransactionId).sort()).toEqual(["T1", "T2"]);
      expect(rows.find(row => row.sourceTransactionId === "T1")!.grossAmountMinor).toBe(1_250);
      // The same ID from another system is a different transaction.
      expect(await ingestCommerceObservations(t.db, { ...input, sourceSystem: "web", observations: [sale(c.outletId, "T1", { grossAmountMinor: 999 })] })).toMatchObject({ inserted: 1 });
    } finally { await t.close(); }
  });

  it("rejects every invalid batch whole, storing nothing", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db), other = await company(t.db);
      const input = { organisationId: c.organisationId, source: "IMPORTED", sourceSystem: "till", now: NOW };
      const good = sale(c.outletId, "GOOD");
      for (const [overrides, code] of [
        [{ grossAmountMinor: -1 }, "INVALID_OBSERVATION"], [{ grossAmountMinor: 12.5 }, "INVALID_OBSERVATION"], [{ grossAmountMinor: "100" }, "INVALID_OBSERVATION"],
        [{ grossAmountMinor: Number.MAX_SAFE_INTEGER + 2 }, "INVALID_OBSERVATION"],
        [{ occurredAt: "not a date" }, "INVALID_OBSERVATION"], [{ occurredAt: "2026-02-31T10:00:00Z" }, "INVALID_OBSERVATION"], [{ occurredAt: "2026-06-01" }, "INVALID_OBSERVATION"], [{ occurredAt: "2026-06-01T10:00:00" }, "INVALID_OBSERVATION"],
        [{ occurredAt: "2026-10-25T10:00:01Z" }, "FUTURE_DATED"],
        [{ sourceTransactionId: "  " }, "INVALID_OBSERVATION"], [{ status: "REFUNDED" }, "INVALID_OBSERVATION"], [{ tip: 5 }, "INVALID_OBSERVATION"],
        [{ currencyCode: "eur" }, "UNSUPPORTED_CURRENCY"], [{ currencyCode: "EURO" }, "UNSUPPORTED_CURRENCY"], [{ currencyCode: "ZZZ" }, "UNSUPPORTED_CURRENCY"], [{ currencyCode: "JPY" }, "UNSUPPORTED_CURRENCY"],
        [{ outletId: randomUUID() }, "UNKNOWN_LOCATION"], [{ outletId: other.outletId }, "UNKNOWN_LOCATION"], [{ outletId: c.inactive }, "UNKNOWN_LOCATION"], [{ outletId: "not-a-uuid" }, "INVALID_OBSERVATION"],
        [{ currencyCode: "GBP" }, "CURRENCY_MISMATCH"],
      ] as const) await rejects(ingestCommerceObservations(t.db, { ...input, observations: [good, { ...good, sourceTransactionId: "BAD", ...overrides }] }), code);
      await rejects(ingestCommerceObservations(t.db, { ...input, observations: [] }), "EMPTY_BATCH");
      await rejects(ingestCommerceObservations(t.db, { ...input, observations: Array.from({ length: MAX_BATCH_OBSERVATIONS + 1 }, (_, i) => sale(c.outletId, `T${i}`)) }), "BATCH_TOO_LARGE");
      for (const source of ["PAYPAL_SANDBOX", "DEMO_SEEDED", "ZETTLE", ""]) await rejects(ingestCommerceObservations(t.db, { ...input, source, observations: [good] }), "UNSUPPORTED_SOURCE");
      await rejects(ingestCommerceObservations(t.db, { ...input, sourceSystem: " ", observations: [good] }), "INVALID_OBSERVATION");
      await rejects(ingestCommerceObservations(t.db, { ...input, organisationId: other.organisationId, observations: [good] }), "UNKNOWN_LOCATION");
      expect(await t.db.select().from(saleTransactions).where(eq(saleTransactions.outletId, c.outletId))).toEqual([]);
      expect(await t.db.select().from(saleTransactions).where(eq(saleTransactions.outletId, other.outletId))).toEqual([]);
      await expect(ingestCommerceObservations(t.db, { ...input, observations: [] })).rejects.toBeInstanceOf(CommerceIngestionError);
    } finally { await t.close(); }
  });

  it("never lets a location's imported history drift into a second currency across batches", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      const input = { organisationId: c.organisationId, source: "IMPORTED", sourceSystem: "till", now: NOW };
      await ingestCommerceObservations(t.db, { ...input, observations: [sale(c.outletId, "T1")] });
      await rejects(ingestCommerceObservations(t.db, { ...input, observations: [sale(c.outletId, "T2", { currencyCode: "GBP" })] }), "CURRENCY_MISMATCH");
      // Reference history at the same location is a separate, separately labelled series.
      expect(await ingestCommerceObservations(t.db, { ...input, source: "REFERENCE", sourceSystem: "rehearsal-set", observations: [sale(c.outletId, "R1", { currencyCode: "GBP" })] })).toMatchObject({ source: "REFERENCE", inserted: 1 });
      const [row] = await t.db.select().from(saleTransactions).where(eq(saleTransactions.sourceTransactionId, "R1"));
      expect(row).toMatchObject({ source: "REFERENCE", providerStatus: "REFERENCE", currencyCode: "GBP" });
    } finally { await t.close(); }
  });
});
