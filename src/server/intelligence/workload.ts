import { z } from "zod";
import { LocalTimeError, localDateTimeToInstant } from "@/server/domain/timezone";
import { applyDemandAdjustment } from "@/server/intelligence/demand-context-policy";
import { applyLocalAdjustment } from "@/server/intelligence/local-intelligence-contract";
import { LOOKBACK_DAYS, shiftDate, startOfLocalDay } from "@/server/intelligence/forecast";

// Operational demand: how many transactions (bills) are expected and when, what that asks
// of staff under the business's own policy, and what is left for casual work. Pure and
// deterministic. Sales value appears here only as commercial context and never enters a
// staffing calculation. A transaction is the workload proxy; covers and roles are not modelled.

export const WORKLOAD_FORECAST_METHOD_VERSION = "transaction-windows-recency-v1";
export const PLANNING_INCREMENT_MINUTES = 15;
const BLOCK_MINUTES = 60;
const MINUTES_IN_DAY = 1440;
const MILLI = 1000;

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

// Minutes after local midnight, so a window means the same wall-clock time all year.
export type TradingWindow = { start: number; end: number };
export type CoverageWindow = TradingWindow & { headcount: number };

function ordered(windows: readonly TradingWindow[], context: z.RefinementCtx) {
  const sorted = [...windows].sort((a, b) => a.start - b.start);
  for (const [i, window] of sorted.entries()) {
    if (window.end <= window.start) context.addIssue({ code: "custom", message: "A window must end after it starts." });
    if (i > 0 && window.start < sorted[i - 1].end) context.addIssue({ code: "custom", message: "Windows on one day can't overlap." });
  }
}
const clock = z.number().int().min(0).max(MINUTES_IN_DAY);
// Trading hours sit on the 15-minute slots the history is read in. No trading past midnight yet.
export const tradingWindowsSchema = z.array(z.object({
  start: clock.refine(value => value % PLANNING_INCREMENT_MINUTES === 0, "Trading hours must fall on a quarter hour."),
  end: clock.refine(value => value % PLANNING_INCREMENT_MINUTES === 0, "Trading hours must fall on a quarter hour."),
}).strict()).max(6).superRefine(ordered);
export const coverageWindowsSchema = z.array(z.object({ start: clock, end: clock, headcount: z.number().int().min(1).max(100) }).strict()).max(12).superRefine(ordered);

export const workloadPolicyInputSchema = z.object({
  transactionsPerStaffHour: z.number().int().min(1).max(1000),
  minimumStaffWhileOpen: z.number().int().min(0).max(100),
}).strict();

export type WorkloadPolicy = {
  version: string; level: "ORGANISATION" | "LOCATION"; source: "CONFIGURED" | "REFERENCE";
  transactionsPerStaffHour: number; minimumStaffWhileOpen: number;
};
export type WorkloadPolicyRecord = { outletId: string | null; version: number; transactionsPerStaffHour: number; minimumStaffWhileOpen: number; source: string };

// A location override wins over the organisation default. Nothing else applies, and
// FairShift supplies no default: with neither, staffing is unavailable.
export function resolveWorkloadPolicy(records: readonly WorkloadPolicyRecord[], outletId: string): WorkloadPolicy | null {
  const record = records.find(row => row.outletId === outletId) ?? records.find(row => row.outletId === null);
  if (!record) return null;
  const level = record.outletId ? "LOCATION" : "ORGANISATION";
  const value = workloadPolicyInputSchema.parse({ transactionsPerStaffHour: record.transactionsPerStaffHour, minimumStaffWhileOpen: record.minimumStaffWhileOpen });
  return { ...value, version: `${level.toLowerCase()}-v${record.version}`, level, source: record.source as WorkloadPolicy["source"] };
}

const ceilDiv = (numerator: number, denominator: number) => numerator === 0 ? 0 : Math.floor((numerator - 1) / denominator) + 1;

// Expected transactions → staff minutes, rounded UP to the planning increment so demand
// is never rounded down into understaffing. Integer arithmetic throughout.
export function transactionWorkloadMinutes(expectedMilliTransactions: number, transactionsPerStaffHour: number) {
  count.parse(expectedMilliTransactions);
  return ceilDiv(expectedMilliTransactions * 60, transactionsPerStaffHour * MILLI * PLANNING_INCREMENT_MINUTES) * PLANNING_INCREMENT_MINUTES;
}

