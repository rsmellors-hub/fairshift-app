import { createHash } from "node:crypto";
import { z } from "zod";

import { localDateTimeToInstant } from "@/server/domain/timezone";

// FS-TIP-DEC-002 (Owner decision, 7 November 2026), deterministic part. Everything here is pure:
// no database, model or provider. It validates imported POS tip evidence and shift blocks, assigns
// each tip row to a block by its transaction time, and splits tips exactly to the cent.
//
//   DIRECT      each tip row goes 100% to the staff member on that POS row; unattributed rows stay
//               unallocated and visible.
//   SHIFT_POOL  each block is its own pool, split as one equal share per member; the remainder goes
//               one cent at a time in ascending staff-ID order, so totals reconcile exactly. Rows
//               outside every block stay unallocated and visible. Hours-based pooling is excluded.
//
// Known limitation (stated by the Owner): a person leaving mid-block still receives a full share.

export const TIP_POLICIES = ["DIRECT", "SHIFT_POOL"] as const;
export type TipPolicy = (typeof TIP_POLICIES)[number];
export const IMPORTED_POS_EVIDENCE = "IMPORTED_POS_EVIDENCE";

// ---------------------------------------------------------------------------------------------
// Shift blocks: [start, end) in local minutes of the day, never overlapping, never past midnight.
export type ShiftBlockInput = { name: string; startMinute: number; endMinute: number };
export type ShiftBlock = ShiftBlockInput & { id: string };

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$|^24:00$/;
const minuteOf = (value: string) => value === "24:00" ? 1440 : Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
export const formatMinute = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

export class TipValidationError extends Error {
  constructor(readonly feedback: string, readonly problems: string[]) { super(problems.join(" ")); this.name = "TipValidationError"; }
}

// "Morning 07:00-12:00, Afternoon 12:00-17:00, Evening 17:00-23:00"
export function parseBlocksText(text: string): ShiftBlockInput[] {
  const parts = text.split(/[,\n]/).map(part => part.trim()).filter(Boolean);
  const problems: string[] = [];
  const blocks = parts.map((part, index) => {
    const match = /^(.{1,40}?)\s+(\d{2}:\d{2})\s*[-–]\s*(\d{2}:\d{2})$/.exec(part);
    if (!match || !TIME.test(match[2]) || !TIME.test(match[3])) { problems.push(`Block ${index + 1} must look like "Morning 07:00-12:00".`); return null; }
    return { name: match[1].trim(), startMinute: minuteOf(match[2]), endMinute: minuteOf(match[3]) };
  }).filter((block): block is ShiftBlockInput => block !== null);
  if (problems.length) throw new TipValidationError("tip-blocks-invalid", problems);
  return validateBlocks(blocks);
}

