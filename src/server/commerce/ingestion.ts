import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Database, DatabaseSession } from "@/server/db/client";
import { outlets, saleTransactions } from "@/server/db/schema";
import { isMinorUnitCurrency } from "@/server/domain/currency";

// The application boundary for canonical historical commerce. Completed sales enter
// here with their provenance and source identity, whatever system they came from;
// forecasting then treats them like any other eligible history.
//
// A batch is atomic: one invalid or conflicting observation rejects all of it and
// nothing is stored. Repeating an identical observation changes nothing. Values are
// stored as given: no currency conversion, no date correction, no rounding.
// PayPal captures keep their own verified path (they carry provider evidence), and
// the legacy demo seed is not an import. Zettle provenance cannot be claimed by a
// caller: it is reachable only through ingestConnectedObservations, used by the sync of
// an authenticated connection.

export const INGESTIBLE_SOURCES = ["IMPORTED", "REFERENCE"] as const;
export const MAX_BATCH_OBSERVATIONS = 10_000;

export type IngestionFailure = "UNSUPPORTED_SOURCE" | "EMPTY_BATCH" | "BATCH_TOO_LARGE" | "INVALID_OBSERVATION" | "UNSUPPORTED_CURRENCY" | "FUTURE_DATED"
  | "UNKNOWN_LOCATION" | "CURRENCY_MISMATCH" | "CONFLICTING_DUPLICATE";
export class CommerceIngestionError extends Error {
  constructor(readonly code: IngestionFailure, detail: string) { super(`${code}: ${detail}`); this.name = "CommerceIngestionError"; }
}

const observationSchema = z.object({
  outletId: z.uuid(),
  sourceTransactionId: z.string().trim().min(1).max(200),
  occurredAt: z.iso.datetime({ offset: true }),
  currencyCode: z.string(),
  grossAmountMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  // Only completed sales are demand evidence; refunds and voids are not modelled yet.
  status: z.literal("COMPLETED"),
}).strict();
export type CommerceObservation = z.input<typeof observationSchema>;
const batchHeader = z.object({ organisationId: z.uuid(), sourceSystem: z.string().trim().min(1).max(100) });

export type CanonicalRow = { internalReference: string; outletId: string; source: "IMPORTED" | "REFERENCE" | "ZETTLE"; sourceSystem: string; sourceTransactionId: string; occurredAt: Date; currencyCode: string; grossAmountMinor: number };

function deterministicId(reference: string) {
  const hash = createHash("sha256").update(reference).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
const sameFacts = (row: CanonicalRow, existing: { outletId: string; source: string; currencyCode: string; grossAmountMinor: number; occurredAt: Date | null }) =>
  existing.outletId === row.outletId && existing.source === row.source && existing.currencyCode === row.currencyCode
    && existing.grossAmountMinor === row.grossAmountMinor && existing.occurredAt?.getTime() === row.occurredAt.getTime();

// Writes validated rows inside the caller's transaction. Rows already present with
// the same facts count as duplicates; the same identity with other facts is refused.
export async function persistCanonicalRows(tx: DatabaseSession, rows: readonly CanonicalRow[]) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 1000) {
    const chunk = rows.slice(i, i + 1000);
    const created = await tx.insert(saleTransactions).values(chunk.map(row => ({ ...row, id: deterministicId(row.internalReference), providerStatus: row.source,
      verificationState: "PENDING", reconciliationState: "NOT_RECONCILED" }))).onConflictDoNothing({ target: saleTransactions.internalReference }).returning({ reference: saleTransactions.internalReference });
    inserted += created.length;
    if (created.length === chunk.length) continue;
    const fresh = new Set(created.map(row => row.reference));
    const repeated = chunk.filter(row => !fresh.has(row.internalReference));
    const existing = new Map((await tx.select().from(saleTransactions).where(inArray(saleTransactions.internalReference, repeated.map(row => row.internalReference)))).map(row => [row.internalReference, row]));
    for (const row of repeated) {
      const found = existing.get(row.internalReference);
      if (!found || !sameFacts(row, found)) throw new CommerceIngestionError("CONFLICTING_DUPLICATE", `${row.sourceSystem}/${row.sourceTransactionId} already exists with different facts.`);
    }
  }
  return { inserted, duplicates: rows.length - inserted };
}

