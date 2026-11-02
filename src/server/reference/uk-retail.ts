import { createHash } from "node:crypto";
import { shiftDate } from "@/server/intelligence/forecast";

// SUPERSEDED, kept so earlier evidence stays reproducible: the current reference company
// is in uk-hospitality.ts. Nothing can load this dataset.
// Fictional five-store UK specialty retailer used to develop, test and demonstrate
// FairShift. Store codes and cities are environmental anchors, not real premises.
// Every value produced here is labelled synthetic REFERENCE input; application
// logic (forecasting, staffing) derives its outputs from these rows like any source.
export const REFERENCE_DATASET = {
  version: "uk-specialty-retail-v2",
  label: "UK reference retailer",
  currency: "GBP",
  timezone: "Europe/London",
  // 104 complete Monday–Sunday weeks.
  firstDate: "2024-11-04",
  lastDate: "2026-11-01",
  // Final 12 weeks reserved for out-of-sample forecast evaluation.
  holdoutStart: "2026-08-10",
  // Each store's recent momentum ramps across the final eight weeks: the forecast lookback.
  momentumStart: "2026-09-07",
  // This fictional company's own planning assumption, provisioned as its labour policy:
  // £100 of forecast sales per labour hour. Not a benchmark or a learned rate.
  salesMinorPerLabourHour: 10_000,
} as const;

export const REFERENCE_STORE_CODES = ["UK01", "UK02", "UK03", "UK04", "UK05"] as const;
export type ReferenceStoreCode = typeof REFERENCE_STORE_CODES[number];

type ReferenceStore = {
  code: ReferenceStoreCode;
  city: string;
  context: string;
  story: string;
  baseDailyMinor: number;
  meanBasketMinor: number;
  weekday: readonly [number, number, number, number, number, number, number]; // Mon..Sun
  season: readonly number[]; // Jan..Dec, multiplies the shared retail season
  bankHoliday: number;
  volatility: number; // Day-to-day lognormal spread
  momentum: number; // Total change in demand by the end of the momentum window
  // One-off store-specific trading days. A closure has no sales; a factor is a short day.
  disruptions: Readonly<Record<string, { closure: string } | { factor: number; event: string; openHour: number }>>;
  // Standing regular-staff rota, planned labour hours Mon..Sun. Hand-set staffing
  // input, not derived from sales; staffing gaps are derived by the application.
  regularCoverageHours: readonly [number, number, number, number, number, number, number];
};

export const REFERENCE_STORES: readonly ReferenceStore[] = [
  { code: "UK01", city: "Leeds", context: "Central retail (Briggate)", story: "Steady trading; late-week cover runs slightly short", baseDailyMinor: 340_000, meanBasketMinor: 11_500,
    weekday: [0.83, 0.84, 0.89, 0.97, 1.12, 1.46, 0.90], season: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], bankHoliday: 1.0, volatility: 0.05, momentum: 0.02, disruptions: {},
    regularCoverageHours: [32, 32, 32, 32, 34, 48, 32] },
  { code: "UK02", city: "Manchester", context: "City-centre retail", story: "Growing fast; the rota has not caught up from Wednesday onward", baseDailyMinor: 430_000, meanBasketMinor: 12_000,
    weekday: [0.80, 0.82, 0.92, 1.02, 1.20, 1.42, 0.82], season: [1, 1, 1, 1, 1, 1, 1, 1, 1.04, 1, 1, 1], bankHoliday: 1.0, volatility: 0.06, momentum: 0.2, disruptions: {},
    regularCoverageHours: [44, 44, 40, 44, 48, 56, 44] },
  { code: "UK03", city: "Birmingham", context: "City-centre retail", story: "Softening demand; the existing rota covers every day", baseDailyMinor: 390_000, meanBasketMinor: 11_200,
    weekday: [0.90, 0.90, 0.92, 0.98, 1.08, 1.34, 0.88], season: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.03], bankHoliday: 1.0, volatility: 0.05, momentum: -0.1,
    disruptions: { "2026-10-06": { closure: "Closed for stocktake" } },
    regularCoverageHours: [40, 40, 40, 40, 48, 56, 40] },
  { code: "UK04", city: "Brighton", context: "Central retail and visitor economy", story: "Quiet weekdays and volatile visitor weekends, with thin Sunday cover", baseDailyMinor: 240_000, meanBasketMinor: 9_500,
    weekday: [0.70, 0.72, 0.78, 0.86, 1.08, 1.68, 1.28], season: [0.94, 0.94, 0.97, 1.02, 1.06, 1.10, 1.22, 1.26, 1.04, 0.98, 0.92, 0.94], bankHoliday: 1.3, volatility: 0.11, momentum: 0, disruptions: {},
    regularCoverageHours: [24, 24, 24, 24, 28, 36, 24] },
  { code: "UK05", city: "London Stratford", context: "Metropolitan retail", story: "The largest store; well covered except at the Friday and Saturday peak", baseDailyMinor: 620_000, meanBasketMinor: 12_800,
    weekday: [0.86, 0.86, 0.92, 1.04, 1.18, 1.48, 1.04], season: [1.04, 1.04, 1, 1, 1, 1, 0.98, 0.98, 1, 1, 0.98, 0.96], bankHoliday: 1.1, volatility: 0.08, momentum: 0.05,
    disruptions: { "2026-09-23": { factor: 0.55, event: "Late opening after store fit-out", openHour: 13 } },
    regularCoverageHours: [64, 64, 64, 72, 72, 88, 72] },
];

