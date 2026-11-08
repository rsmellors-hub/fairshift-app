import { createHash } from "node:crypto";
import { shiftDate, type DailySales, type SalesSource } from "@/server/intelligence/forecast";
import type { HolidayFact } from "@/server/reference/public-holiday-feed";
import { UK_BANK_HOLIDAYS, type BankHolidayDivision } from "@/server/reference/uk-bank-holidays";

// Contextual signals: what FairShift knows about a location and date beyond its demand
// baseline. Each carries where it came from. A signal never edits sales history and never
// changes staffing by itself. A missing signal means unknown, never normal conditions.

export const SIGNAL_TYPES = ["MOMENTUM", "MANAGER_ENTERED", "BANK_HOLIDAY", "WEATHER_FORECAST", "BOOKINGS", "LOCAL_EVENT", "PROMOTION"] as const;
export type SignalType = typeof SIGNAL_TYPES[number];
export const SIGNAL_DIRECTIONS = ["UP", "DOWN", "FLAT", "UNSPECIFIED"] as const;
export type SignalDirection = typeof SIGNAL_DIRECTIONS[number];
export type SignalProvenance = "DETERMINISTIC_CALCULATION" | "MANAGER_ENTERED" | "OFFICIAL_SNAPSHOT" | "PROVIDER_FORECAST" | "PROVIDER_EVENT" | "HOLIDAY_FEED" | "HOLIDAY_FALLBACK";
// Minutes after local midnight, when a signal concerns part of a day.
export type SignalPeriod = { start: number; end: number };

export type ContextSignal = {
  id: string; organisationId: string; outletId: string; type: SignalType;
  validFrom: string; validTo: string; period: SignalPeriod | null; direction: SignalDirection;
  provenance: SignalProvenance; sourceLabel: string; sourceRef: string | null;
  summary: string; metadata: Record<string, unknown>;
  enteredBy: string | null; createdAt: Date | null; withdrawnAt: Date | null;
};

export const MOMENTUM_METHOD_VERSION = "transactions-28-v-prior-28-v1";
const MOMENTUM_WINDOW_DAYS = 28;
// Three weeks of the four: fewer observed days can't support a comparison, so there is no signal.
const MOMENTUM_MINIMUM_OBSERVED_DAYS = 21;
// A change under one percent is reported as flat, with its figure still shown.
const MOMENTUM_FLAT_BPS = 100;
// How long after the data cutoff a comparison still describes the forecast date.
const MOMENTUM_VALID_DAYS = 14;

const signalId = (...parts: readonly (string | number)[]) => `ctx_${createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24)}`;
export const managerSignalId = (uniqueToken: string) => signalId("MANAGER_ENTERED", uniqueToken);

const percent = (bps: number) => new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 }).format(Math.abs(bps) / 100);

// Latest 28 days against the 28 before them, by transactions per observed trading day, from
// this location's own chosen history. Calculated, not AI. The result is null where either
// period is too thin or the cutoff is too old to describe the forecast period.
export function momentumSignal(input: { organisationId: string; outletId: string; source: SalesSource; synthetic: boolean; days: readonly DailySales[]; dataThrough: string }): ContextSignal | null {
  const recentFrom = shiftDate(input.dataThrough, -(MOMENTUM_WINDOW_DAYS - 1)), priorTo = shiftDate(recentFrom, -1), priorFrom = shiftDate(priorTo, -(MOMENTUM_WINDOW_DAYS - 1));
  const within = (from: string, to: string) => input.days.filter(day => day.date >= from && day.date <= to && day.transactions > 0);
  const recent = within(recentFrom, input.dataThrough), prior = within(priorFrom, priorTo);
  if (recent.length < MOMENTUM_MINIMUM_OBSERVED_DAYS || prior.length < MOMENTUM_MINIMUM_OBSERVED_DAYS) return null;
  const total = (rows: readonly DailySales[]) => rows.reduce((sum, row) => sum + row.transactions, 0);
  const recentTransactions = total(recent), priorTransactions = total(prior);
  // Integer cross-multiplication: the same counts always give the same figure.
  const changeBps = Math.round(((recentTransactions * prior.length - priorTransactions * recent.length) * 10_000) / (priorTransactions * recent.length));
  const direction: SignalDirection = Math.abs(changeBps) < MOMENTUM_FLAT_BPS ? "FLAT" : changeBps > 0 ? "UP" : "DOWN";
  const label = input.synthetic ? "synthetic reference history" : "recorded sales history";
  return {
    id: signalId("MOMENTUM", input.outletId, input.dataThrough, input.source, MOMENTUM_METHOD_VERSION, recentTransactions, recent.length, priorTransactions, prior.length),
    organisationId: input.organisationId, outletId: input.outletId, type: "MOMENTUM",
    validFrom: shiftDate(input.dataThrough, 1), validTo: shiftDate(input.dataThrough, MOMENTUM_VALID_DAYS), period: null, direction,
    provenance: "DETERMINISTIC_CALCULATION", sourceLabel: `Calculated by FairShift from ${label}`, sourceRef: MOMENTUM_METHOD_VERSION,
    summary: direction === "FLAT"
      ? `Transactions per trading day were about level (${changeBps < 0 ? "down" : "up"} ${percent(changeBps)}%) over the latest 28 days against the 28 before.`
      : `Transactions per trading day were ${percent(changeBps)}% ${direction === "UP" ? "higher" : "lower"} over the latest 28 days against the 28 before.`,
    metadata: { method: MOMENTUM_METHOD_VERSION, source: input.source, synthetic: input.synthetic, recentFrom, recentTo: input.dataThrough, priorFrom, priorTo, recentTransactions, recentDays: recent.length, priorTransactions, priorDays: prior.length, changeBps },
    enteredBy: null, createdAt: null, withdrawnAt: null,
  };
}

