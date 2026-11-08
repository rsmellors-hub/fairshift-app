import { eq } from "drizzle-orm";
import { z } from "zod";
import type { DatabaseSession } from "@/server/db/client";
import { externalFeeds } from "@/server/db/schema";
import { classifySaDate, SA_PUBLIC_HOLIDAYS_SOURCE } from "@/server/reference/sa-public-holidays";

// South African public holidays from a live public feed (Nager.Date, which lists ZA), fetched on a
// schedule and when the server starts. FairShift's committed rule-based reference
// (sa-public-holidays.ts) is the fallback only, labelled as such, for any date the feed doesn't
// cover. A holiday is a fact about a date: it carries no demand effect of its own.

export const NAGER_DATE_URL = "https://date.nager.at/api/v3/PublicHolidays";
export const HOLIDAY_FEED_LABEL = "Nager.Date public holidays API";
export const HOLIDAY_FALLBACK_LABEL = "FairShift’s built-in South African holiday rules (fallback)";
// A feed not refreshed for a week is shown as stale.
export const HOLIDAY_FEED_STALE_HOURS = 7 * 24;
const FETCH_TIMEOUT_MS = 8_000;

export const holidayFeedKey = (countryCode: string) => `HOLIDAYS:${countryCode}`;
export const isSouthAfrica = (country: string | null | undefined) => /^(south africa|za)$/i.test(country?.trim() ?? "");
export const holidayFeedUrl = (year: number, countryCode: string) => `${NAGER_DATE_URL}/${year}/${countryCode}`;

export type FeedHoliday = { date: string; localName: string; name: string };
export type HolidayFeedPayload = { countryCode: string; years: Record<string, FeedHoliday[]> };
type FeedRow = typeof externalFeeds.$inferSelect;

const rowSchema = z.object({ date: z.iso.date(), localName: z.string().min(1).max(200), name: z.string().min(1).max(200), countryCode: z.string(), types: z.array(z.string()).nullish() }).passthrough();

// Public holidays of one year for one country, refusing anything that isn't that country and year.
export function parseNagerHolidays(raw: unknown, year: number, countryCode: string): FeedHoliday[] {
  const parsed = z.array(rowSchema).max(100).parse(raw);
  return parsed.filter(row => row.countryCode === countryCode && row.date.startsWith(`${year}-`) && (!row.types || row.types.includes("Public")))
    .map(row => ({ date: row.date, localName: row.localName.replace(/[\u0000-\u001f\u007f]/g, " ").trim(), name: row.name.replace(/[\u0000-\u001f\u007f]/g, " ").trim() }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export async function fetchNagerHolidays(year: number, countryCode: string, fetchImpl: typeof fetch = fetch) {
  const response = await fetchImpl(holidayFeedUrl(year, countryCode), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  return parseNagerHolidays(await response.json(), year, countryCode);
}

// This year and next, so December planning sees January. A failure keeps the last good list.
export async function refreshHolidayFeed(db: DatabaseSession, options: { countryCode?: string; now?: Date; fetchImpl?: typeof fetch } = {}): Promise<"REFRESHED" | "FAILED"> {
  const countryCode = options.countryCode ?? "ZA", now = options.now ?? new Date(), feed = holidayFeedKey(countryCode);
  const year = Number(now.toISOString().slice(0, 4));
  const [existing] = await db.select().from(externalFeeds).where(eq(externalFeeds.feed, feed));
  try {
    const years = Object.fromEntries(await Promise.all([year, year + 1].map(async value => [String(value), await fetchNagerHolidays(value, countryCode, options.fetchImpl)] as const)));
    const payload: HolidayFeedPayload = { countryCode, years: { ...((existing?.payload as HolidayFeedPayload | undefined)?.years ?? {}), ...years } };
    await db.insert(externalFeeds).values({ feed, sourceUrl: holidayFeedUrl(year, countryCode), lastAttemptAt: now, lastSuccessAt: now, lastFailureCode: null, payload })
      .onConflictDoUpdate({ target: externalFeeds.feed, set: { sourceUrl: holidayFeedUrl(year, countryCode), lastAttemptAt: now, lastSuccessAt: now, lastFailureCode: null, payload } });
    return "REFRESHED";
  } catch (error) {
    const code = error instanceof Error && /^HTTP_\d+$/.test(error.message) ? error.message : error instanceof z.ZodError ? "MALFORMED_RESPONSE" : "NETWORK_ERROR";
    console.error("Holiday feed refresh failed; the last good list stands.", { feed, code });
    await db.insert(externalFeeds).values({ feed, sourceUrl: holidayFeedUrl(year, countryCode), lastAttemptAt: now, lastFailureCode: code, payload: existing?.payload ?? { countryCode, years: {} } })
      .onConflictDoUpdate({ target: externalFeeds.feed, set: { lastAttemptAt: now, lastFailureCode: code } });
    return "FAILED";
  }
}

export type HolidayFact = { date: string; name: string; origin: "FEED" | "FALLBACK"; sourceLabel: string; sourceUrl: string; verification: string | null };
export type FeedFreshness = { status: "NOT_FETCHED" | "FRESH" | "STALE"; updatedAt: Date | null; lastAttemptAt: Date | null; lastFailureCode: string | null };

export function feedFreshness(row: Pick<FeedRow, "lastAttemptAt" | "lastSuccessAt" | "lastFailureCode"> | null | undefined, staleHours: number, now: Date): FeedFreshness {
  if (!row?.lastSuccessAt) return { status: "NOT_FETCHED", updatedAt: null, lastAttemptAt: row?.lastAttemptAt ?? null, lastFailureCode: row?.lastFailureCode ?? null };
  const age = (now.getTime() - row.lastSuccessAt.getTime()) / 3_600_000;
  return { status: age >= staleHours || row.lastFailureCode ? "STALE" : "FRESH", updatedAt: row.lastSuccessAt, lastAttemptAt: row.lastAttemptAt, lastFailureCode: row.lastFailureCode };
}

// What FairShift knows about one date's holiday: from the feed when it covers the year, else from the
// labelled fallback rules when they cover the date, else nothing (undefined: unknown, not "no holiday").
export function holidayLookup(row: Pick<FeedRow, "payload" | "sourceUrl"> | null | undefined, countryCode = "ZA") {
  const years = (row?.payload as HolidayFeedPayload | undefined)?.years ?? {};
  return (date: string): HolidayFact | null | undefined => {
    const listed = years[date.slice(0, 4)];
    if (listed) {
      const holiday = listed.find(entry => entry.date === date);
      return holiday ? { date, name: holiday.localName || holiday.name, origin: "FEED", sourceLabel: HOLIDAY_FEED_LABEL, sourceUrl: holidayFeedUrl(Number(date.slice(0, 4)), countryCode), verification: null } : null;
    }
    if (countryCode !== "ZA") return undefined;
    const fallback = classifySaDate(date);
    if (fallback.status === "OUTSIDE_REFERENCE") return undefined;
    return fallback.status === "PUBLIC_HOLIDAY" ? { date, name: fallback.holiday.name, origin: "FALLBACK", sourceLabel: HOLIDAY_FALLBACK_LABEL, sourceUrl: SA_PUBLIC_HOLIDAYS_SOURCE.url, verification: fallback.holiday.verification } : null;
  };
}
