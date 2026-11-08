import { inArray } from "drizzle-orm";
import type { DatabaseSession } from "@/server/db/client";
import { externalFeeds } from "@/server/db/schema";
import { ECB_FEED, isFreshRateDate, latestFxReferenceRate } from "@/server/fx/reference-rates";
import { feedFreshness, holidayFeedKey, HOLIDAY_FEED_STALE_HOURS, type FeedFreshness, type HolidayFeedPayload } from "@/server/reference/public-holiday-feed";

// The organisation-independent feeds, as the Owner sees them: the South African holiday feed and the
// ECB reference rate, each with when it last updated and whether it has fallen behind.
const ECB_FEED_STALE_HOURS = 30;

export type LiveFeedStatus = {
  holidays: FeedFreshness & { years: string[] };
  ecb: FeedFreshness & { fresh: boolean; rate: { rateDate: string; usdZarMicros: number; source: string; recordedAt: Date } | null };
};

export async function getLiveFeedStatus(db: DatabaseSession, now = new Date()): Promise<LiveFeedStatus> {
  const rows = await db.select().from(externalFeeds).where(inArray(externalFeeds.feed, [holidayFeedKey("ZA"), ECB_FEED]));
  const holidays = rows.find(row => row.feed === holidayFeedKey("ZA")), ecb = rows.find(row => row.feed === ECB_FEED);
  const rate = await latestFxReferenceRate(db);
  return {
    holidays: { ...feedFreshness(holidays, HOLIDAY_FEED_STALE_HOURS, now), years: Object.keys((holidays?.payload as HolidayFeedPayload | undefined)?.years ?? {}).sort() },
    ecb: { ...feedFreshness(ecb, ECB_FEED_STALE_HOURS, now), fresh: !!rate && isFreshRateDate(rate.rateDate, now), rate: rate ? { rateDate: rate.rateDate, usdZarMicros: rate.usdZarMicros, source: rate.source, recordedAt: rate.createdAt } : null },
  };
}
