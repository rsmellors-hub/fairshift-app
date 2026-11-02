import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fetchOpenMeteoHourly, openMeteoRequestUrl, parseOpenMeteoHourly, WeatherProviderError } from "@/server/integrations/open-meteo/forecast";
import { EventProviderError, fetchTicketmasterEvents, parseTicketmasterEvents, type ProviderEvent } from "@/server/integrations/ticketmaster/events";
import { prepareContextInput, validateContextOutput, contextJsonSchema, CONTEXT_INSTRUCTIONS } from "@/server/intelligence/demand-context-contract";
import type { ContextSignal } from "@/server/intelligence/demand-signals";
import { eventInfluence, influenceWindow } from "@/server/intelligence/event-influence";
import { distanceKm, EVENT_RADIUS_KM, eventSignals, listingSignals } from "@/server/intelligence/event-signal";
import { shiftDate } from "@/server/intelligence/forecast";
import { buildStructuredSignal } from "@/server/intelligence/manager-signals";
import { VENUE_PROFILES, venueContextSchema, venueProfileOf } from "@/server/intelligence/venue-profile";
import { summariseWeather, toLocalHours, weatherBands, weatherSignal, type LocalHour } from "@/server/intelligence/weather-signal";
import { calculateDayWorkload, type TransactionSlot } from "@/server/intelligence/workload";
import { REFERENCE_STORES, REFERENCE_VENUE_CONTEXT } from "@/server/reference/uk-hospitality";

const ORG = "org-1", OUTLET = "outlet-1", DATE = "2026-11-04", FETCHED = new Date("2026-11-02T18:00:00Z");
// The weather fixture is a saved genuine response, trimmed to the fields FairShift reads. The
// listings fixture is invented, in the provider's shape, and marked as synthetic.
const fixture = (name: string) => JSON.parse(readFileSync(`tests/fixtures/context-signals/${name}.json`, "utf8"));

const hour = (minute: number, rainChancePercent: number | null, temperatureC: number | null = 10, rainMm: number | null = 0): LocalHour => ({ date: DATE, minute, rainChancePercent, rainMm, temperatureC });
const signalFrom = (hours: LocalHour[], trading: { start: number; end: number }[] | null = [{ start: 540, end: 1080 }]) => weatherSignal({ organisationId: ORG, outletId: OUTLET, date: DATE, hours, trading, fetchedAt: FETCHED });

describe("weather parsing and local time", () => {
  it("reads a saved genuine Open-Meteo response", () => {
    const hours = parseOpenMeteoHourly(fixture("open-meteo-leeds"));
    expect(hours.length).toBeGreaterThanOrEqual(24 * 7);
    expect(hours[0].at).toBeInstanceOf(Date);
    expect(hours.every(row => row.temperatureC === null || (row.temperatureC > -40 && row.temperatureC < 50))).toBe(true);
  });
  it("asks for the three hourly values, in unix time, with no key", () => {
    const url = openMeteoRequestUrl({ latitude: 53.8, longitude: -1.5 });
    for (const text of ["precipitation_probability", "precipitation", "temperature_2m", "timeformat=unixtime", "forecast_days=8"]) expect(url).toContain(text);
    expect(url).not.toMatch(/key/i);
  });
  it("refuses a malformed or misaligned response whole", () => {
    for (const raw of [null, {}, { hourly: {} }, { hourly: { time: [1], precipitation_probability: [], precipitation: [1], temperature_2m: [1] } }, { hourly: { time: [], precipitation_probability: [], precipitation: [], temperature_2m: [] } }]) expect(() => parseOpenMeteoHourly(raw)).toThrow(WeatherProviderError);
  });
  it("names each failure and doesn't throw raw errors", async () => {
    const codeOf = async (impl: typeof fetch) => fetchOpenMeteoHourly({ latitude: 1, longitude: 1 }, { timeoutMs: 100, fetchImpl: impl }).then(() => "OK", error => (error as WeatherProviderError).code);
    expect(await codeOf(async () => new Response("no", { status: 503 }))).toBe("HTTP_503");
    expect(await codeOf(async () => { throw new TypeError("offline"); })).toBe("NETWORK_ERROR");
    expect(await codeOf(async () => { throw new DOMException("late", "TimeoutError"); })).toBe("TIMEOUT");
    expect(await codeOf(async () => new Response("<html>"))).toBe("MALFORMED_RESPONSE");
  });
  const instant = (iso: string) => ({ at: new Date(iso), rainChancePercent: 1, rainMm: 0, temperatureC: 1 });
  it("converts to the venue's own clock, in summer, in winter and across date lines", () => {
    expect(toLocalHours([instant("2026-07-01T12:00:00Z")], "Europe/London")[0]).toMatchObject({ date: "2026-07-01", minute: 13 * 60 });
    expect(toLocalHours([instant("2026-12-01T12:00:00Z")], "Europe/London")[0]).toMatchObject({ date: "2026-12-01", minute: 12 * 60 });
    expect(toLocalHours([instant("2026-07-01T23:30:00Z")], "Europe/London")[0]).toMatchObject({ date: "2026-07-02", minute: 30 });
    expect(toLocalHours([instant("2026-12-01T12:00:00Z")], "Africa/Johannesburg")[0]).toMatchObject({ date: "2026-12-01", minute: 14 * 60 });
  });
  it("keeps the first reading in the hour the clocks repeat, and has none for the one they skip", () => {
    const back = toLocalHours([instant("2026-10-25T00:00:00Z"), instant("2026-10-25T01:00:00Z"), instant("2026-10-25T02:00:00Z")], "Europe/London");
    expect(back.map(row => row.minute)).toEqual([60, 120]);
    const forward = toLocalHours([instant("2026-03-29T00:00:00Z"), instant("2026-03-29T01:00:00Z")], "Europe/London");
    expect(forward.map(row => row.minute)).toEqual([0, 120]);
  });
});

