import { describe, expect, it } from "vitest";
import { shiftDate } from "@/server/intelligence/forecast";
import {
  REFERENCE_DATASET, REFERENCE_STORE_CODES, REFERENCE_STORES, assertReferenceDate, londonInstant,
  referenceDates, referenceTradingDay, referenceTransactions,
} from "@/server/reference/uk-retail";

const londonParts = (date: Date) => Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit" }).formatToParts(date).map(part => [part.type, part.value]));
const weekday = (date: string) => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

describe("UK reference retailer definition", () => {
  it("defines exactly five GBP stores on the established 104-week calendar", () => {
    expect(REFERENCE_STORE_CODES).toEqual(["UK01", "UK02", "UK03", "UK04", "UK05"]);
    expect(REFERENCE_STORES.map(store => store.city)).toEqual(["Leeds", "Manchester", "Birmingham", "Brighton", "London Stratford"]);
    expect(REFERENCE_DATASET).toMatchObject({ currency: "GBP", timezone: "Europe/London", firstDate: "2024-01-01", lastDate: "2025-12-28", holdoutStart: "2025-10-06" });
    const dates = referenceDates();
    expect(dates).toHaveLength(104 * 7);
    expect(weekday(dates[0])).toBe(0);
    expect(weekday(dates.at(-1)!)).toBe(6);
    expect(() => assertReferenceDate("2025-12-29")).toThrow("Reference history covers");
    expect(() => assertReferenceDate("2023-12-31")).toThrow("Reference history covers");
    expect(() => referenceDates("2025-12-28", "2025-12-01")).toThrow("must not follow");
  });

  it("is deterministic and every store-day sums exactly to its demand", () => {
    for (const code of REFERENCE_STORE_CODES) for (const date of ["2024-01-02", "2024-07-13", "2025-11-28", "2025-12-28"]) {
      const day = referenceTradingDay(code, date);
      const first = referenceTransactions(code, date);
      expect(referenceTransactions(code, date)).toEqual(first);
      expect(day.open).toBe(true);
      if (!day.open) continue;
      expect(first).toHaveLength(day.transactions);
      expect(first.reduce((sum, sale) => sum + sale.amountMinor, 0)).toBe(day.salesMinor);
      for (const sale of first) expect(Number.isSafeInteger(sale.amountMinor) && sale.amountMinor > 0).toBe(true);
    }
  });

  it("places receipts inside local trading hours across GMT and BST and keeps the London trading date", () => {
    expect(londonInstant("2025-01-15", 9 * 3600).toISOString()).toBe("2025-01-15T09:00:00.000Z");
    expect(londonInstant("2025-07-15", 9 * 3600).toISOString()).toBe("2025-07-15T08:00:00.000Z");
    for (const date of ["2025-01-15", "2025-03-30", "2025-07-15", "2025-10-26", "2025-12-24"]) {
      const day = referenceTradingDay("UK05", date);
      if (!day.open) throw new Error("expected trading day");
      for (const sale of referenceTransactions("UK05", date)) {
        const local = londonParts(sale.occurredAt);
        expect(`${local.year}-${local.month}-${local.day}`).toBe(date);
        expect(Number(local.hour)).toBeGreaterThanOrEqual(day.openHour);
        expect(Number(local.hour)).toBeLessThan(day.closeHour);
      }
    }
  });

  it("closes only where large UK shops must close, and those days carry no receipts", () => {
    const closed = REFERENCE_STORE_CODES.flatMap(code => referenceDates().filter(date => !referenceTradingDay(code, date).open).map(date => `${code}:${date}`));
    expect(closed).toHaveLength(20);
    for (const code of REFERENCE_STORE_CODES) {
      for (const date of ["2024-03-31", "2024-12-25", "2025-04-20", "2025-12-25"]) {
        expect(referenceTradingDay(code, date)).toMatchObject({ open: false });
        expect(referenceTransactions(code, date)).toEqual([]);
      }
    }
  });

  it("gives stores distinct scale and weekly shape, with clear weekday variation", () => {
    const dates = referenceDates("2025-02-03", "2025-05-25");
    const profile = Object.fromEntries(REFERENCE_STORE_CODES.map(code => {
      const days = dates.map(date => referenceTradingDay(code, date)).filter(day => day.open);
      const byWeekday = Array.from({ length: 7 }, (_, i) => mean(days.filter(day => weekday(day.date) === i).map(day => day.open ? day.salesMinor : 0)));
      return [code, { mean: mean(days.map(day => day.open ? day.salesMinor : 0)), byWeekday }];
    }));
    for (const code of REFERENCE_STORE_CODES) expect(profile[code].byWeekday[5]).toBeGreaterThan(profile[code].byWeekday[0] * 1.3);
    const means = REFERENCE_STORE_CODES.map(code => profile[code].mean);
    expect(new Set(means.map(value => Math.round(value / 50_000))).size).toBe(5);
    expect(Math.max(...means)).toBe(profile.UK05.mean);
    expect(Math.min(...means)).toBe(profile.UK04.mean);
    // Brighton's visitor-economy Sunday is relatively stronger than Manchester's.
    expect(profile.UK04.byWeekday[6] / profile.UK04.byWeekday[0]).toBeGreaterThan(profile.UK02.byWeekday[6] / profile.UK02.byWeekday[0] + 0.3);
  });

  it("leaves every store at least three observations of each weekday in the final 56 days", () => {
    const window = referenceDates(shiftDate(REFERENCE_DATASET.lastDate, -55), REFERENCE_DATASET.lastDate);
    for (const code of REFERENCE_STORE_CODES) {
      const open = window.filter(date => referenceTradingDay(code, date).open);
      for (let i = 0; i < 7; i++) expect(open.filter(date => weekday(date) === i).length).toBeGreaterThanOrEqual(3);
    }
  });
});
