import { randomUUID } from "node:crypto";
import { desc } from "drizzle-orm";
import { z } from "zod";

import type { DatabaseSession } from "@/server/db/client";
import { fxReferenceRates } from "@/server/db/schema";
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
// The external_feeds row recording the scheduled fetch of the ECB file.
export const ECB_FEED = "ECB_EUROFXREF";
export const MANUAL_SOURCE = "OWNER_MANUAL";
export const FX_FRESH_BUSINESS_DAYS = 3;
const FETCH_TIMEOUT_MS = 10_000;

export type FxReferenceRate = typeof fxReferenceRates.$inferSelect;
export type EcbQuote = { rateDate: string; eurZar: string; eurUsd: string; eurGbp?: string };

const quote = z.string().regex(/^[0-9]{1,6}(\.[0-9]{1,6})?$/).refine(value => Number(value) > 0);
const isoDate = z.iso.date();
export const ecbQuoteSchema = z.object({ rateDate: isoDate, eurZar: quote, eurUsd: quote, eurGbp: quote.optional() }).strict();

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
  // GBP is read when the file has it (it always should); its absence never blocks ZAR payouts.
  const gbp = [...xml.matchAll(/<Cube\s+currency=['"]GBP['"]\s+rate=['"]([0-9.]+)['"]/g)].map(match => match[1]);
  return ecbQuoteSchema.parse({ rateDate: dates[0], eurZar: rateOf("ZAR"), eurUsd: rateOf("USD"), ...(gbp.length === 1 ? { eurGbp: gbp[0] } : {}) });
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
    id: randomUUID(), rateDate: value.rateDate, eurZar: value.eurZar, eurUsd: value.eurUsd, eurGbp: value.eurGbp ?? null,
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
