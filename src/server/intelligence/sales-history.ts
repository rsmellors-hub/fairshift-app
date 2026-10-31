import { cache } from "react";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DatabaseSession } from "@/server/db/client";
import { outlets, saleTransactions } from "@/server/db/schema";
import type { SalesSource } from "@/server/intelligence/forecast";

// Commercial sale time: explicit for reference and imported history, provider time for PayPal, else record time.
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
)`;

export type DailySalesRow = { outletId: string; source: SalesSource; currency: string; date: string; salesMinor: number; transactions: number };

// Eligible daily totals per outlet, source and currency for one organisation,
// aggregated in the database so long histories are never loaded row by row.
// Memoised per server request: Overview needs the same organisation-wide totals
// for recorded sales and for the weekly forecast. Outside a request it simply runs.
export const loadDailySales = cache(async function loadDailySales(db: DatabaseSession, organisationId: string, outletIds?: string[]): Promise<DailySalesRow[]> {
  if (outletIds && !outletIds.length) return [];
  const rows = await db.select({
    outletId: outlets.id, source: saleTransactions.source, currency: saleTransactions.currencyCode, date: saleDate,
    salesMinor: sql<number>`sum(${saleTransactions.grossAmountMinor})`.mapWith(Number),
    transactions: sql<number>`count(*)`.mapWith(Number),
  }).from(saleTransactions).innerJoin(outlets, eq(saleTransactions.outletId, outlets.id))
    .where(and(eq(outlets.organisationId, organisationId), outletIds ? inArray(outlets.id, outletIds) : undefined, eligibleSale))
    .groupBy(outlets.id, saleTransactions.source, saleTransactions.currencyCode, saleDate);
  return rows.map(row => ({ ...row, source: row.source as SalesSource }));
});
