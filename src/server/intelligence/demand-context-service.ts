import { randomUUID } from "node:crypto";
import { and, desc, eq, lt } from "drizzle-orm";
import { z } from "zod";
import { assertRole, type Scope } from "@/server/auth/access";
import { consumeLimit } from "@/server/auth/identity";
import { requireEntitlement } from "@/server/billing/entitlement";
import type { Database } from "@/server/db/client";
import { auditEvents, demandContextDecisions, demandContextFeeds, demandContextProposals, demandContextSignals, outletTradingHours, outlets } from "@/server/db/schema";
import { UserFacingError } from "@/server/domain/errors";
import type { FeedState } from "@/server/intelligence/demand-context";
import { AiProviderError, type StaffingAssessmentProvider } from "@/server/integrations/openai/staffing-assessment";
import { fetchOpenMeteoHourly, WeatherProviderError, type HourlyForecast } from "@/server/integrations/open-meteo/forecast";
import { EventProviderError, fetchTicketmasterEvents, getTicketmasterApiKey, type EventQuery, type ProviderEvent } from "@/server/integrations/ticketmaster/events";
import { CONTEXT_INPUT_VERSION, CONTEXT_INSTRUCTIONS, CONTEXT_OUTPUT_SCHEMA_VERSION, contextJsonSchema, outputFingerprint, validateContextOutput } from "@/server/intelligence/demand-context-contract";
import { DEMAND_CONTEXT_POLICY_VERSION, SCENARIO_ADJUSTMENT_BPS, type DemandScenario } from "@/server/intelligence/demand-context-policy";
import { managerSignalId, type ContextSignal } from "@/server/intelligence/demand-signals";
import { EVENT_RADIUS_KM, listingSignals, type ListingExclusions } from "@/server/intelligence/event-signal";
import { localDate, shiftDate, startOfLocalDay } from "@/server/intelligence/forecast";
import { buildStructuredSignal, type StructuredSignalKind } from "@/server/intelligence/manager-signals";
import { getWeeklyStaffing } from "@/server/intelligence/staffing";
import { toLocalHours, weatherSignal } from "@/server/intelligence/weather-signal";
import { tradingWindowsSchema, type TradingWindow } from "@/server/intelligence/workload";

// Changes to the contextual layer, for the session's own location only. No form field names a
// location, and the figures are always re-read here. A model is called only when a person asks,
// and a proposal changes nothing until a person accepts it.

type ContextScope = Pick<Scope, "userId" | "organisationId" | "locationId" | "role" | "organisationName" | "locationName">;
const MAX_SIGNAL_DAYS = 14, MAX_DAYS_AHEAD = 60;

async function authorise(db: Database, scope: ContextScope) {
  assertRole(scope as Scope, ["OWNER", "MANAGER"]);
  await requireEntitlement(db, scope.organisationId);
}
const audit = (db: Pick<Database, "insert">, scope: ContextScope, action: string, entityType: string, entityId: string, metadata: Record<string, unknown>) =>
  db.insert(auditEvents).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: scope.locationId, action, entityType, entityId, correlationId: `demand-context:${scope.locationId}`, metadata: { actorUserId: scope.userId, ...metadata } });

async function currentDay(db: Database, scope: ContextScope, date: string, now: Date) {
  const staffing = await getWeeklyStaffing(db, scope as Scope, now);
  const outlet = staffing.outlets.find(row => row.outletId === scope.locationId);
  const day = outlet?.demandContext?.days.find(row => row.date === date) ?? null;
  return { outlet: outlet ?? null, day };
}

