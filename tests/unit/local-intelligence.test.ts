import { describe, expect, it, vi } from "vitest";
import {
  applyLocalAdjustment, blockAdjustments, buildDiscoveryInput, discoveryJsonSchema, DISCOVERY_INSTRUCTIONS, impactScore, locationProfileSchema, MAX_BLOCK_ADJUSTMENT_BPS, signalKey, sourceDecision, validateDiscoveryOutput,
  type AppliableSignal, type DiscoveredSignal,
} from "@/server/intelligence/local-intelligence-contract";
import { consultedBy, createSourceChecker, normaliseUrl, publicHttpsUrl, siteOf } from "@/server/intelligence/local-intelligence-sources";
import { blockRisks, capacityAlerts, type DisruptionSignal } from "@/server/intelligence/disruptions";
import { OpenAiWebDiscoveryProvider, searchesOf } from "@/server/integrations/openai/web-discovery";

// Fixtures only: no model or web page is contacted here.
const WINDOW = { today: "2026-11-09", from: "2026-11-09", to: "2026-11-16" };
const context = { locationKey: "Rosebank", window: WINDOW, categories: ["PUBLIC_HOLIDAY", "SPORT", "NEWS_POLITICAL", "SERVICE_DISRUPTION", "ACCESS_DISRUPTION", "OTHER"] as const };
const signal = (overrides: Partial<DiscoveredSignal> = {}): DiscoveredSignal => ({
  location: "Rosebank", category: "SPORT", otherLabel: null, effectType: "DEMAND", name: "Fixture rugby match at a nearby stadium", dateFrom: "2026-11-14", dateTo: "2026-11-14", startTime: "15:00", endTime: "17:00",
  dateCertainty: "FIXED", shiftBlocks: ["AFTERNOON"], roles: ["FOH", "BOH"], direction: "UP", sizeBand: "MINOR", severity: null, closureLikely: false,
  confidence: "MEDIUM", sourceTier: "EVENT_ORGANISER", reasoning: "Fans pass the cafe before kick-off, matching its afternoon trade.", sourceUrl: "https://tickets.example.com/match", sourceTitle: "Match tickets", ...overrides,
});
const answer = (...signals: unknown[]) => ({ coverage: [{ category: "SPORT", label: "Sport", queries: ["Rosebank sport this week"], outcome: "FOUND" }], signals });
const only = (raw: unknown) => { const result = validateDiscoveryOutput(raw, { ...context, categories: [...context.categories] }); if (!result.ok) throw new Error(result.code); return result.candidates; };

