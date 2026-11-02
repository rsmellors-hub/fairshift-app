import { createHash } from "node:crypto";
import type { ContextSignal } from "@/server/intelligence/demand-signals";
import { influenceWindow, overlaps } from "@/server/intelligence/event-influence";
import { parseClock, type TradingWindow } from "@/server/intelligence/workload";
import { TICKETMASTER_SOURCE_LABEL, type ProviderEvent } from "@/server/integrations/ticketmaster/events";

// Provider-listed events near a location, as LOCAL_EVENT signals. FS-CONTEXT-SIGNALS-DEC-001 D-S4
// fixes the 3 km radius. A listing has a start, rarely an end and no attendance, and none is
// invented. Its times go in its metadata, and its signal claims no period. It carries no direction:
// its effect depends on the venue.
export const EVENT_RADIUS_KM = 3;
// A bound on the model's input only, set well above what a date has been seen to list. Distance
// isn't importance: a stadium further off can matter more than a small room next door.
const MAX_EVENTS_PER_DAY = 15;
const CLOSED_STATUSES = new Set(["cancelled", "canceled", "postponed", "rescheduled"]);

export function distanceKm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = radians(b.latitude - a.latitude), dLon = radians(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

// Provider text is data. It is kept to a line, without control characters, before it is shown or sent.
const clean = (text: string, max: number) => text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

// Why a listing isn't a signal, counted for the audit trail and the evidence. Each is counted once,
// under the first rule it meets, in this order.
export const LISTING_EXCLUSIONS = ["OUTSIDE_PLANNING_WEEK", "CANCELLED_OR_MOVED", "OUTSIDE_RADIUS", "STANDING_OR_LONG_RUNNING", "OUTSIDE_TRADING_HOURS", "DUPLICATE", "OVER_DAY_LIMIT"] as const;
export type ListingExclusion = typeof LISTING_EXCLUSIONS[number];
export type ListingExclusions = Record<ListingExclusion, number>;

const STANDING_SEGMENT = "miscellaneous";
const standingKey = (event: ProviderEvent) => [clean(event.name, 120).toLowerCase(), event.venueName ? clean(event.venueName, 80).toLowerCase() : "", event.localTime ?? ""].join("|");

// FS-CONTEXT-SIGNALS-DEC-002, from the provider's own classification and date fields, with no name
// or genre read. The provider has no field for a standing attraction: it lists one as a dated event
// each day. A listing in its Miscellaneous segment repeated at one venue and time on another date
// is treated as one. Repeated performances in its other segments are dated events, and stay.
function standingOrLongRunning(events: readonly ProviderEvent[]) {
  const dates = new Map<string, Set<string>>();
  for (const event of events) if (event.segment?.trim().toLowerCase() === STANDING_SEGMENT) dates.set(standingKey(event), (dates.get(standingKey(event)) ?? new Set()).add(event.localDate));
  return (event: ProviderEvent) => event.multiDay === true || (dates.get(standingKey(event))?.size ?? 0) > 1;
}

// `tradingFor` gives a date's trading windows: empty when closed, null when not known. An event
// with no start time has no window to compare, so it stays unless the venue is closed that day.
export function listingSignals(input: { organisationId: string; outletId: string; latitude: number; longitude: number; firstDate: string; lastDate: string; events: readonly ProviderEvent[]; fetchedAt: Date; tradingFor?: (date: string) => readonly TradingWindow[] | null }): { signals: ContextSignal[]; excluded: ListingExclusions } {
  type Located = ProviderEvent & { distance: number | null };
  const excluded = Object.fromEntries(LISTING_EXCLUSIONS.map(reason => [reason, 0])) as ListingExclusions;
  const seen = new Map<string, Located>(), byDate = new Map<string, Located[]>();
  const located = input.events.flatMap(event => {
    if (event.localDate < input.firstDate || event.localDate > input.lastDate) { excluded.OUTSIDE_PLANNING_WEEK++; return []; }
    if (CLOSED_STATUSES.has(event.status?.toLowerCase() ?? "")) { excluded.CANCELLED_OR_MOVED++; return []; }
    const distance = event.latitude !== null && event.longitude !== null ? distanceKm(input, { latitude: event.latitude, longitude: event.longitude }) : null;
    if (distance !== null && distance > EVENT_RADIUS_KM) { excluded.OUTSIDE_RADIUS++; return []; }
    return [{ ...event, distance }];
  });
  const isStanding = standingOrLongRunning(located);
  for (const event of located) {
    if (isStanding(event)) { excluded.STANDING_OR_LONG_RUNNING++; continue; }
    const trading = input.tradingFor?.(event.localDate) ?? null;
    if (trading) {
      const window = event.localTime === null ? null : influenceWindow(parseClock(event.localTime), event.localEndTime ? parseClock(event.localEndTime) : null);
      if (!trading.length || (window && !trading.some(open => overlaps(window, open)))) { excluded.OUTSIDE_TRADING_HOURS++; continue; }
    }
    const name = clean(event.name, 120), venueName = event.venueName ? clean(event.venueName, 80) : null;
    // Listings repeat one event for packages and hospitality, under other names. One venue and
    // start time counts once, under its plainest name. Without both, nothing can be matched.
    const key = venueName && event.localTime ? [venueName.toLowerCase(), event.localDate, event.localTime].join("|") : `id:${event.providerId}`;
    const held = seen.get(key);
    if (held) excluded.DUPLICATE++;
    if (!held || name.length < held.name.length) seen.set(key, { ...event, name, venueName });
  }
  for (const event of seen.values()) byDate.set(event.localDate, [...(byDate.get(event.localDate) ?? []), event]);
  const kept = [...byDate.values()].flatMap(rows => {
    const ordered = [...rows].sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity) || a.providerId.localeCompare(b.providerId));
    excluded.OVER_DAY_LIMIT += Math.max(0, ordered.length - MAX_EVENTS_PER_DAY);
    return ordered.slice(0, MAX_EVENTS_PER_DAY);
  });
  const signals = kept.map(event => {
    const distanceKmRounded = event.distance === null ? null : Math.round(event.distance * 10) / 10;
    const facts = { providerId: event.providerId, name: event.name, venue: event.venueName, startTime: event.localTime, endTime: event.localEndTime ?? null, distanceKm: distanceKmRounded };
    return {
      id: `ctx_${createHash("sha256").update(["PROVIDER_EVENT", input.outletId, event.localDate, JSON.stringify(facts)].join("|")).digest("hex").slice(0, 24)}`,
      organisationId: input.organisationId, outletId: input.outletId, type: "LOCAL_EVENT" as const, validFrom: event.localDate, validTo: event.localDate, period: null, direction: "UNSPECIFIED" as const,
      provenance: "PROVIDER_EVENT" as const, sourceLabel: TICKETMASTER_SOURCE_LABEL, sourceRef: `ticketmaster:event:${event.providerId}`,
      summary: `Listed event: ${event.name}${event.venueName ? ` at ${event.venueName}` : ""}, ${event.localTime ? `starts ${event.localTime}` : "start time not given"}${event.localEndTime ? `, ends ${event.localEndTime}` : ""}${distanceKmRounded === null ? "" : `, ${distanceKmRounded} km away`}.`,
      metadata: facts, enteredBy: null, createdAt: input.fetchedAt, withdrawnAt: null,
    };
  });
  return { signals, excluded };
}

export const eventSignals = (input: Parameters<typeof listingSignals>[0]): ContextSignal[] => listingSignals(input).signals;
