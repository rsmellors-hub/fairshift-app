import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, ne } from "drizzle-orm";
import type { Database } from "@/server/db/client";
import { localIntelligenceOutcomes, localIntelligenceRuns, localIntelligenceSignals, outlets, outletTradingHours, saleTransactions } from "@/server/db/schema";
import { localDate, shiftDate, LOOKBACK_DAYS } from "@/server/intelligence/forecast";
import { coversBlock } from "@/server/intelligence/local-intelligence-contract";
import { loadTransactionSlots } from "@/server/intelligence/sales-history";
import { forecastTransactionWindows, planningBlocks, tradingWindowsSchema, type TradingWindow } from "@/server/intelligence/workload";

// The AI signal track record (Owner decision, 8 November 2026). After each day, every accepted demand
// signal for it is compared with what happened: the deterministic forecast for the hours it covered,
// from history up to the day before, against the day's actual transactions in those hours. The
// direction is a match when they agree. Here the actuals are synthetic reference history, which
// contains no real-world events, so the record shows the method working, not the AI's accuracy.

export const TRACK_RECORD_METHOD = "fs-signal-direction-v1";
// A change smaller than this either way counts as flat. A product setting, not a learned value.
const FLAT_BPS = 200;
const LOOK_BACK_DAYS = 14;

export function directionOf(baselineMilli: number, actualMilli: number): "UP" | "DOWN" | "FLAT" {
  if (baselineMilli <= 0) return actualMilli > 0 ? "UP" : "FLAT";
  const bps = Math.round(((actualMilli - baselineMilli) * 10_000) / baselineMilli);
  return bps > FLAT_BPS ? "UP" : bps < -FLAT_BPS ? "DOWN" : "FLAT";
}

// Records every outcome that can be measured now and isn't recorded yet, for one location. A day with
// no recorded history yet waits; nothing is guessed.
export async function recordTrackRecord(db: Database, target: { organisationId: string; outletId: string }, now = new Date()) {
  const [outlet] = await db.select().from(outlets).where(and(eq(outlets.id, target.outletId), eq(outlets.organisationId, target.organisationId)));
  if (!outlet) return { recorded: 0, waiting: 0 };
  const yesterday = shiftDate(localDate(now, outlet.timezone), -1), earliest = shiftDate(yesterday, -(LOOK_BACK_DAYS - 1));
  const runs = await db.select({ id: localIntelligenceRuns.id }).from(localIntelligenceRuns).where(and(eq(localIntelligenceRuns.outletId, outlet.id), eq(localIntelligenceRuns.status, "COMPLETED"), gte(localIntelligenceRuns.windowTo, earliest)));
  if (!runs.length) return { recorded: 0, waiting: 0 };
  const rows = await db.select().from(localIntelligenceSignals).where(and(inArray(localIntelligenceSignals.runId, runs.map(row => row.id)), eq(localIntelligenceSignals.status, "ACCEPTED"), ne(localIntelligenceSignals.sourceCheck, "RESTRICTED"), eq(localIntelligenceSignals.effectType, "DEMAND"))).orderBy(desc(localIntelligenceSignals.createdAt));
  const latest = new Map<string, typeof rows[number]>();
  for (const row of rows) if (!latest.has(row.signalKey)) latest.set(row.signalKey, row);
  const done = new Set((await db.select({ key: localIntelligenceOutcomes.signalKey, date: localIntelligenceOutcomes.targetDate }).from(localIntelligenceOutcomes).where(eq(localIntelligenceOutcomes.outletId, outlet.id))).map(row => `${row.key}|${row.date}`));
  const trading = await db.select().from(outletTradingHours).where(eq(outletTradingHours.outletId, outlet.id));
  const tradingFor = (date: string): TradingWindow[] => { const weekday = new Date(`${date}T12:00:00Z`).getUTCDay() || 7; const windows = trading.find(row => row.isoWeekday === weekday)?.windows; return windows ? tradingWindowsSchema.parse(windows) : []; };
  // Synthetic reference history is the only history these demo outcomes are measured against.
  const [currency] = await db.select({ code: saleTransactions.currencyCode }).from(saleTransactions).where(and(eq(saleTransactions.outletId, outlet.id), eq(saleTransactions.source, "REFERENCE"))).limit(1);
  if (!currency) return { recorded: 0, waiting: latest.size };
  let recorded = 0, waiting = 0;
  for (const signal of latest.values()) {
    for (let date = signal.validFrom < earliest ? earliest : signal.validFrom; date <= signal.validTo && date <= yesterday; date = shiftDate(date, 1)) {
      if (done.has(`${signal.signalKey}|${date}`)) continue;
      const windows = planningBlocks(tradingFor(date)).filter(block => coversBlock({ validFrom: signal.validFrom, validTo: signal.validTo, startMinute: signal.startMinute, endMinute: signal.endMinute, shiftBlocks: signal.shiftBlocks as string[] }, date, block));
      if (!windows.length) continue;
      const slots = await loadTransactionSlots(db, outlet.id, "REFERENCE", currency.code, shiftDate(date, -LOOKBACK_DAYS), date);
      const actualDay = slots.filter(row => row.date === date);
      if (!actualDay.length) { waiting++; continue; }
      const history = slots.filter(row => row.date < date);
      const forecast = history.length ? forecastTransactionWindows({ slots: history, dataThrough: shiftDate(date, -1), targetDate: date, windows }) : null;
      if (!forecast) { waiting++; continue; }
      const baselineMilli = forecast.windows.reduce((sum, row) => sum + row.expectedMilliTransactions, 0);
      const actualMilli = actualDay.filter(row => windows.some(window => row.minute >= window.start && row.minute < window.end)).reduce((sum, row) => sum + row.transactions, 0) * 1000;
      const actualDirection = directionOf(baselineMilli, actualMilli);
      const [row] = await db.insert(localIntelligenceOutcomes).values({ id: randomUUID(), organisationId: outlet.organisationId, outletId: outlet.id, signalId: signal.id, signalKey: signal.signalKey, targetDate: date,
        predictedDirection: signal.direction!, sizeBand: signal.sizeBand!, baselineMilliTransactions: baselineMilli, actualMilliTransactions: actualMilli, actualDirection, matched: actualDirection === signal.direction,
        measuredAgainst: "SYNTHETIC_REFERENCE", method: TRACK_RECORD_METHOD, recordedAt: now }).onConflictDoNothing().returning();
      if (row) recorded++;
    }
  }
  return { recorded, waiting };
}
