// Location currencies. Work terms are denominated in the currency of the location
// that offers them, and every amount derived from those terms keeps that currency.
// Nothing is converted.

// Established currency of existing locations outside the United Kingdom, including
// the original demonstration location and its PayPal Sandbox payouts.
export const DEFAULT_LOCATION_CURRENCY = "USD";

// Mirrored by the policy backfill in drizzle/0013_work_payables.sql.
const COUNTRY_CURRENCIES: Readonly<Record<string, string>> = {
  "united kingdom": "GBP", uk: "GBP", gb: "GBP", "great britain": "GBP",
  england: "GBP", scotland: "GBP", wales: "GBP", "northern ireland": "GBP",
};

export function currencyForCountry(country?: string | null) {
  return country ? COUNTRY_CURRENCIES[country.trim().toLowerCase()] ?? null : null;
}

// The location's own country when it has one, otherwise the organisation's country;
// a country without a mapped currency keeps the established default.
export function resolveLocationCurrency(input: { locationCountry?: string | null; organisationCountry?: string | null }) {
  const country = input.locationCountry?.trim() ? input.locationCountry : input.organisationCountry;
  return currencyForCountry(country) ?? DEFAULT_LOCATION_CURRENCY;
}