describe("the weather signal", () => {
  it("writes its own summary, from what was forecast", () => {
    const summary = signalFrom([hour(540, 10), hour(600, 20, 11), hour(900, 60), hour(960, 80), hour(1020, 70)])!.summary;
    expect(summary).toBe("Rain likely 15:00–18:00 (up to 80%), top 11°C");
  });
  it("words each level, and says when a figure isn't given", () => {
    const at = (chance: number | null) => [{ minute: 600, time: "10:00", rainChancePercent: chance, rainMm: 0, temperatureC: 9 }];
    expect(summariseWeather(at(0))).toBe("Rain chance 0%, top 9°C");
    expect(summariseWeather(at(20))).toBe("Low chance of rain (up to 20%), top 9°C");
    expect(summariseWeather(at(30))).toBe("Rain possible 10:00–11:00 (up to 30%), top 9°C");
    expect(summariseWeather(at(50))).toBe("Rain likely 10:00–11:00 (up to 50%), top 9°C");
    expect(summariseWeather(at(null))).toBe("Rain chance not given, top 9°C");
  });
  it("carries provenance, the trading-hours span, hourly values, and no direction", () => {
    const signal = signalFrom([hour(540, 40), hour(600, 44, 11.4, 0.3)])!;
    expect(signal).toMatchObject({ type: "WEATHER_FORECAST", provenance: "PROVIDER_FORECAST", direction: "UNSPECIFIED", sourceLabel: "Open-Meteo forecast", period: { start: 540, end: 1080 }, validFrom: DATE, validTo: DATE, createdAt: FETCHED });
    expect(signal.sourceRef).toContain("open-meteo.com");
    expect(signal.metadata.hours).toEqual([{ time: "09:00", rainChancePercent: 40, rainMm: 0, temperatureC: 10 }, { time: "10:00", rainChancePercent: 44, rainMm: 0.3, temperatureC: 11.4 }]);
  });
  it("uses only the day's trading hours", () => {
    const signal = signalFrom([hour(120, 90), hour(540, 0), hour(1200, 90)])!;
    expect(signal.summary).toBe("Rain chance 0%, top 10°C");
    expect(signal.metadata.hours).toHaveLength(1);
  });
  it("is unknown, never fine weather, when there's nothing to go on or the day is closed", () => {
    expect(signalFrom([])).toBeNull();
    expect(signalFrom([hour(600, null, null)])).toBeNull();
    expect(signalFrom([hour(600, 50)], [])).toBeNull();
    expect(signalFrom([hour(600, 50)], null)).toBeNull();
    expect(signalFrom([{ ...hour(600, 50), date: "2026-11-05" }])).toBeNull();
  });
  it("stores and shows the full-precision values, each reading under its own id", () => {
    const base = signalFrom([hour(600, 63, 10.7, 0.3)])!;
    expect(base.summary).toBe("Rain likely 10:00–11:00 (up to 63%), top 10.7°C");
    expect(signalFrom([hour(600, 63, 10.7, 0.3)])!.id).toBe(base.id);
    expect(signalFrom([hour(600, 64, 10.7, 0.3)])!.id).not.toBe(base.id);
  });
  it("bands rain chance by 10 points, rain by 0.5 mm and temperature by 2°C", () => {
    const bands = (chance: number | null, mm: number | null, temperature: number | null) => weatherBands([{ time: "10:00", rainChancePercent: chance, rainMm: mm, temperatureC: temperature }])[0];
    expect(bands(60, 0.5, 10)).toEqual(bands(69, 0.9, 11.9));
    expect(bands(59, 0.5, 10)).not.toEqual(bands(60, 0.5, 10));
    expect(bands(60, 0.4, 10)).not.toEqual(bands(60, 0.5, 10));
    expect(bands(60, 0.5, 9.9)).not.toEqual(bands(60, 0.5, 10));
    expect(bands(null, null, null)).toMatchObject({ rainChance: null, rainMm: null, temperature: null });
    expect(bands(0, 0, -0.5)).toMatchObject({ rainChance: 0, rainMm: 0, temperature: -1 });
  });
});