const UK_COUNTRY = /^(united kingdom|uk|great britain|gb|england|wales|scotland|northern ireland)$/i;
const DIVISION: Record<string, BankHolidayDivision> = { england: "england-and-wales", wales: "england-and-wales", scotland: "scotland", "northern ireland": "northern-ireland" };

// Bank holidays differ by nation, so the nation must be stated in the location's own record.
// A county or city is not resolved to a nation here: that would be a guess, so it stays unknown.
export function bankHolidayDivision(location: { province: string | null; country: string | null }): BankHolidayDivision | null {
  const country = location.country?.trim() ?? "", province = location.province?.trim().toLowerCase() ?? "";
  if (!UK_COUNTRY.test(country)) return null;
  return DIVISION[province] ?? DIVISION[country.toLowerCase()] ?? null;
}

const NATION_LABEL: Record<BankHolidayDivision, string> = { "england-and-wales": "England and Wales", scotland: "Scotland", "northern-ireland": "Northern Ireland" };

// The official holiday on one date, from the committed snapshot. Its effect on trade is not
// known to FairShift, so it carries no direction.
export function bankHolidaySignal(input: { organisationId: string; outletId: string; division: BankHolidayDivision; date: string }): ContextSignal | null {
  const event = UK_BANK_HOLIDAYS.events[input.division].find(row => row.date === input.date);
  if (!event) return null;
  return {
    id: signalId("BANK_HOLIDAY", input.outletId, input.division, input.date, UK_BANK_HOLIDAYS.retrievedOn),
    organisationId: input.organisationId, outletId: input.outletId, type: "BANK_HOLIDAY",
    validFrom: input.date, validTo: input.date, period: null, direction: "UNSPECIFIED",
    provenance: "OFFICIAL_SNAPSHOT", sourceLabel: `GOV.UK bank holidays, snapshot of ${UK_BANK_HOLIDAYS.retrievedOn}`, sourceRef: UK_BANK_HOLIDAYS.source,
    summary: `Bank holiday in ${NATION_LABEL[input.division]}: ${event.title}${event.notes ? ` (${event.notes})` : ""}.`,
    metadata: { division: input.division, title: event.title, snapshotRetrievedOn: UK_BANK_HOLIDAYS.retrievedOn },
    enteredBy: null, createdAt: null, withdrawnAt: null,
  };
}

// A South African public holiday on one date: from the live holiday feed, or, for a year the feed
// doesn't cover, from FairShift's built-in rules, labelled as the fallback. Like the UK's, it says only
// that the date is a holiday and carries no direction. Its identifier follows what it says, so a feed
// refresh with the same holiday keeps it and no decision goes stale.
export function saPublicHolidaySignal(input: { organisationId: string; outletId: string; fact: HolidayFact; updatedAt: Date | null }): ContextSignal {
  const { fact } = input;
  return {
    id: signalId("BANK_HOLIDAY", input.outletId, "ZA", fact.date, fact.origin, fact.name),
    organisationId: input.organisationId, outletId: input.outletId, type: "BANK_HOLIDAY",
    validFrom: fact.date, validTo: fact.date, period: null, direction: "UNSPECIFIED",
    provenance: fact.origin === "FEED" ? "HOLIDAY_FEED" : "HOLIDAY_FALLBACK", sourceLabel: fact.sourceLabel, sourceRef: fact.sourceUrl,
    summary: `Public holiday in South Africa: ${fact.name}.`,
    metadata: { country: "ZA", name: fact.name, origin: fact.origin, ...(fact.verification ? { verification: fact.verification } : {}) },
    enteredBy: null, createdAt: input.updatedAt, withdrawnAt: null,
  };
}

export type SignalScopeFailure = "FOREIGN_ORGANISATION" | "FOREIGN_LOCATION" | "INVALID_DATE" | "WITHDRAWN";
// Whether a signal may inform this organisation's location on this date, and why not.
export function signalScopeFailure(signal: Pick<ContextSignal, "organisationId" | "outletId" | "validFrom" | "validTo" | "withdrawnAt">, scope: { organisationId: string; outletId: string; date: string }): SignalScopeFailure | null {
  if (signal.organisationId !== scope.organisationId) return "FOREIGN_ORGANISATION";
  if (signal.outletId !== scope.outletId) return "FOREIGN_LOCATION";
  if (scope.date < signal.validFrom || scope.date > signal.validTo) return "INVALID_DATE";
  return signal.withdrawnAt ? "WITHDRAWN" : null;
}
