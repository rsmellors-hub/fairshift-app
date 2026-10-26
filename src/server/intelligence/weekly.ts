import { and, eq } from "drizzle-orm";
import { assertRole, type Scope } from "@/server/auth/access";
import type { DatabaseSession } from "@/server/db/client";
import { outlets } from "@/server/db/schema";
import { forecastFromHistory, localDate, LOOKBACK_DAYS, METHOD_VERSION, shiftDate, type DailySales, type SalesForecast, type SalesSource } from "@/server/intelligence/forecast";
import { loadDailySales, type DailySalesRow } from "@/server/intelligence/sales-history";

export const SOURCE_RULE_VERSION = "source-eligibility-v1";
export const PROVIDER_RULE = { minimumDays: 28, minimumPerWeekday: 3, maximumAgeDays: 2 } as const;
const PROVIDER_SOURCES: readonly SalesSource[] = ["PAYPAL_SANDBOX"];
// Historical evidence sources in precedence order. They never describe current trading.
const HISTORICAL_SOURCES: readonly SalesSource[] = ["REFERENCE", "DEMO_SEEDED"];

export type SourceRejection = {
  source: SalesSource;
  currency: string;
  reason: "CURRENCY_MISMATCH" | "STALE" | "INSUFFICIENT_DAYS" | "INCOMPLETE_WEEKDAYS" | "AMBIGUOUS";
  detail: string;
};
export type SourceSelection =
  | { status: "SELECTED"; source: SalesSource; currency: string; kind: "PROVIDER" | "HISTORICAL";
      dataThrough: string; firstTarget: string; days: DailySales[]; rejected: SourceRejection[] }
  | { status: "NONE"; rejected: SourceRejection[] };

const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

// Deterministic, versioned choice of one history per outlet. Histories are never
// mixed. A provider series supersedes historical evidence only when it is complete
// enough for a weekly forecast: in the 56 days to yesterday it needs 28 distinct
// days, three of every weekday, recent data, and the outlet's planning currency.
// Otherwise labelled historical evidence (reference, then legacy demo) is used.
// Every source plans the same horizon: the next seven local days from tomorrow.
// Historical evidence keeps its own data-through date and is never re-dated; its
// comparable weekdays are mapped onto the planning dates by the forecast method.
export function selectForecastSource(rows: readonly DailySalesRow[], today: string): SourceSelection {
  const yesterday = shiftDate(today, -1);
  const series = new Map<string, { source: SalesSource; currency: string; days: DailySales[] }>();
  // Only completed local days count; any future-dated row is not evidence.
  for (const row of rows) if (row.date <= yesterday && row.transactions > 0) {
    const key = `${row.source}:${row.currency}`;
    const entry = series.get(key) ?? { source: row.source, currency: row.currency, days: [] };
    entry.days.push({ date: row.date, salesMinor: row.salesMinor, transactions: row.transactions });
    series.set(key, entry);
  }
  const all = [...series.values()].map(entry => ({ ...entry, days: entry.days.sort((a, b) => a.date.localeCompare(b.date)) }));
  const rejected: SourceRejection[] = [];
  // The outlet's planning currency is that of its established history (reference,
  // else legacy demo), when that history has exactly one currency.
  const established = HISTORICAL_SOURCES.map(source => all.filter(entry => entry.source === source)).find(entries => entries.length);
  const planningCurrency = established?.length === 1 ? established[0].currency : null;

  const eligibleProviders = all.filter(entry => PROVIDER_SOURCES.includes(entry.source)).filter(entry => {
    const reject = (reason: SourceRejection["reason"], detail: string) => (rejected.push({ source: entry.source, currency: entry.currency, reason, detail }), false);
    if (planningCurrency && entry.currency !== planningCurrency) return reject("CURRENCY_MISMATCH", `${entry.currency} history cannot replace ${planningCurrency} planning history.`);
    const latest = entry.days.at(-1)!.date;
    if (latest < shiftDate(yesterday, -(PROVIDER_RULE.maximumAgeDays - 1))) return reject("STALE", `Latest completed sales day is ${latest}.`);
    const window = entry.days.filter(day => day.date >= shiftDate(yesterday, -(LOOKBACK_DAYS - 1)));
    if (window.length < PROVIDER_RULE.minimumDays) return reject("INSUFFICIENT_DAYS", `${window.length} of ${PROVIDER_RULE.minimumDays} required days in the ${LOOKBACK_DAYS}-day lookback.`);
    const thin = [0, 1, 2, 3, 4, 5, 6].filter(day => window.filter(row => weekday(row.date) === day).length < PROVIDER_RULE.minimumPerWeekday);
    if (thin.length) return reject("INCOMPLETE_WEEKDAYS", `${thin.length} weekday(s) have fewer than ${PROVIDER_RULE.minimumPerWeekday} observations.`);
    return true;
  });
  if (eligibleProviders.length === 1) {
    const [entry] = eligibleProviders;
    // Live evidence runs through yesterday; today is still trading, so planning starts tomorrow.
    return { status: "SELECTED", source: entry.source, currency: entry.currency, kind: "PROVIDER",
      dataThrough: yesterday, firstTarget: shiftDate(today, 1), days: entry.days, rejected };
  }
  for (const entry of eligibleProviders) rejected.push({ source: entry.source, currency: entry.currency, reason: "AMBIGUOUS", detail: "More than one eligible provider currency; none was chosen." });

  for (const source of HISTORICAL_SOURCES) {
    const candidates = all.filter(entry => entry.source === source);
    if (candidates.length > 1) {
      for (const entry of candidates) rejected.push({ source, currency: entry.currency, reason: "AMBIGUOUS", detail: "History exists in more than one currency; none was chosen." });
      continue;
    }
    if (!candidates.length) continue;
    const [entry] = candidates;
    const dataThrough = entry.days.at(-1)!.date;
    return { status: "SELECTED", source, currency: entry.currency, kind: "HISTORICAL",
      dataThrough, firstTarget: shiftDate(today, 1), days: entry.days, rejected };
  }
  return { status: "NONE", rejected };
}

