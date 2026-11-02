import { createHash } from "node:crypto";
import { shiftDate } from "@/server/intelligence/forecast";
import type { CoverageWindow, TradingWindow } from "@/server/intelligence/workload";

// Fictional five-location UK fast-casual café and dining group: the current reference company
// used to develop, test and demonstrate FairShift. Codes and cities are anchors, not real
// premises. Everything here is labelled synthetic REFERENCE input with documented, hand-set
// characteristics. Application logic derives its outputs from the resulting rows like any
// source; FairShift learns nothing causal from them.
//
// Deliberately absent: events, weather, bookings, covers, tables and menu items. A
// transaction is one bill, the MVP proxy for workload.
export const REFERENCE_DATASET = {
  version: "uk-hospitality-v1",
  label: "UK reference fast-casual café and dining group",
  currency: "GBP",
  timezone: "Europe/London",
  // 65 complete Monday–Sunday weeks. Dates still ahead of the clock are never loaded.
  firstDate: "2025-11-03",
  lastDate: "2027-01-31",
} as const;

// This fictional company's own operating assumptions, decided by the Owner on 2 Nov 2026
// (docs/HOSPITALITY_POLICY_FREEZE_EVIDENCE.md). Sustainable busy-service transactions per
// operational staff-hour, and the fewest operational staff while open. Not an industry
// standard, not a legal requirement, and not learned from data.
export const REFERENCE_WORKLOAD_POLICY = { transactionsPerStaffHour: 7, minimumStaffWhileOpen: 2 } as const;

export const REFERENCE_STORE_CODES = ["UK01", "UK02", "UK03", "UK04", "UK05"] as const;
export type ReferenceStoreCode = typeof REFERENCE_STORE_CODES[number];

type HourCurve = Readonly<Record<number, number>>;
type DayShape = { open: number; close: number; curve: HourCurve };
type Schedule = { weekday: DayShape; friday?: DayShape; saturday: DayShape; sunday: DayShape };
type CoverageDay = readonly (readonly [number, number, number])[]; // Start hour, end hour, headcount
export type ReferenceVenue = {
  code: ReferenceStoreCode; city: string; profile: "A" | "B" | "C" | "D" | "E"; profileName: string; design: string;
  baseDailyBills: number; meanBillMinor: number;
  // Relative bill size by hour band: breakfast and commuter bills are smaller than dinner ones.
  billByHour: (hour: number) => number;
  dayFactor: readonly [number, number, number, number, number, number, number]; // Mon..Sun
  season: readonly number[]; // Jan..Dec
  holidayFactor: number;
  volatility: number;
  schedule: Schedule;
  // Hand-set standing cover, not derived from demand or from any capacity figure.
  coverage: { weekday: CoverageDay; friday?: CoverageDay; saturday: CoverageDay; sunday: CoverageDay };
};

const evening = (hour: number) => hour >= 17 ? 1.3 : hour >= 11 ? 1 : 0.7;

