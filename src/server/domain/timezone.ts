// Location time zones. A location's time zone defines its local sales dates,
// weekdays, planning dates and shift dates, so it is resolved from what the domain
// knows about the location rather than assumed for every new location.

// Established default for locations whose country is not recognised below
// (the original South African demonstration location).
export const DEFAULT_LOCATION_TIMEZONE = "Africa/Johannesburg";

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

// Location country first, then the organisation's country, then the single time
// zone already used by the organisation's locations, then the established default.
export function resolveLocationTimezone(input: { locationCountry?: string | null; organisationCountry?: string | null; existingTimezones?: readonly string[] }) {
  const existing = [...new Set(input.existingTimezones ?? [])];
  return timezoneForCountry(input.locationCountry) ?? timezoneForCountry(input.organisationCountry)
    ?? (existing.length === 1 ? existing[0] : null) ?? DEFAULT_LOCATION_TIMEZONE;
}