// required = max(minimum cover, transaction workload);
// remaining = max(0, required - regular - allocated casual). One window only.
export function calculateWindowCapacity(input: { expectedMilliTransactions: number; openMinutes: number; regularMinutes: number; allocatedCasualMinutes: number; policy: Pick<WorkloadPolicy, "transactionsPerStaffHour" | "minimumStaffWhileOpen"> }) {
  const workloadMinutes = transactionWorkloadMinutes(input.expectedMilliTransactions, input.policy.transactionsPerStaffHour);
  const minimumCoverMinutes = input.policy.minimumStaffWhileOpen * count.parse(input.openMinutes);
  const requiredMinutes = Math.max(workloadMinutes, minimumCoverMinutes);
  const regularMinutes = count.parse(input.regularMinutes), allocatedCasualMinutes = count.parse(input.allocatedCasualMinutes);
  return { workloadMinutes, minimumCoverMinutes, requiredMinutes, regularMinutes, allocatedCasualMinutes,
    casualNeedMinutes: Math.max(0, requiredMinutes - regularMinutes),
    remainingMinutes: Math.max(0, requiredMinutes - regularMinutes - allocatedCasualMinutes) };
}

const overlap = (a: TradingWindow, b: TradingWindow) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

// Regular staff minutes inside one wall-clock window, headcount by actual overlap.
export function regularMinutesWithin(window: TradingWindow, coverage: readonly CoverageWindow[]) {
  return coverage.reduce((sum, row) => sum + row.headcount * overlap(window, row), 0);
}

// Casual minutes inside one window. Only the part of a shift overlapping it counts.
export function casualMinutesWithin(window: { startsAt: Date; endsAt: Date }, shifts: readonly { startsAt: Date; endsAt: Date }[]) {
  return shifts.reduce((sum, shift) => {
    const shared = Math.min(shift.endsAt.getTime(), window.endsAt.getTime()) - Math.max(shift.startsAt.getTime(), window.startsAt.getTime());
    return sum + (shared > 0 ? Math.floor(shared / 60_000) : 0);
  }, 0);
}

// Open time cut into clock-hour planning blocks, clipped to the trading windows.
export function planningBlocks(trading: readonly TradingWindow[]): TradingWindow[] {
  const blocks: TradingWindow[] = [];
  for (const window of [...trading].sort((a, b) => a.start - b.start)) {
    let start = window.start;
    while (start < window.end) {
      const end = Math.min(window.end, (Math.floor(start / BLOCK_MINUTES) + 1) * BLOCK_MINUTES);
      blocks.push({ start, end });
      start = end;
    }
  }
  return blocks;
}

export type TransactionSlot = { date: string; minute: number; transactions: number; salesMinor: number };
export type WindowForecast = { expectedMilliTransactions: number; lowerMilliTransactions: number; upperMilliTransactions: number; expectedSalesMinor: number };
export type DayWorkloadForecast = {
  support: "LOW" | "MODERATE"; basis: "SAME_WEEKDAY" | "RECENT_OBSERVED_DAYS"; comparableDays: number;
  // Transactions the history shows outside the stated hours: they would otherwise vanish silently.
  outsideHoursMilliTransactions: number;
  windows: WindowForecast[];
};

const weekdayOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

function weighted(values: readonly number[], support: "LOW" | "MODERATE") {
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const cap = values.length >= 5 && median > 0 ? median * 2 : Infinity;
  const totalWeight = values.length * (values.length + 1) / 2;
  const used = values.map(value => Math.min(value, cap));
  const point = used.reduce((sum, value, i) => sum + value * ((i + 1) / totalWeight), 0);
  const deviation = used.reduce((sum, value, i) => sum + Math.abs(value - point) * ((i + 1) / totalWeight), 0);
  const width = Math.max(point * (support === "LOW" ? 0.5 : 0.25), 2 * deviation);
  return { point, lower: Math.max(0, point - width), upper: point + width };
}

