import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { assertRole, type Scope } from "@/server/auth/access";
import type { DatabaseSession } from "@/server/db/client";
import { outlets, saleTransactions, shiftIncentives, shifts, workers } from "@/server/db/schema";
import { shiftDate } from "@/server/intelligence/forecast";

export type SalesSeries = {
  key: string;
  source: "PAYPAL_SANDBOX" | "DEMO_SEEDED" | "REFERENCE";
  currency: string;
  start: string;
  end: string;
  totalMinor: number;
  days: { date: string; amountMinor: number | null }[];
  locations: { id: string; amountMinor: number | null; observedDays: number }[];
};

// Commercial sale time: explicit for reference history, provider time for PayPal, else record time.
const saleTime = sql`coalesce(${saleTransactions.occurredAt}, ${saleTransactions.providerCreatedAt}, ${saleTransactions.createdAt})`;
const saleDate = sql<string>`to_char(${saleTime} at time zone ${outlets.timezone}, 'YYYY-MM-DD')`;
const syntheticUnverified = sql`${saleTransactions.verificationState} = 'PENDING' and ${saleTransactions.reconciliationState} = 'NOT_RECONCILED'
  and ${saleTransactions.paypalCaptureId} is null and ${saleTransactions.providerCreatedAt} is null`;
const eligibleSale = sql`(
  (${saleTransactions.source} = 'PAYPAL_SANDBOX' and ${saleTransactions.verificationState} = 'VERIFIED'
    and ${saleTransactions.reconciliationState} = 'RECONCILED' and ${saleTransactions.providerStatus} = 'COMPLETED'
    and ${saleTransactions.paypalCaptureId} is not null and ${saleTransactions.providerCreatedAt} is not null)
  or (${saleTransactions.source} = 'DEMO_SEEDED' and ${saleTransactions.providerStatus} = 'DEMO_SEEDED' and ${syntheticUnverified})
  or (${saleTransactions.source} = 'REFERENCE' and ${saleTransactions.providerStatus} = 'REFERENCE'
    and ${saleTransactions.occurredAt} is not null and ${syntheticUnverified})
)`;

// Default series order. Series are never merged; every other series stays selectable.
// A complete labelled reference history leads; a few provider records do not displace it.
const SOURCE_ORDER: Record<SalesSeries["source"], number> = { REFERENCE: 0, PAYPAL_SANDBOX: 1, DEMO_SEEDED: 2 };

export async function getOwnerOverview(db: DatabaseSession, scope: Scope) {
  assertRole(scope, ["OWNER"]);
  const locations = await db.select({ id: outlets.id, name: outlets.name, timezone: outlets.timezone, active: outlets.active })
    .from(outlets).where(eq(outlets.organisationId, scope.organisationId)).orderBy(outlets.name);

  // Each independently scoped source can fail without erasing the other section.
  const [salesResult, attentionResult] = await Promise.allSettled([
    // Daily totals per outlet, source and currency, aggregated in the database so
    // long reference histories are never loaded row by row. Only rows whose full
    // provenance matches their source count: verified PayPal captures, or labelled
    // synthetic history that carries no provider identifiers or verification claims.
    db.select({ outletId: outlets.id, source: saleTransactions.source, currency: saleTransactions.currencyCode,
      date: saleDate,
      amount: sql<number>`sum(${saleTransactions.grossAmountMinor})`.mapWith(Number),
    }).from(saleTransactions).innerJoin(outlets, eq(saleTransactions.outletId, outlets.id))
      .where(and(eq(outlets.organisationId, scope.organisationId), eligibleSale))
      .groupBy(outlets.id, saleTransactions.source, saleTransactions.currencyCode, saleDate),
    db.select({ id: shiftIncentives.id, locationId: outlets.id, locationName: outlets.name,
      date: shifts.shiftDate, status: shiftIncentives.status,
    }).from(shiftIncentives).innerJoin(shifts, eq(shiftIncentives.shiftId, shifts.id))
      .innerJoin(outlets, eq(shifts.outletId, outlets.id))
      .innerJoin(workers, and(eq(workers.id, shiftIncentives.workerId), eq(workers.organisationId, outlets.organisationId), eq(workers.locationId, outlets.id)))
      .where(and(eq(outlets.organisationId, scope.organisationId), inArray(shiftIncentives.status, ["EARNED", "FAILED"])))
      .orderBy(desc(shifts.shiftDate), shiftIncentives.id),
  ]);

  const groups = new Map<string, { source: SalesSeries["source"]; currency: string; entries: { locationId: string; date: string; amount: number }[] }>();
  if (salesResult.status === "fulfilled") for (const sale of salesResult.value) {
    const source = sale.source as SalesSeries["source"];
    const key = `${source}:${sale.currency}`;
    const group = groups.get(key) ?? { source, currency: sale.currency, entries: [] };
    group.entries.push({ locationId: sale.outletId, date: sale.date, amount: sale.amount });
    groups.set(key, group);
  }
  const series: SalesSeries[] = [...groups].sort(([a, x], [b, y]) => SOURCE_ORDER[x.source] - SOURCE_ORDER[y.source] || a.localeCompare(b)).map(([key, group]) => {
    // Seven calendar days ending at this source's latest observed local sale date.
    // Missing receipts establish neither zero sales nor complete trading-day totals.
    const end = group.entries.reduce((latest, row) => row.date > latest ? row.date : latest, "");
    const start = shiftDate(end, -6);
    const entries = group.entries.filter(row => row.date >= start);
    const sum = (rows: typeof entries) => rows.length ? rows.reduce((total, row) => total + row.amount, 0) : null;
    return { key, source: group.source, currency: group.currency, start, end,
      totalMinor: sum(entries)!,
      days: Array.from({ length: 7 }, (_, i) => {
        const date = shiftDate(start, i);
        return { date, amountMinor: sum(entries.filter(row => row.date === date)) };
      }),
      locations: locations.map(location => {
        const rows = entries.filter(row => row.locationId === location.id);
        return { id: location.id, amountMinor: sum(rows), observedDays: new Set(rows.map(row => row.date)).size };
      }),
    };
  });
  return { locations, series, salesUnavailable: salesResult.status === "rejected",
    attention: attentionResult.status === "fulfilled" ? attentionResult.value : null,
    forecastLocationName: scope.locationName,
  };
}

export type OwnerOverviewData = Awaited<ReturnType<typeof getOwnerOverview>>;
