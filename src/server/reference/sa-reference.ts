import { createHash } from "node:crypto";
import { shiftDate } from "@/server/intelligence/forecast";
import type { CoverageWindow, TradingWindow } from "@/server/intelligence/workload";
import type { ReferenceCompany } from "@/server/reference/provision";

// Jacaranda Table Demo: the fictional five-location South African reference business for the
// submission demo. Its name, locations and cities were approved by the Owner for the SA demo
// bootstrap (FS-HACK-SA-OWNER-DEMO-BOOTSTRAP-001, 6 November 2026), and its identifiers are the
// ones that bootstrap created, so a database already holding it stays compatible. Its hourly shapes,
// weekend factors, trading hours, standing cover and workload policy are that bootstrap's fixture
// assumptions, carried over unchanged. They are not learned, benchmarked or tuned to any result.
//
// Everything produced here is labelled synthetic REFERENCE input. It is not Square, PayPal or any
// South African merchant's trading. It is food-and-beverage sample data; nothing here makes that
// an industry classification. Deliberately absent: holiday effects, weather, events, promotions,
// trends and seasonality. Public holidays trade like any other day of the week, because FairShift
// knows of no effect to apply (see sa-public-holidays.ts).

export const SA_REFERENCE_DATASET = {
  version: "sa-reference-v1",
  label: "South African reference business (fictional)",
  currency: "ZAR",
  timezone: "Africa/Johannesburg",
  // Monday to the end of the checked SA holiday range. Dates still ahead of the clock are never loaded.
  firstDate: "2026-02-02",
  lastDate: "2027-03-31",
} as const;

export const SA_REFERENCE_ORGANISATION = {
  id: "846ff1bc-fe0a-45fb-b0f0-3ab44ba1f1e4",
  name: "Jacaranda Table Demo",
  country: "South Africa",
  province: "Gauteng",
  city: "Johannesburg",
} as const;

// The fictional business's own operating assumption, the same one the bootstrap used: sustainable
// transactions per operational staff-hour and the fewest operational staff while open.
export const SA_REFERENCE_WORKLOAD_POLICY = { transactionsPerStaffHour: 7, minimumStaffWhileOpen: 2 } as const;

export const SA_REFERENCE_STORE_CODES = ["SA01", "SA02", "SA03", "SA04", "SA05"] as const;
export type SaReferenceStoreCode = typeof SA_REFERENCE_STORE_CODES[number];

// Coordinates are approximate centres of each public area, used only to place area context. They
// are not business addresses: the venues are fictional. No venue profile is stated, so it stays unknown.
export type SaReferenceLocation = {
  code: SaReferenceStoreCode; id: string; name: string; city: string; province: string;
  latitude: number; longitude: number; coordinateBasis: "APPROXIMATE_AREA_CENTRE"; area: string;
  // Transactions per hour from 08:00, Monday to Friday. Weekends scale the whole day.
  hourly: readonly number[]; weekendFactor: number;
};

