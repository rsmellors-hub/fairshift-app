import { and, desc, eq, inArray } from "drizzle-orm";
import { assertRole, type Scope } from "@/server/auth/access";
import type { DatabaseSession } from "@/server/db/client";
import { outlets, shiftIncentives, shifts, workers, workPayables, workPayouts } from "@/server/db/schema";
import { shiftDate, type SalesSource } from "@/server/intelligence/forecast";
import { loadDailySales, syntheticHistoryAllowed } from "@/server/intelligence/sales-history";
import type { WeeklyForecast } from "@/server/intelligence/weekly";
import type { WeeklyStaffing } from "@/server/intelligence/staffing";

export type SalesSeries = {
  key: string;
  source: SalesSource;
  currency: string;
  start: string;
  end: string;
  totalMinor: number;
  days: { date: string; amountMinor: number | null }[];
  locations: { id: string; amountMinor: number | null; observedDays: number }[];
};

// Default series order. Series are never merged; every other series stays selectable.
// A complete labelled reference history leads; a few provider records do not displace it.
const SOURCE_ORDER: Record<SalesSeries["source"], number> = { IMPORTED: 0, REFERENCE: 1, SQUARE: 2, ZETTLE: 3, PAYPAL_SANDBOX: 4, DEMO_SEEDED: 5 };

export async function getOwnerOverview(db: DatabaseSession, scope: Scope) {
  assertRole(scope, ["OWNER"]);
  const locations = await db.select({ id: outlets.id, name: outlets.name, timezone: outlets.timezone, active: outlets.active })
    .from(outlets).where(eq(outlets.organisationId, scope.organisationId)).orderBy(outlets.name);

  // Each independently scoped source can fail without erasing the other section.
  const [salesResult, attentionResult, payablesResult] = await Promise.allSettled([
    loadDailySales(db, scope.organisationId, undefined, syntheticHistoryAllowed(scope)),
    db.select({ id: shiftIncentives.id, locationId: outlets.id, locationName: outlets.name,
      date: shifts.shiftDate, status: shiftIncentives.status,
    }).from(shiftIncentives).innerJoin(shifts, eq(shiftIncentives.shiftId, shifts.id))
      .innerJoin(outlets, eq(shifts.outletId, outlets.id))
      .innerJoin(workers, and(eq(workers.id, shiftIncentives.workerId), eq(workers.organisationId, outlets.organisationId), eq(workers.locationId, outlets.id)))
      .where(and(eq(outlets.organisationId, scope.organisationId), inArray(shiftIncentives.status, ["EARNED", "FAILED"])))
      .orderBy(desc(shifts.shiftDate), shiftIncentives.id),
    // Confirmed work waiting on a manager, and payouts that have not gone through.
    db.select({ id: workPayables.id, locationName: outlets.name, status: workPayables.status, payoutStatus: workPayouts.status })
      .from(workPayables).innerJoin(outlets, eq(outlets.id, workPayables.outletId)).leftJoin(workPayouts, eq(workPayouts.payableId, workPayables.id))
      .where(and(eq(workPayables.organisationId, scope.organisationId), eq(outlets.organisationId, scope.organisationId))),
  ]);

  const groups = new Map<string, { source: SalesSeries["source"]; currency: string; entries: { locationId: string; date: string; amount: number }[] }>();
  if (salesResult.status === "fulfilled") for (const sale of salesResult.value) {
    const source = sale.source;
    const key = `${source}:${sale.currency}`;
    const group = groups.get(key) ?? { source, currency: sale.currency, entries: [] };
    group.entries.push({ locationId: sale.outletId, date: sale.date, amount: sale.salesMinor });
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
    payables: payablesResult.status === "fulfilled" ? {
      awaitingApproval: payablesResult.value.filter(row => row.status === "PENDING_REVIEW").length,
      needsAttention: payablesResult.value.filter(row => row.payoutStatus === "FAILED" || row.payoutStatus === "RECONCILIATION_REQUIRED").length,
    } : null,
  };
}

export type OwnerOverviewData = Awaited<ReturnType<typeof getOwnerOverview>>;

// Serialisable weekly forecast summary for the Overview client component.
export function ownerForecastSummary(weekly: WeeklyForecast) {
  return {
    consolidated: weekly.consolidated && { source: weekly.consolidated.source, currency: weekly.consolidated.currency, dataThrough: weekly.consolidated.dataThrough,
      firstTarget: weekly.consolidated.firstTarget, lastTarget: weekly.consolidated.days.at(-1)!.targetDate, totalMinor: weekly.consolidated.totalMinor },
    outlets: weekly.outlets.map(outlet => ({ id: outlet.outletId, weeklyTotalMinor: outlet.weeklyTotalMinor,
      currency: outlet.selection.status === "SELECTED" ? outlet.selection.currency : null,
      firstTarget: outlet.selection.status === "SELECTED" ? outlet.selection.firstTarget : null })),
  };
}
export type OwnerForecastSummary = ReturnType<typeof ownerForecastSummary>;

// Serialisable staffing summary for the Overview client component.
export function ownerStaffingSummary(staffing: WeeklyStaffing) {
  const c = staffing.consolidated;
  // Calculated order of what to act on: missing inputs first, then the largest gaps.
  const blocked = staffing.outlets.flatMap(outlet => { const reason = outlet.days.find(day => day.unavailable)?.unavailable; return reason ? [{ id: outlet.outletId, name: outlet.outletName, reason }] : []; });
  const gaps = staffing.outlets.flatMap(outlet => outlet.days.flatMap(day => (day.casualGapMinutes ?? 0) > 0 ? [{ id: outlet.outletId, name: outlet.outletName, date: day.planningDate, minutes: day.casualGapMinutes! }] : []))
    .sort((a, b) => b.minutes - a.minutes || a.date.localeCompare(b.date));
  return {
    commercial: staffing.commercial, blocked, largestGaps: gaps.slice(0, 3), gapDays: gaps.length,
    consolidated: c && { firstDate: c.firstDate, lastDate: c.lastDate, requiredMinutes: c.totals.requiredMinutes,
      coverageMinutes: c.totals.coverageMinutes, casualGapMinutes: c.totals.casualGapMinutes, indicativeShifts: c.totals.indicativeShifts },
    outlets: staffing.outlets.map(outlet => ({ id: outlet.outletId, casualGapMinutes: outlet.totals?.casualGapMinutes ?? null,
      indicativeShifts: outlet.totals?.indicativeShifts ?? null, currency: outlet.currency, cost: outlet.commercial?.cost ?? null })),
  };
}
export type OwnerStaffingSummary = ReturnType<typeof ownerStaffingSummary>;