// Shared specialty-retail season (Jan..Dec), before store-specific adjustment.
const SEASON = [0.82, 0.80, 0.88, 0.92, 0.93, 0.95, 0.98, 0.99, 0.92, 0.97, 1.12, 1.42];

// Factual England & Wales bank holidays inside the reference period.
export const UK_BANK_HOLIDAYS: Readonly<Record<string, string>> = {
  "2024-12-25": "Christmas Day", "2024-12-26": "Boxing Day",
  "2025-01-01": "New Year’s Day", "2025-04-18": "Good Friday", "2025-04-21": "Easter Monday",
  "2025-05-05": "Early May bank holiday", "2025-05-26": "Spring bank holiday", "2025-08-25": "Summer bank holiday",
  "2025-12-25": "Christmas Day", "2025-12-26": "Boxing Day",
  "2026-01-01": "New Year’s Day", "2026-04-03": "Good Friday", "2026-04-06": "Easter Monday",
  "2026-05-04": "Early May bank holiday", "2026-05-25": "Spring bank holiday", "2026-08-31": "Summer bank holiday",
};
// Large shops in England and Wales may not open on Christmas Day or Easter Sunday.
const CLOSED: Readonly<Record<string, string>> = { "2024-12-25": "Christmas Day", "2025-04-20": "Easter Sunday", "2025-12-25": "Christmas Day", "2026-04-05": "Easter Sunday" };
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
  const weekday = weekdayIndex(date);
  if (weekday === 6) return [11, 17];
  return weekday >= 3 ? [9, 20] : [9, 19]; // Late trading Thursday to Saturday.
}

// Monthly season values apply at mid-month and blend between, so no month starts with a jump.
function seasonFactor(store: ReferenceStore, date: string) {
  const [year, month, day] = date.split("-").map(Number);
  const anchor = (y: number, m: number) => Date.UTC(y, m, 15);
  const at = Date.UTC(year, month - 1, day);
  const [fromYear, fromMonth] = at < anchor(year, month - 1) ? [year, month - 2] : [year, month - 1];
  const from = new Date(Date.UTC(fromYear, fromMonth, 15)), to = new Date(Date.UTC(fromYear, fromMonth + 1, 15));
  const value = (m: number) => SEASON[m] * store.season[m];
  const progress = (at - from.getTime()) / (to.getTime() - from.getTime());
  return value(from.getUTCMonth()) * (1 - progress) + value(to.getUTCMonth()) * progress;
}

// Recent direction of one store: flat until the momentum window, then a steady ramp that holds.
function momentumFactor(store: ReferenceStore, date: string) {
  if (date <= REFERENCE_DATASET.momentumStart) return 1;
  const elapsed = (Date.parse(`${date}T12:00:00Z`) - Date.parse(`${REFERENCE_DATASET.momentumStart}T12:00:00Z`)) / 86_400_000;
  const span = (Date.parse(`${REFERENCE_DATASET.lastDate}T12:00:00Z`) - Date.parse(`${REFERENCE_DATASET.momentumStart}T12:00:00Z`)) / 86_400_000;
  return 1 + store.momentum * Math.min(1, elapsed / span);
}

export function referenceTradingDay(code: ReferenceStoreCode, date: string): ReferenceTradingDay {
  assertReferenceDate(date);
  if (CLOSED[date]) return { date, open: false, closure: CLOSED[date] };
  const store = referenceStore(code);
  const disruption = store.disruptions[date];
  if (disruption && "closure" in disruption) return { date, open: false, closure: disruption.closure };
  const event = eventFor(date);
  const rng = random(code, date, "day");
  const growth = 1 + 0.05 * dayNumber(date) / 727;
  const noise = Math.exp(store.volatility * rng.normal() - store.volatility ** 2 / 2);
  const holiday = UK_BANK_HOLIDAYS[date] && !event ? store.bankHoliday * 1.05 : 1;
  const short = disruption && "factor" in disruption ? disruption : null;
  const salesMinor = Math.round(store.baseDailyMinor * store.weekday[weekdayIndex(date)] * seasonFactor(store, date) * momentumFactor(store, date) *
    (short?.factor ?? 1) * (event?.factor ?? 1) * holiday * growth * noise);
  const transactions = Math.max(1, Math.round(salesMinor / store.meanBasketMinor * (1 + 0.05 * rng.normal())));
  const [openHour, closeHour] = tradingHours(date);
  return { date, open: true, openHour: short?.openHour ?? openHour, closeHour, salesMinor, transactions, event: short?.event ?? event?.name ?? UK_BANK_HOLIDAYS[date] ?? null };
}

// Relative trading intensity by local hour of opening.
function hourWeight(date: string, hour: number) {
  const weekday = weekdayIndex(date);
  const curve: Record<number, number> = weekday === 5
    ? { 9: 0.5, 10: 0.8, 11: 1.1, 12: 1.3, 13: 1.4, 14: 1.45, 15: 1.4, 16: 1.2, 17: 1.0, 18: 0.75, 19: 0.5 }
    : weekday === 6 || UK_BANK_HOLIDAYS[date]
      ? { 10: 0.8, 11: 0.9, 12: 1.2, 13: 1.3, 14: 1.3, 15: 1.15, 16: 0.9, 17: 0.7 }
      : { 9: 0.55, 10: 0.75, 11: 0.95, 12: 1.2, 13: 1.25, 14: 1.05, 15: 1.0, 16: 1.05, 17: 1.1, 18: 0.85, 19: 0.6 };
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
