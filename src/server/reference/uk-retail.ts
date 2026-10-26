import { createHash } from "node:crypto";
import { shiftDate } from "@/server/intelligence/forecast";

// Fictional five-store UK specialty retailer used to develop, test and demonstrate
// FairShift. Store codes and cities are environmental anchors, not real premises.
// Every value produced here is labelled synthetic REFERENCE input; application
// logic (forecasting, staffing) derives its outputs from these rows like any source.
export const REFERENCE_DATASET = {
  version: "uk-specialty-retail-v1",
  label: "UK reference retailer",
  currency: "GBP",
  timezone: "Europe/London",
  // 104 complete Monday–Sunday weeks.
  firstDate: "2024-01-01",
  lastDate: "2025-12-28",
  // Final 12 weeks reserved for out-of-sample forecast evaluation.
  holdoutStart: "2025-10-06",
} as const;

export const REFERENCE_STORE_CODES = ["UK01", "UK02", "UK03", "UK04", "UK05"] as const;
export type ReferenceStoreCode = typeof REFERENCE_STORE_CODES[number];

type ReferenceStore = {
  code: ReferenceStoreCode;
  city: string;
  context: string;
  baseDailyMinor: number;
  meanBasketMinor: number;
  weekday: readonly [number, number, number, number, number, number, number]; // Mon..Sun
  season: readonly number[]; // Jan..Dec, multiplies the shared retail season
  bankHoliday: number;
  // Standing regular-staff rota, planned labour hours Mon..Sun. Hand-set staffing
  // input (larger weekday teams, thinner weekend cover); staffing gaps are derived.
  regularCoverageHours: readonly [number, number, number, number, number, number, number];
};

export const REFERENCE_STORES: readonly ReferenceStore[] = [
  { code: "UK01", city: "Leeds", context: "Central retail (Briggate)", baseDailyMinor: 820_000, meanBasketMinor: 11_500,
    weekday: [0.83, 0.84, 0.89, 0.97, 1.12, 1.46, 0.90], season: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], bankHoliday: 1.0,
    regularCoverageHours: [104, 104, 104, 112, 136, 144, 72] },
  { code: "UK02", city: "Manchester", context: "City-centre retail", baseDailyMinor: 940_000, meanBasketMinor: 12_000,
    weekday: [0.84, 0.85, 0.90, 0.99, 1.15, 1.45, 0.88], season: [1, 1, 1, 1, 1, 1, 1, 1, 1.04, 1, 1, 1], bankHoliday: 1.0,
    regularCoverageHours: [128, 120, 120, 128, 168, 200, 120] },
  { code: "UK03", city: "Birmingham", context: "City-centre retail", baseDailyMinor: 860_000, meanBasketMinor: 11_200,
    weekday: [0.83, 0.84, 0.89, 0.97, 1.12, 1.48, 0.90], season: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.03], bankHoliday: 1.0,
    regularCoverageHours: [96, 96, 104, 104, 144, 160, 96] },
  { code: "UK04", city: "Brighton", context: "Central retail and visitor economy", baseDailyMinor: 630_000, meanBasketMinor: 9_500,
    weekday: [0.74, 0.76, 0.82, 0.90, 1.10, 1.62, 1.20], season: [0.94, 0.94, 0.97, 1.02, 1.06, 1.10, 1.22, 1.26, 1.04, 0.98, 0.92, 0.94], bankHoliday: 1.3,
    regularCoverageHours: [72, 72, 72, 72, 96, 112, 64] },
  { code: "UK05", city: "London Stratford", context: "Metropolitan retail", baseDailyMinor: 1_120_000, meanBasketMinor: 12_800,
    weekday: [0.86, 0.86, 0.92, 1.04, 1.18, 1.48, 1.04], season: [1.04, 1.04, 1, 1, 1, 1, 0.98, 0.98, 1, 1, 0.98, 0.96], bankHoliday: 1.1,
    regularCoverageHours: [152, 152, 152, 160, 232, 256, 176] },
];

