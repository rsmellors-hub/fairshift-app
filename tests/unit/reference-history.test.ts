// SUPERSEDED dataset, kept reproducible: uk-specialty-retail-v2 is historical evidence, not the
// current reference company. See reference-hospitality.test.ts for the current one.
import { describe, expect, it } from "vitest";
import { forecastFromHistory, shiftDate } from "@/server/intelligence/forecast";
import {
  REFERENCE_DATASET, REFERENCE_STORE_CODES, REFERENCE_STORES, UK_BANK_HOLIDAYS, assertReferenceDate, londonInstant,
  referenceDates, referenceStore, referenceTradingDay, referenceTransactions, type ReferenceStoreCode,
} from "@/server/reference/uk-retail";

const londonParts = (date: Date) => Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit" }).formatToParts(date).map(part => [part.type, part.value]));
const weekday = (date: string) => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
const sales = (code: ReferenceStoreCode, from: string, through: string) => referenceDates(from, through).map(date => referenceTradingDay(code, date)).flatMap(day => day.open ? [day] : []);

describe("UK reference retailer definition", () => {
  it("defines exactly five GBP stores on a 104-week calendar ending on the Sunday before the first November planning week", () => {
    expect(REFERENCE_STORE_CODES).toEqual(["UK01", "UK02", "UK03", "UK04", "UK05"]);
    expect(REFERENCE_STORES.map(store => store.city)).toEqual(["Leeds", "Manchester", "Birmingham", "Brighton", "London Stratford"]);
    expect(REFERENCE_DATASET).toMatchObject({ version: "uk-specialty-retail-v2", currency: "GBP", timezone: "Europe/London", firstDate: "2024-11-04", lastDate: "2026-11-01", holdoutStart: "2026-08-10" });
    const dates = referenceDates();
    expect(dates).toHaveLength(104 * 7);
    expect(weekday(dates[0])).toBe(0);
    expect(weekday(dates.at(-1)!)).toBe(6);
    expect(() => assertReferenceDate("2026-11-02")).toThrow("Reference history covers");
    expect(() => assertReferenceDate("2024-11-03")).toThrow("Reference history covers");
    expect(() => assertReferenceDate("2026-02-30")).toThrow("Invalid ISO date");
    expect(() => assertReferenceDate("31/10/2026")).toThrow("Invalid date");
    expect(() => referenceDates("2026-11-01", "2026-10-01")).toThrow("must not follow");
  });

  it("is deterministic and every store-day sums exactly to its demand with positive receipts", () => {
    for (const code of REFERENCE_STORE_CODES) for (const date of ["2024-11-05", "2025-07-12", "2025-11-28", "2026-10-25", "2026-11-01"]) {
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
    expect(londonInstant("2026-01-15", 9 * 3600).toISOString()).toBe("2026-01-15T09:00:00.000Z");
    expect(londonInstant("2026-07-15", 9 * 3600).toISOString()).toBe("2026-07-15T08:00:00.000Z");
    // Includes both clock changes: 29 March and 25 October 2026.
    for (const date of ["2026-01-15", "2026-03-29", "2026-07-15", "2026-10-25", "2026-10-31", "2025-12-24"]) {
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

  it("trades until 20:00 from Thursday to Saturday, so a 14:00–20:00 shift falls inside trading hours", () => {
    for (const [date, closes] of [["2026-10-26", 19], ["2026-10-29", 20], ["2026-10-30", 20], ["2026-10-31", 20], ["2026-10-25", 17]] as const) {
      expect(referenceTradingDay("UK01", date)).toMatchObject({ open: true, closeHour: closes });
    }
  });

  it("closes where large UK shops must close plus one stocktake, and those days carry no receipts", () => {
    const closed = REFERENCE_STORE_CODES.flatMap(code => referenceDates().filter(date => !referenceTradingDay(code, date).open).map(date => `${code}:${date}`));
    expect(closed).toHaveLength(21);
    for (const code of REFERENCE_STORE_CODES) {
      for (const date of ["2024-12-25", "2025-04-20", "2025-12-25", "2026-04-05"]) {
        expect(referenceTradingDay(code, date)).toMatchObject({ open: false });
        expect(referenceTransactions(code, date)).toEqual([]);
      }
    }
    expect(referenceTradingDay("UK03", "2026-10-06")).toMatchObject({ open: false, closure: "Closed for stocktake" });
    expect(referenceTradingDay("UK01", "2026-10-06").open).toBe(true);
  });

  it("carries no holiday outside the dataset, and each holiday falls on a real trading calendar date", () => {
    for (const date of Object.keys(UK_BANK_HOLIDAYS)) expect(() => assertReferenceDate(date)).not.toThrow();
    // No bank holiday falls in the forecast lookback, so none distorts the current planning week.
    const lookback = referenceDates(shiftDate(REFERENCE_DATASET.lastDate, -55), REFERENCE_DATASET.lastDate);
    expect(lookback.filter(date => UK_BANK_HOLIDAYS[date])).toEqual([]);
    expect(UK_BANK_HOLIDAYS["2026-08-31"]).toBe("Summer bank holiday");
    expect(UK_BANK_HOLIDAYS["2026-04-03"]).toBe("Good Friday");
  });

  it("leaves every store at least three observations of each weekday in the final 56 days", () => {
    const window = referenceDates(shiftDate(REFERENCE_DATASET.lastDate, -55), REFERENCE_DATASET.lastDate);
    for (const code of REFERENCE_STORE_CODES) {
      const open = window.filter(date => referenceTradingDay(code, date).open);
      expect(open.length).toBeGreaterThanOrEqual(28);
      for (let i = 0; i < 7; i++) expect(open.filter(date => weekday(date) === i).length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("five-location commercial story", () => {
  const recent = (code: ReferenceStoreCode) => sales(code, "2026-09-07", "2026-11-01");
  const weekdayMean = (code: ReferenceStoreCode, index: number) => mean(recent(code).filter(day => weekday(day.date) === index).map(day => day.salesMinor));
  // Deviation from each store's own weekday and season, so only store behaviour remains.
  const spread = (code: ReferenceStoreCode) => {
    const days = recent(code);
    const ratios = days.map(day => day.salesMinor / mean(days.filter(other => weekday(other.date) === weekday(day.date)).map(other => other.salesMinor)));
    const average = mean(ratios);
    return Math.sqrt(mean(ratios.map(value => (value - average) ** 2)));
  };
  // Change against the same weeks' Leeds trading removes the shared autumn season.
  const momentum = (code: ReferenceStoreCode) => {
    const change = (c: ReferenceStoreCode) => mean(sales(c, "2026-10-12", "2026-11-01").map(day => day.salesMinor)) / mean(sales(c, "2026-08-17", "2026-09-06").map(day => day.salesMinor));
    return change(code) / change("UK01");
  };

  it("does not clone one store: scale and weekly shape differ beyond a multiplier", () => {
    const means = REFERENCE_STORE_CODES.map(code => mean(recent(code).map(day => day.salesMinor)));
    expect(new Set(means.map(value => Math.round(value / 20_000))).size).toBe(5);
    expect(Math.max(...means)).toBe(means[4]);
    expect(Math.min(...means)).toBe(means[3]);
    const shapes = REFERENCE_STORE_CODES.map(code => Array.from({ length: 7 }, (_, i) => weekdayMean(code, i) / weekdayMean(code, 0)));
    for (let a = 0; a < 5; a++) for (let b = a + 1; b < 5; b++) {
      expect(Math.max(...shapes[a].map((value, i) => Math.abs(value - shapes[b][i])))).toBeGreaterThan(0.1);
    }
    // Brighton's visitor weekend is relatively stronger than Birmingham's.
    expect(weekdayMean("UK04", 6) / weekdayMean("UK04", 0)).toBeGreaterThan(weekdayMean("UK03", 6) / weekdayMean("UK03", 0) + 0.5);
  });

  it("gives stores different recent momentum and volatility", () => {
    expect(momentum("UK02")).toBeGreaterThan(1.08);
    expect(momentum("UK03")).toBeLessThan(0.95);
    expect(spread("UK04")).toBeGreaterThan(spread("UK01") * 1.3);
    for (const code of REFERENCE_STORE_CODES) expect(spread(code)).toBeLessThan(0.2);
  });

  it("does not jump at the turn of a month", () => {
    const week = (from: string, through: string) => mean(sales("UK01", from, through).map(day => day.salesMinor));
    for (const code of REFERENCE_STORE_CODES) {
      const store = referenceStore(code);
      expect(store.momentum).toBeGreaterThanOrEqual(-0.1);
      expect(store.momentum).toBeLessThanOrEqual(0.2);
    }
    expect(week("2026-10-26", "2026-11-01") / week("2026-10-19", "2026-10-25")).toBeLessThan(1.1);
  });

  // The forecast each planning day would get, minus the rota: the demo's staffing week.
  const gaps = (code: ReferenceStoreCode) => {
    const days = sales(code, "2026-09-05", "2026-10-31").map(day => ({ date: day.date, salesMinor: day.salesMinor, transactions: day.transactions }));
    return Array.from({ length: 7 }, (_, i) => {
      const target = shiftDate("2026-11-02", i);
      const forecast = forecastFromHistory({ days, dataThrough: "2026-10-31", targetDate: target })!;
      const required = Math.ceil(forecast.forecastSalesMinor / 2_500) / 4;
      return Math.max(0, required - referenceStore(code).regularCoverageHours[i]);
    });
  };

  it("produces a coherent week: covered stores and days, modest needs, one large gap, nothing absurd", () => {
    const all = Object.fromEntries(REFERENCE_STORE_CODES.map(code => [code, gaps(code)]));
    expect(all.UK03.every(gap => gap === 0)).toBe(true); // Softening demand, fully covered.
    expect(all.UK01.slice(0, 3).every(gap => gap === 0)).toBe(true);
    // Leeds: a single 14:00–20:00 shift closes the Friday gap.
    expect(all.UK01[4]).toBeGreaterThan(3);
    expect(all.UK01[4]).toBeLessThanOrEqual(6);
    expect(all.UK02[5]).toBeGreaterThan(all.UK01[5] * 2); // Manchester's rota has fallen behind.
    expect(all.UK04.slice(0, 5).every(gap => gap === 0)).toBe(true);
    expect(all.UK04[6]).toBeGreaterThan(all.UK04[5]); // Thin Sunday cover at Brighton.
    expect(Math.max(...Object.values(all).flat())).toBeLessThanOrEqual(24);
    expect(new Set(Object.values(all).map(row => row.reduce((a, b) => a + b, 0))).size).toBe(5);
  });
});