const MANAGER_SOURCE_LABEL = "Manager entered, not independently verified";
const OWNER_SOURCE_LABEL = "Owner entered, not independently verified";
async function assertSignalDates(db: Database, scope: ContextScope, value: { validFrom: string; validTo: string }, now: Date) {
  const { outlet } = await currentDay(db, scope, value.validFrom, now);
  const today = outlet ? localDate(now, outlet.timezone) : value.validFrom;
  if (value.validTo < value.validFrom || value.validFrom < today || value.validFrom > shiftDate(today, MAX_DAYS_AHEAD) || value.validTo > shiftDate(value.validFrom, MAX_SIGNAL_DAYS - 1)) throw new UserFacingError("context-signal-dates", "Choose dates from today onwards, up to two weeks long.");
}

const managerSignalSchema = z.object({
  validFrom: z.iso.date(), validTo: z.iso.date(),
  summary: z.string().trim().min(3).max(200).refine(value => !/[\u0000-\u001f\u007f]/.test(value), "No control characters."),
  direction: z.enum(["UP", "DOWN", "UNSPECIFIED"]),
}).strict();

// A Manager's own note about their location. It is recorded as exactly that: never as a
// verified event, whatever it says.
export async function addManagerSignal(db: Database, scope: ContextScope, raw: unknown, now = new Date()) {
  await authorise(db, scope);
  const parsed = managerSignalSchema.safeParse(raw);
  if (!parsed.success) throw new UserFacingError("context-signal-invalid", "Enter the dates, a short description and what you expect.");
  const value = parsed.data;
  await assertSignalDates(db, scope, value, now);
  const id = managerSignalId(randomUUID());
  const [row] = await db.insert(demandContextSignals).values({ id, organisationId: scope.organisationId, outletId: scope.locationId, signalType: "MANAGER_ENTERED", validFrom: value.validFrom, validTo: value.validTo, direction: value.direction,
    provenance: "MANAGER_ENTERED", sourceLabel: MANAGER_SOURCE_LABEL, sourceRef: null, summary: value.summary, metadata: {}, enteredBy: scope.userId, createdAt: now }).returning();
  await audit(db, scope, "DEMAND_CONTEXT_SIGNAL_ADDED", "demand_context_signal", id, { validFrom: value.validFrom, validTo: value.validTo, direction: value.direction });
  return row;
}

// Bookings, a local event or a promotion, in fields rather than prose. FairShift writes the
// summary from them, and it's recorded as the Manager's word, never as verified.
export async function addStructuredSignal(db: Database, scope: ContextScope, kind: StructuredSignalKind, raw: unknown, now = new Date()) {
  await authorise(db, scope);
  const value = buildStructuredSignal(kind, raw);
  if (!value) throw new UserFacingError("context-signal-fields", "Check the details: fill in what’s required, with the end time after the start.");
  // An Owner's event is curated from a published source, and says where.
  if (kind === "LOCAL_EVENT" && scope.role === "OWNER" && !value.sourceUrl) throw new UserFacingError("context-event-source-required", "Add the link where this event is published: an event you enter needs its source.");
  await assertSignalDates(db, scope, value, now);
  const id = managerSignalId(randomUUID());
  const [row] = await db.insert(demandContextSignals).values({ id, organisationId: scope.organisationId, outletId: scope.locationId, signalType: value.type, validFrom: value.validFrom, validTo: value.validTo, periodStart: value.period?.start ?? null, periodEnd: value.period?.end ?? null, direction: value.direction,
    provenance: "MANAGER_ENTERED", sourceLabel: scope.role === "OWNER" ? OWNER_SOURCE_LABEL : MANAGER_SOURCE_LABEL, sourceRef: value.sourceUrl ?? null, summary: value.summary,
    metadata: { ...value.metadata, enteredByRole: scope.role, ...(value.sourceUrl ? { sourceUrl: value.sourceUrl } : {}) }, enteredBy: scope.userId, createdAt: now }).returning();
  await audit(db, scope, "DEMAND_CONTEXT_SIGNAL_ADDED", "demand_context_signal", id, { signalType: value.type, validFrom: value.validFrom, validTo: value.validTo, direction: value.direction });
  return row;
}

