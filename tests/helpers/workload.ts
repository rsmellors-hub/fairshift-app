import { randomUUID } from "node:crypto";
import { outletTradingHours, regularCoverageWindows, workloadPolicies } from "@/server/db/schema";
import { ingestCommerceObservations } from "@/server/commerce/ingestion";
import { shiftDate } from "@/server/intelligence/forecast";
import type { CoverageWindow, TradingWindow } from "@/server/intelligence/workload";
import type { createTestDatabase } from "./database";

type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];

// TEST-FIXTURE VALUES ONLY. These exercise the arithmetic. They are not reference-company
// policy, not benchmarks and not a recommendation; production code never reads them.
export const TEST_FIXTURE_POLICY = { transactionsPerStaffHour: 4, minimumStaffWhileOpen: 0 } as const;
export const ALL_DAY: TradingWindow[] = [{ start: 0, end: 1440 }];
export const hours = (start: number, end: number, headcount = 1): CoverageWindow => ({ start: start * 60, end: end * 60, headcount });

// Directly stated configuration for a fixture business, labelled CONFIGURED as an Owner's would be.
export async function configureFixture(db: Db, input: { organisationId: string; outletId: string; policy?: { transactionsPerStaffHour: number; minimumStaffWhileOpen: number } | null; policyLevel?: "ORGANISATION" | "LOCATION"; trading?: readonly TradingWindow[] | null; coverage?: readonly CoverageWindow[] | null }) {
  const { organisationId, outletId } = input;
  if (input.policy) await db.insert(workloadPolicies).values({ id: randomUUID(), organisationId, outletId: input.policyLevel === "LOCATION" ? outletId : null, version: 1, ...input.policy, source: "CONFIGURED" });
  if (input.trading !== null) await db.insert(outletTradingHours).values(Array.from({ length: 7 }, (_, i) => ({ id: randomUUID(), organisationId, outletId, isoWeekday: i + 1, windows: input.trading ?? ALL_DAY, source: "CONFIGURED" })));
  if (input.coverage !== null) await db.insert(regularCoverageWindows).values(Array.from({ length: 7 }, (_, i) => ({ id: randomUUID(), organisationId, outletId, isoWeekday: i + 1, windows: input.coverage ?? [], source: "CONFIGURED" })));
}

const isoWeekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay() || 7;
// 56 days of timed bills through the canonical boundary, all in one hour of the day: a
// count and a bill value per weekday, so the weighted forecast equals them exactly.
export function ingestTimedBills(db: Db, input: { organisationId: string; outletId: string; currencyCode?: string; through: string; bills: (isoWeekday: number) => number; billMinor?: number; at?: string; now: Date; sourceSystem?: string; days?: number }) {
  const { currencyCode = "GBP", billMinor = 5_000, at = "12:00:00Z", days = 56 } = input;
  return ingestCommerceObservations(db, { organisationId: input.organisationId, source: "IMPORTED", sourceSystem: input.sourceSystem ?? "dataset", now: input.now, observations: Array.from({ length: days }, (_, i) => shiftDate(input.through, -i)).flatMap(date =>
    Array.from({ length: input.bills(isoWeekday(date)) }, (_, n) => ({ outletId: input.outletId, sourceTransactionId: `${date}:${n}`, occurredAt: `${date}T${at}`, currencyCode, grossAmountMinor: billMinor, status: "COMPLETED" }))) });
}
export const requiredFor = (bills: number, capacity: number) => Math.ceil((bills * 60) / (capacity * 15)) * 15;