export const SA_REFERENCE_LOCATIONS: readonly SaReferenceLocation[] = [
  { code: "SA01", id: "202c691b-061d-4d4a-b4d7-9befc524e2ab", name: "Rosebank", city: "Johannesburg", province: "Gauteng",
    latitude: -26.1457, longitude: 28.0437, coordinateBasis: "APPROXIMATE_AREA_CENTRE", area: "Rosebank, Johannesburg",
    hourly: [10, 14, 12, 18, 24, 22, 16, 12, 8, 7, 5, 3], weekendFactor: 0.7 },
  { code: "SA02", id: "fd6526f5-24e4-4b10-b223-c16897d0942f", name: "Sandton", city: "Johannesburg", province: "Gauteng",
    latitude: -26.1076, longitude: 28.0567, coordinateBasis: "APPROXIMATE_AREA_CENTRE", area: "Sandton central, Johannesburg",
    hourly: [5, 8, 10, 24, 30, 26, 15, 12, 10, 9, 6, 4], weekendFactor: 0.7 },
  { code: "SA03", id: "7e81ed33-3e90-4601-800b-be7751fe2731", name: "Pretoria Central", city: "Pretoria", province: "Gauteng",
    latitude: -25.7461, longitude: 28.1881, coordinateBasis: "APPROXIMATE_AREA_CENTRE", area: "Pretoria city centre",
    hourly: [12, 15, 10, 16, 22, 20, 12, 8, 6, 5, 4, 2], weekendFactor: 0.7 },
  { code: "SA04", id: "91619930-06df-4c4b-bf96-9cec60840c1c", name: "Durban North", city: "Durban", province: "KwaZulu-Natal",
    latitude: -29.793, longitude: 31.037, coordinateBasis: "APPROXIMATE_AREA_CENTRE", area: "Durban North, Durban",
    hourly: [4, 6, 8, 12, 18, 20, 22, 24, 20, 16, 12, 8], weekendFactor: 1.4 },
  { code: "SA05", id: "e3e3104d-7658-4ad5-8570-a924f512e49a", name: "Cape Town Gardens", city: "Cape Town", province: "Western Cape",
    latitude: -33.934, longitude: 18.413, coordinateBasis: "APPROXIMATE_AREA_CENTRE", area: "Gardens, Cape Town",
    hourly: [6, 8, 12, 18, 22, 24, 26, 22, 20, 18, 14, 10], weekendFactor: 1.4 },
];

const OPEN_HOUR = 8, CLOSE_HOUR = 20;
// Standing regular cover while open: the bootstrap's two full-time staff, every day.
const REGULAR_HEADCOUNT = 2;
// Day-to-day variation around each venue's shape, so history doesn't repeat exactly by weekday.
const VOLATILITY = 0.06;
// Bills from R45 to R164, in whole rand.
const BILL_MIN_MINOR = 4_500, BILL_STEPS = 120;

// DEMO PROFILES (fictional venues). Short Owner-style descriptions for local intelligence, written
// for the demonstration and stored as DEMO_SEED so they are always labelled. They describe each public
// area and an imagined customer mix; they set no effect on demand and were not tuned to any result.
export const SA_DEMO_LOCATION_PROFILES: Readonly<Record<SaReferenceStoreCode, { area: string; venueType: string; typicalCustomers: string }>> = {
  SA01: { area: "Rosebank, Johannesburg: offices, a shopping centre and the Gautrain station", venueType: "Fictional fast-casual cafe and dining room", typicalCustomers: "Office workers at breakfast and lunch, shoppers and commuters, local residents in the evening" },
  SA02: { area: "Sandton central, Johannesburg: the business district and convention centre", venueType: "Fictional fast-casual cafe in an office precinct", typicalCustomers: "Corporate staff on weekdays, business visitors and conference delegates, fewer customers at weekends" },
  SA03: { area: "Pretoria city centre, near government buildings and offices", venueType: "Fictional fast-casual cafe on a busy city street", typicalCustomers: "Civil servants and office workers on weekdays, students and visitors to government offices" },
  SA04: { area: "Durban North, a residential suburb close to the beachfront", venueType: "Fictional neighbourhood cafe and dining room", typicalCustomers: "Local families and residents, weekend brunch crowds, holidaymakers in season" },
  SA05: { area: "Gardens, Cape Town: a busy city-bowl street of restaurants and shops", venueType: "Fictional cafe and dining room", typicalCustomers: "Residents, students and tourists by day, evening diners" },
};

export function saReferenceLocation(code: SaReferenceStoreCode) {
  const location = SA_REFERENCE_LOCATIONS.find(row => row.code === code);
  if (!location) throw new Error(`Unknown reference store ${code}.`);
  return location;
}

export function assertSaReferenceDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || shiftDate(date, 0) !== date) throw new Error(`Invalid date ${date}.`);
  if (date < SA_REFERENCE_DATASET.firstDate || date > SA_REFERENCE_DATASET.lastDate) {
    throw new Error(`Reference history covers ${SA_REFERENCE_DATASET.firstDate} to ${SA_REFERENCE_DATASET.lastDate}.`);
  }
}

