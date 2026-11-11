// Cancellation pay when a location has no saved rule (Owner decision 10 Nov 2026: default 50% within 24 h).
export const DEFAULT_CANCELLATION = { percent: 50, windowMinutes: 1440 } as const;

// Plain-text labels for shift notices (Inbox and email). Amounts come from the persisted shift terms.
type ShiftTerms = { startsAt: Date; endsAt: Date; earningsModel: string; rateMinor: number | null; expectedEarningsMinor: number | null; guaranteedBasePayMinor: number; currencyCode: string; commissionBps: number | null;
  cancellationPercent: number | null; cancellationWindowMinutes: number | null };

export function formatMinor(minor: number, currency: string) {
  if (currency === "ZAR") return `R${new Intl.NumberFormat("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(minor / 100)}`;
  return new Intl.NumberFormat(currency === "GBP" ? "en-GB" : "en-US", { style: "currency", currency }).format(minor / 100);
}

export function shiftLabel(shift: Pick<ShiftTerms, "startsAt" | "endsAt">, timeZone: string) {
  const day = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone }).format(shift.startsAt);
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone });
  return `${day}, ${time.format(shift.startsAt)}–${time.format(shift.endsAt)}`;
}

export function payLabel(shift: ShiftTerms) {
  if (shift.earningsModel === "COMMISSION") return `${(shift.commissionBps ?? 0) / 100}% commission`;
  const base = shift.expectedEarningsMinor ?? shift.guaranteedBasePayMinor;
  const rate = shift.earningsModel === "HOURLY" && shift.rateMinor ? ` (${formatMinor(shift.rateMinor, shift.currencyCode)} an hour)` : "";
  return `${formatMinor(base, shift.currencyCode)}${rate}`;
}

// Cancellation pay due under the shift's own terms when it's cancelled at `at`: the shift's percentage of
// its base pay inside the window before the start, nothing outside it. Null when the shift carries no rule
// (made before cancellation pay was set) or has no fixed pay.
export function cancellationDue(shift: ShiftTerms, at: Date): number | null {
  if (shift.cancellationPercent === null || shift.cancellationWindowMinutes === null || shift.earningsModel === "COMMISSION") return null;
  const minutesBefore = (shift.startsAt.getTime() - at.getTime()) / 60_000;
  if (minutesBefore > shift.cancellationWindowMinutes) return 0;
  const base = shift.expectedEarningsMinor ?? shift.guaranteedBasePayMinor;
  return Math.round(base * shift.cancellationPercent / 100);
}

export function cancellationTerms(shift: Pick<ShiftTerms, "cancellationPercent" | "cancellationWindowMinutes">) {
  if (shift.cancellationPercent === null || shift.cancellationWindowMinutes === null) return null;
  return `If this shift is cancelled within ${Math.round(shift.cancellationWindowMinutes / 60)} h of its start, ${shift.cancellationPercent}% of its pay is due to you.`;
}
