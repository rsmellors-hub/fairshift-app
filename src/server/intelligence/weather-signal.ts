import { createHash } from "node:crypto";
import type { ContextSignal } from "@/server/intelligence/demand-signals";
import { formatClock, type TradingWindow } from "@/server/intelligence/workload";
import { OPEN_METEO_FORECAST_URL, OPEN_METEO_SOURCE_LABEL, type HourlyForecast } from "@/server/integrations/open-meteo/forecast";

// A provider's hourly forecast turned into one signal per location and date, for that day's
// trading hours. Its summary is written here, not by the provider or the AI, and it carries no
// direction: weather's effect depends on the venue, and FairShift doesn't encode one.

// Rain-chance words for the summary only. They set no effect on demand.
const LIKELY_PERCENT = 50, POSSIBLE_PERCENT = 30;

export type LocalHour = { date: string; minute: number; rainChancePercent: number | null; rainMm: number | null; temperatureC: number | null };
export type WeatherHour = { time: string; rainChancePercent: number | null; rainMm: number | null; temperatureC: number | null };

// Each provider instant on the venue's own clock. In the repeated hour when clocks go back,
// the first reading stands; the skipped hour when clocks go forward simply has none.
export function toLocalHours(hours: readonly HourlyForecast[], timeZone: string): LocalHour[] {
  const format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const seen = new Set<string>();
  return hours.flatMap(hour => {
    const parts = Object.fromEntries(format.formatToParts(hour.at).map(part => [part.type, part.value]));
    const date = `${parts.year}-${parts.month}-${parts.day}`, minute = Number(parts.hour) * 60 + Number(parts.minute);
    if (seen.has(`${date}|${minute}`)) return [];
    seen.add(`${date}|${minute}`);
    return [{ date, minute, rainChancePercent: hour.rainChancePercent, rainMm: hour.rainMm, temperatureC: hour.temperatureC }];
  });
}

// FS-CONTEXT-SIGNALS-DEC-002. A forecast is stored and shown at full precision, and compared in
// bands, so a provider's small hourly revisions don't send a decision back for review. Bands start
// at zero, so the rain words above can only change when a band does.
const RAIN_CHANCE_BAND = 10, RAIN_MM_BAND = 0.5, TEMPERATURE_BAND = 2;
const bandOf = (value: number | null, step: number) => value === null ? null : Math.floor(value / step);
export const weatherBands = (hours: readonly WeatherHour[]) => hours.map(hour => ({ time: hour.time, rainChance: bandOf(hour.rainChancePercent, RAIN_CHANCE_BAND), rainMm: bandOf(hour.rainMm, RAIN_MM_BAND), temperature: bandOf(hour.temperatureC, TEMPERATURE_BAND) }));

type Run = { start: number; end: number; peak: number };
function runsAtOrAbove(hours: readonly (WeatherHour & { minute: number })[], threshold: number) {
  const runs: Run[] = [];
  for (const hour of hours) {
    if ((hour.rainChancePercent ?? -1) < threshold) continue;
    const last = runs.at(-1);
    if (last && last.end === hour.minute) { last.end = hour.minute + 60; last.peak = Math.max(last.peak, hour.rainChancePercent!); }
    else runs.push({ start: hour.minute, end: hour.minute + 60, peak: hour.rainChancePercent! });
  }
  return runs;
}

export function summariseWeather(hours: readonly (WeatherHour & { minute: number })[]) {
  const temperatures = hours.flatMap(hour => hour.temperatureC === null ? [] : [hour.temperatureC]);
  const chances = hours.flatMap(hour => hour.rainChancePercent === null ? [] : [hour.rainChancePercent]);
  const top = temperatures.length ? `top ${Math.max(...temperatures)}°C` : null;
  const describe = (word: string, runs: readonly Run[]) => `Rain ${word} ${runs.slice(0, 2).map(run => `${formatClock(run.start)}–${formatClock(run.end)}`).join(" and ")} (up to ${Math.max(...runs.map(run => run.peak))}%)`;
  const likely = runsAtOrAbove(hours, LIKELY_PERCENT), possible = runsAtOrAbove(hours, POSSIBLE_PERCENT);
  const rain = !chances.length ? "Rain chance not given" : likely.length ? describe("likely", likely) : possible.length ? describe("possible", possible) : Math.max(...chances) === 0 ? "Rain chance 0%" : `Low chance of rain (up to ${Math.max(...chances)}%)`;
  return [rain, top].filter(Boolean).join(", ");
}

// Null when the day is closed or the provider gave nothing for its hours: that reads as
// unknown, never as fine weather.
export function weatherSignal(input: { organisationId: string; outletId: string; date: string; hours: readonly LocalHour[]; trading: readonly TradingWindow[] | null; fetchedAt: Date }): ContextSignal | null {
  const trading = input.trading ?? [];
  if (!trading.length) return null;
  const inside = input.hours.filter(hour => hour.date === input.date && trading.some(window => hour.minute < window.end && hour.minute + 60 > window.start)).sort((a, b) => a.minute - b.minute);
  const hours = inside.map(hour => ({ minute: hour.minute, time: formatClock(hour.minute), rainChancePercent: hour.rainChancePercent, rainMm: hour.rainMm, temperatureC: hour.temperatureC }));
  if (!hours.some(hour => hour.rainChancePercent !== null || hour.temperatureC !== null)) return null;
  const stored: WeatherHour[] = hours.map(({ time, rainChancePercent, rainMm, temperatureC }) => ({ time, rainChancePercent, rainMm, temperatureC }));
  const period = { start: Math.min(...trading.map(window => window.start)), end: Math.max(...trading.map(window => window.end)) };
  return {
    // From what it says: an unchanged forecast keeps its row, and a revised one gets its own. A
    // signal row is never edited, so each reading stays as it was.
    id: `ctx_${createHash("sha256").update(["WEATHER_FORECAST", input.outletId, input.date, period.start, period.end, JSON.stringify(stored)].join("|")).digest("hex").slice(0, 24)}`,
    organisationId: input.organisationId, outletId: input.outletId, type: "WEATHER_FORECAST", validFrom: input.date, validTo: input.date, period, direction: "UNSPECIFIED",
    provenance: "PROVIDER_FORECAST", sourceLabel: OPEN_METEO_SOURCE_LABEL, sourceRef: OPEN_METEO_FORECAST_URL,
    summary: summariseWeather(hours), metadata: { hours: stored },
    enteredBy: null, createdAt: input.fetchedAt, withdrawnAt: null,
  };
}
