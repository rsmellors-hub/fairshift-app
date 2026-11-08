import { z } from "zod";
import type { SignalDirection, SignalType } from "@/server/intelligence/demand-signals";
import { formatClock, parseClock } from "@/server/intelligence/workload";

// A Manager's structured context. Each is what the Manager said and is never verified. The
// summary is written here from the fields; anything free text in it stays data for the model.

export const BOOKING_COMPARISONS = ["ABOVE", "SIMILAR", "BELOW", "NOT_STATED"] as const;
export const DISTANCE_BANDS = ["UNDER_1KM", "1_TO_3KM", "OVER_3KM"] as const;
export const ATTENDANCE_BANDS = ["UNDER_1000", "1000_TO_10000", "OVER_10000"] as const;
export const STRUCTURED_SIGNAL_KINDS = ["BOOKINGS", "LOCAL_EVENT", "PROMOTION"] as const;
export type StructuredSignalKind = typeof STRUCTURED_SIGNAL_KINDS[number];

export const DISTANCE_LABEL: Record<typeof DISTANCE_BANDS[number], string> = { UNDER_1KM: "under 1 km away", "1_TO_3KM": "1 to 3 km away", OVER_3KM: "over 3 km away" };
export const ATTENDANCE_LABEL: Record<typeof ATTENDANCE_BANDS[number], string> = { UNDER_1000: "under 1,000 attending", "1000_TO_10000": "1,000 to 10,000 attending", OVER_10000: "over 10,000 attending" };
const COMPARISON_LABEL: Record<typeof BOOKING_COMPARISONS[number], string> = { ABOVE: "above a usual day", SIMILAR: "similar to a usual day", BELOW: "below a usual day", NOT_STATED: "no comparison with a usual day stated" };
// The Manager's own comparison gives bookings a direction. Events and promotions state none,
// because their effect depends on the venue.
const COMPARISON_DIRECTION: Record<typeof BOOKING_COMPARISONS[number], SignalDirection> = { ABOVE: "UP", SIMILAR: "FLAT", BELOW: "DOWN", NOT_STATED: "UNSPECIFIED" };

const blank = (value: unknown) => typeof value === "string" && value.trim() === "" ? undefined : value;
const plainText = (min: number, max: number) => z.string().trim().min(min).max(max).refine(value => !/[\u0000-\u001f\u007f]/.test(value), "No control characters.");
const clock = z.string().trim().refine(value => parseClock(value) !== null, "Enter a time.").transform(value => parseClock(value)!);
const optionalClock = z.preprocess(blank, clock.optional());
const inOrder = (value: { start?: number; end?: number }) => (value.start === undefined) === (value.end === undefined) && (value.start === undefined || value.start < value.end!);

const bookingsSchema = z.object({
  date: z.iso.date(), start: optionalClock, end: optionalClock,
  quantityKind: z.enum(["BOOKINGS", "COVERS"]), quantity: z.coerce.number().int().min(0).max(100_000),
  comparison: z.enum(BOOKING_COMPARISONS),
}).strict().refine(inOrder, "Enter both times, with the end after the start.");
// Where an event is published. An Owner's event needs one (Owner decision, 8 November 2026); a
// Manager may add one. Either way it is a person's entry, never a verified event.
const sourceUrl = z.preprocess(blank, z.string().trim().max(2000).refine(value => { try { const url = new URL(value); return url.protocol === "https:" && !!url.hostname && !url.username; } catch { return false; } }, "Enter an https link.").optional());
const eventSchema = z.object({
  date: z.iso.date(), name: plainText(3, 80), start: clock, end: clock,
  distanceBand: z.enum(DISTANCE_BANDS), attendanceBand: z.preprocess(blank, z.enum(ATTENDANCE_BANDS).optional()), sourceUrl,
}).strict().refine(inOrder, "The end must be after the start.");
const promotionSchema = z.object({
  validFrom: z.iso.date(), validTo: z.iso.date(), name: plainText(3, 80), start: optionalClock, end: optionalClock, description: plainText(3, 200),
}).strict().refine(inOrder, "Enter both times, with the end after the start.");

export type StructuredSignal = { type: SignalType; validFrom: string; validTo: string; period: { start: number; end: number } | null; direction: SignalDirection; summary: string; metadata: Record<string, string | number | null>; sourceUrl?: string | null };
const periodOf = (value: { start?: number; end?: number }) => value.start === undefined ? null : { start: value.start, end: value.end! };
const timeText = (period: { start: number; end: number } | null) => period ? `${formatClock(period.start)}–${formatClock(period.end)}` : "all day";

// Null when the fields don't make a valid signal of this kind.
export function buildStructuredSignal(kind: StructuredSignalKind, raw: unknown): StructuredSignal | null {
  if (kind === "BOOKINGS") {
    const parsed = bookingsSchema.safeParse(raw);
    if (!parsed.success) return null;
    const value = parsed.data, period = periodOf(value), noun = value.quantityKind === "COVERS" ? "expected covers" : "bookings";
    return { type: "BOOKINGS", validFrom: value.date, validTo: value.date, period, direction: COMPARISON_DIRECTION[value.comparison],
      summary: `${value.quantity.toLocaleString("en-GB")} ${noun}, ${timeText(period)}, ${COMPARISON_LABEL[value.comparison]} for that time.`,
      metadata: { quantityKind: value.quantityKind, quantity: value.quantity, comparison: value.comparison } };
  }
  if (kind === "LOCAL_EVENT") {
    const parsed = eventSchema.safeParse(raw);
    if (!parsed.success) return null;
    const value = parsed.data, period = { start: value.start, end: value.end };
    return { type: "LOCAL_EVENT", validFrom: value.date, validTo: value.date, period, direction: "UNSPECIFIED",
      summary: `Local event: ${value.name}, ${timeText(period)}, ${[DISTANCE_LABEL[value.distanceBand], value.attendanceBand ? ATTENDANCE_LABEL[value.attendanceBand] : null].filter(Boolean).join(", ")}.`,
      metadata: { name: value.name, distanceBand: value.distanceBand, attendanceBand: value.attendanceBand ?? null }, sourceUrl: value.sourceUrl ?? null };
  }
  const parsed = promotionSchema.safeParse(raw);
  if (!parsed.success) return null;
  const value = parsed.data, period = periodOf(value);
  return { type: "PROMOTION", validFrom: value.validFrom, validTo: value.validTo, period, direction: "UNSPECIFIED",
    summary: `Promotion: ${value.name}, ${timeText(period)}. ${value.description}`,
    metadata: { name: value.name, description: value.description } };
}
