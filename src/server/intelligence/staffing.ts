import { and, eq, gt, inArray, lt } from "drizzle-orm";
import { z } from "zod";
import { assertRole, type Scope } from "@/server/auth/access";
import type { DatabaseSession } from "@/server/db/client";
import { outlets, regularStaffCoverage, shiftOffers, shifts, workAllocations, workers } from "@/server/db/schema";
import { shiftDate, startOfLocalDay, type SalesSource } from "@/server/intelligence/forecast";
import { getWeeklyForecast, type OutletWeeklyForecast } from "@/server/intelligence/weekly";

export const STAFFING_METHOD_VERSION = "coverage-gap-v1";

export const labourPolicySchema = z.object({
  version: z.string().min(1),
  currency: z.string().length(3),
  salesMinorPerLabourHour: z.number().int().positive(),
  planningIncrementMinutes: z.number().int().min(1).max(60),
  indicativeShiftMinutes: z.number().int().min(60).max(720),
});
export type LabourPolicy = z.infer<typeof labourPolicySchema>;

// Hackathon MVP reference productivity assumption for the UK reference retailer:
// £100 of forecast sales per required labour hour. A documented planning
// assumption, not a UK retail benchmark, a learned per-location rate or an AI output.
// Labour is planned in 15-minute increments; 8-hour shifts only give an indicative count.
export const REFERENCE_LABOUR_POLICY = labourPolicySchema.parse({
  version: "reference-productivity-v1",
  currency: "GBP",
  salesMinorPerLabourHour: 10_000,
  planningIncrementMinutes: 15,
  indicativeShiftMinutes: 480,
});
const LABOUR_POLICIES: readonly LabourPolicy[] = [REFERENCE_LABOUR_POLICY];

// A labour assumption is denominated in one currency; no currency is converted.
export function labourPolicyFor(currency: string) {
  return LABOUR_POLICIES.find(policy => policy.currency === currency) ?? null;
}

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ceilDiv = (numerator: number, denominator: number) => numerator === 0 ? 0 : Math.floor((numerator - 1) / denominator) + 1;

// Forecast sales → required labour minutes, in integer arithmetic, rounded UP to
// the planning increment so demand is never rounded down into understaffing.
export function requiredLabourMinutes(forecastSalesMinor: number, policy: LabourPolicy) {
  count.parse(forecastSalesMinor);
  const scaled = forecastSalesMinor * 60;
  if (!Number.isSafeInteger(scaled)) throw new Error("Forecast exceeds safe labour arithmetic limits.");
  return ceilDiv(scaled, policy.salesMinorPerLabourHour * policy.planningIncrementMinutes) * policy.planningIncrementMinutes;
}

// Demand → required labour → existing coverage → casual gap. Labour minutes are
// authoritative; the shift count is an indicative conversion of the gap only.
export function calculateStaffing(input: { forecastSalesMinor: number; regularMinutes: number; allocatedCasualMinutes: number; policy: LabourPolicy }) {
  const policy = labourPolicySchema.parse(input.policy);
  const requiredMinutes = requiredLabourMinutes(input.forecastSalesMinor, policy);
  const regularMinutes = count.parse(input.regularMinutes);
  const allocatedCasualMinutes = count.parse(input.allocatedCasualMinutes);
  const coverageMinutes = regularMinutes + allocatedCasualMinutes;
  const casualGapMinutes = Math.max(0, requiredMinutes - coverageMinutes);
  return { requiredMinutes, regularMinutes, allocatedCasualMinutes, coverageMinutes, casualGapMinutes,
    indicativeShifts: ceilDiv(casualGapMinutes, policy.indicativeShiftMinutes) };
}

export type StaffingUnavailableReason = "NO_FORECAST" | "NO_LABOUR_ASSUMPTION" | "REGULAR_COVERAGE_NOT_SET";
export type StaffingDay = {
  planningDate: string;
  forecastSalesMinor: number | null;
  support: "LOW" | "MODERATE" | null;
  requiredMinutes: number | null;
  regularMinutes: number | null;
  allocatedCasualMinutes: number;
  coverageMinutes: number | null;
  casualGapMinutes: number | null;
  indicativeShifts: number | null;
  unavailable: StaffingUnavailableReason | null;
};
type Totals = { forecastSalesMinor: number; requiredMinutes: number; regularMinutes: number; allocatedCasualMinutes: number; coverageMinutes: number; casualGapMinutes: number; indicativeShifts: number };
export type OutletStaffing = {
  outletId: string; outletName: string; timezone: string;
  currency: string | null; policy: LabourPolicy | null;
  evidence: { source: SalesSource; kind: "PROVIDER" | "HISTORICAL"; dataThrough: string; ageDays: number } | null;
  regularCoverage: "REFERENCE" | null;
  days: StaffingDay[];
  totals: Totals | null;
};