export async function withdrawManagerSignal(db: Database, scope: ContextScope, signalId: string, now = new Date()) {
  await authorise(db, scope);
  const [row] = await db.update(demandContextSignals).set({ withdrawnAt: now, withdrawnBy: scope.userId })
    .where(and(eq(demandContextSignals.id, signalId), eq(demandContextSignals.organisationId, scope.organisationId), eq(demandContextSignals.outletId, scope.locationId), eq(demandContextSignals.provenance, "MANAGER_ENTERED"))).returning();
  if (!row) throw new UserFacingError("context-not-found", "That context is no longer available.");
  await audit(db, scope, "DEMAND_CONTEXT_SIGNAL_WITHDRAWN", "demand_context_signal", signalId, {});
  return row;
}

export type ProposeResult = { record: typeof demandContextProposals.$inferSelect; generated: boolean };

// Asks the model for a bounded scenario on one date. A provider failure or rejected output is
// recorded as a failed attempt, and the baseline and everything from it carry on regardless.
export async function proposeDemandContext(db: Database, scope: ContextScope, date: string, provider: StaffingAssessmentProvider, now = new Date()): Promise<ProposeResult> {
  await authorise(db, scope);
  const { outlet, day } = await currentDay(db, scope, date, now);
  if (!day?.input || !day.fingerprint) throw new UserFacingError("context-no-baseline", "There’s no demand baseline for that day.");
  if (!day.signals.length) throw new UserFacingError("context-no-signal", "There’s no context for that day, so there’s nothing to weigh against the baseline.");
  const reusable = async () => (await db.select().from(demandContextProposals).where(and(eq(demandContextProposals.organisationId, scope.organisationId), eq(demandContextProposals.outletId, scope.locationId), eq(demandContextProposals.targetDate, date), eq(demandContextProposals.inputFingerprint, day.fingerprint!), eq(demandContextProposals.status, "AVAILABLE"))))[0];
  // The same evidence is never put to the model twice, so a later call can't replace an answer.
  const existing = await reusable();
  if (existing) return { record: existing, generated: false };
  await consumeLimit(db, `demand-context:${scope.organisationId}:${scope.locationId}`, 20);

  // How old a feed is goes to the model but isn't part of the fingerprint, so its age alone or a
  // failed refresh never makes a decision stale. A changed forecast or listing does.
  const freshness = (state: FeedState | undefined, supplied: boolean) => supplied && state?.ageHours != null ? { fetchedHoursAgo: Math.round(state.ageHours), stale: state.status === "STALE" } : null;
  const request = { ...day.input,
    weatherFreshness: freshness(outlet?.demandContext?.weather, day.signals.some(signal => signal.provenance === "PROVIDER_FORECAST")),
    eventsFreshness: freshness(outlet?.demandContext?.events, day.signals.some(signal => signal.provenance === "PROVIDER_EVENT")) };
  type Outcome = { scenario: DemandScenario; period: TradingWindow | null; citedSignalIds: string[]; reason: string; responseModel: string; responseId: string | null } | { failureCode: string; responseModel: string | null; responseId: string | null };
  let outcome: Outcome;
  try {
    const response = await provider.assess({ instructions: CONTEXT_INSTRUCTIONS, input: JSON.stringify(request), schemaName: "fairshift_demand_context", schema: contextJsonSchema(day.input) });
    let raw: unknown;
    try { raw = JSON.parse(response.text); } catch { raw = undefined; }
    // The evidence is read again: an answer about evidence that has moved isn't used.
    const after = await currentDay(db, scope, date, new Date());
    const validated = validateContextOutput(raw, { organisationId: scope.organisationId, outletId: scope.locationId, date, signals: day.signals, blocks: outlet?.days.find(row => row.planningDate === date)?.context?.baseline.blocks ?? outlet?.days.find(row => row.planningDate === date)?.blocks ?? [], inputFingerprint: day.fingerprint, currentFingerprint: after.day?.fingerprint ?? "" });
    // Which rule rejected it, for diagnosis; never the model's text.
    if (!validated.ok) console.error("Demand context output rejected", { code: validated.code, responseId: response.responseId });
    outcome = validated.ok ? { ...validated.output, responseModel: response.responseModel, responseId: response.responseId } : { failureCode: `VALIDATION_${validated.code}`, responseModel: response.responseModel, responseId: response.responseId };
  } catch (error) {
    outcome = { failureCode: error instanceof AiProviderError ? error.code : "PROVIDER_ERROR", responseModel: null, responseId: null };
  }
  // Calculated and official signals are kept as they were put to the model, with their sources.
  // People's entries and feed signals are already stored.
  const derived = day.signals.filter(signal => signal.provenance === "DETERMINISTIC_CALCULATION" || signal.provenance === "OFFICIAL_SNAPSHOT" || signal.provenance === "HOLIDAY_FEED" || signal.provenance === "HOLIDAY_FALLBACK");
  if (derived.length) await db.insert(demandContextSignals).values(derived.map(signal => ({ id: signal.id, organisationId: signal.organisationId, outletId: signal.outletId, signalType: signal.type, validFrom: signal.validFrom, validTo: signal.validTo, direction: signal.direction, provenance: signal.provenance, sourceLabel: signal.sourceLabel, sourceRef: signal.sourceRef, summary: signal.summary, metadata: signal.metadata, createdAt: now }))).onConflictDoNothing();
  const base = { organisationId: scope.organisationId, outletId: scope.locationId, targetDate: date, policyVersion: DEMAND_CONTEXT_POLICY_VERSION, inputVersion: CONTEXT_INPUT_VERSION, outputSchemaVersion: CONTEXT_OUTPUT_SCHEMA_VERSION, inputFingerprint: day.fingerprint, input: request,
    provider: provider.provider, model: provider.model, responseModel: outcome.responseModel, providerResponseId: outcome.responseId, requestedBy: scope.userId, createdAt: now };
  const values = "scenario" in outcome
    ? { ...base, id: randomUUID(), status: "AVAILABLE", scenario: outcome.scenario, periodStart: outcome.period?.start ?? null, periodEnd: outcome.period?.end ?? null, citedSignalIds: outcome.citedSignalIds, reason: outcome.reason, failureCode: null }
    : { ...base, id: randomUUID(), status: "FAILED", scenario: null, periodStart: null, periodEnd: null, citedSignalIds: null, reason: null, failureCode: outcome.failureCode };
  const [record] = await db.insert(demandContextProposals).values(values).onConflictDoNothing().returning();
  if (!record) return { record: (await reusable())!, generated: false };
  await audit(db, scope, record.status === "AVAILABLE" ? "DEMAND_CONTEXT_PROPOSED" : "DEMAND_CONTEXT_PROPOSAL_FAILED", "demand_context_proposal", record.id, { date, model: record.model, responseModel: record.responseModel, scenario: record.scenario, periodStart: record.periodStart, periodEnd: record.periodEnd, failureCode: record.failureCode });
  return { record, generated: true };
}