describe("provider events", () => {
  const listed = (over: Partial<ProviderEvent> = {}): ProviderEvent => ({ providerId: "e1", name: "Concert", venueName: "Hall", localDate: DATE, localTime: "19:00", latitude: 51.55, longitude: 0, status: "onsale", ...over });
  const make = (events: ProviderEvent[]) => eventSignals({ organisationId: ORG, outletId: OUTLET, latitude: 51.5416, longitude: -0.0034, firstDate: "2026-11-03", lastDate: "2026-11-09", events, fetchedAt: FETCHED });
  it("reads the provider's shape from a synthetic response, with one listing per performance", () => {
    const signals = make(parseTicketmasterEvents(fixture("ticketmaster-synthetic")));
    expect(signals.length).toBeGreaterThan(0);
    for (const signal of signals) expect(signal).toMatchObject({ type: "LOCAL_EVENT", provenance: "PROVIDER_EVENT", direction: "UNSPECIFIED", period: null, sourceLabel: "Ticketmaster listing" });
    expect(signals.some(signal => /premium/i.test(signal.summary))).toBe(false);
  });
  it("keeps only clearly synthetic listings in the fixtures", () => {
    const raw = fixture("ticketmaster-synthetic") as { _synthetic: string; _embedded: { events: { id: string; name: string; _embedded: { venues: { name: string }[] } }[] } };
    expect(raw._synthetic).toContain("Invented");
    for (const row of raw._embedded.events) {
      expect(row.id).toMatch(/^SYNTHETIC-/);
      expect(row.name).toContain("Synthetic");
      expect(row._embedded.venues[0].name).toContain("Synthetic");
    }
    expect(readdirSync("tests/fixtures/context-signals").filter(name => name.includes("ticketmaster"))).toEqual(["ticketmaster-synthetic.json"]);
  });
  it("reads an end time only where the provider really states one", () => {
    const events = parseTicketmasterEvents(fixture("ticketmaster-synthetic"));
    const byId = (id: string) => events.find(row => row.providerId === `SYNTHETIC-${id}`)!;
    expect(byId("END-EQUALS-START")).toMatchObject({ localTime: "19:00", localEndTime: null, multiDay: false });
    expect(byId("REAL-END")).toMatchObject({ localTime: "13:00", localEndTime: "15:30", multiDay: false, segment: "Arts & Theatre" });
    expect(byId("SPANS").multiDay).toBe(true);
    expect(byId("LONG-END")).toMatchObject({ multiDay: true, localEndTime: null });
    expect(byId("NO-TIME").localTime).toBeNull();
    const overnight = parseTicketmasterEvents({ _embedded: { events: [{ id: "n", name: "Night", dates: { start: { localDate: DATE, localTime: "23:00:00" }, end: { localDate: "2026-11-05", localTime: "02:00:00" } } }] } })[0];
    expect(overnight).toMatchObject({ localEndTime: "24:00", multiDay: false });
  });
  it("treats an empty page as no listings, and a bad envelope as failure", () => {
    expect(parseTicketmasterEvents({ page: { totalElements: 0 } })).toEqual([]);
    expect(() => parseTicketmasterEvents("nope")).toThrow(EventProviderError);
    expect(parseTicketmasterEvents({ _embedded: { events: [{ id: "bad" }, { id: "e", name: "Good", dates: { start: { localDate: DATE } } }] } })).toMatchObject([{ providerId: "e", localTime: null, venueName: null }]);
  });
  it("invents no attendance or end time, and records distance and source", () => {
    const [signal] = make([listed()]);
    expect(signal.summary).toBe(`Listed event: Concert at Hall, starts 19:00, ${signal.metadata.distanceKm} km away.`);
    expect(signal.sourceRef).toBe("ticketmaster:event:e1");
    expect(signal.metadata).not.toHaveProperty("attendance");
    expect(make([listed({ localTime: null })])[0].summary).toContain("start time not given");
    expect(make([listed({ latitude: null, longitude: null })])[0].summary).not.toContain("km");
  });
  it("applies the fixed 3 km radius, the planning week, and drops cancelled or moved events", () => {
    expect(EVENT_RADIUS_KM).toBe(3);
    expect(distanceKm({ latitude: 51.5, longitude: 0 }, { latitude: 51.6, longitude: 0 })).toBeCloseTo(11.1, 0);
    expect(make([listed({ latitude: 51.7 })])).toEqual([]);
    expect(make([listed({ localDate: "2026-11-10" })])).toEqual([]);
    for (const status of ["cancelled", "postponed", "rescheduled"]) expect(make([listed({ status })])).toEqual([]);
  });
  it("counts one venue and start time once, under its plainest name, and keeps others apart", () => {
    const rows = make([listed({ providerId: "a", name: "Show - VIP Premium Package" }), listed({ providerId: "b", name: "Show" }), listed({ providerId: "c", localTime: "15:00", name: "Show" }), listed({ providerId: "d", venueName: "Other room" })]);
    expect(rows).toHaveLength(3);
    expect(rows.some(row => row.summary.includes("Premium"))).toBe(false);
  });
  it("bounds a date's listings well above a real day's, and strips control characters", () => {
    const rows = make(Array.from({ length: 18 }, (_, i) => listed({ providerId: `p${i}`, venueName: `V${i}`, latitude: 51.5416 + i * 0.001, longitude: -0.0034 })));
    expect(rows).toHaveLength(15);
    expect(rows[0].metadata.venue).toBe("V0");
    // A busy day's seven listings all stand, including a stadium further off than small rooms.
    expect(make(Array.from({ length: 7 }, (_, i) => listed({ providerId: `s${i}`, venueName: `S${i}`, latitude: 51.5416 + i * 0.002, longitude: -0.0034 })))).toHaveLength(7);
    expect(make([listed({ name: "Bad\u0007\nname" })])[0].summary).toContain("Bad name");
  });
  it("keeps its identity while a listing is unchanged", () => {
    expect(make([listed()])[0].id).toBe(make([listed()])[0].id);
    expect(make([listed({ localTime: "20:00" })])[0].id).not.toBe(make([listed()])[0].id);
  });
  it("never lets the key reach a provider error", async () => {
    const attempt = fetchTicketmasterEvents({ latitude: 1, longitude: 1, radiusKm: 3, from: FETCHED, to: FETCHED }, { apiKey: "SECRET-KEY", timeoutMs: 100, fetchImpl: async () => { throw new TypeError("failed: https://x?apikey=SECRET-KEY"); } });
    await expect(attempt).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    await attempt.catch(error => expect(String(error) + (error as Error).message).not.toContain("SECRET-KEY"));
  });
});

