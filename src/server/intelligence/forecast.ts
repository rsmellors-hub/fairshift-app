import { z } from "zod";

export const METHOD_VERSION = "comparable-days-recency-v1";
export const sourceSchema = z.enum(["PAYPAL_SANDBOX", "DEMO_SEEDED", "REFERENCE", "IMPORTED"]);
export type SalesSource = z.infer<typeof sourceSchema>;
// Reference and demo history are generated; imported and PayPal history are genuine.
export const isSyntheticSource = (source: SalesSource) => source === "REFERENCE" || source === "DEMO_SEEDED";
const minor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const staffingPolicySchema = z.object({
  version: z.literal("revenue-capacity-v1"),
  salesMinorPerLabourHour: minor.refine((value) => value > 0),
  tradingHours: z.number().int().min(1).max(24),
  minimumWorkers: z.number().int().min(0).max(100),
  comparisonWorkers: z.number().int().min(0).max(100),
});

// Legacy single-day demonstration estimate, no longer reachable from any page: weekly
// staffing with the business's labour policy is authoritative. Not wages, individual
// quotas or a saved staffing plan. One worker supplies an entire eight-hour trading day.
export const STAFFING_POLICY_CURRENCY = "USD";
export const STAFFING_POLICY = staffingPolicySchema.parse({
  version: "revenue-capacity-v1",
  salesMinorPerLabourHour: 10_000, // USD 100 sales per labour hour
  tradingHours: 8,
  minimumWorkers: 2, // minimum assumed opening coverage
  comparisonWorkers: 5,
});

const observationSchema = z.object({
  id: z.string().uuid(),
  outletId: z.string().uuid(),
  source: sourceSchema,
  currencyCode: z.string().length(3),
  grossAmountMinor: minor,
  verificationState: z.string(),
  reconciliationState: z.string(),
  providerStatus: z.string(),
  paypalCaptureId: z.string().nullable(),
  providerCreatedAt: z.date().nullable(),
  occurredAt: z.date().nullable().optional(),
  createdAt: z.date(),
});
export type Observation = z.infer<typeof observationSchema>;

const daySchema = z.object({
  date: z.iso.date(),
  salesMinor: minor,
  transactions: z.number().int().positive(),
  usedSalesMinor: minor,
  weight: z.number().int().positive(),
});
const common = {
  methodVersion: z.literal(METHOD_VERSION),
  organisationId: z.string().uuid(),
  outletId: z.string().uuid(),
  outletName: z.string().min(1),
  timezone: z.string().min(1),
  targetDate: z.iso.date(),
  currency: z.string().length(3),
  source: sourceSchema,
  dataAsOf: z.iso.datetime(),
  generatedAt: z.iso.datetime(),
};
export const forecastResultSchema = z.discriminatedUnion("status", [
  z.object({ ...common, status: z.literal("UNAVAILABLE"), reason: z.enum(["NO_ELIGIBLE_HISTORY", "NO_STAFFING_POLICY_FOR_CURRENCY"]) }),
  z.object({
    ...common,
    status: z.literal("AVAILABLE"),
    forecastSalesMinor: minor,
    lowerSalesMinor: minor,
    upperSalesMinor: minor,
    support: z.enum(["LOW", "MODERATE"]),
    basis: z.enum(["SAME_WEEKDAY", "RECENT_OBSERVED_DAYS"]),
    lookbackDays: z.literal(56),
    eligibleDays: z.number().int().positive(),
    eligibleTransactions: z.number().int().positive(),
    evidence: z.array(daySchema).min(1),
    staffing: z.object({
      policy: staffingPolicySchema,
      workers: z.number().int().nonnegative(),
      workerDelta: z.number().int(),
      labourHours: z.number().nonnegative(),
    }),
    drivers: z.array(z.string()).min(1),
    action: z.string().min(1),
  }).refine((value) => value.lowerSalesMinor <= value.forecastSalesMinor && value.forecastSalesMinor <= value.upperSalesMinor,
    "Forecast must fall inside its planning range."),
]);
export type ForecastResult = z.infer<typeof forecastResultSchema>;

