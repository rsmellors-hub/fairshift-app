import { cache } from "react";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { Scope } from "@/server/auth/access";
import { isDemoOrganisation } from "@/server/demo/organisation";
import type { DatabaseSession } from "@/server/db/client";
import { outlets, saleTransactions } from "@/server/db/schema";
import type { SalesSource } from "@/server/intelligence/forecast";

// Commercial sale time: explicit for reference, imported and connected-provider history, provider time for PayPal, else record time.
const saleTime = sql`coalesce(${saleTransactions.occurredAt}, ${saleTransactions.providerCreatedAt}, ${saleTransactions.createdAt})`;
const saleDate = sql<string>`to_char(${saleTime} at time zone ${outlets.timezone}, 'YYYY-MM-DD')`;
const unverified = sql`${saleTransactions.verificationState} = 'PENDING' and ${saleTransactions.reconciliationState} = 'NOT_RECONCILED'
  and ${saleTransactions.paypalCaptureId} is null and ${saleTransactions.providerCreatedAt} is null`;
// Only rows whose full provenance matches their source count: verified PayPal
// captures, or labelled synthetic or imported history with no provider identifiers
// or verification claims. Mirrors eligibleObservation() in forecast.ts.
const eligibleSale = sql`(
  (${saleTransactions.source} = 'PAYPAL_SANDBOX' and ${saleTransactions.verificationState} = 'VERIFIED'
    and ${saleTransactions.reconciliationState} = 'RECONCILED' and ${saleTransactions.providerStatus} = 'COMPLETED'
    and ${saleTransactions.paypalCaptureId} is not null and ${saleTransactions.providerCreatedAt} is not null)
  or (${saleTransactions.source} = 'DEMO_SEEDED' and ${saleTransactions.providerStatus} = 'DEMO_SEEDED' and ${unverified})
  or (${saleTransactions.source} = 'REFERENCE' and ${saleTransactions.providerStatus} = 'REFERENCE'
    and ${saleTransactions.occurredAt} is not null and ${unverified})
  or (${saleTransactions.source} = 'IMPORTED' and ${saleTransactions.providerStatus} = 'IMPORTED'
    and ${saleTransactions.occurredAt} is not null and ${unverified})
  or (${saleTransactions.source} = 'ZETTLE' and ${saleTransactions.providerStatus} = 'ZETTLE'
    and ${saleTransactions.occurredAt} is not null and ${unverified})
  or (${saleTransactions.source} = 'SQUARE' and ${saleTransactions.providerStatus} = 'SQUARE'
    and ${saleTransactions.occurredAt} is not null and ${unverified})
)`;

export type DailySalesRow = { outletId: string; source: SalesSource; currency: string; date: string; salesMinor: number; transactions: number };

// Synthetic history is readable only for the organisation the server configures as the
// demonstration (public demo or Sandbox organisation), whether the visitor is a public demo
// persona or a signed-in account of that business. Rows alone never grant demo access.
export function syntheticHistoryAllowed(scope: Pick<Scope, "organisationId"> & Partial<Pick<Scope, "demo">>) {
  return isDemoOrganisation(scope.organisationId);
}

// Eligible daily totals per outlet, source and currency for one organisation,
// aggregated in the database so long histories are never loaded row by row.
// Memoised per server request: Overview needs the same organisation-wide totals
// for recorded sales and for the weekly forecast. Outside a request it simply runs.
export const loadDailySales = cache(async function loadDailySales(db: DatabaseSession, organisationId: string, outletIds?: string[], allowSynthetic = false): Promise<DailySalesRow[]> {
  if (outletIds && !outletIds.length) return [];
  const rows = await db.select({
    outletId: outlets.id, source: saleTransactions.source, currency: saleTransactions.currencyCode, date: saleDate,
    salesMinor: sql<number>`sum(${saleTransactions.grossAmountMinor})`.mapWith(Number),
    transactions: sql<number>`count(*)`.mapWith(Number),
  }).from(saleTransactions).innerJoin(outlets, eq(saleTransactions.outletId, outlets.id))
    .where(and(eq(outlets.organisationId, organisationId), outletIds ? inArray(outlets.id, outletIds) : undefined,
      allowSynthetic ? undefined : notInArray(saleTransactions.source, ["REFERENCE", "DEMO_SEEDED"]), eligibleSale))
    .groupBy(outlets.id, saleTransactions.source, saleTransactions.currencyCode, saleDate);
  return rows.map(row => ({ ...row, source: row.source as SalesSource }));
});

// Transactions of one source and currency at one location, per 15-minute local time slot,
// for the workload forecast. Only sales with a real recorded time count: a row whose only
// time is when it was written says nothing about when customers came.
export async function loadTransactionSlots(db: DatabaseSession, outletId: string, source: SalesSource, currency: string, from: string, through: string): Promise<{ date: string; minute: number; transactions: number; salesMinor: number }[]> {
  const known = sql`coalesce(${saleTransactions.occurredAt}, ${saleTransactions.providerCreatedAt})`;
  const local = sql`(${known} at time zone ${outlets.timezone})`;
  const date = sql<string>`to_char(${local}, 'YYYY-MM-DD')`;
  const minute = sql<number>`(extract(hour from ${local})::int * 60 + floor(extract(minute from ${local}) / 15)::int * 15)`.mapWith(Number);
  return db.select({ date, minute,
    transactions: sql<number>`count(*)`.mapWith(Number), salesMinor: sql<number>`sum(${saleTransactions.grossAmountMinor})`.mapWith(Number),
  }).from(saleTransactions).innerJoin(outlets, eq(saleTransactions.outletId, outlets.id))
    .where(and(eq(outlets.id, outletId), eq(saleTransactions.source, source), eq(saleTransactions.currencyCode, currency), sql`${known} is not null`, eligibleSale,
      sql`${date} >= ${from}`, sql`${date} <= ${through}`))
    .groupBy(date, minute);
}

// Which generated dataset a location's reference history came from, if any.
export async function referenceDatasetOf(db: DatabaseSession, outletId: string): Promise<string | null> {
  const [row] = await db.select({ dataset: saleTransactions.sourceSystem }).from(saleTransactions)
    .where(and(eq(saleTransactions.outletId, outletId), eq(saleTransactions.source, "REFERENCE"))).limit(1);
  return row?.dataset ?? null;
}