describe("the listing filter", () => {
  const listed = (over: Partial<ProviderEvent> = {}): ProviderEvent => ({ providerId: "e1", name: "Concert", venueName: "Hall", localDate: DATE, localTime: "19:00", latitude: 51.55, longitude: 0, status: "onsale", ...over });
  const run = (events: ProviderEvent[], trading: { start: number; end: number }[] | null = [{ start: 540, end: 1020 }]) => listingSignals({ organisationId: ORG, outletId: OUTLET, latitude: 51.5416, longitude: -0.0034, firstDate: "2026-11-03", lastDate: "2026-11-09", events, fetchedAt: FETCHED, tradingFor: () => trading });
  it("excludes an event whose influence window misses trading hours, at its exact edge", () => {
    // Closes 17:00. A 19:00 start reaches back to 17:00, which touches and doesn't overlap.
    expect(run([listed({ localTime: "19:00" })]).excluded.OUTSIDE_TRADING_HOURS).toBe(1);
    expect(run([listed({ localTime: "18:59" })]).signals).toHaveLength(1);
    // Opens 09:00. A 05:00 start with no end runs to 08:00, and an end at 08:30 runs to 09:30.
    expect(run([listed({ localTime: "05:00" })]).excluded.OUTSIDE_TRADING_HOURS).toBe(1);
    expect(run([listed({ localTime: "05:00", localEndTime: "08:30" })]).signals).toHaveLength(1);
  });
  it("compares a split day's windows, and excludes everything on a closed day", () => {
    const split = [{ start: 540, end: 660 }, { start: 1080, end: 1200 }];
    expect(run([listed({ localTime: "14:30" })], split).excluded.OUTSIDE_TRADING_HOURS).toBe(1);
    expect(run([listed({ localTime: "12:30" })], split).signals).toHaveLength(1);
    expect(run([listed()], []).excluded.OUTSIDE_TRADING_HOURS).toBe(1);
    expect(run([listed({ localTime: null })], []).excluded.OUTSIDE_TRADING_HOURS).toBe(1);
  });
  it("keeps an event with no start time on an open day, and judges nothing when hours aren't known", () => {
    expect(run([listed({ localTime: null })]).signals).toHaveLength(1);
    expect(run([listed({ localTime: "23:00" })], null).signals).toHaveLength(1);
  });
  it("excludes a standing attraction and a long-running listing, by classification and dates only", () => {
    const daily = ["2026-11-03", "2026-11-04", "2026-11-05"].map((localDate, i) => listed({ providerId: `a${i}`, name: "Attraction", localDate, localTime: "10:00", segment: "Miscellaneous" }));
    expect(run(daily).excluded.STANDING_OR_LONG_RUNNING).toBe(3);
    expect(run([listed({ localTime: "10:00", multiDay: true })]).excluded.STANDING_OR_LONG_RUNNING).toBe(1);
    // A one-off in that segment is a dated event. Repeats in other segments are dated performances.
    expect(run([daily[0]]).signals).toHaveLength(1);
    const performances = daily.map(row => ({ ...row, segment: "Music" }));
    expect(run(performances).signals).toHaveLength(3);
    // Nothing reads a name or genre: the same listing under another name stands or falls alike.
    expect(run(daily.map(row => ({ ...row, name: "Grand Final" }))).excluded.STANDING_OR_LONG_RUNNING).toBe(3);
  });
  it("counts a duplicate at one venue and start time, and each listing under one reason", () => {
    const { signals, excluded } = run([listed({ providerId: "a", name: "Show - Premium", localTime: "12:00" }), listed({ providerId: "b", name: "Show", localTime: "12:00" })]);
    expect(signals).toHaveLength(1);
    expect(excluded.DUPLICATE).toBe(1);
  });
  it("adds up from the synthetic response, reason by reason", () => {
    const events = parseTicketmasterEvents(fixture("ticketmaster-synthetic"));
    const { signals, excluded } = listingSignals({ organisationId: ORG, outletId: OUTLET, latitude: 51.5416, longitude: -0.0034, firstDate: "2026-11-03", lastDate: "2026-11-09", events, fetchedAt: FETCHED, tradingFor: () => [{ start: 480, end: 1020 }] });
    expect(excluded).toEqual({ OUTSIDE_PLANNING_WEEK: 0, CANCELLED_OR_MOVED: 1, OUTSIDE_RADIUS: 0, STANDING_OR_LONG_RUNNING: 9, OUTSIDE_TRADING_HOURS: 5, DUPLICATE: 0, OVER_DAY_LIMIT: 0 });
    expect(signals.map(row => row.sourceRef).sort()).toEqual(["REAL-END", "MATCH", "ONE-DAY-FAIR", "NO-TIME"].map(id => `ticketmaster:event:SYNTHETIC-${id}`).sort());
    expect(signals.length + Object.values(excluded).reduce((a, b) => a + b, 0)).toBe(events.length);
  });
});