export type ContextAction = "ACCEPTED" | "DISMISSED" | "WITHDRAWN";

// A person's decision on a proposal. The form supplies only the proposal: the scenario and its
// assumption are read here, so no value can be typed in. Accepting or dismissing requires the
// evidence to be unchanged since the proposal. Withdrawing returns the day to its baseline.
export async function decideDemandContext(db: Database, scope: ContextScope, input: { proposalId: string; action: ContextAction }, now = new Date()) {
  await authorise(db, scope);
  const missing = () => new UserFacingError("context-not-found", "That proposal is no longer available.");
  if (!z.uuid().safeParse(input.proposalId).success || !["ACCEPTED", "DISMISSED", "WITHDRAWN"].includes(input.action)) throw missing();
  const [proposal] = await db.select().from(demandContextProposals).where(and(eq(demandContextProposals.id, input.proposalId), eq(demandContextProposals.organisationId, scope.organisationId), eq(demandContextProposals.outletId, scope.locationId), eq(demandContextProposals.status, "AVAILABLE")));
  if (!proposal) throw missing();
  const { outlet, day } = await currentDay(db, scope, proposal.targetDate, now);
  if (input.action !== "WITHDRAWN" && (!day || day.fingerprint !== proposal.inputFingerprint)) throw new UserFacingError("context-changed", "The evidence has changed since this was proposed, so it can’t be decided on. Ask for a new proposal.");
  // One influence is never counted twice: a day already using AI-found adjustments takes no scenario.
  if (input.action === "ACCEPTED" && outlet?.localIntelligence?.days.some(row => row.date === proposal.targetDate && row.state === "ACCEPTED")) throw new UserFacingError("context-local-accepted", "This day already uses AI-found adjustments. Stop using them first, so the same influence isn’t counted twice.");
  const scenario = proposal.scenario as DemandScenario;
  return db.transaction(async tx => {
    const [locked] = await tx.select({ id: demandContextProposals.id }).from(demandContextProposals).where(eq(demandContextProposals.id, proposal.id)).for("update");
    if (!locked) throw missing();
    const [latest] = await tx.select().from(demandContextDecisions).where(and(eq(demandContextDecisions.outletId, scope.locationId), eq(demandContextDecisions.targetDate, proposal.targetDate))).orderBy(desc(demandContextDecisions.sequence)).limit(1);
    if (input.action === "WITHDRAWN" && (!latest || latest.proposalId !== proposal.id || latest.action === "WITHDRAWN")) throw new UserFacingError("context-not-found", "There’s no decision on this proposal to withdraw.");
    // Pressing a button twice records one decision.
    if (latest && latest.proposalId === proposal.id && latest.action === input.action) return latest;
    const [decision] = await tx.insert(demandContextDecisions).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: scope.locationId, targetDate: proposal.targetDate, sequence: (latest?.sequence ?? 0) + 1, proposalId: proposal.id, action: input.action, scenario, adjustmentBps: SCENARIO_ADJUSTMENT_BPS[scenario], periodStart: proposal.periodStart, periodEnd: proposal.periodEnd,
      policyVersion: proposal.policyVersion, inputFingerprint: proposal.inputFingerprint, outputFingerprint: outputFingerprint({ scenario, citedSignalIds: proposal.citedSignalIds, reason: proposal.reason!, period: proposal.periodStart === null || proposal.periodEnd === null ? null : { start: proposal.periodStart, end: proposal.periodEnd } }), signalIds: proposal.citedSignalIds, decidedBy: scope.userId, decidedByRole: scope.role, decidedAt: now }).returning();
    await audit(tx as unknown as Database, scope, `DEMAND_CONTEXT_${input.action}`, "demand_context_decision", decision.id, { proposalId: proposal.id, date: proposal.targetDate, scenario, adjustmentBps: decision.adjustmentBps, periodStart: decision.periodStart, periodEnd: decision.periodEnd, policyVersion: decision.policyVersion, inputFingerprint: decision.inputFingerprint });
    return decision;
  });
}