// Shared specialty-retail season (Jan..Dec), before store-specific adjustment.
const SEASON = [0.82, 0.80, 0.88, 0.92, 0.93, 0.95, 0.98, 0.99, 0.92, 0.97, 1.12, 1.42];

// Factual England & Wales calendar for the reference period.
export const UK_BANK_HOLIDAYS: Readonly<Record<string, string>> = {
  "2024-01-01": "New Year’s Day", "2024-03-29": "Good Friday", "2024-04-01": "Easter Monday",
  "2024-05-06": "Early May bank holiday", "2024-05-27": "Spring bank holiday", "2024-08-26": "Summer bank holiday",
  "2024-12-25": "Christmas Day", "2024-12-26": "Boxing Day",
  "2025-01-01": "New Year’s Day", "2025-04-18": "Good Friday", "2025-04-21": "Easter Monday",
  "2025-05-05": "Early May bank holiday", "2025-05-26": "Spring bank holiday", "2025-08-25": "Summer bank holiday",
  "2025-12-25": "Christmas Day", "2025-12-26": "Boxing Day",
};
// Large shops in England and Wales may not open on Christmas Day or Easter Sunday.
const CLOSED: Readonly<Record<string, string>> = { "2024-03-31": "Easter Sunday", "2024-12-25": "Christmas Day", "2025-04-20": "Easter Sunday", "2025-12-25": "Christmas Day" };
const BLACK_FRIDAY = new Set(["2024-11-29", "2025-11-28"]);

export type ReferenceTradingDay =
  | { date: string; open: false; closure: string }
  | { date: string; open: true; openHour: number; closeHour: number; salesMinor: number; transactions: number; event: string | null };

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

// Deterministic per-store, per-day pseudo-random stream (mulberry32).
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

function eventFor(date: string): { name: string; factor: number } | null {
  const [, month, day] = date.split("-").map(Number);
  if (BLACK_FRIDAY.has(date)) return { name: "Black Friday", factor: 2.1 };
  if (BLACK_FRIDAY.has(shiftDate(date, -1))) return { name: "Black Friday weekend", factor: 1.35 };
  if (BLACK_FRIDAY.has(shiftDate(date, -2))) return { name: "Black Friday weekend", factor: 1.2 };
  if (BLACK_FRIDAY.has(shiftDate(date, -3))) return { name: "Cyber Monday", factor: 1.15 };
  if (month === 12 && day === 24) return { name: "Christmas Eve", factor: 1.3 };
  if (month === 12 && day === 26) return { name: "Boxing Day", factor: 1.9 };
  if (month === 12 && day >= 27) return { name: "Post-Christmas sales", factor: 1.25 };
  if (month === 1 && day === 1) return { name: "New Year’s Day", factor: 0.7 };
  if (month === 12 && day >= 14 && day <= 23) return { name: "Christmas trading", factor: 1.15 };
  return null;
}

function tradingHours(date: string): [number, number] {
  const [, month, day] = date.split("-").map(Number);
  if (month === 12 && (day === 24 || day === 31)) return [9, 17];
  if (month === 12 && day === 26) return [9, 18];
  if (UK_BANK_HOLIDAYS[date]) return [10, 17];
  return weekdayIndex(date) === 6 ? [11, 17] : [9, 19];
}

