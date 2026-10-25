import { and, desc, eq, inArray } from "drizzle-orm";
import { assertRole, type Scope } from "@/server/auth/access";
import type { DatabaseSession } from "@/server/db/client";
import { outlets, saleTransactions, shiftIncentives, shifts, workers } from "@/server/db/schema";
import { localDate, shiftDate } from "@/server/intelligence/forecast";

export type SalesSeries = {
  key: string;
  source: "PAYPAL_SANDBOX" | "DEMO_SEEDED";
  currency: string;
  start: string;
  end: string;
  totalMinor: number;
  days: { date: string; amountMinor: number | null }[];
  locations: { id: string; amountMinor: number | null; observedDays: number }[];
};

export async function getOwnerOverview(db: DatabaseSession, scope: Scope) {
  assertRole(scope, ["OWNER"]);
  const locations = await db.select({ id: outlets.id, name: outlets.name, timezone: outlets.timezone, active: outlets.active })
    .from(outlets).where(eq(outlets.organisationId, scope.organisationId)).orderBy(outlets.name);

  // Each independently scoped source can fail without erasing the other section.
  const [salesResult, attentionResult] = await Promise.allSettled([
    db.select({ outletId: outlets.id, timezone: outlets.timezone, source: saleTransactions.source,
      currency: saleTransactions.currencyCode, amount: saleTransactions.grossAmountMinor,
      verification: saleTransactions.verificationState, reconciliation: saleTransactions.reconciliationState,
      providerStatus: saleTransactions.providerStatus, providerDate: saleTransactions.providerCreatedAt,
      captureId: saleTransactions.paypalCaptureId, createdAt: saleTransactions.createdAt,
    }).from(saleTransactions).innerJoin(outlets, eq(saleTransactions.outletId, outlets.id))
      .where(eq(outlets.organisationId, scope.organisationId)),
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
    const seeded = sale.source === "DEMO_SEEDED" && sale.providerStatus === "DEMO_SEEDED" &&
      sale.verification === "PENDING" && sale.reconciliation === "NOT_RECONCILED" && !sale.captureId && !sale.providerDate;
    const verified = sale.source === "PAYPAL_SANDBOX" && sale.verification === "VERIFIED" &&
      sale.reconciliation === "RECONCILED" && sale.providerStatus === "COMPLETED" && sale.captureId && sale.providerDate;
    if (!seeded && !verified) continue;
    const source = seeded ? "DEMO_SEEDED" : "PAYPAL_SANDBOX";
    const key = `${source}:${sale.currency}`;
    const group = groups.get(key) ?? { source, currency: sale.currency, entries: [] };
    group.entries.push({ locationId: sale.outletId, date: localDate(sale.providerDate ?? sale.createdAt, sale.timezone), amount: sale.amount });
    groups.set(key, group);
  }
  const series: SalesSeries[] = [...groups].sort(([a], [b]) => b.localeCompare(a)).map(([key, group]) => {
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
