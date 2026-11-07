import type { DatabaseSession } from "@/server/db/client";
import { businessDaysBefore, recordEcbQuote } from "@/server/fx/reference-rates";

// Synthetic ECB-shaped quotes for tests only, never a published ECB rate:
// 20.0232 / 1.08 = 18.54 ZAR per USD, and 19.98 / 1.08 = 18.50 ZAR per USD.
export const TEST_QUOTE_1854 = { eurZar: "20.0232", eurUsd: "1.08" } as const;
export const TEST_QUOTE_1850 = { eurZar: "19.98", eurUsd: "1.08" } as const;
export const todayUtc = (now = new Date()) => now.toISOString().slice(0, 10);

// Records a fresh test reference rate (dated today, or `daysBack` weekdays ago).
export async function seedTestFxRate(db: DatabaseSession, quote: { eurZar: string; eurUsd: string } = TEST_QUOTE_1854, daysBack = 0) {
  const rateDate = daysBack ? businessDaysBefore(new Date(), daysBack) : todayUtc();
  const { row } = await recordEcbQuote(db, { rateDate, ...quote });
  return row!;
}