export function saReferenceDates(from: string = SA_REFERENCE_DATASET.firstDate, through: string = SA_REFERENCE_DATASET.lastDate) {
  assertSaReferenceDate(from);
  assertSaReferenceDate(through);
  if (from > through) throw new Error("Reference history start must not follow its end.");
  const dates: string[] = [];
  for (let date = from; date <= through; date = shiftDate(date, 1)) dates.push(date);
  return dates;
}

// Deterministic per-venue, per-day pseudo-random stream (mulberry32).
function random(...parts: string[]) {
  let state = createHash("sha256").update([SA_REFERENCE_DATASET.version, ...parts].join(":")).digest().readUInt32BE(0);
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

const isWeekend = (date: string) => [0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay());

// UTC offset (ms) of the dataset's time zone at local noon on a date.
function offsetAt(date: string) {
  const noon = Date.parse(`${date}T12:00:00Z`);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: SA_REFERENCE_DATASET.timezone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(new Date(noon)).map(part => [part.type, part.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute)) - noon;
}

export type SaReferenceTransaction = { sequence: number; occurredAt: Date; amountMinor: number };

// Bill-level records for one venue-day, spread over its hours by its own shape.
export function saReferenceTransactions(code: SaReferenceStoreCode, date: string): SaReferenceTransaction[] {
  assertSaReferenceDate(date);
  const location = saReferenceLocation(code);
  const rng = random(code, date);
  const factor = isWeekend(date) ? location.weekendFactor : 1;
  const base = location.hourly.reduce((sum, value) => sum + value, 0);
  const count = Math.max(1, Math.round(base * factor * Math.exp(VOLATILITY * rng.normal() - VOLATILITY ** 2 / 2)));
  const bills = Array.from({ length: count }, () => {
    let pick = rng.next() * base, index = 0;
    while (pick > location.hourly[index] && index < location.hourly.length - 1) pick -= location.hourly[index++];
    const seconds = (OPEN_HOUR + index) * 3600 + Math.floor(rng.next() * 3600);
    return { seconds, amountMinor: BILL_MIN_MINOR + Math.floor(rng.next() * BILL_STEPS) * 100 };
  }).sort((a, b) => a.seconds - b.seconds);
  const midnight = Date.parse(`${date}T00:00:00Z`) - offsetAt(date);
  return bills.map((bill, i) => ({ sequence: i + 1, occurredAt: new Date(midnight + bill.seconds * 1000), amountMinor: bill.amountMinor }));
}

// Stated trading hours and standing cover, Monday first: reference configuration.
export function saReferenceTradingHours(code: SaReferenceStoreCode): TradingWindow[][] {
  saReferenceLocation(code);
  return Array.from({ length: 7 }, () => [{ start: OPEN_HOUR * 60, end: CLOSE_HOUR * 60 }]);
}
export function saReferenceCoverage(code: SaReferenceStoreCode): CoverageWindow[][] {
  saReferenceLocation(code);
  return Array.from({ length: 7 }, () => [{ start: OPEN_HOUR * 60, end: CLOSE_HOUR * 60, headcount: REGULAR_HEADCOUNT }]);
}

export const SA_REFERENCE_COMPANY: ReferenceCompany<SaReferenceStoreCode> = {
  dataset: SA_REFERENCE_DATASET, countryLabel: "South Africa", storeCodes: SA_REFERENCE_STORE_CODES,
  venueContext: Object.fromEntries(SA_REFERENCE_LOCATIONS.map(row => [row.code, { venueProfile: null, latitude: row.latitude, longitude: row.longitude }])) as ReferenceCompany<SaReferenceStoreCode>["venueContext"],
  workloadPolicy: SA_REFERENCE_WORKLOAD_POLICY, dates: saReferenceDates, transactions: saReferenceTransactions,
  tradingHours: saReferenceTradingHours, coverage: saReferenceCoverage,
};