// Allocated casual shift minutes falling inside one local planning day. Shifts are
// clipped to the day, so a shift crossing midnight counts only its hours on each day.
export function minutesWithin(shift: { startsAt: Date; endsAt: Date }, dayStart: Date, dayEnd: Date) {
  const overlap = Math.min(shift.endsAt.getTime(), dayEnd.getTime()) - Math.max(shift.startsAt.getTime(), dayStart.getTime());
  return overlap > 0 ? Math.floor(overlap / 60_000) : 0;
}

const isoWeekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay() || 7;
const sumTotals = (rows: readonly Totals[]): Totals => rows.reduce((sum, row) => ({
  forecastSalesMinor: sum.forecastSalesMinor + row.forecastSalesMinor, requiredMinutes: sum.requiredMinutes + row.requiredMinutes,
  regularMinutes: sum.regularMinutes + row.regularMinutes, allocatedCasualMinutes: sum.allocatedCasualMinutes + row.allocatedCasualMinutes,
  coverageMinutes: sum.coverageMinutes + row.coverageMinutes, casualGapMinutes: sum.casualGapMinutes + row.casualGapMinutes,
  indicativeShifts: sum.indicativeShifts + row.indicativeShifts,
}), { forecastSalesMinor: 0, requiredMinutes: 0, regularMinutes: 0, allocatedCasualMinutes: 0, coverageMinutes: 0, casualGapMinutes: 0, indicativeShifts: 0 });

// Pure assembly of one outlet's planning week from its forecast and coverage inputs.
export function outletStaffing(forecast: OutletWeeklyForecast, regular: ReadonlyMap<number, { plannedMinutes: number; source: string }>,
  allocated: readonly { startsAt: Date; endsAt: Date }[]): OutletStaffing {
  const selected = forecast.selection.status === "SELECTED" ? forecast.selection : null;
  const policy = selected ? labourPolicyFor(selected.currency) : null;
  const firstDate = shiftDate(forecast.today, 1);
  const days = Array.from({ length: 7 }, (_, i): StaffingDay => {
    const planningDate = shiftDate(firstDate, i);
    const prediction = forecast.days.find(day => day.targetDate === planningDate)?.forecast ?? null;
    const dayStart = startOfLocalDay(planningDate, forecast.timezone), dayEnd = startOfLocalDay(shiftDate(planningDate, 1), forecast.timezone);
    const allocatedCasualMinutes = allocated.reduce((sum, shift) => sum + minutesWithin(shift, dayStart, dayEnd), 0);
    const regularMinutes = regular.get(isoWeekday(planningDate))?.plannedMinutes ?? null;
    const base = { planningDate, forecastSalesMinor: prediction?.forecastSalesMinor ?? null, support: prediction?.support ?? null, regularMinutes, allocatedCasualMinutes };
    const unavailable: StaffingUnavailableReason | null = !prediction ? "NO_FORECAST" : !policy ? "NO_LABOUR_ASSUMPTION" : regularMinutes === null ? "REGULAR_COVERAGE_NOT_SET" : null;
    if (unavailable) {
      // Required labour is still known without regular coverage; the gap is not.
      const requiredMinutes = prediction && policy ? requiredLabourMinutes(prediction.forecastSalesMinor, policy) : null;
      return { ...base, requiredMinutes, coverageMinutes: null, casualGapMinutes: null, indicativeShifts: null, unavailable };
    }
    return { ...base, ...calculateStaffing({ forecastSalesMinor: prediction!.forecastSalesMinor, regularMinutes: regularMinutes!, allocatedCasualMinutes, policy: policy! }), unavailable: null };
  });
  const complete = days.every(day => !day.unavailable);
  return {
    outletId: forecast.outletId, outletName: forecast.outletName, timezone: forecast.timezone,
    currency: selected?.currency ?? null, policy,
    evidence: selected && { source: selected.source, kind: selected.kind, dataThrough: selected.dataThrough,
      ageDays: Math.round((Date.parse(`${firstDate}T12:00:00Z`) - Date.parse(`${selected.dataThrough}T12:00:00Z`)) / 86_400_000) },
    regularCoverage: regular.size ? "REFERENCE" : null,
    days,
    totals: complete ? sumTotals(days as unknown as Totals[]) : null,
  };
}

