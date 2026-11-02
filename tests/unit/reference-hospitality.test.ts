import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { shiftDate } from "@/server/intelligence/forecast";
import { coverageWindowsSchema, tradingWindowsSchema } from "@/server/intelligence/workload";
import { assertReferenceDate, REFERENCE_DATASET, REFERENCE_STORE_CODES, REFERENCE_STORES, referenceCoverage, referenceDates, referenceStore, referenceTradingDay, referenceTradingHours, referenceTransactions, UK_BANK_HOLIDAYS, type ReferenceStoreCode } from "@/server/reference/uk-hospitality";

const londonHour = (date: Date) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hourCycle: "h23", hour: "2-digit" }).format(date));
const londonDate = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(date);
const weekday = (date: string) => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
const WINDOW = referenceDates("2026-08-31", "2026-10-25"); // 56 days.
// Share of a venue's bills falling in each hour, on one kind of day.
function hourShare(code: ReferenceStoreCode, match: (i: number) => boolean) {
  const counts = new Map<number, number>();
  let total = 0;
  for (const date of WINDOW.filter(d => match(weekday(d)))) for (const bill of referenceTransactions(code, date)) { const hour = londonHour(bill.occurredAt); counts.set(hour, (counts.get(hour) ?? 0) + 1); total++; }
  return (from: number, to: number) => [...counts].filter(([hour]) => hour >= from && hour < to).reduce((sum, [, n]) => sum + n, 0) / total;
}
const billsPerDay = (code: ReferenceStoreCode, i: number) => { const days = WINDOW.filter(d => weekday(d) === i); return days.reduce((sum, d) => sum + referenceTransactions(code, d).length, 0) / days.length; };