export function localDate(date: Date, timezone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function shiftDate(date: string, days: number) {
  z.iso.date().parse(date);
  const result = new Date(`${date}T12:00:00Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

export function recommendStaffing(salesMinor: number, policy = STAFFING_POLICY) {
  minor.parse(salesMinor);
  const valid = staffingPolicySchema.parse(policy);
  const capacity = valid.salesMinorPerLabourHour * valid.tradingHours;
  if (!Number.isSafeInteger(capacity)) throw new Error("Staffing capacity exceeds safe numeric limits.");
  const workers = Math.max(valid.minimumWorkers, Math.ceil(salesMinor / capacity));
  return {
    policy: valid, workers, workerDelta: workers - valid.comparisonWorkers,
    labourHours: salesMinor / valid.salesMinorPerLabourHour,
  };
}

// Whether a persisted sale carries the complete provenance of its claimed source.
// Mirrors the database predicate in sales-history.ts.
export function eligibleObservation(sale: Observation, source: SalesSource) {
  if (sale.source !== source) return false;
  if (source === "PAYPAL_SANDBOX") return sale.verificationState === "VERIFIED" && sale.reconciliationState === "RECONCILED" &&
    sale.providerStatus === "COMPLETED" && !!sale.paypalCaptureId && !!sale.providerCreatedAt;
  const synthetic = sale.verificationState === "PENDING" && sale.reconciliationState === "NOT_RECONCILED" &&
    !sale.paypalCaptureId && !sale.providerCreatedAt;
  if (source === "IMPORTED") return synthetic && sale.providerStatus === "IMPORTED" && !!sale.occurredAt;
  return source === "REFERENCE" ? synthetic && sale.providerStatus === "REFERENCE" && !!sale.occurredAt
    : synthetic && sale.providerStatus === "DEMO_SEEDED";
}

export type DailySales = { date: string; salesMinor: number; transactions: number };
export const LOOKBACK_DAYS = 56;

export const salesForecastSchema = z.object({
  forecastSalesMinor: minor,
  lowerSalesMinor: minor,
  upperSalesMinor: minor,
  support: z.enum(["LOW", "MODERATE"]),
  basis: z.enum(["SAME_WEEKDAY", "RECENT_OBSERVED_DAYS"]),
  lookbackDays: z.literal(LOOKBACK_DAYS),
  eligibleDays: z.number().int().positive(),
  eligibleTransactions: z.number().int().positive(),
  evidence: z.array(daySchema).min(1),
  drivers: z.array(z.string()).min(1),
}).refine((value) => value.lowerSalesMinor <= value.forecastSalesMinor && value.forecastSalesMinor <= value.upperSalesMinor,
  "Forecast must fall inside its planning range.");
export type SalesForecast = z.infer<typeof salesForecastSchema>;

// Comparable-day recency forecast for one target date from daily totals of one
// source, currency and outlet. Only days inside the 56-day lookback ending at
// dataThrough count; absent days are unknown, never zero. Returns null without evidence.
export function forecastFromHistory(input: { days: readonly DailySales[]; dataThrough: string; targetDate: string }): SalesForecast | null {
  z.iso.date().parse(input.dataThrough);
  z.iso.date().parse(input.targetDate);
  if (input.targetDate <= input.dataThrough) throw new Error("Forecast target must follow the data cutoff day.");
  const startDate = shiftDate(input.dataThrough, -(LOOKBACK_DAYS - 1));
  const history = input.days.filter((day) => day.date >= startDate && day.date <= input.dataThrough && day.transactions > 0)
    .map((day) => ({ date: day.date, salesMinor: minor.parse(day.salesMinor), transactions: day.transactions }))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!history.length) return null;

  const weekday = new Date(`${input.targetDate}T12:00:00Z`).getUTCDay();
  const comparable = history.filter((day) => new Date(`${day.date}T12:00:00Z`).getUTCDay() === weekday);
  const sameWeekday = comparable.length >= 3;
  const selected = sameWeekday ? comparable : history.slice(-14);
  const sortedSales = selected.map((day) => day.salesMinor).sort((a, b) => a - b);
  const median = sortedSales[Math.floor(sortedSales.length / 2)];
  // Cap isolated high days only with at least five observations. Preserve raw
  // evidence and disclose adjustments; do not invent external numeric uplifts.
  const cap = selected.length >= 5 && median > 0 ? median * 2 : Infinity;
  const evidence = selected.map((day, i) => ({ ...day, usedSalesMinor: Math.min(day.salesMinor, cap), weight: i + 1 }));
  const totalWeight = evidence.reduce((sum, day) => sum + day.weight, 0);
  const point = minor.parse(Math.round(evidence.reduce((sum, day) => sum + day.usedSalesMinor * (day.weight / totalWeight), 0)));
  const support = sameWeekday && selected.length >= 4 ? "MODERATE" : "LOW";
  const deviation = evidence.reduce((sum, day) => sum + Math.abs(day.usedSalesMinor - point) * (day.weight / totalWeight), 0);
  const width = Math.ceil(Math.max(point * (support === "LOW" ? 0.5 : 0.25), 2 * deviation));
  const adjusted = evidence.filter((day) => day.salesMinor !== day.usedSalesMinor).length;
  return salesForecastSchema.parse({
    forecastSalesMinor: point, lowerSalesMinor: Math.max(0, point - width), upperSalesMinor: point + width,
    support, basis: sameWeekday ? "SAME_WEEKDAY" : "RECENT_OBSERVED_DAYS", lookbackDays: LOOKBACK_DAYS,
    eligibleDays: history.length, eligibleTransactions: history.reduce((sum, day) => sum + day.transactions, 0),
    evidence,
    drivers: [
      `${selected.length} ${sameWeekday ? "matching weekdays" : "recent observed days (fewer than three matching weekdays)"} from a 56-day lookback.`,
      `Weights rise from 1 to ${selected.length} with recency, so recent demand has more influence; no trend extrapolation.`,
      `${adjusted} high day(s) capped at twice the sample median; raw sales remain visible.`,
      "Planning range uses twice weighted absolute deviation, with a minimum ±25% (±50% for low support). It is not a calibrated confidence interval.",
      "Days without eligible transactions are unknown, not assumed zero. Sales are only a proxy for service workload.",
    ],
  });
}

// Daily totals of one outlet's eligible sales in one source and currency, by local date.
export function dailyHistory(sales: readonly unknown[], outlet: { id: string; timezone: string }, source: SalesSource, currency: string): DailySales[] {
  const days = new Map<string, DailySales>();
  for (const raw of sales) {
    const sale = observationSchema.parse(raw);
    if (sale.outletId !== outlet.id || sale.currencyCode !== currency || !eligibleObservation(sale, source)) continue;
    const date = localDate(sale.occurredAt ?? sale.providerCreatedAt ?? sale.createdAt, outlet.timezone);
    const day = days.get(date) ?? { date, salesMinor: 0, transactions: 0 };
    day.salesMinor = minor.parse(day.salesMinor + sale.grossAmountMinor);
    day.transactions++;
    days.set(date, day);
  }
  return [...days.values()];
}

// UTC instant at which a local calendar day begins in a time zone.
export function startOfLocalDay(date: string, timezone: string) {
  z.iso.date().parse(date);
  const midnightUtc = Date.parse(`${date}T00:00:00Z`);
  let instant = midnightUtc;
  // Two passes settle the offset, including across daylight-saving changes.
  for (let i = 0; i < 2; i++) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
    const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    instant = midnightUtc - (local - instant);
  }
  return new Date(instant);
}

// Single-day forecast plus the explicit staffing policy (manager workflow). The
// policy is denominated in USD, so other currencies get no staffing recommendation.
export function staffedForecast(input: {
  days: readonly DailySales[];
  outlet: { id: string; organisationId: string; name: string; timezone: string };
  source: SalesSource;
  currency: string;
  dataThrough: string;
  targetDate: string;
  asOf: Date;
  generatedAt?: Date;
}): ForecastResult {
  const base = {
    methodVersion: METHOD_VERSION, organisationId: input.outlet.organisationId,
    outletId: input.outlet.id, outletName: input.outlet.name, timezone: input.outlet.timezone,
    source: input.source, currency: input.currency, targetDate: input.targetDate,
    dataAsOf: input.asOf.toISOString(), generatedAt: (input.generatedAt ?? input.asOf).toISOString(),
  };
  if (input.currency !== STAFFING_POLICY_CURRENCY) return forecastResultSchema.parse({ ...base, status: "UNAVAILABLE", reason: "NO_STAFFING_POLICY_FOR_CURRENCY" });
  const forecast = forecastFromHistory({ days: input.days, dataThrough: input.dataThrough, targetDate: input.targetDate });
  if (!forecast) return forecastResultSchema.parse({ ...base, status: "UNAVAILABLE", reason: "NO_ELIGIBLE_HISTORY" });
  const staffing = recommendStaffing(forecast.forecastSalesMinor);
  const delta = staffing.workerDelta;
  return forecastResultSchema.parse({
    ...base, status: "AVAILABLE", ...forecast, staffing,
    action: `Review ${staffing.workers} workers for an ${staffing.policy.tradingHours}-hour trading day: ${delta > 0 ? "+" : ""}${delta} versus the assumed ${staffing.policy.comparisonWorkers}-worker baseline. Manager judgement required; no schedule is changed.`,
  });
}

// Raw-observation form of staffedForecast (USD). Without dataThrough, the as-of
// day is treated as incomplete and excluded.
export function forecastDemand(input: {
  sales: readonly unknown[];
  outlet: { id: string; organisationId: string; name: string; timezone: string };
  source: SalesSource;
  targetDate: string;
  asOf: Date;
  dataThrough?: string;
  generatedAt?: Date;
}): ForecastResult {
  const dataThrough = input.dataThrough ?? shiftDate(localDate(input.asOf, input.outlet.timezone), -1);
  z.iso.date().parse(input.targetDate);
  if (input.targetDate <= shiftDate(dataThrough, input.dataThrough ? 0 : 1)) throw new Error("Forecast target must follow the data cutoff day.");
  return staffedForecast({ ...input, currency: STAFFING_POLICY_CURRENCY, dataThrough,
    days: dailyHistory(input.sales, input.outlet, input.source, STAFFING_POLICY_CURRENCY) });
}
