import { randomUUID } from "node:crypto";
import { desc } from "drizzle-orm";
import { z } from "zod";

import { AccessError, type Scope } from "@/server/auth/access";
import { sandboxOrganisationId } from "@/server/config/deployment";
import type { Database, DatabaseSession } from "@/server/db/client";
import { auditEvents, fxReferenceRates } from "@/server/db/schema";
import { UserFacingError } from "@/server/domain/errors";
import { FX_RATE_SCALE, ProviderCurrencyRateUnavailableError, ZAR_PROVIDER_PAYOUT_CURRENCY, type ProviderCurrencyConversion } from "@/server/domain/provider-currency";

// DEC-SA-012 (Owner decision, 7 November 2026): payouts convert ZAR to USD at the most recent ECB
// reference rate, USD/ZAR derived from EUR/ZAR ÷ EUR/USD. The rate is locked in when a payout is
// reserved and never re-converted. If no rate from the last 3 business days is available,
// payouts are blocked (provider-fx-rate-unavailable).
//
// Freshness is counted in Monday-Friday days on the UTC calendar: a rate dated on or after the
// third weekday before today is fresh. ECB holidays (TARGET closing days) are not modelled, so a
// long holiday can make the newest rate look stale and block payouts: that fails closed, and an
// Owner can record the ECB's own published rate by hand.

export const ECB_DAILY_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
export const ECB_SOURCE = "ECB_EUROFXREF_DAILY";
export const MANUAL_SOURCE = "OWNER_MANUAL";
export const FX_FRESH_BUSINESS_DAYS = 3;
const FETCH_TIMEOUT_MS = 10_000;

export type FxReferenceRate = typeof fxReferenceRates.$inferSelect;
export type EcbQuote = { rateDate: string; eurZar: string; eurUsd: string };

const quote = z.string().regex(/^[0-9]{1,6}(\.[0-9]{1,6})?$/).refine(value => Number(value) > 0);
const isoDate = z.iso.date();
export const ecbQuoteSchema = z.object({ rateDate: isoDate, eurZar: quote, eurUsd: quote }).strict();

