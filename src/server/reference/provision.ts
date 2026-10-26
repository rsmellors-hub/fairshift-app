import { createHash } from "node:crypto";
import { and, eq, inArray, like, not, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@/server/db/client";
import { organisations, outlets, regularStaffCoverage, saleTransactions } from "@/server/db/schema";
import { REFERENCE_DATASET, REFERENCE_STORE_CODES, referenceDates, referenceStore, referenceTransactions, type ReferenceStoreCode } from "@/server/reference/uk-retail";

const inputSchema = z.object({
  organisationId: z.string().uuid(),
  // Every reference store must be mapped explicitly to a distinct outlet; nothing is inferred.
  outlets: z.object(Object.fromEntries(REFERENCE_STORE_CODES.map(code => [code, z.string().uuid()])) as Record<ReferenceStoreCode, z.ZodString>).strict(),
  from: z.iso.date().default(REFERENCE_DATASET.firstDate),
  through: z.iso.date().default(REFERENCE_DATASET.lastDate),
}).strict();
export type ReferenceProvisionInput = z.input<typeof inputSchema>;

// Outlet-specific so two organisations can each hold their own labelled copy.
export const referencePrefix = (code: ReferenceStoreCode, outletId: string) => `REF:${REFERENCE_DATASET.version}:${code}:${outletId}:`;

function deterministicId(reference: string) {
  const hash = createHash("sha256").update(reference).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export async function referenceDataThrough(db: Pick<Database, "select">, outletIds: string[]) {
  if (!outletIds.length) return [];
  return db.select({
    outletId: saleTransactions.outletId,
    dataThrough: sql<string>`to_char(max(${saleTransactions.occurredAt} at time zone ${outlets.timezone}), 'YYYY-MM-DD')`,
    transactions: sql<number>`count(*)::int`,
  }).from(saleTransactions).innerJoin(outlets, eq(outlets.id, saleTransactions.outletId))
    .where(and(eq(saleTransactions.source, "REFERENCE"), inArray(saleTransactions.outletId, outletIds)))
    .groupBy(saleTransactions.outletId);
}

// Loads labelled synthetic reference sales into explicitly mapped outlets of one
// organisation. Idempotent: deterministic references make a rerun insert nothing.
export async function provisionReferenceHistory(db: Database, rawInput: ReferenceProvisionInput) {
  const input = inputSchema.parse(rawInput);
  const dates = referenceDates(input.from, input.through);
  const mapping = REFERENCE_STORE_CODES.map(code => ({ code, outletId: input.outlets[code] }));
  if (new Set(mapping.map(row => row.outletId)).size !== mapping.length) throw new Error("Each reference store needs a distinct outlet.");

  const result = await db.transaction(async tx => {
    const [organisation] = await tx.select({ id: organisations.id }).from(organisations).where(eq(organisations.id, input.organisationId));
    if (!organisation) throw new Error("Organisation not found.");
    const rows = await tx.select().from(outlets)
      .where(and(eq(outlets.organisationId, input.organisationId), inArray(outlets.id, mapping.map(row => row.outletId)))).for("update");
    for (const { code, outletId } of mapping) {
      const outlet = rows.find(row => row.id === outletId);
      if (!outlet) throw new Error(`${code}: outlet is not part of this organisation.`);
      if (!outlet.active) throw new Error(`${code}: outlet is inactive.`);
      // Time zone is location data (set from the location's country); the loader never changes it.
      if (outlet.timezone !== REFERENCE_DATASET.timezone) {
        throw new Error(`${code}: outlet time zone is ${outlet.timezone}; reference sales are ${REFERENCE_DATASET.timezone} trading. Map a United Kingdom location.`);
      }
      // Never mix two reference stores (or dataset versions) into one outlet history.
      const [foreign] = await tx.select({ id: saleTransactions.id }).from(saleTransactions).where(and(
        eq(saleTransactions.outletId, outletId), eq(saleTransactions.source, "REFERENCE"),
        not(like(saleTransactions.internalReference, `${referencePrefix(code, outletId)}%`)),
      )).limit(1);
      if (foreign) throw new Error(`${code}: outlet already holds a different reference history.`);
    }
    let inserted = 0, expected = 0;
    for (const { code, outletId } of mapping) {
      let batch: (typeof saleTransactions.$inferInsert)[] = [];
      const flush = async () => {
        if (!batch.length) return;
        inserted += (await tx.insert(saleTransactions).values(batch)
          .onConflictDoNothing({ target: saleTransactions.internalReference }).returning({ id: saleTransactions.id })).length;
        batch = [];
      };
      for (const date of dates) {
        for (const sale of referenceTransactions(code, date)) {
          const reference = `${referencePrefix(code, outletId)}${date}:${String(sale.sequence).padStart(4, "0")}`;
          batch.push({ id: deterministicId(reference), internalReference: reference, outletId, source: "REFERENCE",
            currencyCode: REFERENCE_DATASET.currency, grossAmountMinor: sale.amountMinor, occurredAt: sale.occurredAt,
            providerStatus: "REFERENCE", verificationState: "PENDING", reconciliationState: "NOT_RECONCILED" });
          expected++;
          if (batch.length === 1000) await flush();
        }
      }
      await flush();
    }
    // Staffing input only (planned regular labour per weekday). Required labour,
    // coverage gaps and shift counts are derived by the application, never stored.
    const coverage = mapping.flatMap(({ code, outletId }) => referenceStore(code).regularCoverageHours.map((hours, i) => ({
      id: deterministicId(`REFCOV:${REFERENCE_DATASET.version}:${code}:${outletId}:${i + 1}`), organisationId: input.organisationId,
      outletId, isoWeekday: i + 1, plannedMinutes: hours * 60, source: "REFERENCE" })));
    await tx.insert(regularStaffCoverage).values(coverage).onConflictDoUpdate({
      target: [regularStaffCoverage.outletId, regularStaffCoverage.isoWeekday],
      set: { plannedMinutes: sql`excluded.planned_minutes`, updatedAt: new Date() },
      setWhere: sql`${regularStaffCoverage.source} = 'REFERENCE'`,
    });
    return { inserted, expected, regularCoverageRows: coverage.length };
  });
  const through = await referenceDataThrough(db, mapping.map(row => row.outletId));
  return {
    dataset: REFERENCE_DATASET.version, provenance: "REFERENCE" as const, currency: REFERENCE_DATASET.currency,
    requested: { from: input.from, through: input.through }, ...result,
    stores: mapping.map(row => ({ ...row, ...through.find(item => item.outletId === row.outletId) })),
  };
}