type IngestionInput = { organisationId: string; source: string; sourceSystem: string; observations: readonly unknown[]; now?: Date };
const REFERENCE_PREFIX = { IMPORTED: "IMP", REFERENCE: "REF", ZETTLE: "ZET" } as const;

export async function ingestCommerceObservations(db: Database, input: IngestionInput) {
  const source = INGESTIBLE_SOURCES.find(value => value === input.source);
  if (!source) throw new CommerceIngestionError("UNSUPPORTED_SOURCE", `${input.source} cannot be ingested here.`);
  return ingest(db, input, source);
}

// The same boundary for observations retrieved through an authenticated connection.
export async function ingestConnectedObservations(db: Database, input: Omit<IngestionInput, "source">) {
  return ingest(db, input, "ZETTLE");
}

async function ingest(db: Database, input: IngestionInput | Omit<IngestionInput, "source">, source: CanonicalRow["source"]) {
  const header = batchHeader.safeParse(input);
  if (!header.success) throw new CommerceIngestionError("INVALID_OBSERVATION", "Organisation or source system is invalid.");
  const { organisationId, sourceSystem } = header.data;
  if (!input.observations.length) throw new CommerceIngestionError("EMPTY_BATCH", "No observations were supplied.");
  if (input.observations.length > MAX_BATCH_OBSERVATIONS) throw new CommerceIngestionError("BATCH_TOO_LARGE", `At most ${MAX_BATCH_OBSERVATIONS} observations per batch.`);
  const now = input.now ?? new Date();

  const rows = new Map<string, CanonicalRow>();
  for (const [index, raw] of input.observations.entries()) {
    const parsed = observationSchema.safeParse(raw);
    if (!parsed.success) throw new CommerceIngestionError("INVALID_OBSERVATION", `Observation ${index}: ${parsed.error.issues[0]?.path.join(".") || "invalid"}.`);
    const value = parsed.data;
    if (!isMinorUnitCurrency(value.currencyCode)) throw new CommerceIngestionError("UNSUPPORTED_CURRENCY", `Observation ${index}: ${value.currencyCode}.`);
    const occurredAt = new Date(value.occurredAt);
    if (occurredAt > now) throw new CommerceIngestionError("FUTURE_DATED", `Observation ${index} is dated after now.`);
    const row: CanonicalRow = { internalReference: `${REFERENCE_PREFIX[source]}:${sourceSystem}:${value.outletId}:${value.sourceTransactionId}`, outletId: value.outletId, source, sourceSystem,
      sourceTransactionId: value.sourceTransactionId, occurredAt, currencyCode: value.currencyCode, grossAmountMinor: value.grossAmountMinor };
    const earlier = rows.get(row.internalReference);
    if (earlier && !sameFacts(row, earlier)) throw new CommerceIngestionError("CONFLICTING_DUPLICATE", `${value.sourceTransactionId} appears twice with different facts.`);
    rows.set(row.internalReference, row);
  }
  const unique = [...rows.values()];

  return db.transaction(async tx => {
    const outletIds = [...new Set(unique.map(row => row.outletId))];
    const known = await tx.select({ id: outlets.id }).from(outlets).where(and(eq(outlets.organisationId, organisationId), eq(outlets.active, true), inArray(outlets.id, outletIds))).for("update");
    if (known.length !== outletIds.length) throw new CommerceIngestionError("UNKNOWN_LOCATION", "A location is not an active location of this organisation.");
    // One source's history at a location stays in one currency; nothing is converted.
    const existing = await tx.selectDistinct({ outletId: saleTransactions.outletId, currencyCode: saleTransactions.currencyCode }).from(saleTransactions)
      .where(and(eq(saleTransactions.source, source), inArray(saleTransactions.outletId, outletIds)));
    for (const outletId of outletIds) {
      const currencies = new Set([...unique.filter(row => row.outletId === outletId).map(row => row.currencyCode), ...existing.filter(row => row.outletId === outletId).map(row => row.currencyCode)]);
      if (currencies.size > 1) throw new CommerceIngestionError("CURRENCY_MISMATCH", `Location history would mix ${[...currencies].join(" and ")}.`);
    }
    const written = await persistCanonicalRows(tx, unique);
    return { source, sourceSystem, received: input.observations.length, inserted: written.inserted, duplicates: input.observations.length - written.inserted };
  });
}
