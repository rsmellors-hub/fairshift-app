// What may happen to a shift's time, given who has responded to it. A worker's acceptance
// covers specific terms, so moving accepted work is never a plain edit. The server applies
// this rule on every change; the schedule only uses it to decide what to offer.
export type ShiftInteraction =
  | "MOVE" // No live offers: nobody has been promised these times.
  | "MOVE_WITH_REACCEPTANCE" // Live offers or acceptances: they must be answered again.
  | "CHANGE_ONLY" // Allocated: only an explicit change, which needs reacceptance too.
  | "LOCKED"; // Finished, reviewed or closed.

type Offer = { offerStatus: string; allocationState?: string | null; confirmedAt?: Date | null };

export function shiftInteraction(shift: { status: string; endsAt: Date }, offers: readonly Offer[], now: Date): ShiftInteraction {
  if (shift.status !== "PUBLISHED" || shift.endsAt <= now || offers.some(offer => offer.confirmedAt)) return "LOCKED";
  if (offers.some(offer => offer.offerStatus === "ACCEPTED" && offer.allocationState === "ALLOCATED")) return "CHANGE_ONLY";
  return offers.some(offer => ["OFFERED", "ACCEPTED"].includes(offer.offerStatus)) ? "MOVE_WITH_REACCEPTANCE" : "MOVE";
}
