import { createHash } from "node:crypto";
import { persistCanonicalRows, type CanonicalRow } from "@/server/commerce/ingestion";
import { writeWorkloadPolicyVersion } from "@/server/intelligence/business-policy";
import { and, eq, inArray, isNull, like, not, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@/server/db/client";
import { organisations, outletTradingHours, outlets, regularCoverageWindows, saleTransactions, workloadPolicies } from "@/server/db/schema";
import { localDate, shiftDate } from "@/server/intelligence/forecast";
import { REFERENCE_DATASET, REFERENCE_STORE_CODES, REFERENCE_VENUE_CONTEXT, REFERENCE_WORKLOAD_POLICY, referenceCoverage, referenceDates, referenceTradingHours, referenceTransactions, type ReferenceStoreCode } from "@/server/reference/uk-hospitality";

const inputSchema = z.object({
  organisationId: z.string().uuid(),
  // Every reference store must be mapped explicitly to a distinct outlet; nothing is inferred.
  outlets: z.object(Object.fromEntries(REFERENCE_STORE_CODES.map(code => [code, z.string().uuid()])) as Record<ReferenceStoreCode, z.ZodString>).strict(),
  from: z.iso.date().default(REFERENCE_DATASET.firstDate),
  through: z.iso.date().optional(),
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
// organisation, through the canonical commerce boundary, with this company's trading hours,
// standing cover and workload policy as explicit reference configuration. Idempotent:
// deterministic references make a rerun insert nothing, and anything the business configured
// itself is kept. No location override is created.
// A day that hasn't finished yet is refused, so no sale can be dated in the future.
export async function provisionReferenceHistory(db: Database, rawInput: ReferenceProvisionInput, now = new Date()) {
  const parsed = inputSchema.parse(rawInput);
  // Reference history holds completed days only, and defaults to the latest one available.
  const latestComplete = shiftDate(localDate(now, REFERENCE_DATASET.timezone), -1);
  const lastRequested = parsed.through ?? (latestComplete < REFERENCE_DATASET.lastDate ? latestComplete : REFERENCE_DATASET.lastDate);
  if (lastRequested > latestComplete) throw new Error(`Reference history cannot include ${lastRequested}: the latest completed trading day is ${latestComplete}.`);
  const input = { ...parsed, through: lastRequested };
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
      let batch: CanonicalRow[] = [];
      const flush = async () => {
        if (!batch.length) return;
        inserted += (await persistCanonicalRows(tx, batch)).inserted;
        batch = [];
      };
      for (const date of dates) {
        for (const sale of referenceTransactions(code, date)) {
          const reference = `${referencePrefix(code, outletId)}${date}:${String(sale.sequence).padStart(4, "0")}`;
          batch.push({ internalReference: reference, outletId, source: "REFERENCE", sourceSystem: REFERENCE_DATASET.version, sourceTransactionId: `${code}:${date}:${sale.sequence}`,
            currencyCode: REFERENCE_DATASET.currency, grossAmountMinor: sale.amountMinor, occurredAt: sale.occurredAt });
          expected++;
          if (batch.length === 1000) await flush();
        }
      }
      await flush();
    }
    // Configuration inputs only. Required capacity and casual gaps are derived, never stored.
    const perWeekday = (read: (code: ReferenceStoreCode) => unknown[], tag: string) => mapping.flatMap(({ code, outletId }) => read(code).map((windows, i) => ({
      id: deterministicId(`${tag}:${REFERENCE_DATASET.version}:${code}:${outletId}:${i + 1}`), organisationId: input.organisationId, outletId, isoWeekday: i + 1, windows, source: "REFERENCE" })));
    await tx.insert(outletTradingHours).values(perWeekday(referenceTradingHours, "REFHOURS")).onConflictDoUpdate({
      target: [outletTradingHours.outletId, outletTradingHours.isoWeekday], set: { windows: sql`excluded.windows`, updatedAt: new Date() }, setWhere: sql`${outletTradingHours.source} = 'REFERENCE'` });
    const coverage = perWeekday(referenceCoverage, "REFCOVER");
    await tx.insert(regularCoverageWindows).values(coverage).onConflictDoUpdate({
      target: [regularCoverageWindows.outletId, regularCoverageWindows.isoWeekday], set: { windows: sql`excluded.windows`, updatedAt: new Date() }, setWhere: sql`${regularCoverageWindows.source} = 'REFERENCE'` });
    // Venue profile and approximate coordinates, labelled reference, unless an Owner stated their own.
    for (const { code, outletId } of mapping) {
      const { venueProfile, latitude, longitude } = REFERENCE_VENUE_CONTEXT[code];
      await tx.update(outlets).set({ venueProfile, latitude, longitude, venueContextSource: "REFERENCE" }).where(and(eq(outlets.id, outletId), or(isNull(outlets.venueContextSource), eq(outlets.venueContextSource, "REFERENCE"))));
    }
    const [existingPolicy] = await tx.select({ id: workloadPolicies.id }).from(workloadPolicies)
      .where(and(eq(workloadPolicies.organisationId, input.organisationId), isNull(workloadPolicies.outletId), eq(workloadPolicies.status, "ACTIVE")));
    if (!existingPolicy) await writeWorkloadPolicyVersion(tx, { organisationId: input.organisationId, outletId: null, ...REFERENCE_WORKLOAD_POLICY, source: "REFERENCE", createdBy: null });
    return { inserted, expected, regularCoverageRows: coverage.length };
  });
  const through = await referenceDataThrough(db, mapping.map(row => row.outletId));
  return {
    dataset: REFERENCE_DATASET.version, provenance: "REFERENCE" as const, currency: REFERENCE_DATASET.currency,
    requested: { from: input.from, through: input.through }, ...result,
    stores: mapping.map(row => ({ ...row, ...through.find(item => item.outletId === row.outletId) })),
  };
}
