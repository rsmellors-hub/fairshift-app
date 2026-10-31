import { z } from "zod";
import { expectedWorkEarnings } from "@/server/domain/work-terms";

// Confirm-as-scheduled: confirmed work is paid on the schedule and terms the worker
// accepted. No timesheet, attendance, overtime, break or rounding adjustment exists.
export const BASE_PAYABLE_METHOD = "confirm-as-scheduled-v1";

const minor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
// The accepted-terms fields a base payable is derived from; other snapshot fields are ignored.
const acceptedTerms = z.object({
  workerId: z.string(), offerId: z.string(), assignmentId: z.string(), locationId: z.string(),
  startsAt: z.iso.datetime(), endsAt: z.iso.datetime(),
  earningsModel: z.enum(["HOURLY", "DAILY", "COMMISSION"]),
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
  rateMinor: minor.nullable(), expectedEarningsMinor: minor.nullable(),
  termsVersion: z.number().int().positive(),
});

export type BasePayableUnavailableReason = "INVALID_ACCEPTED_TERMS" | "NOT_WHOLE_MINOR_UNITS" | "EXPECTED_EARNINGS_MISMATCH";
export type BasePayableResult =
  | { state: "CALCULATED"; earningsModel: "HOURLY" | "DAILY"; currencyCode: string; rateMinor: number; scheduledStartsAt: Date; scheduledEndsAt: Date; baseAmountMinor: number; termsVersion: number }
  // Commission needs verified worker-attributed sales; none exist, so nothing is payable.
  | { state: "ATTRIBUTION_REQUIRED" }
  | { state: "UNAVAILABLE"; reason: BasePayableUnavailableReason };

export class BasePayableUnavailableError extends Error {
  constructor(readonly reason: BasePayableUnavailableReason) { super("Base payable could not be calculated from the accepted terms."); }
}

// Base payable from an immutable acceptance snapshot. It uses the same exact
// arithmetic as the expected earnings shown before acceptance, and must reproduce
// them, so the two can never round differently. Unknown is never zero.
export function basePayableFromAcceptedTerms(snapshot: unknown, work: { workerId: string; offerId: string; shiftId: string; locationId: string; termsVersion: number }): BasePayableResult {
  const parsed = acceptedTerms.safeParse(snapshot);
  if (!parsed.success) return { state: "UNAVAILABLE", reason: "INVALID_ACCEPTED_TERMS" };
  const terms = parsed.data;
  if (terms.workerId !== work.workerId || terms.offerId !== work.offerId || terms.assignmentId !== work.shiftId
    || terms.locationId !== work.locationId || terms.termsVersion !== work.termsVersion) return { state: "UNAVAILABLE", reason: "INVALID_ACCEPTED_TERMS" };
  if (terms.earningsModel === "COMMISSION") return { state: "ATTRIBUTION_REQUIRED" };
  const scheduledStartsAt = new Date(terms.startsAt), scheduledEndsAt = new Date(terms.endsAt);
  if (terms.rateMinor === null || terms.expectedEarningsMinor === null || scheduledEndsAt <= scheduledStartsAt) return { state: "UNAVAILABLE", reason: "INVALID_ACCEPTED_TERMS" };
  let baseAmountMinor: number;
  try { baseAmountMinor = expectedWorkEarnings({ earningsModel: terms.earningsModel, rateMinor: terms.rateMinor }, scheduledStartsAt, scheduledEndsAt)!; }
  catch { return { state: "UNAVAILABLE", reason: "NOT_WHOLE_MINOR_UNITS" }; }
  if (baseAmountMinor !== terms.expectedEarningsMinor) return { state: "UNAVAILABLE", reason: "EXPECTED_EARNINGS_MISMATCH" };
  return { state: "CALCULATED", earningsModel: terms.earningsModel, currencyCode: terms.currencyCode, rateMinor: terms.rateMinor,
    scheduledStartsAt, scheduledEndsAt, baseAmountMinor, termsVersion: terms.termsVersion };
}
