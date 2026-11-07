import { describe, expect, it } from "vitest";

import {
  blockForMinute, blockInterval, directShares, equalShares, localParts, overlaps, parseBlocksText, parseTipCsv, TIP_CSV_HEADER, TipValidationError, validateBlocks,
} from "@/server/tips/policy";

// FS-TIP-DEC-002 deterministic rules. Synthetic demo values only.
const TZ = "Africa/Johannesburg";
const LOCATION = { locationId: "fd6526f5-24e4-4b10-b223-c16897d0942f", locationName: "Sandton", currency: "ZAR" };
const csv = (...rows: string[]) => [TIP_CSV_HEADER.join(","), ...rows].join("\n");
const row = (ref: string, at: string, staff = "", tip = "20.00", bill = "200.00", extra: Partial<{ location: string; currency: string; source: string }> = {}) =>
  [extra.source ?? "Demo POS export", extra.location ?? "Sandton", ref, at, staff, bill, tip, extra.currency ?? "ZAR"].join(",");

describe("shift blocks", () => {
  it("parses the demo blocks and orders them", () => {
    expect(parseBlocksText("Evening 17:00-23:00, Morning 07:00-12:00, Afternoon 12:00-17:00")).toEqual([
      { name: "Morning", startMinute: 420, endMinute: 720 }, { name: "Afternoon", startMinute: 720, endMinute: 1020 }, { name: "Evening", startMinute: 1020, endMinute: 1380 },
    ]);
  });
  it("refuses overlapping, reversed, duplicate or malformed blocks", () => {
    expect(() => parseBlocksText("Morning 07:00-12:30, Afternoon 12:00-17:00")).toThrow(/overlap/);
    expect(() => parseBlocksText("Late 23:00-02:00")).toThrow(/start before it ends/);
    expect(() => parseBlocksText("Morning 07:00-12:00, morning 13:00-14:00")).toThrow(/different/);
    expect(() => parseBlocksText("Morning 7am-noon")).toThrow(TipValidationError);
    expect(() => validateBlocks([])).toThrow(/between one and eight/);
  });
  it("assigns a time to the block whose [start, end) contains it, boundaries included", () => {
    const blocks = parseBlocksText("Morning 07:00-12:00, Afternoon 12:00-17:00, Evening 17:00-23:00");
    expect(blockForMinute(7 * 60, blocks)?.name).toBe("Morning");
    expect(blockForMinute(12 * 60 - 1, blocks)?.name).toBe("Morning");
    expect(blockForMinute(12 * 60, blocks)?.name).toBe("Afternoon");
    expect(blockForMinute(17 * 60, blocks)?.name).toBe("Evening");
    expect(blockForMinute(23 * 60, blocks)).toBeNull();
    expect(blockForMinute(6 * 60 + 59, blocks)).toBeNull();
  });
  it("reads transaction times in the location's own time zone", () => {
    // 09:59:59Z is 11:59 in Johannesburg (UTC+2): Morning. 10:00Z is 12:00: Afternoon.
    expect(localParts(new Date("2026-11-06T09:59:59Z"), TZ)).toEqual({ date: "2026-11-06", isoWeekday: 5, minute: 719 });
    expect(localParts(new Date("2026-11-06T10:00:00Z"), TZ).minute).toBe(720);
    expect(localParts(new Date("2026-11-06T22:30:00Z"), TZ)).toMatchObject({ date: "2026-11-07", isoWeekday: 6 });
  });
  it("defines casual membership as a positive overlap with the block interval", () => {
    const afternoon = blockInterval({ name: "Afternoon", startMinute: 720, endMinute: 1020 }, "2026-11-06", TZ);
    expect(afternoon).toEqual({ start: new Date("2026-11-06T10:00:00Z"), end: new Date("2026-11-06T15:00:00Z") });
    expect(overlaps({ start: new Date("2026-11-06T08:00:00Z"), end: new Date("2026-11-06T10:15:00Z") }, afternoon)).toBe(true);
    // A shift ending exactly as the block starts is not in it.
    expect(overlaps({ start: new Date("2026-11-06T06:00:00Z"), end: new Date("2026-11-06T10:00:00Z") }, afternoon)).toBe(false);
  });
});