// Feed refresh, for weather and provider events. On page open a feed runs only when its last good
// fetch is over six hours old, waits no more than a few seconds, and tries at most once in a quarter
// of an hour, so an outage can't slow every page. Failure keeps the last good signals, and is never
// a reason to stop planning.
const FEED_DUE_HOURS = 6, FEED_RETRY_MINUTES = 15;
const FEED_OPEN_TIMEOUT_MS = 3_000, FEED_EXPLICIT_TIMEOUT_MS = 8_000;
export type FeedRefreshResult = "REFRESHED" | "FAILED" | "NO_COORDINATES" | "NOT_CONFIGURED" | "NOT_DUE";
type FeedScope = Pick<ContextScope, "organisationId" | "locationId">;
type FeedLocation = { timezone: string; latitude: number; longitude: number; today: string };

async function refreshFeed(db: Database, scope: FeedScope, feed: "WEATHER" | "EVENTS", mode: "EXPLICIT" | "ON_OPEN", now: Date, signalsFor: (location: FeedLocation, timeoutMs: number) => Promise<{ signals: ContextSignal[]; excluded?: ListingExclusions }>): Promise<FeedRefreshResult> {
  const [outlet] = await db.select({ timezone: outlets.timezone, latitude: outlets.latitude, longitude: outlets.longitude }).from(outlets).where(and(eq(outlets.id, scope.locationId), eq(outlets.organisationId, scope.organisationId)));
  if (!outlet || outlet.latitude === null || outlet.longitude === null) return "NO_COORDINATES";
  const key = and(eq(demandContextFeeds.outletId, scope.locationId), eq(demandContextFeeds.feed, feed));
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
  if (mode === "ON_OPEN") {
    const [row] = await db.select().from(demandContextFeeds).where(key);
    if (row?.lastSuccessAt && row.lastSuccessAt > hoursAgo(FEED_DUE_HOURS)) return "NOT_DUE";
  }
  // Claiming the attempt in one statement means two open tabs make one provider call.
  const [claimed] = await db.insert(demandContextFeeds).values({ organisationId: scope.organisationId, outletId: scope.locationId, feed, lastAttemptAt: now })
    .onConflictDoUpdate({ target: [demandContextFeeds.outletId, demandContextFeeds.feed], set: { lastAttemptAt: now }, where: mode === "ON_OPEN" ? lt(demandContextFeeds.lastAttemptAt, hoursAgo(FEED_RETRY_MINUTES / 60)) : undefined }).returning();
  if (!claimed) return "NOT_DUE";
  try {
    const { signals, excluded } = await signalsFor({ timezone: outlet.timezone, latitude: outlet.latitude, longitude: outlet.longitude, today: localDate(now, outlet.timezone) }, mode === "ON_OPEN" ? FEED_OPEN_TIMEOUT_MS : FEED_EXPLICIT_TIMEOUT_MS);
    await db.transaction(async tx => {
      // A signal already held keeps its row and first-seen time. The feed records this fetch.
      if (signals.length) await tx.insert(demandContextSignals).values(signals.map(signal => ({ id: signal.id, organisationId: signal.organisationId, outletId: signal.outletId, signalType: signal.type, validFrom: signal.validFrom, validTo: signal.validTo, periodStart: signal.period?.start ?? null, periodEnd: signal.period?.end ?? null, direction: signal.direction, provenance: signal.provenance, sourceLabel: signal.sourceLabel, sourceRef: signal.sourceRef, summary: signal.summary, metadata: signal.metadata, createdAt: now }))).onConflictDoNothing();
      await tx.update(demandContextFeeds).set({ lastSuccessAt: now, lastFailureCode: null, currentSignalIds: signals.map(signal => signal.id) }).where(key);
      await tx.insert(auditEvents).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: scope.locationId, action: `DEMAND_CONTEXT_${feed}_REFRESHED`, entityType: "outlet", entityId: scope.locationId, correlationId: `demand-context:${scope.locationId}`, metadata: { mode, signals: signals.length, ...(excluded ? { excluded } : {}) } });
    });
    return "REFRESHED";
  } catch (error) {
    // The code only: a provider's URL can carry its key, and its body isn't ours to log.
    const code = error instanceof WeatherProviderError || error instanceof EventProviderError ? error.code : "REFRESH_ERROR";
    console.error("Feed refresh failed; the last good signals stand.", { feed, code });
    await db.update(demandContextFeeds).set({ lastFailureCode: code }).where(key);
    return "FAILED";
  }
}