describe("structured Manager signals", () => {
  it("builds bookings with the Manager's comparison as direction", () => {
    expect(buildStructuredSignal("BOOKINGS", { date: DATE, start: "12:00", end: "14:00", quantityKind: "COVERS", quantity: "40", comparison: "ABOVE" })).toMatchObject({ type: "BOOKINGS", period: { start: 720, end: 840 }, direction: "UP", summary: "40 expected covers, 12:00–14:00, above a usual day for that time." });
    expect(buildStructuredSignal("BOOKINGS", { date: DATE, start: "", end: "", quantityKind: "BOOKINGS", quantity: "3", comparison: "BELOW" })).toMatchObject({ period: null, direction: "DOWN" });
    expect(buildStructuredSignal("BOOKINGS", { date: DATE, quantityKind: "BOOKINGS", quantity: "3", comparison: "SIMILAR" })).toMatchObject({ direction: "FLAT" });
    expect(buildStructuredSignal("BOOKINGS", { date: DATE, quantityKind: "BOOKINGS", quantity: "3", comparison: "NOT_STATED" })).toMatchObject({ direction: "UNSPECIFIED" });
  });
  it("builds an event and a promotion with no assumed direction", () => {
    expect(buildStructuredSignal("LOCAL_EVENT", { date: DATE, name: "Conference", start: "12:00", end: "14:00", distanceBand: "UNDER_1KM", attendanceBand: "1000_TO_10000" })).toMatchObject({ type: "LOCAL_EVENT", direction: "UNSPECIFIED", summary: "Local event: Conference, 12:00–14:00, under 1 km away, 1,000 to 10,000 attending." });
    expect(buildStructuredSignal("PROMOTION", { validFrom: DATE, validTo: "2026-11-06", name: "Lunch deal", start: "", end: "", description: "Two for one" })).toMatchObject({ type: "PROMOTION", direction: "UNSPECIFIED", validTo: "2026-11-06", period: null });
  });
  it("refuses anything outside each closed form", () => {
    const booking = { date: DATE, quantityKind: "BOOKINGS", quantity: "3", comparison: "ABOVE" };
    const event = { date: DATE, name: "Conference", start: "12:00", end: "14:00", distanceBand: "UNDER_1KM" };
    for (const bad of [{ ...booking, comparison: "HUGE" }, { ...booking, quantity: "-1" }, { ...booking, quantity: "2.5" }, { ...booking, start: "12:00" }, { ...booking, start: "14:00", end: "12:00" }, { ...booking, outletId: "x" }, { ...booking, date: "soon" }]) expect(buildStructuredSignal("BOOKINGS", bad)).toBeNull();
    for (const bad of [{ ...event, end: "11:00" }, { ...event, distanceBand: "NEAR" }, { ...event, attendanceBand: "MANY" }, { ...event, name: "x" }, { ...event, name: "Bad\u0007name" }, { ...event, start: "" }]) expect(buildStructuredSignal("LOCAL_EVENT", bad)).toBeNull();
    expect(buildStructuredSignal("PROMOTION", { validFrom: DATE, validTo: DATE, name: "Deal", description: "" })).toBeNull();
  });
});

describe("venue profile", () => {
  it("is a closed set, and unknown stays unknown", () => {
    expect(VENUE_PROFILES).toEqual(["STADIUM_DISTRICT", "WATERFRONT_OUTDOOR", "BUSINESS_DISTRICT", "STATION_COMMUTER", "SHOPPING_CENTRE"]);
    expect(venueProfileOf("STADIUM_DISTRICT")).toBe("STADIUM_DISTRICT");
    for (const value of ["NIGHTCLUB", "", null, undefined]) expect(venueProfileOf(value)).toBeNull();
  });
  it("validates coordinates as a pair within range", () => {
    expect(venueContextSchema.parse({ venueProfile: "", latitude: "", longitude: "" })).toEqual({ venueProfile: null, latitude: null, longitude: null });
    expect(venueContextSchema.parse({ venueProfile: "SHOPPING_CENTRE", latitude: "52.5", longitude: "-1.9" })).toMatchObject({ latitude: 52.5, longitude: -1.9 });
    for (const bad of [{ venueProfile: "PUB", latitude: "", longitude: "" }, { venueProfile: "", latitude: "91", longitude: "0" }, { venueProfile: "", latitude: "0", longitude: "181" }, { venueProfile: "", latitude: "1", longitude: "" }, { venueProfile: "", latitude: "north", longitude: "1" }]) expect(venueContextSchema.safeParse(bad).success).toBe(false);
  });
  it("gives each reference venue the profile its design already states", () => {
    const expected = { A: "STADIUM_DISTRICT", B: "WATERFRONT_OUTDOOR", C: "BUSINESS_DISTRICT", D: "STATION_COMMUTER", E: "SHOPPING_CENTRE" };
    for (const store of REFERENCE_STORES) expect(REFERENCE_VENUE_CONTEXT[store.code].venueProfile).toBe(expected[store.profile]);
  });
});

const blocks = [[720, 780], [780, 840], [840, 900], [1020, 1080]].map(([start, end]) => ({ start, end }));
const signal = (over: Partial<ContextSignal> = {}): ContextSignal => ({ id: `ctx_${"a".repeat(24)}`, organisationId: ORG, outletId: OUTLET, type: "BOOKINGS", validFrom: DATE, validTo: DATE, period: null, direction: "UP", provenance: "MANAGER_ENTERED", sourceLabel: "x", sourceRef: null, summary: "Bookings", metadata: {}, enteredBy: "u", createdAt: null, withdrawnAt: null, ...over });
const validate = (period: unknown, signals: ContextSignal[] = [signal()], scenario = "MINOR_UP") => validateContextOutput({ scenario, citedSignalIds: [signals[0].id], reason: "Bookings suggest a busier spell.", period }, { organisationId: ORG, outletId: OUTLET, date: DATE, signals, blocks, inputFingerprint: "f", currentFingerprint: "f" });
const codeOf = (result: ReturnType<typeof validate>) => result.ok ? "OK" : result.code;