describe("local intelligence contract", () => {
  it("accepts a valid discovery answer and keeps its coverage log", () => {
    const result = validateDiscoveryOutput(answer(signal()), { ...context, categories: [...context.categories] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.coverage).toEqual([{ category: "SPORT", label: "Sport", queries: ["Rosebank sport this week"], outcome: "FOUND" }]);
    expect(result.candidates).toEqual([{ index: 0, signal: signal(), rejection: null, detail: null }]);
  });

  it("takes an influence outside the checklist as OTHER with its own label, and only then", () => {
    expect(only(answer(signal({ category: "OTHER", otherLabel: "Night market" })))[0].rejection).toBeNull();
    expect(only(answer(signal({ category: "OTHER", otherLabel: null })))[0].rejection).toBe("OTHER_LABEL");
    expect(only(answer(signal({ category: "SPORT", otherLabel: "Rugby" })))[0].rejection).toBe("OTHER_LABEL");
  });

  it("rejects a signal with no usable source page, and one whose page can't be reached", () => {
    expect(only(answer(signal({ sourceUrl: "" })))[0].rejection).toBe("BAD_SOURCE_URL");
    expect(only(answer(signal({ sourceUrl: "http://tickets.example.com/match" })))[0].rejection).toBe("BAD_SOURCE_URL");
    expect(only(answer(signal({ sourceUrl: "https://user:pw@tickets.example.com/" })))[0].rejection).toBe("BAD_SOURCE_URL");
    for (const outcome of ["NOT_FOUND", "UNREACHABLE", "INVALID"] as const) expect(sourceDecision(signal(), { outcome, consulted: true })).toMatchObject({ status: "REJECTED", rejection: "SOURCE_UNREACHABLE" });
  });

  it("shows unconfirmed signals but never applies them", () => {
    expect(sourceDecision(signal({ sourceTier: "UNCONFIRMED" }), { outcome: "REACHABLE", consulted: true }).status).toBe("UNCONFIRMED");
    expect(sourceDecision(signal(), { outcome: "REACHABLE", consulted: false }).status).toBe("UNCONFIRMED");
    expect(sourceDecision(signal(), { outcome: "RESTRICTED", consulted: true }).status).toBe("ACCEPTED");
    expect(sourceDecision(signal(), { outcome: "REACHABLE", consulted: true }).status).toBe("ACCEPTED");
    const unconfirmed: AppliableSignal = { key: "a", status: "UNCONFIRMED", effectType: "DEMAND", direction: "UP", sizeBand: "MODERATE", validFrom: "2026-11-14", validTo: "2026-11-14", startMinute: null, endMinute: null, shiftBlocks: [], impact: 999 };
    const result = blockAdjustments("2026-11-14", [{ start: 720, end: 780 }], [unconfirmed]);
    expect(result.blocks[0]).toMatchObject({ bps: 0, applied: [], listed: [] });
    expect(result.adjusted).toEqual([]);
  });

  it("rejects dates outside the window and signals for another location", () => {
    expect(only(answer(signal({ dateFrom: "2026-11-08", dateTo: "2026-11-08" })))[0].rejection).toBe("OUTSIDE_WINDOW");
    expect(only(answer(signal({ dateFrom: "2026-11-16", dateTo: "2026-11-17" })))[0].rejection).toBe("OUTSIDE_WINDOW");
    expect(only(answer(signal({ dateFrom: "2026-11-15", dateTo: "2026-11-14" })))[0].rejection).toBe("OUTSIDE_WINDOW");
    expect(only(answer(signal({ location: "Sandton" })))[0].rejection).toBe("WRONG_LOCATION");
    expect(only(answer(signal({ startTime: "17:00", endTime: "15:00" })))[0].rejection).toBe("BAD_TIME");
  });

  it("keeps effects to their own fields and rejects one bad signal without losing the rest", () => {
    const candidates = only(answer(signal({ severity: "HIGH" }), signal({ effectType: "CAPACITY", direction: null, sizeBand: null, severity: "HIGH", closureLikely: true, name: "Fixture water outage" }), { not: "a signal" }, signal({ effectType: "ACCESS", direction: null, sizeBand: null, severity: "LOW", closureLikely: true, name: "Fixture road closure" })));
    expect(candidates.map(row => row.rejection)).toEqual(["INCONSISTENT_EFFECT", null, "SCHEMA", "INCONSISTENT_EFFECT"]);
    expect(validateDiscoveryOutput("not json", { ...context, categories: [...context.categories] })).toEqual({ ok: false, code: "MALFORMED" });
    expect(validateDiscoveryOutput({ signals: [], extra: 1 }, { ...context, categories: [...context.categories] })).toEqual({ ok: false, code: "SCHEMA" });
  });

  it("ranks by impact, applies at most two signals to a block and lists the rest, inside a fixed bound", () => {
    const base = { status: "ACCEPTED" as const, effectType: "DEMAND", validFrom: "2026-11-14", validTo: "2026-11-14", startMinute: null, endMinute: null, shiftBlocks: ["AFTERNOON"] };
    const strong = { ...base, key: "strong", direction: "UP", sizeBand: "MODERATE", impact: impactScore({ effectType: "DEMAND", sizeBand: "MODERATE", severity: null, confidence: "HIGH", sourceTier: "OFFICIAL" }) };
    const middle = { ...base, key: "middle", direction: "UP", sizeBand: "MODERATE", impact: impactScore({ effectType: "DEMAND", sizeBand: "MODERATE", severity: null, confidence: "MEDIUM", sourceTier: "NEWS" }) };
    const weak = { ...base, key: "weak", direction: "DOWN", sizeBand: "MINOR", impact: impactScore({ effectType: "DEMAND", sizeBand: "MINOR", severity: null, confidence: "LOW", sourceTier: "NEWS" }) };
    const result = blockAdjustments("2026-11-14", [{ start: 600, end: 660 }, { start: 780, end: 840 }], [weak, middle, strong]);
    expect(result.blocks[0]).toMatchObject({ bps: 0, applied: [], listed: [] });
    expect(result.blocks[1]).toMatchObject({ bps: 2000, applied: ["strong", "middle"], listed: ["weak"] });
    expect(MAX_BLOCK_ADJUSTMENT_BPS).toBe(2000);
    expect(applyLocalAdjustment(10_000, 2000)).toBe(12_000);
    expect(applyLocalAdjustment(10_000, -500)).toBe(9_500);
    expect(() => applyLocalAdjustment(10_000, 2500)).toThrow();
    expect(() => applyLocalAdjustment(10_000, 300)).toThrow();
    // The same applied set always has the same fingerprint; a change gives a new one.
    expect(blockAdjustments("2026-11-14", [{ start: 780, end: 840 }], [strong, middle, weak]).fingerprint).toBe(blockAdjustments("2026-11-14", [{ start: 780, end: 840 }], [weak, middle, strong]).fingerprint);
    expect(blockAdjustments("2026-11-14", [{ start: 780, end: 840 }], [strong]).fingerprint).not.toBe(blockAdjustments("2026-11-14", [{ start: 780, end: 840 }], [strong, middle]).fingerprint);
    // A signal's own times narrow it within its parts of the day.
    const timed = { ...strong, key: "timed", startMinute: 900, endMinute: 960 };
    expect(blockAdjustments("2026-11-14", [{ start: 780, end: 840 }, { start: 900, end: 960 }], [timed]).blocks.map(block => block.bps)).toEqual([0, 1000]);
  });

  it("holds news and political signals to operational effects", () => {
    const news = (name: string, reasoning: string) => only(answer(signal({ category: "NEWS_POLITICAL", name, reasoning })))[0].rejection;
    expect(news("Fixture march closes Jan Smuts Avenue", "Road closures around the march route will slow customers and staff reaching the cafe.")).toBeNull();
    expect(news("ANC rally closes roads", "Road closures around the rally will slow customers reaching the cafe.")).toBe("NEUTRALITY");
    expect(news("Protest closes roads", "Protesters blamed the council, and closures will slow customers reaching the cafe.")).toBe("NEUTRALITY");
    // The same words outside news and politics are not judged.
    expect(only(answer(signal({ category: "SPORT", name: "ANC fun run", reasoning: "Runners pass the cafe on the morning route, adding walk-in trade." })))[0].rejection).toBeNull();
    expect(DISCOVERY_INSTRUCTIONS).toContain("do not name\n  political parties");
  });

  it("builds a model input from the location's public facts only", () => {
    const input = buildDiscoveryInput({ runKind: "DAILY", today: "2026-11-09", location: { name: "Rosebank", city: "Johannesburg", province: "Gauteng", country: "South Africa", latitude: -26.1457, longitude: 28.0437, timezone: "Africa/Johannesburg" },
      profile: { area: "Rosebank, Johannesburg", venueType: "Fast-casual cafe", typicalCustomers: "Office workers and shoppers", source: "DEMO_SEED" }, tradingFor: date => date === "2026-11-15" ? [] : [{ start: 480, end: 1200 }],
      holidays: [{ date: "2026-12-16", name: "Day of Reconciliation", source: "Nager.Date public holidays API" }, { date: "2026-11-10", name: "Fixture holiday", source: "Nager.Date public holidays API" }] });
    expect(input.window).toEqual(WINDOW);
    expect(input.location.area).toBe("Rosebank, Johannesburg, Gauteng, South Africa");
    expect(input.knownHolidays).toEqual([{ date: "2026-11-10", name: "Fixture holiday", source: "Nager.Date public holidays API" }]);
    expect(input.tradingHours.find(row => row.date === "2026-11-15")?.hours).toBe("CLOSED");
    expect(input.categories).toHaveLength(12);
    expect(Object.keys(input).sort()).toEqual(["bands", "categories", "dayParts", "inputVersion", "knownHolidays", "location", "policyVersion", "profile", "runKind", "tradingHours", "window"]);
    expect(buildDiscoveryInput({ runKind: "DISRUPTIONS", today: "2026-11-09", location: { name: "Rosebank", city: null, province: null, country: "South Africa", latitude: null, longitude: null, timezone: "Africa/Johannesburg" }, profile: null, tradingFor: () => null, holidays: [] }).categories.map(row => row.category)).toEqual(["NEWS_POLITICAL", "SERVICE_DISRUPTION", "ACCESS_DISRUPTION", "EXTREME_WEATHER", "OTHER"]);
    const schema = discoveryJsonSchema(input) as { properties: { signals: { items: { required: string[] } } } };
    expect(schema.properties.signals.items.required).toContain("sourceUrl");
  });

  it("keeps contact details and links out of an Owner's location profile", () => {
    expect(locationProfileSchema.safeParse({ area: "Rosebank", venueType: "Cafe", typicalCustomers: "Office workers" }).success).toBe(true);
    expect(locationProfileSchema.safeParse({ area: "Rosebank", venueType: "Cafe", typicalCustomers: "Ask thandi@example.test" }).success).toBe(false);
    expect(locationProfileSchema.safeParse({ area: "Rosebank", venueType: "Call +27 11 555 0100", typicalCustomers: "Office workers" }).success).toBe(false);
    expect(locationProfileSchema.safeParse({ area: "https://example.test", venueType: "Cafe", typicalCustomers: "Office workers" }).success).toBe(false);
  });

  it("keys a finding by what it says, so a re-run finds the same signal", () => {
    expect(signalKey(signal())).toBe(signalKey(signal({ reasoning: "Different words, same finding.", confidence: "HIGH" })));
    expect(signalKey(signal())).not.toBe(signalKey(signal({ sizeBand: "MODERATE" })));
  });
});

describe("source checks", () => {
  const lookup = vi.fn(async (host: string) => host === "internal.example.com" ? ["10.0.0.5"] : ["93.184.216.34"]);
  const responder = (routes: Record<string, { status: number; location?: string }>) => vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const route = routes[`${init?.method} ${input.toString()}`] ?? routes[input.toString()] ?? { status: 404 };
    return new Response(null, { status: route.status, headers: route.location ? { location: route.location } : {} });
  });

  it("calls a page reachable, restricted, missing or unreachable from its answer", async () => {
    const fetchImpl = responder({ "https://ok.example.com/a": { status: 200 }, "https://bot.example.com/a": { status: 403 }, "HEAD https://head.example.com/a": { status: 405 }, "GET https://head.example.com/a": { status: 200 }, "GET https://broken.example.com/a": { status: 503 },
      "https://moved.example.com/a": { status: 301, location: "https://ok.example.com/a" }, "https://sneaky.example.com/a": { status: 302, location: "https://internal.example.com/" } });
    const check = createSourceChecker({ fetchImpl: fetchImpl as unknown as typeof fetch, lookup });
    expect((await check("https://ok.example.com/a")).outcome).toBe("REACHABLE");
    expect((await check("https://bot.example.com/a")).outcome).toBe("RESTRICTED");
    expect((await check("https://gone.example.com/a")).outcome).toBe("NOT_FOUND");
    // A server that never answers HEAD is still checked: FairShift asks with GET and reads no body.
    expect((await check("https://head.example.com/a")).outcome).toBe("REACHABLE");
    expect((await check("https://broken.example.com/a")).outcome).toBe("UNREACHABLE");
    expect(fetchImpl.mock.calls.every(call => call[1]?.method === "GET")).toBe(true);
    expect((await check("https://moved.example.com/a")).outcome).toBe("REACHABLE");
    // A redirect into a private network is refused before it is followed.
    expect((await check("https://sneaky.example.com/a")).outcome).toBe("INVALID");
    expect((await check("http://ok.example.com/a")).outcome).toBe("INVALID");
    expect((await check("https://127.0.0.1/a")).outcome).toBe("INVALID");
    expect((await check("https://localhost/a")).outcome).toBe("INVALID");
    const failing = createSourceChecker({ fetchImpl: (async () => { throw new TypeError("network"); }) as unknown as typeof fetch, lookup });
    expect(await failing("https://ok.example.com/a")).toEqual({ outcome: "UNREACHABLE", httpStatus: null, reason: "NETWORK" });
    // A certificate FairShift can't verify is never skipped: the page counts as unreachable, and says why.
    const badChain = createSourceChecker({ fetchImpl: (async () => { throw new TypeError("fetch failed", { cause: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" } }); }) as unknown as typeof fetch, lookup });
    const certificate = await badChain("https://ok.example.com/a");
    expect(certificate).toEqual({ outcome: "UNREACHABLE", httpStatus: null, reason: "CERTIFICATE" });
    expect(sourceDecision({ sourceTier: "OFFICIAL" }, { outcome: certificate.outcome, consulted: true, reason: certificate.reason }).note).toContain("security certificate");
    // Only a generic client name is sent.
    const headers = fetchImpl.mock.calls[0][1]?.headers as Record<string, string>;
    expect(Object.keys(headers).sort()).toEqual(["accept", "user-agent"]);
    expect(headers["user-agent"]).toBe("FairShift-source-check/1.0");
  });

  it("matches a cited page against the pages the search opened", () => {
    expect(normaliseUrl("https://WWW.News.example.co.za/story/?utm_source=x#top")).toBe("https://news.example.co.za/story");
    expect(siteOf("www.joburg.org.za")).toBe("joburg.org.za");
    expect(siteOf("news.example.com")).toBe("example.com");
    expect(consultedBy("https://www.joburg.org.za/notice/", ["https://joburg.org.za/notice"])).toEqual({ exact: true, site: true });
    expect(consultedBy("https://joburg.org.za/other", ["https://joburg.org.za/notice"])).toEqual({ exact: false, site: true });
    expect(consultedBy("https://made-up.example.net/x", ["https://joburg.org.za/notice"])).toEqual({ exact: false, site: false });
    expect(publicHttpsUrl("https://example.com:8443/x")).toBeNull();
  });
});

describe("OpenAI web discovery transport", () => {
  it("asks for web search, a bounded number of tool calls, the full source list and strict output, and reads the search record", async () => {
    const body = { id: "resp_fixture", model: "fixture-model", status: "completed", output: [
      { type: "web_search_call", action: { type: "search", query: "Rosebank road closures", sources: [{ type: "url", url: "https://joburg.org.za/notice" }] } },
      { type: "web_search_call", action: { type: "open_page", url: "https://tickets.example.com/match" } },
      { type: "message", content: [{ type: "output_text", text: JSON.stringify(answer()), annotations: [{ type: "url_citation", url: "https://news.example.co.za/story" }] }] },
    ] };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    const provider = new OpenAiWebDiscoveryProvider("sk-fixture", "fixture-model", fetchImpl as unknown as typeof fetch);
    const response = await provider.discover({ instructions: "i", input: "{}", schemaName: "s", schema: { type: "object" }, maxToolCalls: 7, userLocation: { country: "South Africa", city: "Johannesburg", region: "Gauteng", timezone: "Africa/Johannesburg" } });
    const sent = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(sent.tools).toEqual([{ type: "web_search", user_location: { type: "approximate", country: "ZA", city: "Johannesburg", region: "Gauteng", timezone: "Africa/Johannesburg" } }]);
    expect(sent).toMatchObject({ tool_choice: "required", max_tool_calls: 7, include: ["web_search_call.action.sources"], store: false, text: { format: { type: "json_schema", strict: true } } });
    expect(response.responseId).toBe("resp_fixture");
    expect(response.consultedUrls).toEqual(["https://joburg.org.za/notice", "https://tickets.example.com/match", "https://news.example.co.za/story"]);
    expect(response.searches).toEqual([{ action: "search", queries: ["Rosebank road closures"], url: null }, { action: "open_page", queries: [], url: "https://tickets.example.com/match" }]);
    expect(searchesOf([]).consultedUrls).toEqual([]);
  });

  it("treats a refused or unfinished answer as a failure, never as findings", async () => {
    const reply = (body: unknown, status = 200) => new OpenAiWebDiscoveryProvider("sk-fixture", "m", (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch);
    const request = { instructions: "i", input: "{}", schemaName: "s", schema: {}, maxToolCalls: 3, userLocation: null };
    await expect(reply({ model: "m", status: "incomplete", output: [] }).discover(request)).rejects.toMatchObject({ code: "INCOMPLETE" });
    await expect(reply({ model: "m", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] }).discover(request)).rejects.toMatchObject({ code: "REFUSAL" });
    await expect(reply({ error: { message: "web search unsupported" } }, 400).discover(request)).rejects.toMatchObject({ code: "HTTP_400" });
  });
});

describe("capacity and access disruptions", () => {
  const disruption = (overrides: Partial<DisruptionSignal & { impact: number }>): DisruptionSignal & { impact: number } => ({ key: "k", status: "ACCEPTED", effectType: "ACCESS", validFrom: "2026-11-14", validTo: "2026-11-14", startMinute: null, endMinute: null, shiftBlocks: ["AFTERNOON"], severity: "MEDIUM", closureLikely: false, impact: 200, ...overrides });
  const blocks = [{ start: 600, end: 660 }, { start: 780, end: 840 }, { start: 1080, end: 1140 }];

  it("flags a staff-attendance risk on the blocks an accepted access signal covers, and nothing for an unconfirmed one", () => {
    const risks = blockRisks("2026-11-14", blocks, [disruption({ key: "closure" }), disruption({ key: "rumour", status: "UNCONFIRMED", shiftBlocks: [] }), disruption({ key: "outage", effectType: "CAPACITY", severity: "HIGH", shiftBlocks: ["EVENING"] })]);
    expect(risks.map(row => [row.start, row.access, row.capacity])).toEqual([[600, [], []], [780, ["closure"], []], [1080, [], ["outage"]]]);
    expect(blockRisks("2026-11-15", blocks, [disruption({ key: "closure" })]).every(row => !row.access.length)).toBe(true);
  });

  it("alerts the Owner to severe capacity signals still ahead, likely closures first", () => {
    const alerts = capacityAlerts([
      disruption({ key: "medium", effectType: "CAPACITY", severity: "MEDIUM" }),
      disruption({ key: "past", effectType: "CAPACITY", severity: "HIGH", validFrom: "2026-11-10", validTo: "2026-11-10" }),
      disruption({ key: "high", effectType: "CAPACITY", severity: "HIGH", validFrom: "2026-11-13", validTo: "2026-11-13" }),
      disruption({ key: "closure", effectType: "CAPACITY", severity: "HIGH", closureLikely: true }),
      disruption({ key: "unconfirmed", effectType: "CAPACITY", severity: "HIGH", status: "UNCONFIRMED" }),
      disruption({ key: "access", effectType: "ACCESS", severity: "HIGH" }),
    ], "2026-11-12");
    expect(alerts.map(row => row.key)).toEqual(["closure", "high"]);
  });
});
