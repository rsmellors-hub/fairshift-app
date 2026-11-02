import { z } from "zod";

// Ticketmaster Discovery API, for events listed near a location. The key travels in the query
// string as the API requires, so a request URL is never logged, stored or put in an error.
const DISCOVERY_EVENTS_URL = "https://app.ticketmaster.com/discovery/v2/events.json";
export const TICKETMASTER_SOURCE_LABEL = "Ticketmaster listing";
const PAGE_SIZE = 100;

// Optional. Without it, listed events are unavailable and Manager-entered events still work.
export const getTicketmasterApiKey = () => process.env.TICKETMASTER_API_KEY?.trim() || null;

export type EventFailureCode = "TIMEOUT" | "NETWORK_ERROR" | `HTTP_${number}` | "MALFORMED_RESPONSE";
export class EventProviderError extends Error {
  constructor(readonly code: EventFailureCode) { super(`Event listing request failed (${code}).`); this.name = "EventProviderError"; }
}

export type EventQuery = { latitude: number; longitude: number; radiusKm: number; from: Date; to: Date };
export type ProviderEvent = {
  providerId: string; name: string; venueName: string | null; localDate: string; localTime: string | null; latitude: number | null; longitude: number | null; status: string | null;
  // An end time only where the provider's fields really state one after the start.
  localEndTime?: string | null;
  // The provider says the listing spans days, or its stated end is a day or more after its start.
  multiDay?: boolean;
  // The provider's top-level classification. Its genre isn't read.
  segment?: string | null;
};

const localTimeSchema = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/);
const envelopeSchema = z.object({ _embedded: z.object({ events: z.array(z.unknown()) }).optional() });
const eventSchema = z.object({
  id: z.string().min(1), name: z.string().min(1),
  dates: z.object({
    start: z.object({ localDate: z.iso.date(), localTime: localTimeSchema.optional(), timeTBA: z.boolean().optional(), noSpecificTime: z.boolean().optional() }),
    end: z.object({ localDate: z.iso.date().optional(), localTime: localTimeSchema.optional(), noSpecificTime: z.boolean().optional() }).optional(),
    status: z.object({ code: z.string() }).optional(), spanMultipleDays: z.boolean().optional(),
  }),
  classifications: z.array(z.object({ primary: z.boolean().nullable().optional(), segment: z.object({ name: z.string().optional() }).optional() })).optional(),
  _embedded: z.object({ venues: z.array(z.object({ name: z.string().optional(), location: z.object({ latitude: z.coerce.number(), longitude: z.coerce.number() }).optional() })).optional() }).optional(),
});

const MINUTES_IN_DAY = 24 * 60;
const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

// What the provider's end fields really say. In the responses seen so far an end has the start's
// own local time and no date, and its instant matches the end of entry, so that states no end. An
// end on the next day counts as running to midnight, because a signal informs one date only.
function statedEnd(dates: z.infer<typeof eventSchema>["dates"], startTime: string | null) {
  const { start, end } = dates, endTime = end && !end.noSpecificTime ? end.localTime?.slice(0, 5) ?? null : null;
  if (!end?.localDate && endTime === null) return { localEndTime: null, longEnd: false };
  const dayGap = end?.localDate ? daysBetween(start.localDate, end.localDate) : 0;
  const longEnd = dayGap > 0 && dayGap * MINUTES_IN_DAY + (endTime === null ? MINUTES_IN_DAY : minutesOf(endTime)) - (startTime === null ? 0 : minutesOf(startTime)) >= MINUTES_IN_DAY;
  if (longEnd || dayGap < 0 || startTime === null) return { localEndTime: null, longEnd };
  if (dayGap > 0) return { localEndTime: "24:00", longEnd };
  return { localEndTime: endTime !== null && minutesOf(endTime) > minutesOf(startTime) ? endTime : null, longEnd };
}

// An empty page is a real answer, no listed events. One unusable entry is skipped, and an
// unreadable envelope is a failure, which keeps the last good listings.
export function parseTicketmasterEvents(raw: unknown): ProviderEvent[] {
  const envelope = envelopeSchema.safeParse(raw);
  if (!envelope.success) throw new EventProviderError("MALFORMED_RESPONSE");
  return (envelope.data._embedded?.events ?? []).flatMap(item => {
    const parsed = eventSchema.safeParse(item);
    if (!parsed.success) return [];
    const { id, name, dates, classifications, _embedded } = parsed.data, venue = _embedded?.venues?.[0];
    // A time the provider marks as to be announced isn't a start time.
    const localTime = dates.start.timeTBA || dates.start.noSpecificTime ? null : dates.start.localTime?.slice(0, 5) ?? null;
    const { localEndTime, longEnd } = statedEnd(dates, localTime);
    const classification = classifications?.find(row => row.primary) ?? classifications?.[0];
    return [{ providerId: id, name, venueName: venue?.name ?? null, localDate: dates.start.localDate, localTime, latitude: venue?.location?.latitude ?? null, longitude: venue?.location?.longitude ?? null, status: dates.status?.code ?? null, localEndTime, multiDay: dates.spanMultipleDays === true || longEnd, segment: classification?.segment?.name ?? null }];
  });
}

const instant = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");
export const ticketmasterRequestUrl = (query: EventQuery, apiKey: string) => {
  const url = new URL(DISCOVERY_EVENTS_URL);
  url.search = new URLSearchParams({ apikey: apiKey, latlong: `${query.latitude},${query.longitude}`, radius: String(query.radiusKm), unit: "km", startDateTime: instant(query.from), endDateTime: instant(query.to), size: String(PAGE_SIZE), sort: "date,asc" }).toString();
  return url.toString();
};

export async function fetchTicketmasterEvents(query: EventQuery, options: { apiKey: string; timeoutMs: number; fetchImpl?: typeof fetch }): Promise<ProviderEvent[]> {
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(ticketmasterRequestUrl(query, options.apiKey), { signal: AbortSignal.timeout(options.timeoutMs), cache: "no-store" });
  } catch (error) {
    throw new EventProviderError(error instanceof DOMException && error.name === "TimeoutError" ? "TIMEOUT" : "NETWORK_ERROR");
  }
  if (!response.ok) throw new EventProviderError(`HTTP_${response.status}`);
  let body: unknown;
  try { body = await response.json(); } catch { throw new EventProviderError("MALFORMED_RESPONSE"); }
  return parseTicketmasterEvents(body);
}
