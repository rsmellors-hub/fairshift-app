import { UserFacingError } from "./errors";

// Location time zones. A location's time zone defines its local sales dates,
// weekdays, planning dates and shift dates, so it is resolved from what the domain
// knows about the location rather than assumed for every new location.

// Single-time-zone countries only; a multi-zone country cannot be resolved from its name.
// Mirrored by the corrective update in drizzle/0012_staffing_coverage.sql.
const COUNTRY_TIMEZONES: Readonly<Record<string, string>> = {
  "united kingdom": "Europe/London", uk: "Europe/London", gb: "Europe/London", "great britain": "Europe/London",
  england: "Europe/London", scotland: "Europe/London", wales: "Europe/London", "northern ireland": "Europe/London",
  "south africa": "Africa/Johannesburg", za: "Africa/Johannesburg",
};

export function timezoneForCountry(country?: string | null) {
  return country ? COUNTRY_TIMEZONES[country.trim().toLowerCase()] ?? null : null;
}

// Location country first, then the organisation's country, then the single time zone
// already used by the organisation's locations. A zone that cannot be established is
// refused: a guess would put every shift at that location at the wrong time.
export function resolveLocationTimezone(input: { locationCountry?: string | null; organisationCountry?: string | null; existingTimezones?: readonly string[] }) {
  const existing = [...new Set(input.existingTimezones ?? [])];
  const zone = timezoneForCountry(input.locationCountry) ?? timezoneForCountry(input.organisationCountry) ?? (existing.length === 1 ? existing[0] : null);
  if (!zone) throw new UserFacingError("location-timezone-unknown", "FairShift can’t yet work out the local time for this location’s country.");
  return zone;
}

// A shift's wall-clock time at its work location → the instant it happens. The
// location's IANA zone is the only input that decides this: not the browser, not the
// server, and no default. Times a location's clocks skip or repeat are refused rather
// than guessed. Pure, so the planning form can preview with the same rule.
export type LocalTimeProblem = "INVALID" | "NONEXISTENT" | "AMBIGUOUS" | "UNKNOWN_TIMEZONE";
export class LocalTimeError extends Error {
  constructor(readonly problem: LocalTimeProblem, message: string) { super(message); this.name = "LocalTimeError"; }
}

function wallClock(instant: number, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(new Date(instant)).map(part => [part.type, part.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
}

export function localDateTimeToInstant(value: string, timeZone: string) {
  try { new Intl.DateTimeFormat("en-GB", { timeZone }); } catch { throw new LocalTimeError("UNKNOWN_TIMEZONE", "This location has no valid time zone."); }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new LocalTimeError("INVALID", "Enter a valid date and time.");
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  const calendar = new Date(wanted);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day || calendar.getUTCHours() !== hour || calendar.getUTCMinutes() !== minute) {
    throw new LocalTimeError("INVALID", "Enter a valid date and time.");
  }
  // The offsets in force either side of this time; a real time matches at least one.
  const offsets = new Set([wanted - 86_400_000, wanted + 86_400_000].map(instant => wallClock(instant, timeZone) - instant));
  const matches = [...new Set([...offsets].map(offset => wanted - offset))].filter(instant => wallClock(instant, timeZone) === wanted);
  if (!matches.length) throw new LocalTimeError("NONEXISTENT", "That time does not exist at this location: the clocks go forward then.");
  if (matches.length > 1) throw new LocalTimeError("AMBIGUOUS", "That time happens twice at this location: the clocks go back then. Choose another time.");
  return new Date(matches[0]);
}