// The commercial forecast's method applied to timed transactions: recency-weighted
// matching weekdays from the 56-day lookback, isolated highs capped. An observed day with
// nothing in a window counts as zero there; a day with no records is unknown and absent.
// Returns null without evidence. Learns no cause and projects no trend.
export function forecastTransactionWindows(input: { slots: readonly TransactionSlot[]; dataThrough: string; targetDate: string; windows: readonly TradingWindow[] }): DayWorkloadForecast | null {
  z.iso.date().parse(input.dataThrough);
  z.iso.date().parse(input.targetDate);
  if (input.targetDate <= input.dataThrough) throw new Error("Forecast target must follow the data cutoff day.");
  const start = shiftDate(input.dataThrough, -(LOOKBACK_DAYS - 1));
  const slots = input.slots.filter(row => row.date >= start && row.date <= input.dataThrough && row.transactions > 0);
  const dates = [...new Set(slots.map(row => row.date))].sort();
  if (!dates.length) return null;
  const matching = dates.filter(date => weekdayOf(date) === weekdayOf(input.targetDate));
  const sameWeekday = matching.length >= 3;
  const selected = sameWeekday ? matching : dates.slice(-14);
  const support = sameWeekday && selected.length >= 4 ? "MODERATE" : "LOW";
  const byDate = new Map<string, TransactionSlot[]>();
  for (const row of slots) byDate.set(row.date, [...(byDate.get(row.date) ?? []), row]);
  const within = (date: string, window: TradingWindow, value: (row: TransactionSlot) => number) => (byDate.get(date) ?? []).filter(row => row.minute >= window.start && row.minute < window.end).reduce((sum, row) => sum + value(row), 0);
  const windows = input.windows.map(window => {
    const transactions = weighted(selected.map(date => within(date, window, row => row.transactions)), support);
    const sales = weighted(selected.map(date => within(date, window, row => row.salesMinor)), support);
    return { expectedMilliTransactions: Math.round(transactions.point * MILLI), lowerMilliTransactions: Math.round(transactions.lower * MILLI), upperMilliTransactions: Math.round(transactions.upper * MILLI), expectedSalesMinor: Math.round(sales.point) };
  });
  const whole = weighted(selected.map(date => (byDate.get(date) ?? []).reduce((sum, row) => sum + row.transactions, 0)), support);
  const inside = weighted(selected.map(date => input.windows.reduce((sum, window) => sum + within(date, window, row => row.transactions), 0)), support);
  return { support, basis: sameWeekday ? "SAME_WEEKDAY" : "RECENT_OBSERVED_DAYS", comparableDays: selected.length,
    outsideHoursMilliTransactions: Math.max(0, Math.round((whole.point - inside.point) * MILLI)), windows };
}

// The instant of a wall-clock minute at a location. A time the clocks skip or repeat
// (only ever around 01:00–02:00 in the zones supported) falls back to elapsed minutes.
export function localInstant(date: string, minute: number, timezone: string) {
  if (minute === MINUTES_IN_DAY) return startOfLocalDay(shiftDate(date, 1), timezone);
  try { return localDateTimeToInstant(`${date}T${formatClock(minute)}`, timezone); }
  catch (error) {
    if (!(error instanceof LocalTimeError) || (error.problem !== "NONEXISTENT" && error.problem !== "AMBIGUOUS")) throw error;
    return new Date(startOfLocalDay(date, timezone).getTime() + minute * 60_000);
  }
}

