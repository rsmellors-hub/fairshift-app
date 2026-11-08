import { coversBlock, type AppliableSignal } from "@/server/intelligence/local-intelligence-contract";
import type { TradingWindow } from "@/server/intelligence/workload";

// Capacity and access disruptions (Owner decisions, 8 November 2026). They never move demand. A
// high-severity CAPACITY signal (the venue's ability to trade) is an Owner alert; an ACCESS signal
// (customers or staff getting there) flags a staff-attendance risk on the planning blocks it covers.
// Only accepted signals count: an unconfirmed one is shown, never applied, and flags nothing.

export type DisruptionSignal = Pick<AppliableSignal, "key" | "status" | "effectType" | "validFrom" | "validTo" | "startMinute" | "endMinute" | "shiftBlocks"> & { severity: string | null; closureLikely: boolean };
export type BlockRisk = TradingWindow & { access: string[]; capacity: string[] };

export function blockRisks(date: string, blocks: readonly TradingWindow[], signals: readonly DisruptionSignal[]): BlockRisk[] {
  const accepted = signals.filter(signal => signal.status === "ACCEPTED");
  return blocks.map(block => ({ start: block.start, end: block.end,
    access: accepted.filter(signal => signal.effectType === "ACCESS" && coversBlock(signal, date, block)).map(signal => signal.key),
    capacity: accepted.filter(signal => signal.effectType === "CAPACITY" && coversBlock(signal, date, block)).map(signal => signal.key) }));
}

// High-severity capacity signals still ahead (today or later), the most likely closures first.
export function capacityAlerts<T extends DisruptionSignal & { impact: number }>(signals: readonly T[], today: string): T[] {
  return signals.filter(signal => signal.status === "ACCEPTED" && signal.effectType === "CAPACITY" && signal.severity === "HIGH" && signal.validTo >= today)
    .sort((a, b) => Number(b.closureLikely) - Number(a.closureLikely) || a.validFrom.localeCompare(b.validFrom) || b.impact - a.impact || a.key.localeCompare(b.key));
}