export function validateBlocks(blocks: ShiftBlockInput[]): ShiftBlockInput[] {
  const problems: string[] = [];
  if (!blocks.length || blocks.length > 8) problems.push("Define between one and eight shift blocks.");
  const names = new Set<string>();
  for (const block of blocks) {
    if (!/^[\p{L}\p{N} '&-]{1,40}$/u.test(block.name)) problems.push(`"${block.name}" isn't a valid block name.`);
    if (names.has(block.name.toLowerCase())) problems.push(`Block names must be different ("${block.name}").`);
    names.add(block.name.toLowerCase());
    if (!Number.isInteger(block.startMinute) || !Number.isInteger(block.endMinute) || block.startMinute < 0 || block.endMinute > 1440 || block.startMinute >= block.endMinute) {
      problems.push(`${block.name} must start before it ends, within one day.`);
    }
  }
  const sorted = [...blocks].sort((a, b) => a.startMinute - b.startMinute);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].startMinute < sorted[i - 1].endMinute) problems.push(`${sorted[i - 1].name} and ${sorted[i].name} overlap.`);
  }
  if (problems.length) throw new TipValidationError("tip-blocks-invalid", problems);
  return sorted;
}

// The block whose [start, end) contains the local minute: 12:00 belongs to a block starting at 12:00.
export function blockForMinute<T extends ShiftBlockInput>(minute: number, blocks: readonly T[]): T | null {
  return blocks.find(block => block.startMinute <= minute && minute < block.endMinute) ?? null;
}

const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
// The local calendar date, ISO weekday and minute of day of an instant in a time zone.
export function localParts(instant: Date, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" })
    .formatToParts(instant).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, isoWeekday: WEEKDAY[parts.weekday], minute: Number(parts.hour) * 60 + Number(parts.minute) };
}
export function isoWeekdayOf(date: string) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

// The instant interval of a block on one local date, for overlap with scheduled shifts.
export function blockInterval(block: ShiftBlockInput, date: string, timeZone: string) {
  const at = (minute: number) => minute === 1440
    ? new Date(localDateTimeToInstant(`${date}T00:00`, timeZone).getTime() + 86_400_000)
    : localDateTimeToInstant(`${date}T${formatMinute(minute)}`, timeZone);
  return { start: at(block.startMinute), end: at(block.endMinute) };
}
// A confirmed casual shift is a member of a block when their scheduled intervals overlap for some
// positive time: shift.start < block.end and shift.end > block.start. No hour threshold applies.
export const overlaps = (a: { start: Date; end: Date }, b: { start: Date; end: Date }) => a.start < b.end && a.end > b.start;

// ---------------------------------------------------------------------------------------------
// Imported POS tip evidence (synthetic demo data only; never presented as live POS data).
export const TIP_CSV_HEADER = ["source", "location", "row_ref", "transaction_at", "staff_ref", "bill_amount", "tip_amount", "currency"] as const;
export const MAX_TIP_ROWS = 2_000;
export const MAX_TIP_CSV_BYTES = 512_000;

export type TipCsvRow = {
  line: number; source: string; location: string; rowRef: string; transactionAt: Date;
  staffRef: string | null; billMinor: number; tipMinor: number; currency: string;
};

const amount = /^(0|[1-9]\d{0,8})(\.\d{1,2})?$/;
const toMinor = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
};
const isoInstant = z.iso.datetime({ offset: true });

// One CSV line into fields, with RFC 4180 double-quote escaping.
function fieldsOf(line: string): string[] | null {
  const fields: string[] = []; let current = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (char === '"') quoted = false;
      else current += char;
    } else if (char === '"' && current === "") quoted = true;
    else if (char === ",") { fields.push(current); current = ""; }
    else current += char;
  }
  if (quoted) return null;
  fields.push(current);
  return fields;
}

// Validates the whole file before anything is stored. Any malformed row rejects the import, with
// every problem listed by line. Exact duplicate rows are dropped (idempotent); the same reference
// with different content is a conflict. Every row must name the import's location and its currency.
export function parseTipCsv(text: string, expected: { locationId: string; locationName: string; currency: string }): { rows: TipCsvRow[]; duplicatesSkipped: number; sha256: string } {
  const problems: string[] = [];
  if (Buffer.byteLength(text, "utf8") > MAX_TIP_CSV_BYTES) throw new TipValidationError("tip-csv-invalid", ["The file is too large."]);
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter(line => line.trim() !== "");
  const header = lines.shift()?.split(",").map(value => value.trim().toLowerCase());
  if (!header || header.join(",") !== TIP_CSV_HEADER.join(",")) throw new TipValidationError("tip-csv-invalid", [`The first line must be exactly: ${TIP_CSV_HEADER.join(",")}`]);
  if (!lines.length) throw new TipValidationError("tip-csv-invalid", ["The file has no tip rows."]);
  if (lines.length > MAX_TIP_ROWS) throw new TipValidationError("tip-csv-invalid", [`At most ${MAX_TIP_ROWS} rows can be imported at once.`]);
  const seen = new Map<string, string>();
  const rows: TipCsvRow[] = [];
  let duplicatesSkipped = 0;
  lines.forEach((raw, index) => {
    const line = index + 2;
    const fields = fieldsOf(raw);
    if (!fields || fields.length !== TIP_CSV_HEADER.length) { problems.push(`Line ${line}: expected ${TIP_CSV_HEADER.length} fields.`); return; }
    const [source, location, rowRef, transactionAt, staffRef, bill, tip, currency] = fields.map(value => value.trim());
    const before = problems.length;
    if (!/^[\p{L}\p{N} ._-]{1,60}$/u.test(source)) problems.push(`Line ${line}: source is missing or invalid.`);
    if (location !== expected.locationId && location.toLowerCase() !== expected.locationName.toLowerCase()) problems.push(`Line ${line}: the row is for another location ("${location.slice(0, 60)}").`);
    if (!/^[A-Za-z0-9._:/-]{1,80}$/.test(rowRef)) problems.push(`Line ${line}: row_ref is missing or invalid.`);
    if (!isoInstant.safeParse(transactionAt).success) problems.push(`Line ${line}: transaction_at must be an ISO 8601 time with an offset.`);
    if (staffRef && !/^[A-Za-z0-9._-]{1,80}$/.test(staffRef)) problems.push(`Line ${line}: staff_ref is invalid.`);
    if (!amount.test(bill)) problems.push(`Line ${line}: bill_amount must be a rand amount like 245.50.`);
    if (!amount.test(tip)) problems.push(`Line ${line}: tip_amount must be a rand amount like 24.50.`);
    else if (toMinor(tip) <= 0) problems.push(`Line ${line}: tip_amount must be more than zero.`);
    if (currency !== expected.currency) problems.push(`Line ${line}: currency must be ${expected.currency}.`);
    if (problems.length > before) return;
    const key = `${source}\u0000${rowRef}`;
    const content = [location, transactionAt, staffRef, bill, tip, currency].join("\u0000");
    const prior = seen.get(key);
    if (prior !== undefined) {
      if (prior === content) { duplicatesSkipped++; return; }
      problems.push(`Line ${line}: row_ref ${rowRef} appears twice with different values.`);
      return;
    }
    seen.set(key, content);
    rows.push({ line, source, location, rowRef, transactionAt: new Date(transactionAt), staffRef: staffRef || null, billMinor: toMinor(bill), tipMinor: toMinor(tip), currency });
  });
  if (problems.length) throw new TipValidationError("tip-csv-invalid", problems.slice(0, 20));
  return { rows, duplicatesSkipped, sha256: createHash("sha256").update(text).digest("hex") };
}

// ---------------------------------------------------------------------------------------------
// Deterministic splits.
export type Share = { workerId: string; amountMinor: number };

// One equal share per member, in cents; the remainder goes one cent each to members in ascending
// staff-ID order. The shares always sum to the total exactly.
export function equalShares(totalMinor: number, memberIds: readonly string[]): Share[] {
  if (!Number.isSafeInteger(totalMinor) || totalMinor < 0) throw new Error("A pool total must be a whole number of cents.");
  const members = [...new Set(memberIds)].sort();
  if (!members.length) return [];
  const base = Math.floor(totalMinor / members.length);
  const remainder = totalMinor - base * members.length;
  return members.map((workerId, index) => ({ workerId, amountMinor: base + (index < remainder ? 1 : 0) }));
}

// DIRECT: each row's tip to the staff member on that row.
export function directShares(rows: readonly { workerId: string | null; tipMinor: number }[]): { shares: Share[]; unallocatedMinor: number } {
  const totals = new Map<string, number>();
  let unallocatedMinor = 0;
  for (const row of rows) {
    if (row.workerId) totals.set(row.workerId, (totals.get(row.workerId) ?? 0) + row.tipMinor);
    else unallocatedMinor += row.tipMinor;
  }
  return { shares: [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([workerId, amountMinor]) => ({ workerId, amountMinor })), unallocatedMinor };
}