describe("imported POS tip evidence", () => {
  it("accepts valid rows and converts rand amounts to cents", () => {
    const parsed = parseTipCsv(csv(row("T-1", "2026-11-06T09:15:00+02:00", "FS-ABC", "24.50", "245.00"), row("T-2", "2026-11-06T13:00:00+02:00")), LOCATION);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({ rowRef: "T-1", staffRef: "FS-ABC", tipMinor: 2_450, billMinor: 24_500, currency: "ZAR" });
    expect(parsed.rows[1].staffRef).toBeNull();
    expect(parsed.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("rejects the whole file for bad amounts, currency, timestamps, header or another location", () => {
    const bad = (line: string) => () => parseTipCsv(csv(row("T-1", "2026-11-06T09:15:00+02:00"), line), LOCATION);
    expect(bad(row("T-2", "2026-11-06T09:15:00+02:00", "", "-5.00"))).toThrow(/tip_amount/);
    expect(bad(row("T-2", "2026-11-06T09:15:00+02:00", "", "5.555"))).toThrow(/tip_amount/);
    expect(bad(row("T-2", "2026-11-06T09:15:00+02:00", "", "0.00"))).toThrow(/more than zero/);
    expect(bad(row("T-2", "2026-11-06T09:15:00+02:00", "", "5.00", "abc"))).toThrow(/bill_amount/);
    expect(bad(row("T-2", "2026-11-06T09:15:00+02:00", "", "5.00", "50.00", { currency: "USD" }))).toThrow(/currency must be ZAR/);
    expect(bad(row("T-2", "2026-11-06 09:15", ""))).toThrow(/transaction_at/);
    expect(bad(row("T-2", "2026-11-06T09:15:00+02:00", "", "5.00", "50.00", { location: "Rosebank" }))).toThrow(/another location/);
    expect(() => parseTipCsv("source,location\nx,y", LOCATION)).toThrow(/first line/);
  });
  it("drops exact duplicate rows and refuses a reused reference with different values", () => {
    const once = row("T-1", "2026-11-06T09:15:00+02:00", "", "10.00");
    expect(parseTipCsv(csv(once, once), LOCATION)).toMatchObject({ duplicatesSkipped: 1, rows: [expect.objectContaining({ rowRef: "T-1" })] });
    expect(() => parseTipCsv(csv(once, row("T-1", "2026-11-06T09:15:00+02:00", "", "11.00")), LOCATION)).toThrow(/appears twice/);
  });
});

describe("deterministic splits", () => {
  it("DIRECT gives each row's tip to its staff member, to the cent, and keeps unattributed tips unallocated", () => {
    expect(directShares([{ workerId: "b", tipMinor: 1_001 }, { workerId: "a", tipMinor: 250 }, { workerId: "b", tipMinor: 99 }, { workerId: null, tipMinor: 777 }]))
      .toEqual({ shares: [{ workerId: "a", amountMinor: 250 }, { workerId: "b", amountMinor: 1_100 }], unallocatedMinor: 777 });
  });
  it("SHIFT_POOL splits equally in cents, the remainder going in ascending staff-ID order", () => {
    // R100.01 among three: 33.34, 33.34, 33.33 to the lowest IDs first.
    expect(equalShares(10_001, ["c", "a", "b"])).toEqual([{ workerId: "a", amountMinor: 3_334 }, { workerId: "b", amountMinor: 3_334 }, { workerId: "c", amountMinor: 3_333 }]);
    for (const total of [0, 1, 2, 999, 10_000, 123_457]) {
      for (const size of [1, 2, 3, 7]) {
        const shares = equalShares(total, Array.from({ length: size }, (_, i) => `w${i}`));
        expect(shares.reduce((sum, share) => sum + share.amountMinor, 0)).toBe(total);
        expect(Math.max(...shares.map(s => s.amountMinor)) - Math.min(...shares.map(s => s.amountMinor))).toBeLessThanOrEqual(1);
      }
    }
    expect(equalShares(500, [])).toEqual([]);
    expect(equalShares(500, ["a", "a"])).toEqual([{ workerId: "a", amountMinor: 500 }]);
  });
});
