import { z } from "zod";

export const METHOD_VERSION = "comparable-days-recency-v1";
export const sourceSchema = z.enum(["PAYPAL_SANDBOX", "DEMO_SEEDED"]);
const minor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const staffingPolicySchema = z.object({
  version: z.literal("revenue-capacity-v1"),
  salesMinorPerLabourHour: minor.refine((value) => value > 0),
  tradingHours: z.number().int().min(1).max(24),
  minimumWorkers: z.number().int().min(0).max(100),
  comparisonWorkers: z.number().int().min(0).max(100),
});

// Explicit demonstration assumptions, not wages, individual quotas or a saved
// staffing plan. One worker supplies an entire eight-hour trading day.
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
  currency: z.literal("USD"),
  source: sourceSchema,
  dataAsOf: z.iso.datetime(),
  generatedAt: z.iso.datetime(),
};
export const forecastResultSchema = z.discriminatedUnion("status", [
  z.object({ ...common, status: z.literal("UNAVAILABLE"), reason: z.literal("NO_ELIGIBLE_HISTORY") }),
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

export function forecastDemand(input: {
  sales: readonly unknown[];
  outlet: { id: string; organisationId: string; name: string; timezone: string };
  source: z.infer<typeof sourceSchema>;
  targetDate: string;
  asOf: Date;
  generatedAt?: Date;
}): ForecastResult {
  const asOfDay = localDate(input.asOf, input.outlet.timezone);
  z.iso.date().parse(input.targetDate);
  if (input.targetDate <= asOfDay) throw new Error("Forecast target must follow the data cutoff day.");
  const startDate = shiftDate(asOfDay, -56);
  const base = {
    methodVersion: METHOD_VERSION, organisationId: input.outlet.organisationId,
    outletId: input.outlet.id, outletName: input.outlet.name, timezone: input.outlet.timezone,
    source: input.source, currency: "USD", targetDate: input.targetDate,
    dataAsOf: input.asOf.toISOString(), generatedAt: (input.generatedAt ?? input.asOf).toISOString(),
  };
  const days = new Map<string, { salesMinor: number; transactions: number }>();
  for (const raw of input.sales) {
    const sale = observationSchema.parse(raw);
    if (sale.outletId !== input.outlet.id || sale.currencyCode !== "USD" || sale.source !== input.source) continue;
    const verified = sale.verificationState === "VERIFIED" && sale.reconciliationState === "RECONCILED" &&
      sale.providerStatus === "COMPLETED" && sale.paypalCaptureId && sale.providerCreatedAt;
    const seeded = sale.verificationState === "PENDING" && sale.reconciliationState === "NOT_RECONCILED" &&
      sale.providerStatus === "DEMO_SEEDED" && !sale.paypalCaptureId && !sale.providerCreatedAt;
    if (input.source === "PAYPAL_SANDBOX" ? !verified : !seeded) continue;
    const date = localDate(sale.providerCreatedAt ?? sale.createdAt, input.outlet.timezone);
    // Exclude the incomplete current day; absent days are unknown, not zero sales.
    if (date < startDate || date >= asOfDay) continue;
    const day = days.get(date) ?? { salesMinor: 0, transactions: 0 };
    day.salesMinor = minor.parse(day.salesMinor + sale.grossAmountMinor);
    day.transactions++;
    days.set(date, day);
  }
  if (!days.size) return forecastResultSchema.parse({ ...base, status: "UNAVAILABLE", reason: "NO_ELIGIBLE_HISTORY" });

  const history = [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, day]) => ({ date, ...day }));
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
  const staffing = recommendStaffing(point);
  const adjusted = evidence.filter((day) => day.salesMinor !== day.usedSalesMinor).length;
  const delta = staffing.workerDelta;
  return forecastResultSchema.parse({
    ...base, status: "AVAILABLE", forecastSalesMinor: point,
    lowerSalesMinor: Math.max(0, point - width), upperSalesMinor: point + width,
    support, basis: sameWeekday ? "SAME_WEEKDAY" : "RECENT_OBSERVED_DAYS", lookbackDays: 56,
    eligibleDays: history.length, eligibleTransactions: history.reduce((sum, day) => sum + day.transactions, 0),
    evidence, staffing,
    drivers: [
      `${selected.length} ${sameWeekday ? "matching weekdays" : "recent observed days (fewer than three matching weekdays)"} from a 56-day lookback.`,
      `Weights rise from 1 to ${selected.length} with recency, so recent demand has more influence; no trend extrapolation.`,
      `${adjusted} high day(s) capped at twice the sample median; raw sales remain visible.`,
      "Planning range uses twice weighted absolute deviation, with a minimum ±25% (±50% for low support). It is not a calibrated confidence interval.",
      "Days without eligible transactions are unknown, not assumed zero. Sales are only a proxy for service workload.",
    ],
    action: `Review ${staffing.workers} workers for an ${staffing.policy.tradingHours}-hour trading day: ${delta > 0 ? "+" : ""}${delta} versus the assumed ${staffing.policy.comparisonWorkers}-worker baseline. Manager judgement required; no schedule is changed.`,
  });
}