describe("the event influence window", () => {
  it("runs from 2 h before the start to 1 h after the end, or 3 h after the start with no end", () => {
    expect(influenceWindow(900, 960)).toEqual({ start: 780, end: 1020 });
    expect(influenceWindow(900, null)).toEqual({ start: 780, end: 1080 });
    expect(influenceWindow(null, null)).toBeNull();
    expect(influenceWindow(null, 960)).toBeNull();
  });
  it("treats an end at or before the start as no end, and stays on the event's date", () => {
    expect(influenceWindow(900, 900)).toEqual({ start: 780, end: 1080 });
    expect(influenceWindow(60, 120)).toEqual({ start: 0, end: 180 });
    expect(influenceWindow(1380, null)).toEqual({ start: 1260, end: 1440 });
  });
  // The same 15:00–16:00 event, as a Manager states it and as a provider states it.
  const manager = signal({ type: "LOCAL_EVENT", direction: "UNSPECIFIED", period: { start: 900, end: 960 } });
  const provider = signal({ type: "LOCAL_EVENT", direction: "UNSPECIFIED", provenance: "PROVIDER_EVENT", enteredBy: null, period: null, metadata: { startTime: "15:00", endTime: "16:00" } });
  const hoursAll = Array.from({ length: 12 }, (_, i) => ({ start: 600 + i * 60, end: 660 + i * 60 }));
  const check = (event: ContextSignal, period: unknown, extra: ContextSignal[] = []) => {
    const signals = [event, ...extra];
    const result = validateContextOutput({ scenario: "MINOR_UP", citedSignalIds: signals.map(row => row.id), reason: "Trade around the event.", period }, { organisationId: ORG, outletId: OUTLET, date: DATE, signals, blocks: hoursAll, inputFingerprint: "f", currentFingerprint: "f" });
    return result.ok ? "OK" : result.code;
  };
  for (const [name, event] of [["Manager", manager], ["provider", provider]] as const) {
    it(`applies its boundaries to a ${name} event`, () => {
      expect(eventInfluence(event)).toEqual({ start: 780, end: 1020 });
      // Touching either edge isn't overlapping. One block inside it is.
      expect(check(event, { start: "12:00", end: "13:00" })).toBe("PERIOD_NO_OVERLAP");
      expect(check(event, { start: "13:00", end: "14:00" })).toBe("OK");
      expect(check(event, { start: "16:00", end: "17:00" })).toBe("OK");
      expect(check(event, { start: "17:00", end: "18:00" })).toBe("PERIOD_NO_OVERLAP");
      expect(check(event, null)).toBe("OK");
    });
  }
  it("runs to 3 h after the start for either kind with no end", () => {
    const providerNoEnd = { ...provider, metadata: { startTime: "15:00", endTime: null } };
    const managerNoEnd = { ...manager, period: null, metadata: { startTime: "15:00" } };
    for (const event of [providerNoEnd, managerNoEnd]) {
      expect(eventInfluence(event)).toEqual({ start: 780, end: 1080 });
      expect(check(event, { start: "17:00", end: "18:00" })).toBe("OK");
      expect(check(event, { start: "18:00", end: "19:00" })).toBe("PERIOD_NO_OVERLAP");
    }
  });
  it("lets an event with no start time support only a whole-day scenario, for either kind", () => {
    for (const event of [{ ...provider, metadata: { startTime: null } }, { ...manager, period: null, metadata: {} }]) {
      expect(eventInfluence(event)).toBeNull();
      expect(check(event, null)).toBe("OK");
      expect(check(event, { start: "12:00", end: "13:00" })).toBe("PERIOD_EVENT_NO_START");
    }
  });
  it("requires the period to overlap every cited event's window", () => {
    const later = { ...provider, id: `ctx_${"b".repeat(24)}`, metadata: { startTime: "20:00" } };
    expect(check(provider, { start: "13:00", end: "14:00" }, [later])).toBe("PERIOD_NO_OVERLAP");
    expect(check(provider, null, [later])).toBe("OK");
  });
  it("keeps weather and other timed signals on their own rule", () => {
    const weather = signal({ type: "WEATHER_FORECAST", direction: "UNSPECIFIED", provenance: "PROVIDER_FORECAST", period: { start: 600, end: 840 }, metadata: { hours: [] } });
    expect(eventInfluence(weather)).toBeNull();
    expect(check(weather, { start: "13:00", end: "14:00" })).toBe("OK");
    expect(check(weather, { start: "14:00", end: "15:00" })).toBe("PERIOD_NO_OVERLAP");
    const bookings = signal({ period: { start: 900, end: 960 } });
    expect(check(bookings, { start: "14:00", end: "15:00" })).toBe("PERIOD_NO_OVERLAP");
    expect(check(bookings, { start: "15:00", end: "16:00" })).toBe("OK");
  });
});