// A date's trading windows: empty when closed, null when none are set.
async function tradingLookup(db: Database, locationId: string) {
  const trading = await db.select().from(outletTradingHours).where(eq(outletTradingHours.outletId, locationId));
  return (date: string): TradingWindow[] | null => {
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay() || 7;
    const windows = trading.find(row => row.isoWeekday === weekday)?.windows;
    return windows ? tradingWindowsSchema.parse(windows) : null;
  };
}

export type FetchHourly = (location: { latitude: number; longitude: number }, timeoutMs: number) => Promise<HourlyForecast[]>;
export function refreshLocationWeather(db: Database, scope: FeedScope, options: { mode: "EXPLICIT" | "ON_OPEN"; now?: Date; fetchHourly?: FetchHourly }) {
  const fetchHourly = options.fetchHourly ?? ((location, timeoutMs) => fetchOpenMeteoHourly(location, { timeoutMs }));
  const now = options.now ?? new Date();
  return refreshFeed(db, scope, "WEATHER", options.mode, now, async (location, timeoutMs) => {
    const hours = toLocalHours(await fetchHourly(location, timeoutMs), location.timezone);
    const tradingFor = await tradingLookup(db, scope.locationId);
    return { signals: Array.from({ length: 7 }, (_, i) => shiftDate(location.today, i + 1)).flatMap(date => {
      const signal = weatherSignal({ organisationId: scope.organisationId, outletId: scope.locationId, date, hours, trading: tradingFor(date), fetchedAt: now });
      return signal ? [signal] : [];
    }) };
  });
}

