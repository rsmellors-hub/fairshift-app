import { createHash, randomUUID } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import { assertRole, type Scope } from "@/server/auth/access";
import { auditActor } from "@/server/auth/audit-actor";
import { requireEntitlement } from "@/server/billing/entitlement";
import { ingestCommerceObservations } from "@/server/commerce/ingestion";
import type { Database, DatabaseSession } from "@/server/db/client";
import { auditEvents, outletTradingHours, outlets, saleTransactions } from "@/server/db/schema";
import { resolveLocationCurrency } from "@/server/domain/currency";
import { UserFacingError } from "@/server/domain/errors";
import { localDateTimeToInstant } from "@/server/domain/timezone";
import { localDate, shiftDate } from "@/server/intelligence/forecast";
import { tradingWindowsSchema, type TradingWindow } from "@/server/intelligence/workload";
import { organisations } from "@/server/db/schema";

// Sales history for a new business (Owner decision 10 Nov 2026, item 2; design Setup step 4): an Owner's
// CSV, labelled "Imported by Owner (CSV, <date>)", or FairShift's sample history, labelled "Sample
// (synthetic)". Both enter through the canonical ingestion boundary as IMPORTED history, so they count
// toward the 28-day rule exactly like any imported history, and a provider (Square) replaces them once
// its own history qualifies. The sample is set aside once the Owner uploads real sales. Sales value
// never sets staffing; transactions do.

export const SAMPLE_SOURCE_SYSTEM = "FAIRSHIFT_SAMPLE_V1";
export const CSV_SOURCE_PREFIX = "OWNER_CSV:";
export const historyLabel = (sourceSystem: string | null) => sourceSystem === SAMPLE_SOURCE_SYSTEM ? "Sample (synthetic)"
  : sourceSystem?.startsWith(CSV_SOURCE_PREFIX) ? `Imported by Owner (CSV, ${sourceSystem.slice(CSV_SOURCE_PREFIX.length)})` : "Imported";

// The sample's shape: bills per seat per day by venue type, the busy hours, and the week. These shape a
// labelled synthetic history only; nothing real is claimed from them.
const PER_SEAT = { CAFE_RESTAURANT: 2.2, BAR: 1.3, TAKEAWAY: 3.4 } as const;
const WEEK = [0.86, 0.86, 0.9, 0.98, 1.18, 1.34, 1.12]; // Monday..Sunday
const PEAKS: Record<keyof typeof PER_SEAT, [number, number][]> = {
  CAFE_RESTAURANT: [[8.5, 1.2], [13, 1.6], [18.5, 1]], BAR: [[18, 1.2], [21, 1.6]], TAKEAWAY: [[12.5, 1.6], [18.5, 1.4]],
};
// A typical bill, in each currency's major units, so sample sales values look plausible. Display only.
const TYPICAL_BILL: Record<string, number> = { ZAR: 145, GBP: 14, USD: 18, EUR: 16 };
const DAYS = 56;

function unit(seed: string) { const hash = createHash("sha256").update(seed).digest(); return hash.readUInt32BE(0) / 0xffffffff; }
const weekdayIndex = (date: string) => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

async function locationFor(db: DatabaseSession, scope: Scope) {
  const [row] = await db.select({ outlet: outlets, organisationCountry: organisations.country }).from(outlets).innerJoin(organisations, eq(organisations.id, outlets.organisationId))
    .where(and(eq(outlets.id, scope.locationId), eq(outlets.organisationId, scope.organisationId), eq(outlets.active, true)));
  if (!row) throw new Error("Location unavailable.");
  const trading = await db.select().from(outletTradingHours).where(eq(outletTradingHours.outletId, row.outlet.id));
  const week = Array.from({ length: 7 }, (_, i) => { const day = trading.find(t => t.isoWeekday === i + 1); return day ? tradingWindowsSchema.parse(day.windows) as TradingWindow[] : null; });
  return { outlet: row.outlet, currency: resolveLocationCurrency({ locationCountry: row.outlet.country, organisationCountry: row.organisationCountry }), week };
}