export function referenceTradingDay(code: ReferenceStoreCode, date: string): ReferenceTradingDay {
  assertReferenceDate(date);
  if (CLOSED[date]) return { date, open: false, closure: CLOSED[date] };
  const store = referenceStore(code);
  const month = Number(date.slice(5, 7)) - 1;
  const event = eventFor(date);
  const rng = random(code, date, "day");
  const growth = 1 + 0.05 * dayNumber(date) / 727;
  const noise = Math.exp(0.07 * rng.normal() - 0.00245);
  const holiday = UK_BANK_HOLIDAYS[date] && !event ? store.bankHoliday * 1.05 : 1;
  const salesMinor = Math.round(store.baseDailyMinor * store.weekday[weekdayIndex(date)] * SEASON[month] *
    store.season[month] * (event?.factor ?? 1) * holiday * growth * noise);
  const transactions = Math.max(1, Math.round(salesMinor / store.meanBasketMinor * (1 + 0.05 * rng.normal())));
  const [openHour, closeHour] = tradingHours(date);
  return { date, open: true, openHour, closeHour, salesMinor, transactions, event: event?.name ?? UK_BANK_HOLIDAYS[date] ?? null };
}

// Relative trading intensity by local hour of opening.
function hourWeight(date: string, hour: number) {
  const weekday = weekdayIndex(date);
  const curve: Record<number, number> = weekday === 5
    ? { 9: 0.5, 10: 0.8, 11: 1.1, 12: 1.3, 13: 1.4, 14: 1.45, 15: 1.4, 16: 1.2, 17: 1.0, 18: 0.75 }
    : weekday === 6 || UK_BANK_HOLIDAYS[date]
      ? { 10: 0.8, 11: 0.9, 12: 1.2, 13: 1.3, 14: 1.3, 15: 1.15, 16: 0.9, 17: 0.7 }
      : { 9: 0.55, 10: 0.75, 11: 0.95, 12: 1.2, 13: 1.25, 14: 1.05, 15: 1.0, 16: 1.05, 17: 1.1, 18: 0.85 };
  return curve[hour] ?? 0.6;
}

// UTC offset (ms) of Europe/London at local noon on a date. Trading hours lie well
// away from the 01:00 UTC daylight-saving transitions, so one offset covers the day.
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

// Receipt-level basket totals for one store-day. Basket sizes follow a fixed
// category mix; totals are then scaled so the day sums exactly to its demand.
export function referenceTransactions(code: ReferenceStoreCode, date: string): ReferenceTransaction[] {
  const day = referenceTradingDay(code, date);
  if (!day.open) return [];
  const rng = random(code, date, "receipts");
  const raw = Array.from({ length: day.transactions }, () => {
    const pick = rng.next();
    const [low, high] = pick < 0.5 ? [500, 4_500] : pick < 0.78 ? [3_500, 22_000] : pick < 0.95 ? [12_000, 65_000] : [45_000, 150_000];
    return low + rng.next() * (high - low);
  });
  const scale = day.salesMinor / raw.reduce((sum, value) => sum + value, 0);
  const amounts = raw.map(value => Math.max(1, Math.round(value * scale)));
  const residual = day.salesMinor - amounts.reduce((sum, value) => sum + value, 0);
  const largest = amounts.indexOf(Math.max(...amounts));
  amounts[largest] += residual;
  const hours = Array.from({ length: day.closeHour - day.openHour }, (_, i) => day.openHour + i);
  const weights = hours.map(hour => hourWeight(date, hour));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const times = amounts.map(() => {
    let pick = rng.next() * totalWeight;
    let index = 0;
    while (pick > weights[index] && index < hours.length - 1) pick -= weights[index++];
    return hours[index] * 3600 + Math.floor(rng.next() * 3600);
  }).sort((a, b) => a - b);
  const offset = londonOffset(date);
  return amounts.map((amountMinor, i) => ({ sequence: i + 1, occurredAt: londonInstant(date, times[i], offset), amountMinor }));
}

export function referenceDates(from: string = REFERENCE_DATASET.firstDate, through: string = REFERENCE_DATASET.lastDate) {
  assertReferenceDate(from);
  assertReferenceDate(through);
  if (from > through) throw new Error("Reference history start must not follow its end.");
  const dates: string[] = [];
  for (let date = from; date <= through; date = shiftDate(date, 1)) dates.push(date);
  return dates;
}