// Seven-day staffing evidence per authorised outlet: forecast demand, required
// labour, regular and allocated casual coverage, and the remaining casual gap.
// Deterministic and derived on read; nothing is stored, no shift is created and
// no AI is involved. A failed coverage query rejects rather than reading as zero.
export async function getWeeklyStaffing(db: DatabaseSession, scope: Scope, now = new Date()) {
  assertRole(scope, ["OWNER", "MANAGER"]);
  const weekly = await getWeeklyForecast(db, scope, now);
  const outletIds = weekly.outlets.map(outlet => outlet.outletId);
  if (!outletIds.length) return { methodVersion: STAFFING_METHOD_VERSION, generatedAt: now.toISOString(), outlets: [], consolidated: null };
  const windows = weekly.outlets.map(outlet => ({ start: startOfLocalDay(shiftDate(outlet.today, 1), outlet.timezone), end: startOfLocalDay(shiftDate(outlet.today, 8), outlet.timezone) }));
  const from = new Date(Math.min(...windows.map(w => w.start.getTime()))), to = new Date(Math.max(...windows.map(w => w.end.getTime())));
  const [regularRows, allocatedRows] = await Promise.all([
    db.select({ outletId: regularStaffCoverage.outletId, isoWeekday: regularStaffCoverage.isoWeekday, plannedMinutes: regularStaffCoverage.plannedMinutes, source: regularStaffCoverage.source })
      .from(regularStaffCoverage).innerJoin(outlets, and(eq(outlets.id, regularStaffCoverage.outletId), eq(outlets.organisationId, regularStaffCoverage.organisationId)))
      .where(and(eq(regularStaffCoverage.organisationId, scope.organisationId), inArray(regularStaffCoverage.outletId, outletIds))),
    // Only final allocations of location-bound casual workers count. Offers,
    // pending or declined responses and acceptances awaiting allocation do not.
    db.select({ outletId: shifts.outletId, startsAt: shifts.startsAt, endsAt: shifts.endsAt }).from(workAllocations)
      .innerJoin(shiftOffers, eq(shiftOffers.id, workAllocations.offerId))
      .innerJoin(shifts, eq(shifts.id, shiftOffers.shiftId))
      .innerJoin(outlets, eq(outlets.id, shifts.outletId))
      .innerJoin(workers, eq(workers.id, shiftOffers.workerId))
      .where(and(eq(outlets.organisationId, scope.organisationId), inArray(shifts.outletId, outletIds),
        eq(workers.organisationId, scope.organisationId), eq(workers.locationId, shifts.outletId), eq(workers.workerType, "CASUAL"),
        eq(workAllocations.state, "ALLOCATED"), eq(shiftOffers.status, "ACCEPTED"), inArray(shifts.status, ["PUBLISHED", "COMPLETED"]),
        lt(shifts.startsAt, to), gt(shifts.endsAt, from))),
  ]);
  const result = weekly.outlets.map(outlet => outletStaffing(outlet,
    new Map(regularRows.filter(row => row.outletId === outlet.outletId).map(row => [row.isoWeekday, row])),
    allocatedRows.filter(row => row.outletId === outlet.outletId)));
  return { methodVersion: STAFFING_METHOD_VERSION, generatedAt: now.toISOString(), outlets: result, consolidated: consolidate(result) };
}

// Company totals only when every outlet has a complete week on the same dates,
// in the same currency under the same labour assumption.
function consolidate(rows: readonly OutletStaffing[]) {
  const [first] = rows;
  if (!first?.totals || !rows.every(row => row.totals && row.currency === first.currency && row.policy?.version === first.policy?.version
    && row.days[0].planningDate === first.days[0].planningDate)) return null;
  return { currency: first.currency!, policy: first.policy!, firstDate: first.days[0].planningDate, lastDate: first.days[6].planningDate,
    totals: sumTotals(rows.map(row => row.totals!)) };
}

export type WeeklyStaffing = Awaited<ReturnType<typeof getWeeklyStaffing>>;