export const REFERENCE_STORES: readonly ReferenceVenue[] = [
  { code: "UK01", city: "Leeds", profile: "C", profileName: "Central business district", design: "Office trade: strong weekday breakfast and lunch, quiet weekends.",
    baseDailyBills: 130, meanBillMinor: 1_050, billByHour: hour => hour < 11 ? 0.65 : 1.1,
    dayFactor: [1.1, 1.15, 1.15, 1.15, 1.05, 0.55, 0.35], season: [0.98, 0.98, 1, 1, 1, 0.98, 0.92, 0.9, 1, 1.02, 1.02, 0.95], holidayFactor: 0.45, volatility: 0.06,
    schedule: {
      weekday: { open: 7, close: 17, curve: { 7: 0.9, 8: 1.5, 9: 1.1, 10: 0.6, 11: 0.9, 12: 2.1, 13: 2, 14: 0.8, 15: 0.4, 16: 0.3 } },
      saturday: { open: 9, close: 16, curve: { 9: 0.7, 10: 1, 11: 1.2, 12: 1.5, 13: 1.4, 14: 0.9, 15: 0.5 } },
      sunday: { open: 10, close: 15, curve: { 10: 0.8, 11: 1.1, 12: 1.4, 13: 1.2, 14: 0.6 } },
    },
    coverage: { weekday: [[7, 11, 2], [11, 15, 3], [15, 17, 2]], saturday: [[9, 16, 2]], sunday: [[10, 15, 2]] } },
  { code: "UK02", city: "Manchester", profile: "A", profileName: "Stadium district", design: "Evening-led with strong Friday and Saturday trade. Later context package may apply nearby events; none are generated here.",
    baseDailyBills: 110, meanBillMinor: 2_100, billByHour: evening,
    dayFactor: [0.72, 0.75, 0.85, 0.95, 1.3, 1.55, 0.9], season: [0.95, 0.95, 0.98, 1, 1, 1.02, 0.98, 0.98, 1.02, 1.02, 1, 1.1], holidayFactor: 1.1, volatility: 0.09,
    schedule: {
      weekday: { open: 11, close: 22, curve: { 11: 0.4, 12: 0.8, 13: 0.7, 14: 0.4, 15: 0.3, 16: 0.5, 17: 1.1, 18: 1.8, 19: 2, 20: 1.5, 21: 0.7 } },
      friday: { open: 11, close: 23, curve: { 11: 0.4, 12: 0.8, 13: 0.7, 14: 0.4, 15: 0.4, 16: 0.7, 17: 1.4, 18: 2, 19: 2.2, 20: 1.9, 21: 1.3, 22: 0.6 } },
      saturday: { open: 11, close: 23, curve: { 11: 0.5, 12: 0.9, 13: 1, 14: 0.8, 15: 0.7, 16: 0.9, 17: 1.4, 18: 2, 19: 2.2, 20: 1.9, 21: 1.3, 22: 0.6 } },
      sunday: { open: 11, close: 21, curve: { 11: 0.5, 12: 1.2, 13: 1.5, 14: 1.3, 15: 0.8, 16: 0.7, 17: 1, 18: 1.1, 19: 0.8, 20: 0.4 } },
    },
    coverage: { weekday: [[11, 17, 2], [17, 22, 3]], friday: [[11, 17, 2], [17, 23, 4]], saturday: [[11, 17, 3], [17, 23, 4]], sunday: [[11, 21, 3]] } },
  { code: "UK03", city: "Birmingham", profile: "E", profileName: "Shopping centre", design: "Follows centre footfall: stronger weekends and bank holidays, with a long afternoon.",
    baseDailyBills: 140, meanBillMinor: 1_350, billByHour: hour => hour >= 17 ? 1.15 : 1,
    dayFactor: [0.8, 0.8, 0.85, 0.95, 1.1, 1.6, 1.15], season: [0.92, 0.9, 0.95, 0.98, 0.98, 0.98, 1.02, 1.02, 0.95, 1, 1.12, 1.3], holidayFactor: 1.35, volatility: 0.07,
    schedule: {
      weekday: { open: 9, close: 20, curve: { 9: 0.4, 10: 0.7, 11: 1, 12: 1.6, 13: 1.6, 14: 1.3, 15: 1.1, 16: 1, 17: 0.9, 18: 0.7, 19: 0.4 } },
      saturday: { open: 9, close: 20, curve: { 9: 0.5, 10: 0.9, 11: 1.3, 12: 1.7, 13: 1.8, 14: 1.6, 15: 1.4, 16: 1.1, 17: 0.9, 18: 0.6, 19: 0.3 } },
      sunday: { open: 11, close: 17, curve: { 11: 1, 12: 1.5, 13: 1.6, 14: 1.3, 15: 1, 16: 0.6 } },
    },
    coverage: { weekday: [[9, 12, 2], [12, 16, 3], [16, 20, 2]], saturday: [[9, 12, 3], [12, 17, 5], [17, 20, 3]], sunday: [[11, 17, 3]] } },
  { code: "UK04", city: "Brighton", profile: "B", profileName: "Waterfront and outdoor", design: "Weekend-led with a warm-month season. Later context package may apply weather; none is generated here.",
    baseDailyBills: 100, meanBillMinor: 1_700, billByHour: hour => hour >= 17 ? 1.25 : hour < 11 ? 0.75 : 1,
    dayFactor: [0.68, 0.68, 0.72, 0.82, 1.08, 1.8, 1.65], season: [0.72, 0.74, 0.82, 0.95, 1.08, 1.22, 1.38, 1.4, 1.12, 0.92, 0.76, 0.8], holidayFactor: 1.4, volatility: 0.12,
    schedule: {
      weekday: { open: 9, close: 21, curve: { 9: 0.5, 10: 0.7, 11: 0.9, 12: 1.4, 13: 1.4, 14: 1.1, 15: 0.9, 16: 0.8, 17: 0.9, 18: 1.2, 19: 1.1, 20: 0.5 } },
      saturday: { open: 8, close: 22, curve: { 8: 0.5, 9: 0.9, 10: 1.2, 11: 1.4, 12: 1.7, 13: 1.8, 14: 1.6, 15: 1.4, 16: 1.2, 17: 1.1, 18: 1.3, 19: 1.3, 20: 0.9, 21: 0.4 } },
      sunday: { open: 8, close: 21, curve: { 8: 0.5, 9: 1, 10: 1.4, 11: 1.6, 12: 1.8, 13: 1.8, 14: 1.5, 15: 1.2, 16: 1, 17: 0.8, 18: 0.7, 19: 0.5, 20: 0.3 } },
    },
    coverage: { weekday: [[9, 15, 2], [15, 21, 2]], saturday: [[8, 14, 3], [14, 22, 3]], sunday: [[8, 15, 3], [15, 21, 2]] } },
  { code: "UK05", city: "London Stratford", profile: "D", profileName: "Station and commuter", design: "Sharp commuter peaks morning and early evening, low bills, high counts on weekdays.",
    baseDailyBills: 220, meanBillMinor: 750, billByHour: hour => hour < 10 ? 0.7 : hour >= 16 ? 1.2 : 1,
    dayFactor: [1.08, 1.12, 1.12, 1.1, 1.05, 0.78, 0.65], season: [0.98, 0.98, 1, 1, 1, 0.98, 0.94, 0.92, 1, 1.02, 1.02, 0.96], holidayFactor: 0.6, volatility: 0.07,
    schedule: {
      weekday: { open: 6, close: 20, curve: { 6: 1.3, 7: 2.6, 8: 2.9, 9: 1.3, 10: 0.5, 11: 0.5, 12: 0.8, 13: 0.7, 14: 0.4, 15: 0.5, 16: 1.1, 17: 2.2, 18: 2, 19: 0.8 } },
      saturday: { open: 7, close: 20, curve: { 7: 0.5, 8: 0.8, 9: 1.1, 10: 1.3, 11: 1.3, 12: 1.4, 13: 1.3, 14: 1.1, 15: 1, 16: 1, 17: 1, 18: 0.8, 19: 0.5 } },
      sunday: { open: 8, close: 19, curve: { 8: 0.6, 9: 0.9, 10: 1.2, 11: 1.3, 12: 1.3, 13: 1.2, 14: 1, 15: 0.9, 16: 0.8, 17: 0.7, 18: 0.4 } },
    },
    coverage: { weekday: [[6, 10, 4], [10, 16, 2], [16, 20, 3]], saturday: [[7, 20, 3]], sunday: [[8, 19, 2]] } },
];

