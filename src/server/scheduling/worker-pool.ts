import { localDate, shiftDate } from "@/server/intelligence/forecast";

// Whether a location's casual worker can be offered a shift, and why not. One rule,
// shared by what the Manager sees and what the server enforces. Casual workers are
// location-bound: only workers of the shift's location are ever candidates.
export type WorkerOpportunityState = "AVAILABLE" | "AVAILABILITY_NOT_PROVIDED" | "UNAVAILABLE" | "ALREADY_WORKING" | "AWAITING_ACTIVATION" | "INACTIVE";
export type AvailabilityState = "AVAILABLE" | "UNAVAILABLE";

export const OPPORTUNITY_LABEL: Record<WorkerOpportunityState, string> = {
  AVAILABLE: "Available",
  AVAILABILITY_NOT_PROVIDED: "Availability not provided",
  UNAVAILABLE: "Unavailable",
  ALREADY_WORKING: "Already working",
  AWAITING_ACTIVATION: "Awaiting activation",
  INACTIVE: "Inactive",
};
// A missing statement is not a refusal: the Manager decides and the worker can decline.
export const isOfferable = (state: WorkerOpportunityState) => state === "AVAILABLE" || state === "AVAILABILITY_NOT_PROVIDED";

const isoWeekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay() || 7;

// The local weekdays a shift touches at its location; a shift crossing midnight touches two.
export function shiftWeekdays(shift: { startsAt: Date; endsAt: Date }, timeZone: string) {
  const last = localDate(new Date(shift.endsAt.getTime() - 1), timeZone);
  const days: number[] = [];
  for (let date = localDate(shift.startsAt, timeZone); date <= last; date = shiftDate(date, 1)) days.push(isoWeekday(date));
  return [...new Set(days)];
}

// Any stated-unavailable day wins; only fully stated days count as available.
export function availabilityForShift(stated: ReadonlyMap<number, string>, weekdays: readonly number[]): "AVAILABLE" | "UNAVAILABLE" | "AVAILABILITY_NOT_PROVIDED" {
  const states = weekdays.map(day => stated.get(day));
  if (states.includes("UNAVAILABLE")) return "UNAVAILABLE";
  return states.every(state => state === "AVAILABLE") ? "AVAILABLE" : "AVAILABILITY_NOT_PROVIDED";
}

export function workerOpportunityState(input: { active: boolean; activated: boolean; conflict: boolean; availability: "AVAILABLE" | "UNAVAILABLE" | "AVAILABILITY_NOT_PROVIDED" }): WorkerOpportunityState {
  if (!input.active) return "INACTIVE";
  if (!input.activated) return "AWAITING_ACTIVATION";
  if (input.conflict) return "ALREADY_WORKING";
  return input.availability;
}
