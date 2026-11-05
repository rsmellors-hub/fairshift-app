// Location currencies. Work terms are denominated in the currency of the location
// that offers them, and every amount derived from those terms keeps that currency.
// Nothing is converted.

// Established currency of existing locations outside the United Kingdom, including
// the original demonstration location and its PayPal Sandbox payouts.
export const DEFAULT_LOCATION_CURRENCY = "USD";

// The UK entries are mirrored by the one-off policy backfill in drizzle/0013_work_payables.sql.
// South Africa operates in ZAR (DEC-SA-001). Applies to policies created from now on: existing
// policies, shifts, accepted terms and payables keep the currency they were made in, and a
// policy in another currency cannot create shifts here. The operating currency says nothing
// about which currency PayPal can pay out in (DEC-SA-010); see payments/work-payouts.ts.
const COUNTRY_CURRENCIES: Readonly<Record<string, string>> = {
  "united kingdom": "GBP", uk: "GBP", gb: "GBP", "great britain": "GBP",
  england: "GBP", scotland: "GBP", wales: "GBP", "northern ireland": "GBP",
  "south africa": "ZAR", za: "ZAR",
};

// Amounts are held in minor units and shown divided by one hundred, so only known
// two-decimal currencies are accepted where a business supplies money or history.
export function isMinorUnitCurrency(code: string) {
  if (!/^[A-Z]{3}$/.test(code) || !Intl.supportedValuesOf("currency").includes(code)) return false;
  return new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits === 2;
}

export function currencyForCountry(country?: string | null) {
  return country ? COUNTRY_CURRENCIES[country.trim().toLowerCase()] ?? null : null;
}

// The location's own country when it has one, otherwise the organisation's country;
// a country without a mapped currency keeps the established default.
export function resolveLocationCurrency(input: { locationCountry?: string | null; organisationCountry?: string | null }) {
  const country = input.locationCountry?.trim() ? input.locationCountry : input.organisationCountry;
  return currencyForCountry(country) ?? DEFAULT_LOCATION_CURRENCY;
}