describe("hospitality reference dataset", () => {
  it("is one versioned, GBP, five-venue fast-casual company with the five authorised profiles", () => {
    expect(REFERENCE_DATASET).toMatchObject({ version: "uk-hospitality-v1", currency: "GBP", timezone: "Europe/London" });
    expect(REFERENCE_STORE_CODES).toEqual(["UK01", "UK02", "UK03", "UK04", "UK05"]);
    expect(new Set(REFERENCE_STORES.map(store => store.profile))).toEqual(new Set(["A", "B", "C", "D", "E"]));
    expect(REFERENCE_STORES.map(store => store.profileName).sort()).toEqual(["Central business district", "Shopping centre", "Stadium district", "Station and commuter", "Waterfront and outdoor"]);
  });
  it("is deterministic and reproducible", () => {
    for (const code of REFERENCE_STORE_CODES) for (const date of ["2025-11-03", "2026-07-11", "2026-10-30"]) {
      const first = referenceTransactions(code, date);
      expect(referenceTransactions(code, date)).toEqual(first);
      expect(first.length).toBeGreaterThan(0);
      expect(first.map(bill => bill.sequence)).toEqual(first.map((_, i) => i + 1));
      expect(first.every(bill => Number.isInteger(bill.amountMinor) && bill.amountMinor > 0)).toBe(true);
    }
    expect(referenceTransactions("UK01", "2026-10-30")).not.toEqual(referenceTransactions("UK02", "2026-10-30"));
  });
  it("keeps every bill inside local trading hours and on its London date, across clock changes", () => {
    for (const date of ["2026-01-15", "2026-03-29", "2026-07-15", "2026-10-25"]) for (const code of REFERENCE_STORE_CODES) {
      const day = referenceTradingDay(code, date);
      if (!day.open) throw new Error("expected trading day");
      for (const bill of referenceTransactions(code, date)) {
        expect(londonDate(bill.occurredAt)).toBe(date);
        expect(londonHour(bill.occurredAt)).toBeGreaterThanOrEqual(day.openHour);
        expect(londonHour(bill.occurredAt)).toBeLessThan(day.closeHour);
      }
    }
  });
  it("gives venues different trading hours and cover, all valid configuration", () => {
    const hours = REFERENCE_STORE_CODES.map(code => referenceTradingHours(code));
    for (const week of hours) { expect(week).toHaveLength(7); for (const day of week) expect(tradingWindowsSchema.safeParse(day).success).toBe(true); }
    expect(new Set(hours.map(week => JSON.stringify(week))).size).toBe(5);
    const cover = REFERENCE_STORE_CODES.map(code => referenceCoverage(code));
    for (const week of cover) { expect(week).toHaveLength(7); for (const day of week) expect(coverageWindowsSchema.safeParse(day).success).toBe(true); }
    expect(new Set(cover.map(week => JSON.stringify(week))).size).toBe(5);
  });
  it("gives the five venues demonstrably different time profiles", () => {
    const weekdays = (i: number) => i < 5, saturdays = (i: number) => i === 5;
    const lunch = Object.fromEntries(REFERENCE_STORE_CODES.map(code => [code, hourShare(code, weekdays)]));
    // Stadium: evening-led. CBD: breakfast and lunch. Station: two commuter peaks.
    expect(lunch.UK02(17, 22)).toBeGreaterThan(0.55);
    expect(lunch.UK01(7, 15)).toBeGreaterThan(0.8);
    expect(lunch.UK01(17, 24)).toBe(0);
    expect(lunch.UK05(7, 9) + lunch.UK05(17, 19)).toBeGreaterThan(0.5);
    expect(lunch.UK05(10, 12)).toBeLessThan(0.1);
    // Waterfront and shopping centre: lunch-to-afternoon, unlike the stadium's evening.
    expect(lunch.UK03(12, 16)).toBeGreaterThan(lunch.UK02(12, 16));
    // Weekend shape: Waterfront peaks at the weekend, CBD falls away, Shopping centre lifts.
    expect(billsPerDay("UK04", 5) / billsPerDay("UK04", 0)).toBeGreaterThan(2);
    expect(billsPerDay("UK03", 5) / billsPerDay("UK03", 0)).toBeGreaterThan(1.6);
    expect(billsPerDay("UK01", 5) / billsPerDay("UK01", 0)).toBeLessThan(0.65);
    expect(billsPerDay("UK02", 5) / billsPerDay("UK02", 0)).toBeGreaterThan(1.6);
    // Saturday hours differ too.
    expect(hourShare("UK04", saturdays)(8, 11)).toBeGreaterThan(0.1);
    // No two venues share an hourly profile.
    const profile = (code: ReferenceStoreCode) => { const share = hourShare(code, weekdays); return Array.from({ length: 24 }, (_, h) => share(h, h + 1)); };
    const all = REFERENCE_STORE_CODES.map(profile);
    for (let a = 0; a < 5; a++) for (let b = a + 1; b < 5; b++) expect(Math.max(...all[a].map((value, i) => Math.abs(value - all[b][i])))).toBeGreaterThan(0.05);
  });
  it("varies value and volume separately: bill size differs by venue and by hour", () => {
    const mean = (code: ReferenceStoreCode, date: string) => { const bills = referenceTransactions(code, date); return bills.reduce((sum, bill) => sum + bill.amountMinor, 0) / bills.length; };
    expect(mean("UK02", "2026-10-30")).toBeGreaterThan(mean("UK05", "2026-10-30") * 1.8);
    expect(billsPerDay("UK05", 1)).toBeGreaterThan(billsPerDay("UK02", 1) * 1.8);
    const bills = referenceTransactions("UK05", "2026-10-27");
    const at = (from: number, to: number) => { const rows = bills.filter(b => londonHour(b.occurredAt) >= from && londonHour(b.occurredAt) < to); return rows.reduce((sum, b) => sum + b.amountMinor, 0) / rows.length; };
    expect(at(17, 20)).toBeGreaterThan(at(6, 9) * 1.3);
  });
  it("contains no fake event, weather or booking signal", async () => {
    const source = await readFile("src/server/reference/uk-hospitality.ts", "utf8");
    const code = source.split("\n").filter(line => !line.trim().startsWith("//")).join("\n");
    expect(code).not.toMatch(/\b(rain|sunny|temperature|concert|match|fixture|kick.?off|booking|reservation|private party|covers?:|guests?|tables?|menu|tip)\b/i);
    for (const code of REFERENCE_STORE_CODES) {
      const day = referenceTradingDay(code, "2026-10-30");
      expect(Object.keys(day).sort()).toEqual(["bankHoliday", "closeHour", "date", "open", "openHour", "transactions"]);
      expect(Object.keys(referenceTransactions(code, "2026-10-30")[0]).sort()).toEqual(["amountMinor", "occurredAt", "sequence"]);
    }
    // Calendar facts only: a bank holiday is the one labelled day type.
    expect(new Set(Object.values(UK_BANK_HOLIDAYS).map(name => name.split(" ")[0]))).toEqual(new Set(["Christmas", "Boxing", "New", "Good", "Easter", "Early", "Spring", "Summer"]));
    // No outlier spike is planted: an ordinary week's days stay within the venue's own range.
    for (const code of REFERENCE_STORE_CODES) {
      const counts = referenceDates("2026-09-07", "2026-10-25").filter(d => weekday(d) === 5).map(d => referenceTransactions(code, d).length);
      expect(Math.max(...counts) / Math.min(...counts)).toBeLessThan(1.9);
    }
  });
  it("closes only on the stated group closures, with no bills then, and rejects dates outside its calendar", () => {
    const closed = REFERENCE_STORE_CODES.flatMap(code => referenceDates("2025-11-03", "2026-12-31").filter(date => !referenceTradingDay(code, date).open));
    expect(new Set(closed)).toEqual(new Set(["2025-12-25", "2026-12-25"]));
    for (const code of REFERENCE_STORE_CODES) expect(referenceTransactions(code, "2025-12-25")).toEqual([]);
    expect(() => assertReferenceDate("2025-11-02")).toThrow("Reference history covers");
    expect(() => assertReferenceDate("2027-02-01")).toThrow("Reference history covers");
    expect(() => assertReferenceDate("2026-02-30")).toThrow();
    expect(() => referenceDates("2026-10-02", "2026-10-01")).toThrow("must not follow");
  });
  it("has enough completed history for the forecast rules: three of every weekday in 56 days", () => {
    for (const code of REFERENCE_STORE_CODES) {
      const window = referenceDates(shiftDate("2026-11-01", -55), "2026-11-01").filter(date => referenceTradingDay(code, date).open);
      expect(window.length).toBeGreaterThanOrEqual(28);
      for (let i = 0; i < 7; i++) expect(window.filter(date => weekday(date) === i).length).toBeGreaterThanOrEqual(3);
      expect(referenceStore(code).baseDailyBills).toBeGreaterThan(0);
    }
  });
});