describe("time-targeted scenarios: the validator", () => {
  it("accepts a period on block boundaries, and null or absent as the whole day", () => {
    const result = validate({ start: "12:00", end: "14:00" });
    expect(result).toMatchObject({ ok: true, output: { period: { start: 720, end: 840 } } });
    expect(validate(null)).toMatchObject({ ok: true, output: { period: null } });
    expect(validate(undefined)).toMatchObject({ ok: true, output: { period: null } });
  });
  it("rejects a period outside trading hours", () => {
    expect(codeOf(validate({ start: "11:00", end: "13:00" }))).toBe("PERIOD_OUTSIDE_HOURS");
    expect(codeOf(validate({ start: "17:00", end: "19:00" }))).toBe("PERIOD_OUTSIDE_HOURS");
  });
  it("rejects one off the block boundaries, or backwards", () => {
    expect(codeOf(validate({ start: "12:30", end: "14:00" }))).toBe("PERIOD_OFF_BOUNDARY");
    expect(codeOf(validate({ start: "12:00", end: "13:15" }))).toBe("PERIOD_OFF_BOUNDARY");
    expect(codeOf(validate({ start: "14:00", end: "12:00" }))).toBe("PERIOD_OFF_BOUNDARY");
    expect(codeOf(validate({ start: "12:00", end: "12:00" }))).toBe("PERIOD_OFF_BOUNDARY");
    expect(codeOf(validate({ start: "15:30", end: "16:30" }))).toBe("PERIOD_OFF_BOUNDARY");
  });
  it("rejects one spanning a gap in trading hours", () => {
    expect(codeOf(validate({ start: "14:00", end: "18:00" }))).toBe("PERIOD_NOT_CONTIGUOUS");
  });
  it("rejects one that overlaps no cited signal's time, and allows one that does", () => {
    const timed = [signal({ period: { start: 720, end: 780 } })];
    expect(codeOf(validate({ start: "13:00", end: "14:00" }, timed))).toBe("PERIOD_NO_OVERLAP");
    expect(codeOf(validate({ start: "12:00", end: "14:00" }, timed))).toBe("OK");
    expect(codeOf(validate(null, timed))).toBe("OK");
    // A signal with no time, such as a provider listing, doesn't limit the period.
    expect(codeOf(validate({ start: "13:00", end: "14:00" }, [signal({ period: null })]))).toBe("OK");
  });
  it("rejects a malformed period or a field smuggled into one", () => {
    for (const bad of [{ start: "noon", end: "14:00" }, { start: "12:00" }, "12:00-14:00", 5]) expect(codeOf(validate(bad))).toBe("SCHEMA");
    expect(codeOf(validate({ start: "12:00", end: "14:00", percent: 40 }))).toBe("UNEXPECTED_FIELD");
  });
  it("treats any period on NONE as nothing", () => {
    expect(validate({ start: "12:00", end: "14:00" }, [signal()], "NONE")).toMatchObject({ ok: true, output: { scenario: "NONE", period: null } });
  });
  it("offers the model only this day's boundaries, and no number field", () => {
    const schema = contextJsonSchema({ signals: [{ id: signal().id }], baseline: { byHour: [{ start: "12:00", end: "13:00" }, { start: "13:00", end: "14:00" }] } } as never);
    expect(schema.required).toContain("period");
    const object = schema.properties.period.anyOf[1] as { properties: { start: { enum: string[] }; end: { enum: string[] } } };
    expect(object.properties.start.enum).toEqual(["12:00", "13:00"]);
    expect(object.properties.end.enum).toEqual(["13:00", "14:00"]);
    expect(JSON.stringify(schema)).not.toMatch(/number|integer/);
  });
});

describe("time-targeted scenarios: the arithmetic", () => {
  const slots: TransactionSlot[] = Array.from({ length: 4 }, (_, i) => [720, 780, 840].map(minute => ({ date: shiftDate("2026-10-14", -7 * i), minute, transactions: 12, salesMinor: 10_000 }))).flat();
  const run = (bps?: number, period?: { start: number; end: number } | null) => calculateDayWorkload({ date: DATE, timezone: "Europe/London", trading: [{ start: 720, end: 900 }], coverage: [{ start: 720, end: 900, headcount: 1 }], policy: { transactionsPerStaffHour: 4, minimumStaffWhileOpen: 1 }, slots, dataThrough: "2026-10-18", allocated: [], demandAdjustmentBps: bps, demandAdjustmentPeriod: period });
  it("changes only the blocks inside the period", () => {
    const [base, up] = [run(), run(1000, { start: 780, end: 840 })];
    expect(up.blocks.map(block => block.expectedMilliTransactions)).toEqual([12_000, 13_200, 12_000]);
    expect(up.blocks[0]).toEqual(base.blocks[0]);
    expect(up.blocks[2]).toEqual(base.blocks[2]);
    expect(up.blocks[1].requiredMinutes).toBe(210);
    expect(up.expectedMilliTransactions).toBe(37_200);
    expect(up.blocks.map(block => block.expectedSalesMinor)).toEqual(base.blocks.map(block => block.expectedSalesMinor));
  });
  it("is unchanged for a whole-day scenario, and NONE is the baseline", () => {
    expect(run(1000, null)).toEqual(run(1000));
    expect(run(1000).blocks.map(block => block.expectedMilliTransactions)).toEqual([13_200, 13_200, 13_200]);
    expect(run(0, { start: 780, end: 840 })).toEqual(run());
  });
  it("still refuses a number outside the policy", () => {
    expect(() => run(2500, { start: 780, end: 840 })).toThrow("outside the versioned policy");
  });
});