// A published decimal quote as an exact integer of millionths.
function millionths(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

// ZAR micro-units per one USD: EUR/ZAR ÷ EUR/USD, exactly, rounded up to the micro-unit so a
// converted USD amount never exceeds the exact cross rate. Same unit as work_payouts.fx_rate_micros.
export function deriveUsdZarMicros(eurZar: string, eurUsd: string): number {
  const numerator = millionths(eurZar) * BigInt(FX_RATE_SCALE), denominator = millionths(eurUsd);
  if (denominator <= 0n || numerator <= 0n) throw new Error("Reference quotes must be positive.");
  const micros = (numerator + denominator - 1n) / denominator;
  const value = Number(micros);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Derived rate out of range.");
  return value;
}

// The ECB daily file: one dated Cube with one Cube per currency. Only USD and ZAR are read; a file
// without both, or with more than one reference date, is refused rather than guessed at.
export function parseEcbDailyXml(xml: string): EcbQuote {
  const dates = [...xml.matchAll(/<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/g)].map(match => match[1]);
  if (dates.length !== 1) throw new Error("The ECB file does not contain exactly one reference date.");
  const rateOf = (currency: string) => {
    const found = [...xml.matchAll(new RegExp(`<Cube\\s+currency=['"]${currency}['"]\\s+rate=['"]([0-9.]+)['"]`, "g"))].map(match => match[1]);
    if (found.length !== 1) throw new Error(`The ECB file does not contain exactly one ${currency} rate.`);
    return found[0];
  };
  return ecbQuoteSchema.parse({ rateDate: dates[0], eurZar: rateOf("ZAR"), eurUsd: rateOf("USD") });
}

export async function fetchEcbDailyQuote(fetchImpl: typeof fetch = fetch): Promise<EcbQuote> {
  const response = await fetchImpl(ECB_DAILY_URL, { headers: { accept: "application/xml" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`The ECB reference file returned HTTP ${response.status}.`);
  return parseEcbDailyXml(await response.text());
}

const utcDate = (value: Date) => value.toISOString().slice(0, 10);
// The UTC date `count` Monday-Friday days before `now`'s UTC date.
export function businessDaysBefore(now: Date, count: number): string {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  let remaining = count;
  while (remaining > 0) {
    day.setUTCDate(day.getUTCDate() - 1);
    const weekday = day.getUTCDay();
    if (weekday !== 0 && weekday !== 6) remaining--;
  }
  return utcDate(day);
}
export function isFreshRateDate(rateDate: string, now: Date): boolean {
  return rateDate >= businessDaysBefore(now, FX_FRESH_BUSINESS_DAYS) && rateDate <= utcDate(now);
}

async function insertRate(db: DatabaseSession, value: EcbQuote, source: string, recordedBy: string | null) {
  const [row] = await db.insert(fxReferenceRates).values({
    id: randomUUID(), rateDate: value.rateDate, eurZar: value.eurZar, eurUsd: value.eurUsd,
    usdZarMicros: deriveUsdZarMicros(value.eurZar, value.eurUsd), source, recordedBy,
  }).onConflictDoNothing({ target: fxReferenceRates.rateDate }).returning();
  return row ?? null;
}

// Stores a fetched ECB quote. A date already recorded is kept as it is (rates are immutable).
export async function recordEcbQuote(db: DatabaseSession, value: EcbQuote, now = new Date()) {
  const parsed = ecbQuoteSchema.parse(value);
  if (parsed.rateDate > utcDate(now)) throw new Error("An ECB reference date cannot be in the future.");
  return { row: await insertRate(db, parsed, ECB_SOURCE, null), quote: parsed };
}

// Fallback when the ECB file can't be fetched: the Owner of the isolated Sandbox demo organisation
// types the ECB's published quotes for one reference date. Nobody else may, and a date already
// recorded is never replaced.
export async function recordManualFxRate(db: Database, scope: Pick<Scope, "userId" | "organisationId" | "role" | "demo">, input: unknown, now = new Date()) {
  if (scope.role !== "OWNER" || scope.demo || sandboxOrganisationId() !== scope.organisationId) throw new AccessError();
  const parsed = ecbQuoteSchema.safeParse(input);
  if (!parsed.success || parsed.data.rateDate > utcDate(now)) throw new UserFacingError("fx-rate-invalid", "Enter the ECB reference date and the EUR/ZAR and EUR/USD rates exactly as published.");
  return db.transaction(async tx => {
    const row = await insertRate(tx, parsed.data, MANUAL_SOURCE, scope.userId);
    if (!row) throw new UserFacingError("fx-rate-exists", "A reference rate for that date is already recorded. Recorded rates can't be changed.");
    await tx.insert(auditEvents).values({ id: randomUUID(), organisationId: scope.organisationId, action: "FX_REFERENCE_RATE_RECORDED", entityType: "fx_reference_rate", entityId: row.id,
      correlationId: `fx:${row.rateDate}`, metadata: { actorUserId: scope.userId, source: MANUAL_SOURCE, rateDate: row.rateDate, eurZar: row.eurZar, eurUsd: row.eurUsd, usdZarMicros: row.usdZarMicros } });
    return row;
  });
}

export async function latestFxReferenceRate(db: DatabaseSession): Promise<FxReferenceRate | null> {
  const [row] = await db.select().from(fxReferenceRates).orderBy(desc(fxReferenceRates.rateDate)).limit(1);
  return row ?? null;
}

// The frozen source recorded on a reservation: the rule and the ECB reference date it used.
export const fxRateSourceOf = (rate: Pick<FxReferenceRate, "source" | "rateDate">) => `${rate.source}:${rate.rateDate}`;

// The ZAR->USD conversion a new reservation locks in: the newest recorded reference rate, if it is
// fresh. Otherwise payouts are blocked with provider-fx-rate-unavailable.
export async function currentZarConversion(db: DatabaseSession, now = new Date()): Promise<ProviderCurrencyConversion> {
  const rate = await latestFxReferenceRate(db);
  if (!rate || !isFreshRateDate(rate.rateDate, now)) throw new ProviderCurrencyRateUnavailableError("ZAR", ZAR_PROVIDER_PAYOUT_CURRENCY);
  return { providerCurrency: ZAR_PROVIDER_PAYOUT_CURRENCY, fxRateMicros: rate.usdZarMicros, fxRateSource: fxRateSourceOf(rate) };
}