export const formatClock = (minute: number) => minute === MINUTES_IN_DAY ? "24:00" : `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
export const parseClock = (value: string) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [hours, minutes] = [Number(match[1]), Number(match[2])];
  return minutes < 60 && hours * 60 + minutes <= MINUTES_IN_DAY ? hours * 60 + minutes : null;
};

export type PlanningBlock = TradingWindow & {
  expectedMilliTransactions: number | null; lowerMilliTransactions: number | null; upperMilliTransactions: number | null; expectedSalesMinor: number | null;
  regularMinutes: number | null; allocatedCasualMinutes: number; requiredMinutes: number | null; casualNeedMinutes: number | null; remainingMinutes: number | null;
};
export type PeriodState = "COVERED" | "OPEN" | "FILLED";
// A run of adjacent blocks in one state: a period the manager reads as a whole. The state
// says whether regular staff cover it, casual work is still needed, or casual work filled it.
export type ServicePeriod = {
  start: number; end: number; startsAt: string; endsAt: string; state: PeriodState;
  expectedMilliTransactions: number; lowerMilliTransactions: number; upperMilliTransactions: number; expectedSalesMinor: number;
  requiredMinutes: number; regularMinutes: number; allocatedCasualMinutes: number; remainingMinutes: number;
  // The most casual staff needed at once in the period, for the shift's places.
  peakCasualStaff: number;
};
export type UnavailableReason = "NO_FORECAST" | "NO_TIMED_HISTORY" | "TRADING_HOURS_NOT_SET" | "NO_WORKLOAD_POLICY" | "REGULAR_COVERAGE_NOT_SET";

export type DayWorkload = {
  // null: trading hours not stated. An empty list of blocks on a stated day is a closed day.
  closed: boolean | null;
  blocks: PlanningBlock[];
  periods: ServicePeriod[];
  support: "LOW" | "MODERATE" | null;
  outsideHoursMilliTransactions: number | null;
  unavailable: UnavailableReason | null;
  expectedMilliTransactions: number | null; lowerMilliTransactions: number | null; upperMilliTransactions: number | null;
  requiredMinutes: number | null; regularMinutes: number | null; allocatedCasualMinutes: number; casualNeedMinutes: number | null; remainingMinutes: number | null;
  indicativeShifts: number | null;
};

const sumBlocks = (blocks: readonly PlanningBlock[], value: (block: PlanningBlock) => number | null) => blocks.reduce((sum, block) => sum + (value(block) ?? 0), 0);

// One location's day: forecast by block, capacity by block, then runs of blocks in one
// state. Blocks never net against each other, so surplus in one period can't cancel a
// shortage in another. Whatever isn't known stays null and names why.
export function calculateDayWorkload(input: {
  date: string; timezone: string;
  trading: readonly TradingWindow[] | null;
  coverage: readonly CoverageWindow[] | null;
  policy: Pick<WorkloadPolicy, "transactionsPerStaffHour" | "minimumStaffWhileOpen"> | null;
  slots: readonly TransactionSlot[];
  dataThrough: string | null;
  allocated: readonly { startsAt: Date; endsAt: Date }[];
  // A Manager-accepted contextual scenario, as its policy assumption. It scales expected
  // transactions by block and nothing else: sales stay as forecast, and capacity, minimum
  // cover and coverage apply exactly as they do to the baseline.
  demandAdjustmentBps?: number;
  // The contiguous part of the day it applies to, on planning-block boundaries. Absent is the
  // whole trading day. Blocks outside it stay exactly as forecast.
  demandAdjustmentPeriod?: TradingWindow | null;
  // A Manager-chosen set of AI-found adjustments, by planning-block start: each block's fixed bands.
  // Used only on a day without an accepted scenario, so one influence is never counted twice.
  blockAdjustmentsBps?: ReadonlyMap<number, number>;
}): DayWorkload {
  const empty = { blocks: [], periods: [], support: null, outsideHoursMilliTransactions: null, expectedMilliTransactions: null, lowerMilliTransactions: null, upperMilliTransactions: null, requiredMinutes: null, regularMinutes: null, allocatedCasualMinutes: 0, casualNeedMinutes: null, remainingMinutes: null, indicativeShifts: null };
  if (input.trading === null) return { ...empty, closed: null, unavailable: !input.dataThrough ? "NO_FORECAST" : "TRADING_HOURS_NOT_SET" };
  if (!input.trading.length) return { ...empty, closed: true, unavailable: null, expectedMilliTransactions: 0, lowerMilliTransactions: 0, upperMilliTransactions: 0, requiredMinutes: 0, regularMinutes: 0, casualNeedMinutes: 0, remainingMinutes: 0, indicativeShifts: 0 };

  const windows = planningBlocks(input.trading);
  const forecast = input.dataThrough ? forecastTransactionWindows({ slots: input.slots, dataThrough: input.dataThrough, targetDate: input.date, windows }) : null;
  const blocks: (PlanningBlock & { startsAt: Date; endsAt: Date })[] = windows.map((window, i) => {
    const startsAt = localInstant(input.date, window.start, input.timezone), endsAt = localInstant(input.date, window.end, input.timezone);
    const regularMinutes = input.coverage ? regularMinutesWithin(window, input.coverage) : null;
    const allocatedCasualMinutes = casualMinutesWithin({ startsAt, endsAt }, input.allocated);
    const forecasted = forecast?.windows[i] ?? null;
    const period = input.demandAdjustmentPeriod;
    const adjusted = !period || (window.start >= period.start && window.end <= period.end);
    const local = input.demandAdjustmentBps ? 0 : input.blockAdjustmentsBps?.get(window.start) ?? 0;
    const expected = forecasted && input.demandAdjustmentBps && adjusted ? { ...forecasted, expectedMilliTransactions: applyDemandAdjustment(forecasted.expectedMilliTransactions, input.demandAdjustmentBps), lowerMilliTransactions: applyDemandAdjustment(forecasted.lowerMilliTransactions, input.demandAdjustmentBps), upperMilliTransactions: applyDemandAdjustment(forecasted.upperMilliTransactions, input.demandAdjustmentBps) }
      : forecasted && local ? { ...forecasted, expectedMilliTransactions: applyLocalAdjustment(forecasted.expectedMilliTransactions, local), lowerMilliTransactions: applyLocalAdjustment(forecasted.lowerMilliTransactions, local), upperMilliTransactions: applyLocalAdjustment(forecasted.upperMilliTransactions, local) } : forecasted;
    const capacity = expected && input.policy && regularMinutes !== null
      ? calculateWindowCapacity({ expectedMilliTransactions: expected.expectedMilliTransactions, openMinutes: window.end - window.start, regularMinutes, allocatedCasualMinutes, policy: input.policy }) : null;
    const requiredOnly = expected && input.policy && regularMinutes === null
      ? calculateWindowCapacity({ expectedMilliTransactions: expected.expectedMilliTransactions, openMinutes: window.end - window.start, regularMinutes: 0, allocatedCasualMinutes: 0, policy: input.policy }).requiredMinutes : null;
    return { ...window, startsAt, endsAt, expectedMilliTransactions: expected?.expectedMilliTransactions ?? null, lowerMilliTransactions: expected?.lowerMilliTransactions ?? null, upperMilliTransactions: expected?.upperMilliTransactions ?? null, expectedSalesMinor: expected?.expectedSalesMinor ?? null,
      regularMinutes, allocatedCasualMinutes, requiredMinutes: capacity?.requiredMinutes ?? requiredOnly, casualNeedMinutes: capacity?.casualNeedMinutes ?? null, remainingMinutes: capacity?.remainingMinutes ?? null };
  });
  const unavailable: UnavailableReason | null = !input.dataThrough ? "NO_FORECAST" : !forecast ? "NO_TIMED_HISTORY" : !input.policy ? "NO_WORKLOAD_POLICY" : input.coverage === null ? "REGULAR_COVERAGE_NOT_SET" : null;
  const periods: ServicePeriod[] = [];
  if (!unavailable) {
    let run: typeof blocks = [];
    const close = () => {
      if (!run.length) return;
      const [first, last] = [run[0], run[run.length - 1]];
      periods.push({ start: first.start, end: last.end, startsAt: first.startsAt.toISOString(), endsAt: last.endsAt.toISOString(), state: stateOf(first),
        expectedMilliTransactions: sumBlocks(run, b => b.expectedMilliTransactions), lowerMilliTransactions: sumBlocks(run, b => b.lowerMilliTransactions), upperMilliTransactions: sumBlocks(run, b => b.upperMilliTransactions), expectedSalesMinor: sumBlocks(run, b => b.expectedSalesMinor),
        requiredMinutes: sumBlocks(run, b => b.requiredMinutes), regularMinutes: sumBlocks(run, b => b.regularMinutes), allocatedCasualMinutes: sumBlocks(run, b => b.allocatedCasualMinutes), remainingMinutes: sumBlocks(run, b => b.remainingMinutes),
        peakCasualStaff: Math.max(0, ...run.map(b => ceilDiv(b.remainingMinutes!, b.end - b.start))) });
      run = [];
    };
    for (const block of blocks) {
      if (run.length && (run[run.length - 1].end !== block.start || stateOf(run[0]) !== stateOf(block))) close();
      run.push(block);
    }
    close();
  }
  const known = (value: (block: PlanningBlock) => number | null) => blocks.every(block => value(block) !== null) ? sumBlocks(blocks, value) : null;
  return {
    closed: false, blocks: blocks.map(block => ({ start: block.start, end: block.end, expectedMilliTransactions: block.expectedMilliTransactions, lowerMilliTransactions: block.lowerMilliTransactions, upperMilliTransactions: block.upperMilliTransactions, expectedSalesMinor: block.expectedSalesMinor, regularMinutes: block.regularMinutes, allocatedCasualMinutes: block.allocatedCasualMinutes, requiredMinutes: block.requiredMinutes, casualNeedMinutes: block.casualNeedMinutes, remainingMinutes: block.remainingMinutes })), periods, support: forecast?.support ?? null,
    outsideHoursMilliTransactions: forecast?.outsideHoursMilliTransactions ?? null, unavailable,
    expectedMilliTransactions: known(b => b.expectedMilliTransactions), lowerMilliTransactions: known(b => b.lowerMilliTransactions), upperMilliTransactions: known(b => b.upperMilliTransactions),
    requiredMinutes: known(b => b.requiredMinutes), regularMinutes: known(b => b.regularMinutes), allocatedCasualMinutes: sumBlocks(blocks, b => b.allocatedCasualMinutes),
    casualNeedMinutes: known(b => b.casualNeedMinutes), remainingMinutes: known(b => b.remainingMinutes),
    indicativeShifts: unavailable ? null : periods.filter(period => period.state === "OPEN").reduce((sum, period) => sum + period.peakCasualStaff, 0),
  };
}

function stateOf(block: PlanningBlock): PeriodState {
  return (block.remainingMinutes ?? 0) > 0 ? "OPEN" : (block.casualNeedMinutes ?? 0) > 0 ? "FILLED" : "COVERED";
}

export const transactionCount = (milli: number) => Math.round(milli / MILLI);

// Owner input as text, so a day reads as it is spoken: "09:00-17:00, 18:00-22:00" or "closed".
// Blank means not set; the caller keeps that distinct.
export function parseTradingText(text: string): TradingWindow[] {
  const value = text.trim();
  if (/^closed$/i.test(value)) return [];
  return tradingWindowsSchema.parse(value.split(",").map(part => {
    const match = /^\s*(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})\s*$/.exec(part);
    const start = match && parseClock(match[1]), end = match && parseClock(match[2]);
    if (start === null || end === null) throw new Error(`Couldn't read "${part.trim()}" as a time range.`);
    return { start, end };
  }));
}
// "07:00-12:00 x3, 12:00-15:00 x4" or "none" for a stated zero.
export function parseCoverageText(text: string): CoverageWindow[] {
  const value = text.trim();
  if (/^none$/i.test(value)) return [];
  return coverageWindowsSchema.parse(value.split(",").map(part => {
    const match = /^\s*(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})\s*[x×]\s*(\d{1,3})\s*$/i.exec(part);
    const start = match && parseClock(match[1]), end = match && parseClock(match[2]);
    if (!match || start === null || end === null) throw new Error(`Couldn't read "${part.trim()}" as a time range and headcount.`);
    return { start, end, headcount: Number(match[3]) };
  }));
}
export const formatTradingText = (windows: readonly TradingWindow[] | null) => windows === null ? "" : windows.length ? windows.map(w => `${formatClock(w.start)}-${formatClock(w.end)}`).join(", ") : "closed";
export const formatCoverageText = (windows: readonly CoverageWindow[] | null) => windows === null ? "" : windows.length ? windows.map(w => `${formatClock(w.start)}-${formatClock(w.end)} x${w.headcount}`).join(", ") : "none";