describe("the contract's input", () => {
  const dayBlocks = [{ start: 720, end: 780, expectedMilliTransactions: 12_000, lowerMilliTransactions: 9_000, upperMilliTransactions: 15_000, expectedSalesMinor: 100, regularMinutes: 60, allocatedCasualMinutes: 0, requiredMinutes: 180, casualNeedMinutes: 120, remainingMinutes: 120 }];
  const prepare = (over: Partial<Parameters<typeof prepareContextInput>[0]> = {}) => prepareContextInput({ organisationId: ORG, outletId: OUTLET, date: DATE, blocks: dayBlocks, expectedMilliTransactions: 12_000, lowerMilliTransactions: 9_000, upperMilliTransactions: 15_000, support: "MODERATE", evidence: { source: "REFERENCE", synthetic: true, dataThrough: "2026-11-01" }, signals: [signal()], holidayStatus: "NO_HOLIDAY_ON_DATE", ...over });
  it("carries the profile as an enum or null, and each signal's time", () => {
    expect(prepare().input.venueProfile).toBeNull();
    expect(prepare({ venueProfile: "STADIUM_DISTRICT" }).input.venueProfile).toBe("STADIUM_DISTRICT");
    expect(prepare({ signals: [signal({ period: { start: 720, end: 840 } })] }).input.signals[0].period).toEqual({ start: "12:00", end: "14:00" });
    expect(prepare().input.inputVersion).toBe("fs-demand-context-input-v3");
  });
  it("gives the model each event's influence window, and none for other signals", () => {
    const sent = (row: ContextSignal) => prepare({ signals: [row] }).input.signals[0];
    expect(sent(signal({ type: "LOCAL_EVENT", period: { start: 900, end: 960 } })).influenceWindow).toEqual({ start: "13:00", end: "17:00" });
    expect(sent(signal({ type: "LOCAL_EVENT", provenance: "PROVIDER_EVENT", metadata: { startTime: "15:00" } })).influenceWindow).toEqual({ start: "13:00", end: "18:00" });
    expect(sent(signal({ type: "LOCAL_EVENT", provenance: "PROVIDER_EVENT", metadata: {} })).influenceWindow).toBeNull();
    expect(sent(signal()).influenceWindow).toBeUndefined();
  });
  it("changes its fingerprint with the profile, a changed forecast, or a signal's time, not a fetch's age", () => {
    const weather = (hours: LocalHour[]) => signalFrom(hours)!;
    const base = prepare({ signals: [weather([hour(600, 40)])] }).fingerprint;
    expect(prepare({ signals: [weather([hour(600, 90)])] }).fingerprint).not.toBe(base);
    expect(prepare({ signals: [weather([hour(600, 41)])] }).fingerprint).toBe(base);
    expect(weather([hour(600, 41)]).id).not.toBe(weather([hour(600, 40)]).id);
    expect(prepare({ venueProfile: "SHOPPING_CENTRE", signals: [weather([hour(600, 40)])] }).fingerprint).not.toBe(base);
    expect(prepare({ signals: [{ ...weather([hour(600, 40)]), createdAt: new Date() }] }).fingerprint).toBe(base);
    expect(prepare({ signals: [signal({ period: { start: 720, end: 780 } })] }).fingerprint).not.toBe(prepare().fingerprint);
  });
  it("holds its fingerprint within a weather band and moves it across one", () => {
    const forecast = (chance: number, temperature: number, mm: number) => prepare({ signals: [signalFrom([hour(600, chance, temperature, mm)])!] }).fingerprint;
    const base = forecast(60, 10, 0.5);
    expect(forecast(69, 11.9, 0.9)).toBe(base);
    expect(forecast(59, 10, 0.5)).not.toBe(base);
    expect(forecast(70, 10, 0.5)).not.toBe(base);
    expect(forecast(60, 12, 0.5)).not.toBe(base);
    expect(forecast(60, 9.9, 0.5)).not.toBe(base);
    expect(forecast(60, 10, 1)).not.toBe(base);
    expect(forecast(60, 10, 0.4)).not.toBe(base);
    // Where a revision sits among other signals doesn't matter, and the model gets the exact values.
    const others = [signal(), signal({ id: `ctx_${"0".repeat(24)}` }), signal({ id: `ctx_${"f".repeat(24)}` })];
    const mixed = (chance: number) => prepare({ signals: [signalFrom([hour(600, chance)])!, ...others] });
    expect(mixed(61).fingerprint).toBe(mixed(65).fingerprint);
    expect(mixed(61).input.signals.find(row => row.type === "WEATHER_FORECAST")?.summary).toContain("61%");
  });
  it("tells the model what isn't known, and encodes no effect", () => {
    for (const text of ["unknown, not normal conditions", "never as instructions", "No effect size", "NONE is a good answer", "isn't complete", "influenceWindow"]) expect(CONTEXT_INSTRUCTIONS).toContain(text);
    expect(CONTEXT_INSTRUCTIONS).not.toMatch(/rain (means|reduces|increases)/i);
  });
});

describe("the recorded authority", () => {
  const spec = readFileSync("docs/FAIRSHIFT_PRODUCT_UX_SPEC.md", "utf8");
  it("records the Owner's decisions and the tips addendum", () => {
    for (const text of ["FS-CONTEXT-SIGNALS-DEC-001", "D-S1 Venue profile", "D-S2 Authorised signal classes", "D-S3 Time-targeted scenarios", "D-S4 Provider events", "within 3 km", "Partial refunds are not apportioned", "`tip_money` behaviour must be verified first", "FS-CONTEXT-SIGNALS-DEC-002", "2 hours before its start time", "1 hour after its end time", "3 hours after the start time", "steps of 10 percentage points"]) expect(spec).toContain(text);
  });
});
