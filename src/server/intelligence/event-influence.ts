import { parseClock, type TradingWindow } from "@/server/intelligence/workload";

// FS-CONTEXT-SIGNALS-DEC-002. Trade around an event happens outside its own hours, so an event
// bears on the time from before it starts until after it ends. These durations are product
// settings, and the same rule applies to a Manager's event and a provider's listing.
const LEAD_MINUTES = 120, AFTER_END_MINUTES = 60, AFTER_START_WITHOUT_END_MINUTES = 180;
const MINUTES_IN_DAY = 24 * 60;

// Kept to the event's own date, the only one its signal informs. Null when there is no start time:
// such an event can support only a whole-day scenario.
export function influenceWindow(start: number | null, end: number | null): TradingWindow | null {
  if (start === null) return null;
  const until = end !== null && end > start ? end + AFTER_END_MINUTES : start + AFTER_START_WITHOUT_END_MINUTES;
  return { start: Math.max(0, start - LEAD_MINUTES), end: Math.min(MINUTES_IN_DAY, until) };
}

const clockOf = (value: unknown) => typeof value === "string" ? parseClock(value) : null;

// A Manager's event holds its hours as the signal's period. A listing has a start and rarely an
// end, so it holds them as stated by the provider, and its signal claims no period.
export function eventInfluence(signal: { type: string; period: { start: number; end: number } | null; metadata: Record<string, unknown> }): TradingWindow | null {
  if (signal.type !== "LOCAL_EVENT") return null;
  return signal.period ? influenceWindow(signal.period.start, signal.period.end) : influenceWindow(clockOf(signal.metadata.startTime), clockOf(signal.metadata.endTime));
}

export const overlaps = (a: TradingWindow, b: TradingWindow) => a.start < b.end && a.end > b.start;