// Factual England & Wales bank holidays inside the dataset's calendar.
export const UK_BANK_HOLIDAYS: Readonly<Record<string, string>> = {
  "2025-12-25": "Christmas Day", "2025-12-26": "Boxing Day",
  "2026-01-01": "New Year’s Day", "2026-04-03": "Good Friday", "2026-04-06": "Easter Monday",
  "2026-05-04": "Early May bank holiday", "2026-05-25": "Spring bank holiday", "2026-08-31": "Summer bank holiday",
  "2026-12-25": "Christmas Day", "2026-12-28": "Boxing Day (substitute day)", "2027-01-01": "New Year’s Day",
};
// A stated assumption of this fictional group: every venue closes on Christmas Day.
const GROUP_CLOSURES: Readonly<Record<string, string>> = { "2025-12-25": "Christmas Day", "2026-12-25": "Christmas Day" };

export type ReferenceTradingDay = { date: string; open: false; closure: string } | { date: string; open: true; openHour: number; closeHour: number; transactions: number; bankHoliday: string | null };

const weekdayIndex = (date: string) => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7; // Mon=0
const dayNumber = (date: string) => Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${REFERENCE_DATASET.firstDate}T12:00:00Z`)) / 86_400_000);

export function referenceStore(code: ReferenceStoreCode) {
  const store = REFERENCE_STORES.find(row => row.code === code);
  if (!store) throw new Error(`Unknown reference store ${code}.`);
  return store;
}

export function assertReferenceDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || shiftDate(date, 0) !== date) throw new Error(`Invalid date ${date}.`);
  if (date < REFERENCE_DATASET.firstDate || date > REFERENCE_DATASET.lastDate) {
    throw new Error(`Reference history covers ${REFERENCE_DATASET.firstDate} to ${REFERENCE_DATASET.lastDate}.`);
  }
}

// Deterministic per-venue, per-day pseudo-random stream (mulberry32).
function random(...parts: string[]) {
  let state = createHash("sha256").update([REFERENCE_DATASET.version, ...parts].join(":")).digest().readUInt32BE(0);
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const normal = () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
  return { next, normal };
}

function dayShape(store: ReferenceVenue, weekday: number): DayShape {
  if (weekday === 6) return store.schedule.sunday;
  if (weekday === 5) return store.schedule.saturday;
  return weekday === 4 && store.schedule.friday ? store.schedule.friday : store.schedule.weekday;
}

// Monthly season values apply at mid-month and blend between, so no month starts with a jump.
function seasonFactor(store: ReferenceVenue, date: string) {
  const [year, month, day] = date.split("-").map(Number);
  const at = Date.UTC(year, month - 1, day);
  const [fromYear, fromMonth] = at < Date.UTC(year, month - 1, 15) ? [year, month - 2] : [year, month - 1];
  const from = new Date(Date.UTC(fromYear, fromMonth, 15)), to = new Date(Date.UTC(fromYear, fromMonth + 1, 15));
  const progress = (at - from.getTime()) / (to.getTime() - from.getTime());
  return store.season[from.getUTCMonth()] * (1 - progress) + store.season[to.getUTCMonth()] * progress;
}

// Bank holidays trade on the venue's Sunday hours and its own holiday shape.
export function referenceTradingDay(code: ReferenceStoreCode, date: string): ReferenceTradingDay {
  assertReferenceDate(date);
  if (GROUP_CLOSURES[date]) return { date, open: false, closure: GROUP_CLOSURES[date] };
  const store = referenceStore(code);
  const bankHoliday = UK_BANK_HOLIDAYS[date] ?? null;
  const weekday = weekdayIndex(date);
  const rng = random(code, date, "day");
  const growth = 1 + 0.02 * dayNumber(date) / 450;
  const noise = Math.exp(store.volatility * rng.normal() - store.volatility ** 2 / 2);
  const dayFactor = bankHoliday ? store.holidayFactor : store.dayFactor[weekday];
  const shape = bankHoliday ? store.schedule.sunday : dayShape(store, weekday);
  return { date, open: true, openHour: shape.open, closeHour: shape.close, transactions: Math.max(1, Math.round(store.baseDailyBills * dayFactor * seasonFactor(store, date) * growth * noise)), bankHoliday };
}

// UTC offset (ms) of Europe/London at local noon on a date. Trading hours lie well away
// from the 01:00 UTC daylight-saving transitions, so one offset covers the day.
function londonOffset(date: string) {
  const noon = Date.parse(`${date}T12:00:00Z`);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: REFERENCE_DATASET.timezone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(new Date(noon)).map(part => [part.type, part.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute)) - noon;
}

// UTC instant of a Europe/London wall-clock time, given seconds after local midnight.
export function londonInstant(date: string, seconds: number, offset = londonOffset(date)) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + seconds * 1000 - offset);
}

export type ReferenceTransaction = { sequence: number; occurredAt: Date; amountMinor: number };

// Bill-level records for one venue-day. Bills fall across the venue's hours by its own
// curve and vary in size by hour, so sales value and bill count don't move in lockstep.
export function referenceTransactions(code: ReferenceStoreCode, date: string): ReferenceTransaction[] {
  const day = referenceTradingDay(code, date);
  if (!day.open) return [];
  const store = referenceStore(code);
  const shape = day.bankHoliday ? store.schedule.sunday : dayShape(store, weekdayIndex(date));
  const rng = random(code, date, "bills");
  const hours = Array.from({ length: shape.close - shape.open }, (_, i) => shape.open + i);
  const weights = hours.map(hour => shape.curve[hour] ?? 0);
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const bills = Array.from({ length: day.transactions }, () => {
    let pick = rng.next() * totalWeight, index = 0;
    while (pick > weights[index] && index < hours.length - 1) pick -= weights[index++];
    const hour = hours[index];
    const seconds = hour * 3600 + Math.floor(rng.next() * 3600);
    const amount = store.meanBillMinor * store.billByHour(hour) * Math.exp(0.42 * rng.normal() - 0.42 ** 2 / 2);
    return { seconds, amountMinor: Math.max(150, Math.round(amount / 5) * 5) };
  }).sort((a, b) => a.seconds - b.seconds);
  const offset = londonOffset(date);
  return bills.map((bill, i) => ({ sequence: i + 1, occurredAt: londonInstant(date, bill.seconds, offset), amountMinor: bill.amountMinor }));
}

export function referenceDates(from: string = REFERENCE_DATASET.firstDate, through: string = REFERENCE_DATASET.lastDate) {
  assertReferenceDate(from);
  assertReferenceDate(through);
  if (from > through) throw new Error("Reference history start must not follow its end.");
  const dates: string[] = [];
  for (let date = from; date <= through; date = shiftDate(date, 1)) dates.push(date);
  return dates;
}

const toTrading = (shape: DayShape): TradingWindow[] => [{ start: shape.open * 60, end: shape.close * 60 }];
const toCoverage = (day: CoverageDay): CoverageWindow[] => day.map(([start, end, headcount]) => ({ start: start * 60, end: end * 60, headcount }));

// A venue's stated trading hours and standing cover, Monday first: reference configuration.
export function referenceTradingHours(code: ReferenceStoreCode): TradingWindow[][] {
  const store = referenceStore(code);
  return Array.from({ length: 7 }, (_, i) => toTrading(dayShape(store, i)));
}
export function referenceCoverage(code: ReferenceStoreCode): CoverageWindow[][] {
  const { coverage } = referenceStore(code);
  return Array.from({ length: 7 }, (_, i) => toCoverage(i === 6 ? coverage.sunday : i === 5 ? coverage.saturday : i === 4 && coverage.friday ? coverage.friday : coverage.weekday));
}