export type WeeklyDay = { targetDate: string; forecast: SalesForecast | null };
export type OutletWeeklyForecast = {
  outletId: string; outletName: string; timezone: string; today: string;
  selection: Omit<Extract<SourceSelection, { status: "SELECTED" }>, "days"> | Extract<SourceSelection, { status: "NONE" }>;
  days: WeeklyDay[];
  weeklyTotalMinor: number | null;
};

// Seven-day demand forecast per authorised outlet. No staffing, AI or schedule
// change happens here; missing evidence yields no forecast rather than zero demand.
export async function getWeeklyForecast(db: DatabaseSession, scope: Scope, now = new Date()) {
  assertRole(scope, ["OWNER", "MANAGER"]);
  const rows = await db.select({ id: outlets.id, name: outlets.name, timezone: outlets.timezone }).from(outlets)
    .where(and(eq(outlets.organisationId, scope.organisationId), eq(outlets.active, true),
      scope.role === "OWNER" ? undefined : eq(outlets.id, scope.locationId)))
    .orderBy(outlets.name);
  // Owners share the organisation-wide totals already loaded for Overview; managers load only their location.
  // (Same argument list as Overview's call, so the per-request memo applies.)
  const daily = await (scope.role === "OWNER" ? loadDailySales(db, scope.organisationId) : loadDailySales(db, scope.organisationId, rows.map(row => row.id)));
  const result: OutletWeeklyForecast[] = rows.map(outlet => {
    const today = localDate(now, outlet.timezone);
    const selection = selectForecastSource(daily.filter(row => row.outletId === outlet.id), today);
    if (selection.status === "NONE") return { outletId: outlet.id, outletName: outlet.name, timezone: outlet.timezone, today, selection, days: [], weeklyTotalMinor: null };
    const { days: history, ...summary } = selection;
    const days = Array.from({ length: 7 }, (_, i) => {
      const targetDate = shiftDate(selection.firstTarget, i);
      return { targetDate, forecast: forecastFromHistory({ days: history, dataThrough: selection.dataThrough, targetDate }) };
    });
    const weeklyTotalMinor = days.every(day => day.forecast) ? days.reduce((sum, day) => sum + day.forecast!.forecastSalesMinor, 0) : null;
    return { outletId: outlet.id, outletName: outlet.name, timezone: outlet.timezone, today, selection: summary, days, weeklyTotalMinor };
  });
  return { methodVersion: METHOD_VERSION, ruleVersion: SOURCE_RULE_VERSION, generatedAt: now.toISOString(), outlets: result, consolidated: consolidate(result) };
}

// A company total exists only when every outlet forecasts the same dates from the
// same source and currency; otherwise histories would be silently mixed.
function consolidate(outletsForecast: OutletWeeklyForecast[]) {
  const first = outletsForecast[0]?.selection;
  if (!first || first.status !== "SELECTED") return null;
  const consistent = outletsForecast.every(row => row.weeklyTotalMinor !== null && row.selection.status === "SELECTED" &&
    row.selection.source === first.source && row.selection.currency === first.currency && row.selection.firstTarget === first.firstTarget);
  if (!consistent) return null;
  const days = outletsForecast[0].days.map((day, i) => ({ targetDate: day.targetDate,
    forecastSalesMinor: outletsForecast.reduce((sum, row) => sum + row.days[i].forecast!.forecastSalesMinor, 0) }));
  return { source: first.source, currency: first.currency, dataThrough: first.dataThrough, firstTarget: first.firstTarget,
    days, totalMinor: days.reduce((sum, day) => sum + day.forecastSalesMinor, 0),
    dataThroughConsistent: outletsForecast.every(row => row.selection.status === "SELECTED" && row.selection.dataThrough === first.dataThrough) };
}

export type WeeklyForecast = Awaited<ReturnType<typeof getWeeklyForecast>>;