export type FetchEvents = (query: EventQuery, timeoutMs: number) => Promise<ProviderEvent[]>;
export async function refreshLocationEvents(db: Database, scope: FeedScope, options: { mode: "EXPLICIT" | "ON_OPEN"; now?: Date; apiKey?: string | null; fetchEvents?: FetchEvents }): Promise<FeedRefreshResult> {
  const apiKey = options.apiKey === undefined ? getTicketmasterApiKey() : options.apiKey;
  if (!apiKey && !options.fetchEvents) return "NOT_CONFIGURED";
  const fetchEvents = options.fetchEvents ?? ((query, timeoutMs) => fetchTicketmasterEvents(query, { apiKey: apiKey!, timeoutMs }));
  const now = options.now ?? new Date();
  return refreshFeed(db, scope, "EVENTS", options.mode, now, async (location, timeoutMs) => {
    const firstDate = shiftDate(location.today, 1), lastDate = shiftDate(location.today, 7);
    const events = await fetchEvents({ latitude: location.latitude, longitude: location.longitude, radiusKm: EVENT_RADIUS_KM, from: startOfLocalDay(firstDate, location.timezone), to: startOfLocalDay(shiftDate(lastDate, 1), location.timezone) }, timeoutMs);
    return listingSignals({ organisationId: scope.organisationId, outletId: scope.locationId, latitude: location.latitude, longitude: location.longitude, firstDate, lastDate, events, fetchedAt: now, tradingFor: await tradingLookup(db, scope.locationId) });
  });
}

// Both feeds together, each failing on its own. The page's open never waits on one after the other.
export async function refreshContextFeedsIfDue(db: Database, scope: FeedScope) {
  await Promise.allSettled([refreshLocationWeather(db, scope, { mode: "ON_OPEN" }), refreshLocationEvents(db, scope, { mode: "ON_OPEN" })]);
}

export async function refreshContextFeeds(db: Database, scope: ContextScope, now = new Date()) {
  await authorise(db, scope);
  await consumeLimit(db, `context-feeds:${scope.locationId}`, 20);
  const [weather, events] = await Promise.all([refreshLocationWeather(db, scope, { mode: "EXPLICIT", now }), refreshLocationEvents(db, scope, { mode: "EXPLICIT", now })]);
  return { weather, events };
}