// Minutes the location trades on a date, as a list of open minutes in 15-minute steps.
const openSlots = (windows: TradingWindow[] | null) => (windows ?? []).flatMap(w => { const out: number[] = []; for (let m = w.start; m < w.end; m += 15) out.push(m); return out; });

async function ingestDays(db: Database, scope: Scope, sourceSystem: string, observations: { outletId: string; sourceTransactionId: string; occurredAt: string; currencyCode: string; grossAmountMinor: number; status: "COMPLETED" }[], now: Date) {
  let inserted = 0;
  for (let i = 0; i < observations.length; i += 9_000) inserted += (await ingestCommerceObservations(db, { organisationId: scope.organisationId, source: "IMPORTED", sourceSystem, observations: observations.slice(i, i + 9_000), now })).inserted;
  return inserted;
}

export async function hasCsvHistory(db: DatabaseSession, outletId: string) {
  const [row] = await db.select({ id: saleTransactions.id }).from(saleTransactions).where(and(eq(saleTransactions.outletId, outletId), eq(saleTransactions.source, "IMPORTED"), like(saleTransactions.sourceSystem, `${CSV_SOURCE_PREFIX}%`))).limit(1);
  return !!row;
}

// "Use sample history for my venue": the last 56 completed days, scaled to seats and venue type over the
// location's trading hours. Deterministic, so running it again adds nothing.
export async function generateSampleHistory(db: Database, scope: Scope, now = new Date()) {
  assertRole(scope, ["OWNER"]);
  await requireEntitlement(db, scope.organisationId);
  const { outlet, currency, week } = await locationFor(db, scope);
  if (!outlet.venueType || !outlet.seats) throw new UserFacingError("sample-needs-venue", "Add the venue type and seats first, so the sample matches your venue.");
  if (!week.some(day => day && day.length)) throw new UserFacingError("sample-needs-hours", "Add trading hours first, so the sample follows when you're open.");
  if (await hasCsvHistory(db, outlet.id)) throw new UserFacingError("sample-after-csv", "You've imported real sales, so the sample isn't needed.");
  const today = localDate(now, outlet.timezone);
  const bill = (TYPICAL_BILL[currency] ?? 15) * 100;
  const observations: Parameters<typeof ingestDays>[3] = [];
  for (let back = DAYS; back >= 1; back--) {
    const date = shiftDate(today, -back), weekday = weekdayIndex(date);
    const slots = openSlots(week[weekday]);
    if (!slots.length) continue;
    const noise = 0.92 + unit(`${outlet.id}:${date}:day`) * 0.16;
    const total = Math.max(1, Math.round(outlet.seats * PER_SEAT[outlet.venueType as keyof typeof PER_SEAT] * WEEK[weekday] * noise));
    const weights = slots.map(m => PEAKS[outlet.venueType as keyof typeof PEAKS].reduce((sum, [hour, size]) => sum + size * Math.exp(-(((m / 60) - hour) ** 2) / 2), 0.25));
    const sum = weights.reduce((a, b) => a + b, 0);
    let made = 0;
    slots.forEach((minute, i) => {
      const count = i === slots.length - 1 ? total - made : Math.round(total * weights[i] / sum);
      for (let n = 0; n < Math.max(0, count); n++) {
        const at = minute + Math.floor(unit(`${outlet.id}:${date}:${minute}:${n}:m`) * 15);
        observations.push({ outletId: outlet.id, sourceTransactionId: `sample:${date}:${minute}:${n}`, occurredAt: localDateTimeToInstant(`${date}T${clock(at)}`, outlet.timezone).toISOString(),
          currencyCode: currency, grossAmountMinor: Math.round(bill * (0.6 + unit(`${outlet.id}:${date}:${minute}:${n}:a`) * 0.8)), status: "COMPLETED" });
      }
      made += Math.max(0, count);
    });
  }
  const inserted = await ingestDays(db, scope, SAMPLE_SOURCE_SYSTEM, observations, now);
  await db.insert(auditEvents).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: outlet.id, action: "SAMPLE_HISTORY_CREATED", entityType: "outlet", entityId: outlet.id,
    correlationId: `sample-history:${outlet.id}:${Date.now()}`, metadata: { ...auditActor(scope), days: DAYS, transactions: observations.length, inserted, label: "Sample (synthetic)" } });
  return { days: DAYS, transactions: observations.length, inserted };
}

