import { z } from "zod";

// Open-Meteo hourly forecast API. It needs no key, and its free tier is non-commercial, so a
// production service would need its paid plan or another provider. The provider's numbers are
// parsed and passed on; its response is not logged, and FairShift writes all summary text.
export const OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
export const OPEN_METEO_SOURCE_LABEL = "Open-Meteo forecast";
// Today plus the seven days of the planning week.
const FORECAST_DAYS = 8;

export type WeatherFailureCode = "TIMEOUT" | "NETWORK_ERROR" | `HTTP_${number}` | "MALFORMED_RESPONSE";
export class WeatherProviderError extends Error {
  constructor(readonly code: WeatherFailureCode) { super(`Weather forecast request failed (${code}).`); this.name = "WeatherProviderError"; }
}

export type HourlyForecast = { at: Date; rainChancePercent: number | null; rainMm: number | null; temperatureC: number | null };

const value = z.number().finite().nullable();
const responseSchema = z.object({ hourly: z.object({ time: z.array(z.number().int()), precipitation_probability: z.array(value), precipitation: z.array(value), temperature_2m: z.array(value) }) });

// Unix times, so converting to the venue's own clock stays in FairShift's code and is testable.
export function parseOpenMeteoHourly(raw: unknown): HourlyForecast[] {
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) throw new WeatherProviderError("MALFORMED_RESPONSE");
  const { time, precipitation_probability: chance, precipitation: rain, temperature_2m: temperature } = parsed.data.hourly;
  if (!time.length || chance.length !== time.length || rain.length !== time.length || temperature.length !== time.length) throw new WeatherProviderError("MALFORMED_RESPONSE");
  return time.map((seconds, i) => ({ at: new Date(seconds * 1000), rainChancePercent: chance[i], rainMm: rain[i], temperatureC: temperature[i] }));
}

export const openMeteoRequestUrl = (location: { latitude: number; longitude: number }) => {
  const url = new URL(OPEN_METEO_FORECAST_URL);
  url.search = new URLSearchParams({ latitude: String(location.latitude), longitude: String(location.longitude), hourly: "precipitation_probability,precipitation,temperature_2m", forecast_days: String(FORECAST_DAYS), timeformat: "unixtime", timezone: "GMT" }).toString();
  return url.toString();
};

export async function fetchOpenMeteoHourly(location: { latitude: number; longitude: number }, options: { timeoutMs: number; fetchImpl?: typeof fetch }): Promise<HourlyForecast[]> {
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(openMeteoRequestUrl(location), { signal: AbortSignal.timeout(options.timeoutMs), cache: "no-store" });
  } catch (error) {
    throw new WeatherProviderError(error instanceof DOMException && error.name === "TimeoutError" ? "TIMEOUT" : "NETWORK_ERROR");
  }
  if (!response.ok) throw new WeatherProviderError(`HTTP_${response.status}`);
  let body: unknown;
  try { body = await response.json(); } catch { throw new WeatherProviderError("MALFORMED_RESPONSE"); }
  return parseOpenMeteoHourly(body);
}
