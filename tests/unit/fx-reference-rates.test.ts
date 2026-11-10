import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fxReferenceRates } from "@/server/db/schema";
import { ProviderCurrencyRateUnavailableError } from "@/server/domain/provider-currency";
import {
  businessDaysBefore, currentZarConversion, deriveUsdZarMicros, ECB_DAILY_URL, fetchEcbDailyQuote, isFreshRateDate,
  parseEcbDailyXml, recordEcbQuote,
} from "@/server/fx/reference-rates";
import { createTestDatabase } from "../helpers/database";

// DEC-SA-012 (7 Nov 2026): ZAR->USD at the newest ECB reference rate, derived EUR/ZAR ÷ EUR/USD,
// locked in at reservation, and blocked when no rate from the last 3 business days exists.
// All quotes here are synthetic test values in the ECB file's shape, never published rates.
const xml = (date: string, rows: string) => `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <gesmes:subject>Reference rates</gesmes:subject>
  <Cube><Cube time='${date}'>${rows}</Cube></Cube>
</gesmes:Envelope>`;
const ROWS = "<Cube currency='USD' rate='1.0800'/><Cube currency='JPY' rate='160.10'/><Cube currency='ZAR' rate='20.0232'/>";

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("ECB reference rate derivation", () => {
  it("derives ZAR per USD exactly as EUR/ZAR ÷ EUR/USD in micro-units", () => {
    expect(deriveUsdZarMicros("20.0232", "1.08")).toBe(18_540_000);
    expect(deriveUsdZarMicros("19.98", "1.0800")).toBe(18_500_000);
  });
  it("rounds an inexact cross rate up, so the converted USD never exceeds the exact rate", () => {
    // 20 / 1.1 = 18.181818..., rounded up at the sixth decimal.
    expect(deriveUsdZarMicros("20", "1.1")).toBe(18_181_819);
  });
  it("rejects zero and non-positive quotes", () => {
    expect(() => deriveUsdZarMicros("0", "1.08")).toThrow();
    expect(() => deriveUsdZarMicros("20", "0")).toThrow();
  });
});

describe("ECB daily file parsing", () => {
  it("reads the reference date and the USD and ZAR quotes", () => {
    expect(parseEcbDailyXml(xml("2026-11-06", ROWS))).toEqual({ rateDate: "2026-11-06", eurZar: "20.0232", eurUsd: "1.0800" });
  });
  it("refuses a file without ZAR, without a date, with two dates or with a malformed quote", () => {
    expect(() => parseEcbDailyXml(xml("2026-11-06", "<Cube currency='USD' rate='1.08'/>"))).toThrow(/ZAR/);
    expect(() => parseEcbDailyXml(ROWS)).toThrow(/reference date/);
    expect(() => parseEcbDailyXml(xml("2026-11-06", ROWS) + xml("2026-11-05", ROWS))).toThrow();
    expect(() => parseEcbDailyXml(xml("2026-11-06", "<Cube currency='USD' rate='1.08'/><Cube currency='ZAR' rate='-20'/>"))).toThrow();
  });
  it("fetches only the ECB daily file, with a fake transport here", async () => {
    const fetchImpl = vi.fn(async () => new Response(xml("2026-11-06", ROWS), { status: 200 }));
    expect(await fetchEcbDailyQuote(fetchImpl as unknown as typeof fetch)).toMatchObject({ rateDate: "2026-11-06", eurZar: "20.0232" });
    expect(fetchImpl).toHaveBeenCalledWith(ECB_DAILY_URL, expect.anything());
    const failing = vi.fn(async () => new Response("unavailable", { status: 503 }));
    await expect(fetchEcbDailyQuote(failing as unknown as typeof fetch)).rejects.toThrow(/503/);
  });
});

describe("three-business-day freshness", () => {
  // Saturday 7 Nov 2026: Fri 6, Thu 5, Wed 4 are the last three business days.
  const saturday = new Date("2026-11-07T10:00:00Z");
  it("counts Monday to Friday only", () => {
    expect(businessDaysBefore(saturday, 3)).toBe("2026-11-04");
    // Monday 9 Nov: Fri 6, Thu 5, Wed 4.
    expect(businessDaysBefore(new Date("2026-11-09T06:00:00Z"), 3)).toBe("2026-11-04");
    // Thursday 12 Nov: Wed 11, Tue 10, Mon 9.
    expect(businessDaysBefore(new Date("2026-11-12T06:00:00Z"), 3)).toBe("2026-11-09");
  });
  it("accepts a rate on the boundary and refuses one a day older, or one from the future", () => {
    expect(isFreshRateDate("2026-11-04", saturday)).toBe(true);
    expect(isFreshRateDate("2026-11-03", saturday)).toBe(false);
    expect(isFreshRateDate("2026-11-08", saturday)).toBe(false);
  });
});

describe("recorded reference rates", () => {
  it("locks in the newest fresh rate, and blocks payouts when the newest is stale or absent", async () => {
    const t = await createTestDatabase();
    try {
      const now = new Date("2026-11-07T10:00:00Z");
      await expect(currentZarConversion(t.db, now)).rejects.toBeInstanceOf(ProviderCurrencyRateUnavailableError);
      await recordEcbQuote(t.db, { rateDate: "2026-11-03", eurZar: "20.0232", eurUsd: "1.08" }, now);
      await expect(currentZarConversion(t.db, now)).rejects.toMatchObject({ feedback: "provider-fx-rate-unavailable" });
      await recordEcbQuote(t.db, { rateDate: "2026-11-06", eurZar: "19.98", eurUsd: "1.08" }, now);
      await recordEcbQuote(t.db, { rateDate: "2026-11-05", eurZar: "20.0232", eurUsd: "1.08" }, now);
      expect(await currentZarConversion(t.db, now)).toEqual({ providerCurrency: "USD", fxRateMicros: 18_500_000, fxRateSource: "ECB_EUROFXREF_DAILY:2026-11-06" });
    } finally { await t.close(); }
  });

  it("keeps one row per reference date, refuses future dates and never edits or deletes a rate", async () => {
    const t = await createTestDatabase();
    try {
      const now = new Date("2026-11-07T10:00:00Z");
      const first = await recordEcbQuote(t.db, { rateDate: "2026-11-06", eurZar: "20.0232", eurUsd: "1.08" }, now);
      const again = await recordEcbQuote(t.db, { rateDate: "2026-11-06", eurZar: "19.98", eurUsd: "1.08" }, now);
      expect(first.row?.usdZarMicros).toBe(18_540_000);
      expect(again.row).toBeNull();
      expect(await t.db.select().from(fxReferenceRates)).toHaveLength(1);
      await expect(recordEcbQuote(t.db, { rateDate: "2026-11-09", eurZar: "20", eurUsd: "1.1" }, now)).rejects.toThrow(/future/);
      await expect(t.db.update(fxReferenceRates).set({ eurZar: "1" }).where(eq(fxReferenceRates.rateDate, "2026-11-06"))).rejects.toBeTruthy();
      await expect(t.db.delete(fxReferenceRates)).rejects.toBeTruthy();
      // The database refuses a derived rate that doesn't match its quotes.
      await expect(t.db.insert(fxReferenceRates).values({ id: crypto.randomUUID(), rateDate: "2026-11-05", eurZar: "20.0232", eurUsd: "1.08", usdZarMicros: 18_000_000, source: "ECB_EUROFXREF_DAILY" })).rejects.toBeTruthy();
    } finally { await t.close(); }
  });

});
