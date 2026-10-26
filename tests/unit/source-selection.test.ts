import { describe, expect, it } from "vitest";
import { shiftDate, type SalesSource } from "@/server/intelligence/forecast";
import type { DailySalesRow } from "@/server/intelligence/sales-history";
import { selectForecastSource } from "@/server/intelligence/weekly";

const TODAY = "2026-10-26";
const YESTERDAY = "2026-10-25";
const outletId = "20000000-0000-4000-8000-000000000009";
const row = (source: SalesSource, date: string, currency = "GBP", salesMinor = 500_000): DailySalesRow =>
  ({ outletId, source, currency, date, salesMinor, transactions: 40 });
const range = (source: SalesSource, through: string, count: number, currency = "GBP", keep: (date: string) => boolean = () => true) =>
  Array.from({ length: count }, (_, i) => shiftDate(through, -i)).filter(keep).map(date => row(source, date, currency));
const reference = range("REFERENCE", "2025-12-28", 120);
const notSunday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay() !== 0;

describe("forecast source eligibility", () => {
  it("uses reference history, keeping its own data-through date, for the real planning week", () => {
    expect(selectForecastSource(reference, TODAY)).toMatchObject({
      status: "SELECTED", source: "REFERENCE", currency: "GBP", kind: "HISTORICAL",
      dataThrough: "2025-12-28", firstTarget: "2026-10-27", rejected: [],
    });
    // The planning week follows the clock; the evidence is never re-dated.
    expect(selectForecastSource(reference, "2027-03-01")).toMatchObject({ dataThrough: "2025-12-28", firstTarget: "2027-03-02" });
  });

  it("never lets one provider day replace a complete reference history", () => {
    const selected = selectForecastSource([...reference, row("PAYPAL_SANDBOX", YESTERDAY)], TODAY);
    expect(selected).toMatchObject({ status: "SELECTED", source: "REFERENCE", rejected: [{ source: "PAYPAL_SANDBOX", reason: "INSUFFICIENT_DAYS" }] });
  });

  it("requires 28 distinct days: 27 are not enough", () => {
    expect(selectForecastSource([...reference, ...range("PAYPAL_SANDBOX", YESTERDAY, 27)], TODAY))
      .toMatchObject({ source: "REFERENCE", rejected: [{ reason: "INSUFFICIENT_DAYS", detail: "27 of 28 required days in the 56-day lookback." }] });
  });

  it("requires three observations of every weekday, even with 28 or more days", () => {
    const noSundays = range("PAYPAL_SANDBOX", YESTERDAY, 56, "GBP", notSunday).slice(0, 28);
    expect(noSundays).toHaveLength(28);
    expect(selectForecastSource([...reference, ...noSundays], TODAY))
      .toMatchObject({ source: "REFERENCE", rejected: [{ reason: "INCOMPLETE_WEEKDAYS" }] });
  });

  it("rejects sufficient provider history in another currency", () => {
    expect(selectForecastSource([...reference, ...range("PAYPAL_SANDBOX", YESTERDAY, 56, "USD")], TODAY))
      .toMatchObject({ source: "REFERENCE", rejected: [{ currency: "USD", reason: "CURRENCY_MISMATCH" }] });
  });

  it("rejects sufficient provider history that has gone stale", () => {
    expect(selectForecastSource([...reference, ...range("PAYPAL_SANDBOX", shiftDate(TODAY, -3), 53)], TODAY))
      .toMatchObject({ source: "REFERENCE", rejected: [{ reason: "STALE" }] });
    // The day before yesterday is still fresh.
    expect(selectForecastSource([...reference, ...range("PAYPAL_SANDBOX", shiftDate(TODAY, -2), 54)], TODAY))
      .toMatchObject({ source: "PAYPAL_SANDBOX" });
  });

  it("selects eligible provider history, through yesterday, planning from tomorrow, without mixing", () => {
    const selected = selectForecastSource([...reference, ...range("PAYPAL_SANDBOX", YESTERDAY, 28)], TODAY);
    expect(selected).toMatchObject({ status: "SELECTED", source: "PAYPAL_SANDBOX", currency: "GBP", kind: "PROVIDER",
      dataThrough: YESTERDAY, firstTarget: "2026-10-27", rejected: [] });
    if (selected.status !== "SELECTED") throw new Error("expected selection");
    expect(selected.days.every(day => day.date >= "2026-09-28")).toBe(true);
  });

  it("ignores today's incomplete trading and future-dated rows", () => {
    // 33 consecutive days ending a month ahead: only yesterday and the day before are evidence.
    const rows = [...reference, ...range("PAYPAL_SANDBOX", shiftDate(TODAY, 30), 33)];
    expect(selectForecastSource(rows, TODAY)).toMatchObject({ source: "REFERENCE", rejected: [{ reason: "INSUFFICIENT_DAYS", detail: "2 of 28 required days in the 56-day lookback." }] });
  });

  it("falls back to legacy demo history, then to no forecast at all", () => {
    expect(selectForecastSource(range("DEMO_SEEDED", "2026-10-14", 56, "USD"), TODAY))
      .toMatchObject({ source: "DEMO_SEEDED", currency: "USD", dataThrough: "2026-10-14", firstTarget: "2026-10-27" });
    expect(selectForecastSource([], TODAY)).toEqual({ status: "NONE", rejected: [] });
    expect(selectForecastSource([row("PAYPAL_SANDBOX", YESTERDAY)], TODAY)).toMatchObject({ status: "NONE", rejected: [{ reason: "INSUFFICIENT_DAYS" }] });
  });

  it("refuses to guess between histories in more than one currency", () => {
    const twoProviders = [...range("PAYPAL_SANDBOX", YESTERDAY, 56, "GBP"), ...range("PAYPAL_SANDBOX", YESTERDAY, 56, "USD")];
    expect(selectForecastSource(twoProviders, TODAY)).toMatchObject({ status: "NONE", rejected: [{ reason: "AMBIGUOUS" }, { reason: "AMBIGUOUS" }] });
    expect(selectForecastSource([...reference, ...range("REFERENCE", "2025-12-28", 10, "USD")], TODAY)).toMatchObject({ status: "NONE" });
  });

  it("is deterministic", () => {
    const rows = [...reference, ...range("PAYPAL_SANDBOX", YESTERDAY, 20)];
    expect(selectForecastSource(rows, TODAY)).toEqual(selectForecastSource([...rows].reverse(), TODAY));
  });
});