// CSV with a header: date,transactions[,sales] for daily totals, or date,hour,transactions[,sales] for hourly
// totals. Daily totals are spread over the day's trading hours. Sales is optional (display only).
export async function importSalesCsv(db: Database, scope: Scope, text: string, now = new Date()) {
  assertRole(scope, ["OWNER"]);
  await requireEntitlement(db, scope.organisationId);
  const { outlet, currency, week } = await locationFor(db, scope);
  const lines = text.replace(/\r/g, "").split("\n").map(line => line.trim()).filter(Boolean);
  if (lines.length < 2 || lines.length > 20_000) throw new UserFacingError("csv-invalid", "The file needs a header row and at least one row of sales, and no more than 20,000 rows.");
  const header = lines[0].toLowerCase().split(",").map(cell => cell.trim());
  const col = (name: string) => header.indexOf(name);
  if (col("date") < 0 || col("transactions") < 0) throw new UserFacingError("csv-invalid", "The header must include date and transactions (and optionally hour and sales).");
  const today = localDate(now, outlet.timezone);
  const observations: Parameters<typeof ingestDays>[3] = [];
  for (const [index, line] of lines.slice(1).entries()) {
    const cells = line.split(",").map(cell => cell.trim());
    const date = cells[col("date")], count = Number(cells[col("transactions")]), hour = col("hour") >= 0 ? cells[col("hour")] : "";
    const sales = col("sales") >= 0 && cells[col("sales")] ? Number(cells[col("sales")]) : null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") || date >= today || !Number.isInteger(count) || count < 0 || count > 5000 || (sales !== null && !(sales >= 0)) || (hour && !/^\d{1,2}(:00)?$/.test(hour)))
      throw new UserFacingError("csv-invalid", `Row ${index + 2} couldn't be read: use a past date (YYYY-MM-DD), a whole number of transactions, and optionally an hour (0–23) and sales.`);
    const minutes = hour ? [Number(hour.split(":")[0]) * 60] : openSlots(week[weekdayIndex(date)]);
    if (!minutes.length) throw new UserFacingError("csv-invalid", `Row ${index + 2}: ${date} is a closed day in your trading hours, so daily totals can't be placed. Add an hour column or check the trading hours.`);
    const each = sales === null || count === 0 ? 0 : Math.round(sales * 100 / count);
    for (let n = 0; n < count; n++) {
      const minute = minutes[n % minutes.length] + (hour ? Math.floor((n * 59) / Math.max(1, count)) : 0);
      observations.push({ outletId: outlet.id, sourceTransactionId: `csv:${date}:${hour || "day"}:${n}`, occurredAt: localDateTimeToInstant(`${date}T${clock(Math.min(minute, 1439))}`, outlet.timezone).toISOString(),
        currencyCode: currency, grossAmountMinor: each, status: "COMPLETED" });
    }
  }
  if (!observations.length) throw new UserFacingError("csv-invalid", "The file has no transactions to import.");
  const sourceSystem = `${CSV_SOURCE_PREFIX}${today}`;
  const inserted = await ingestDays(db, scope, sourceSystem, observations, now);
  await db.insert(auditEvents).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: outlet.id, action: "SALES_CSV_IMPORTED", entityType: "outlet", entityId: outlet.id,
    correlationId: `sales-csv:${outlet.id}:${Date.now()}`, metadata: { ...auditActor(scope), rows: lines.length - 1, transactions: observations.length, inserted, label: historyLabel(sourceSystem) } });
  return { rows: lines.length - 1, transactions: observations.length, inserted };
}

// Which imported history a location has, for labels.
export async function importedHistoryLabels(db: DatabaseSession, outletId: string) {
  const rows = await db.select({ system: saleTransactions.sourceSystem, count: sql<number>`count(*)::int` }).from(saleTransactions)
    .where(and(eq(saleTransactions.outletId, outletId), eq(saleTransactions.source, "IMPORTED"))).groupBy(saleTransactions.sourceSystem);
  return rows.map(row => ({ label: historyLabel(row.system), transactions: row.count, sample: row.system === SAMPLE_SOURCE_SYSTEM }));
}
