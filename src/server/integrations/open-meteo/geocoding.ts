import { z } from "zod";

// Open-Meteo geocoding: place names (towns, suburbs) to coordinates. It needs no key; its free tier is
// non-commercial. It doesn't resolve street addresses, so FairShift starts the map at the area and the
// Owner drags the pin onto the venue and confirms it. Nothing is stored until the Owner confirms.
export const OPEN_METEO_GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
export type Place = { name: string; region: string | null; country: string | null; latitude: number; longitude: number };

const COUNTRY_CODES: Record<string, string> = { "south africa": "ZA", za: "ZA", rsa: "ZA", "united kingdom": "GB", uk: "GB", gb: "GB", england: "GB", scotland: "GB", wales: "GB", "northern ireland": "GB" };
export const countryCodeFor = (country?: string | null) => country ? COUNTRY_CODES[country.trim().toLowerCase()] ?? null : null;

const responseSchema = z.object({ results: z.array(z.object({ name: z.string(), latitude: z.number(), longitude: z.number(), admin1: z.string().optional(), country: z.string().optional() })).optional() });

export async function geocodePlace(query: string, country: string | null, fetchImpl: typeof fetch = fetch): Promise<Place[]> {
  const name = query.trim().slice(0, 100);
  if (name.length < 2) return [];
  const url = new URL(OPEN_METEO_GEOCODING_URL);
  url.searchParams.set("name", name); url.searchParams.set("count", "6"); url.searchParams.set("language", "en"); url.searchParams.set("format", "json");
  const code = countryCodeFor(country);
  if (code) url.searchParams.set("countryCode", code);
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(8_000), headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`GEOCODING_HTTP_${response.status}`);
  const parsed = responseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("GEOCODING_MALFORMED");
  return (parsed.data.results ?? []).map(row => ({ name: row.name, region: row.admin1 ?? null, country: row.country ?? null, latitude: row.latitude, longitude: row.longitude }));
}
