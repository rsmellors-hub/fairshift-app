import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, isNotNull, lt } from "drizzle-orm";
import { z } from "zod";

import { AccessError, type Scope } from "@/server/auth/access";
import type { Database, DatabaseSession } from "@/server/db/client";
import {
  auditEvents, organisations, outlets, shiftOffers, shifts, staffDestinationEvents, tipAgentEvents, tipAllocationLines, tipAllocations, tipBlockRoster,
  tipEvidenceRows, tipImports, tipLocationSettings, tipShiftBlocks, workAllocations, workers,
} from "@/server/db/schema";
import { canonicalJson } from "@/server/domain/canonical-json";
import { resolveLocationCurrency } from "@/server/domain/currency";
import { UserFacingError } from "@/server/domain/errors";
import {
  blockForMinute, blockInterval, directShares, equalShares, IMPORTED_POS_EVIDENCE, isoWeekdayOf, localParts, overlaps, parseBlocksText, parseTipCsv,
  TipValidationError, type ShiftBlock, type TipPolicy,
} from "./policy";

// Permanent-staff tips under FS-TIP-DEC-002 (Owner decision, 7 November 2026). The Owner sets the
// location's standing policy, shift blocks, block roster and auto-release cap, then imports
// labelled POS tip evidence; this module allocates it deterministically. Managers have no role
// here: every write requires the Owner (FS-TIP-AGENT-DEC-001). Permanent staff are lightweight
// `workers` rows (worker_type REGULAR): no login, no shift offers, never in the casual pool.

type OwnerScope = Pick<Scope, "userId" | "organisationId" | "locationId" | "role" | "demo">;
export function assertTipOwner(scope: OwnerScope) {
  if (scope.role !== "OWNER" || scope.demo) throw new AccessError();
}

async function audit(db: DatabaseSession, scope: Pick<Scope, "organisationId" | "locationId">, action: string, entityType: string, entityId: string, metadata: Record<string, unknown>) {
  await db.insert(auditEvents).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: scope.locationId, action, entityType, entityId, correlationId: `tips:${scope.locationId}`, metadata });
}

async function scopedLocation(db: DatabaseSession, scope: Pick<Scope, "organisationId" | "locationId">) {
  const [row] = await db.select({ outlet: outlets, organisationCountry: organisations.country }).from(outlets).innerJoin(organisations, eq(organisations.id, outlets.organisationId))
    .where(and(eq(outlets.id, scope.locationId), eq(outlets.organisationId, scope.organisationId)));
  if (!row) throw new AccessError();
  return { ...row.outlet, currencyCode: resolveLocationCurrency({ locationCountry: row.outlet.country, organisationCountry: row.organisationCountry }) };
}

// ---------------------------------------------------------------------------------------------
// Permanent staff: minimal personal data (POPIA) — name, location, contact email, PayPal
// destination, status and block roster.
const staffSchema = z.object({
  firstName: z.string().trim().min(1).max(100), surname: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().email().max(254), paypalEmail: z.string().trim().toLowerCase().email().max(254),
}).strict();

export async function addPermanentStaff(db: Database, scope: OwnerScope, input: unknown) {
  assertTipOwner(scope);
  const parsed = staffSchema.safeParse(input);
  if (!parsed.success) throw new UserFacingError("staff-invalid", "Enter a first name, surname, contact email and PayPal email.");
  await scopedLocation(db, scope);
  const value = parsed.data;
  return db.transaction(async tx => {
    const [existing] = await tx.select({ id: workers.id }).from(workers).where(and(eq(workers.organisationId, scope.organisationId), eq(workers.email, value.email)));
    if (existing) throw new UserFacingError("staff-exists", "A staff record already exists for this email.");
    const [worker] = await tx.insert(workers).values({
      id: randomUUID(), organisationId: scope.organisationId, locationId: scope.locationId, workerType: "REGULAR",
      firstName: value.firstName, surname: value.surname, displayName: `${value.firstName} ${value.surname}`, email: value.email, paypalPayoutEmail: value.paypalEmail,
    }).returning();
    await tx.insert(staffDestinationEvents).values({ id: randomUUID(), organisationId: scope.organisationId, workerId: worker.id, kind: "RECORDED", recordedBy: scope.userId });
    await audit(tx, scope, "PERMANENT_STAFF_ADDED", "worker", worker.id, { actorUserId: scope.userId });
    return worker;
  });
}

export async function setPermanentStaffStatus(db: Database, scope: OwnerScope, workerId: string, status: "ACTIVE" | "INACTIVE") {
  assertTipOwner(scope);
  if (!z.uuid().safeParse(workerId).success) throw new AccessError();
  const [row] = await db.update(workers).set({ status, updatedAt: new Date() })
    .where(and(eq(workers.id, workerId), eq(workers.organisationId, scope.organisationId), eq(workers.locationId, scope.locationId), eq(workers.workerType, "REGULAR"))).returning();
  if (!row) throw new AccessError();
  await audit(db, scope, "PERMANENT_STAFF_STATUS", "worker", row.id, { actorUserId: scope.userId, status });
  return row;
}

// ---------------------------------------------------------------------------------------------
// Owner settings: policy, blocks, roster, auto-release cap.
const settingsSchema = z.object({ policy: z.enum(["DIRECT", "SHIFT_POOL"]), autoReleaseCapMinor: z.number().int().min(1).max(100_000_000) }).strict();

export async function saveTipSettings(db: Database, scope: OwnerScope, input: unknown) {
  assertTipOwner(scope);
  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success) throw new UserFacingError("tip-settings-invalid", "Choose a tip policy and an auto-release cap above zero.");
  const location = await scopedLocation(db, scope);
  const values = { organisationId: scope.organisationId, policy: parsed.data.policy, autoReleaseCapMinor: parsed.data.autoReleaseCapMinor, currencyCode: location.currencyCode, setBy: scope.userId, setAt: new Date() };
  return db.transaction(async tx => {
    const [row] = await tx.insert(tipLocationSettings).values({ outletId: scope.locationId, ...values })
      .onConflictDoUpdate({ target: tipLocationSettings.outletId, set: values }).returning();
    await audit(tx, scope, "TIP_SETTINGS_SAVED", "tip_location_settings", scope.locationId, { actorUserId: scope.userId, policy: row.policy, autoReleaseCapMinor: row.autoReleaseCapMinor });
    return row;
  });
}

export async function tipSettingsFor(db: DatabaseSession, scope: Pick<Scope, "organisationId" | "locationId">) {
  const [row] = await db.select().from(tipLocationSettings).where(and(eq(tipLocationSettings.outletId, scope.locationId), eq(tipLocationSettings.organisationId, scope.organisationId)));
  return row ?? null;
}

export async function activeBlocks(db: DatabaseSession, scope: Pick<Scope, "organisationId" | "locationId">): Promise<ShiftBlock[]> {
  return db.select({ id: tipShiftBlocks.id, name: tipShiftBlocks.name, startMinute: tipShiftBlocks.startMinute, endMinute: tipShiftBlocks.endMinute }).from(tipShiftBlocks)
    .where(and(eq(tipShiftBlocks.outletId, scope.locationId), eq(tipShiftBlocks.organisationId, scope.organisationId), eq(tipShiftBlocks.active, true))).orderBy(asc(tipShiftBlocks.startMinute));
}

// Replaces the location's block set. Unchanged blocks are kept (with their roster); others are
// deactivated, never edited or deleted, because allocations keep their snapshot and reference.
export async function saveShiftBlocks(db: Database, scope: OwnerScope, text: string) {
  assertTipOwner(scope);
  await scopedLocation(db, scope);
  const blocks = parseBlocksText(text);
  return db.transaction(async tx => {
    const current = await activeBlocks(tx, scope);
    const same = (a: { name: string; startMinute: number; endMinute: number }, b: typeof a) => a.name === b.name && a.startMinute === b.startMinute && a.endMinute === b.endMinute;
    const retire = current.filter(block => !blocks.some(next => same(block, next)));
    if (retire.length) await tx.update(tipShiftBlocks).set({ active: false }).where(inArray(tipShiftBlocks.id, retire.map(block => block.id)));
    const add = blocks.filter(next => !current.some(block => same(block, next)));
    if (add.length) await tx.insert(tipShiftBlocks).values(add.map(block => ({ id: randomUUID(), organisationId: scope.organisationId, outletId: scope.locationId, ...block, createdBy: scope.userId })));
    await audit(tx, scope, "TIP_BLOCKS_SAVED", "tip_shift_blocks", scope.locationId, { actorUserId: scope.userId, blocks });
    return activeBlocks(tx, scope);
  });
}

// Replaces one permanent staff member's standing weekly roster (active blocks only).
export async function saveBlockRoster(db: Database, scope: OwnerScope, workerId: string, entries: { isoWeekday: number; blockId: string }[]) {
  assertTipOwner(scope);
  const parsed = z.array(z.object({ isoWeekday: z.number().int().min(1).max(7), blockId: z.uuid() }).strict()).max(56).safeParse(entries);
  if (!parsed.success || !z.uuid().safeParse(workerId).success) throw new UserFacingError("tip-roster-invalid", "That roster couldn't be saved.");
  return db.transaction(async tx => {
    const [worker] = await tx.select({ id: workers.id }).from(workers).where(and(eq(workers.id, workerId), eq(workers.organisationId, scope.organisationId), eq(workers.locationId, scope.locationId), eq(workers.workerType, "REGULAR")));
    if (!worker) throw new AccessError();
    const blocks = new Set((await activeBlocks(tx, scope)).map(block => block.id));
    if (parsed.data.some(entry => !blocks.has(entry.blockId))) throw new UserFacingError("tip-roster-invalid", "That roster couldn't be saved.");
    await tx.delete(tipBlockRoster).where(and(eq(tipBlockRoster.workerId, workerId), eq(tipBlockRoster.outletId, scope.locationId)));
    const unique = [...new Map(parsed.data.map(entry => [`${entry.isoWeekday}:${entry.blockId}`, entry])).values()];
    if (unique.length) await tx.insert(tipBlockRoster).values(unique.map(entry => ({ id: randomUUID(), organisationId: scope.organisationId, outletId: scope.locationId, workerId, ...entry, createdBy: scope.userId })));
    await audit(tx, scope, "TIP_ROSTER_SAVED", "worker", workerId, { actorUserId: scope.userId, entries: unique });
    return unique;
  });
}

// ---------------------------------------------------------------------------------------------
// Import and deterministic allocation.
type RowDraft = { id: string; source: string; rowRef: string; transactionAt: Date; localDate: string; isoWeekday: number; minute: number;
  staffRef: string | null; workerId: string | null; workerType: string | null; workerActive: boolean | null; billMinor: number; tipMinor: number;
  blockId: string | null; disposition: "POOL" | "DIRECT" | "CASUAL_SHIFT_PAY" | "UNATTRIBUTED" | "OUTSIDE_BLOCKS"; allocationId: string | null };
type MemberDraft = { workerId: string; workerType: "REGULAR" | "CASUAL"; membership: "ROSTER" | "CONFIRMED_SHIFT" | "POS_ROW"; active: boolean };

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

// The evidence a tip allocation rests on, hashed: the allocation, its lines and members, and its
// rows. The Pay Agent's recommendation applies only to this version.
export function tipEvidenceVersion(input: { allocation: Record<string, unknown>; lines: { workerId: string; shareMinor: number; membership: string }[]; rows: Record<string, unknown>[]; members: { workerId: string; active: boolean }[] }) {
  return sha256(canonicalJson({ scheme: 1, ...input }));
}

// Confirmed casual work at the location overlapping a block interval: the allocation was confirmed
// by a manager and is still allocated. Scheduled times are used (existing shift data).
async function confirmedCasualsIn(db: DatabaseSession, scope: Pick<Scope, "organisationId" | "locationId">, interval: { start: Date; end: Date }) {
  const rows = await db.select({ workerId: shiftOffers.workerId, startsAt: shifts.startsAt, endsAt: shifts.endsAt, status: workers.status })
    .from(workAllocations).innerJoin(shiftOffers, eq(shiftOffers.id, workAllocations.offerId)).innerJoin(shifts, eq(shifts.id, shiftOffers.shiftId)).innerJoin(workers, eq(workers.id, shiftOffers.workerId))
    .where(and(eq(shifts.outletId, scope.locationId), eq(workers.organisationId, scope.organisationId), eq(workers.workerType, "CASUAL"), eq(workAllocations.state, "ALLOCATED"),
      isNotNull(workAllocations.confirmedAt), lt(shifts.startsAt, interval.end), gt(shifts.endsAt, interval.start)));
  return rows.filter(row => overlaps({ start: row.startsAt, end: row.endsAt }, interval));
}

export type TipImportResult = { importId: string; created: boolean; rowsStored: number; rowsAlreadyRecorded: number; duplicatesInFile: number; allocationIds: string[]; eventIds: string[] };

// Validates the whole CSV, then in one transaction stores the import, its new rows, the
// allocations and their lines, and one PENDING Pay Agent tip event per allocation. The same file
// is the same import; a row already recorded is never stored or counted twice.
export async function importTipEvidence(db: Database, scope: OwnerScope, text: string, now = new Date()): Promise<TipImportResult> {
  assertTipOwner(scope);
  const location = await scopedLocation(db, scope);
  const settings = await tipSettingsFor(db, scope);
  if (!settings) throw new UserFacingError("tip-policy-required", "Set this location's tip policy before importing tips.");
  const policy = settings.policy as TipPolicy;
  const blocks = policy === "SHIFT_POOL" ? await activeBlocks(db, scope) : [];
  if (policy === "SHIFT_POOL" && !blocks.length) throw new UserFacingError("tip-blocks-required", "Define this location's shift blocks before importing tips.");
  let parsed: ReturnType<typeof parseTipCsv>;
  try { parsed = parseTipCsv(text, { locationId: location.id, locationName: location.name, currency: location.currencyCode }); }
  catch (error) { if (error instanceof TipValidationError) throw new UserFacingError(error.feedback, `The file wasn't imported: ${error.problems.join(" ")}`); throw error; }

  return db.transaction(async tx => {
    const [existing] = await tx.select().from(tipImports).where(and(eq(tipImports.outletId, scope.locationId), eq(tipImports.fileSha256, parsed.sha256)));
    if (existing) {
      const allocations = await tx.select({ id: tipAllocations.id }).from(tipAllocations).where(eq(tipAllocations.importId, existing.id));
      return { importId: existing.id, created: false, rowsStored: 0, rowsAlreadyRecorded: parsed.rows.length, duplicatesInFile: parsed.duplicatesSkipped, allocationIds: allocations.map(row => row.id), eventIds: [] };
    }
    const staff = await tx.select({ id: workers.id, code: workers.attributionCode, type: workers.workerType, status: workers.status }).from(workers)
      .where(and(eq(workers.organisationId, scope.organisationId), eq(workers.locationId, scope.locationId)));
    const byCode = new Map(staff.map(row => [row.code, row]));
    const known = await tx.select({ source: tipEvidenceRows.source, rowRef: tipEvidenceRows.rowRef }).from(tipEvidenceRows).where(eq(tipEvidenceRows.outletId, scope.locationId));
    const recorded = new Set(known.map(row => `${row.source}\u0000${row.rowRef}`));
    const fresh = parsed.rows.filter(row => !recorded.has(`${row.source}\u0000${row.rowRef}`));

    const drafts: RowDraft[] = fresh.map(row => {
      const local = localParts(row.transactionAt, location.timezone);
      const person = row.staffRef ? byCode.get(row.staffRef) ?? null : null;
      const block = policy === "SHIFT_POOL" ? blockForMinute(local.minute, blocks) : null;
      const disposition: RowDraft["disposition"] = policy === "SHIFT_POOL" ? (block ? "POOL" : "OUTSIDE_BLOCKS")
        : !person ? "UNATTRIBUTED" : person.type === "CASUAL" ? "CASUAL_SHIFT_PAY" : "DIRECT";
      return { id: randomUUID(), source: row.source, rowRef: row.rowRef, transactionAt: row.transactionAt, localDate: local.date, isoWeekday: local.isoWeekday, minute: local.minute,
        staffRef: row.staffRef, workerId: person?.id ?? null, workerType: person?.type ?? null, workerActive: person ? person.status === "ACTIVE" : null,
        billMinor: row.billMinor, tipMinor: row.tipMinor, blockId: block?.id ?? null, disposition, allocationId: null };
    });

    const importId = randomUUID();
    await tx.insert(tipImports).values({ id: importId, organisationId: scope.organisationId, outletId: scope.locationId, label: IMPORTED_POS_EVIDENCE, fileSha256: parsed.sha256, policy,
      rowCount: drafts.length, duplicateRowsSkipped: parsed.duplicatesSkipped + (parsed.rows.length - fresh.length), totalTipMinor: drafts.reduce((sum, row) => sum + row.tipMinor, 0),
      currencyCode: location.currencyCode, importedBy: scope.userId, importedAt: now });

    // Group into allocations: per local date (DIRECT) or per local date and block (SHIFT_POOL).
    const groups = new Map<string, RowDraft[]>();
    for (const row of drafts) {
      if (row.disposition === "CASUAL_SHIFT_PAY" || row.disposition === "OUTSIDE_BLOCKS") continue;
      const key = `${row.localDate}|${policy === "SHIFT_POOL" ? row.blockId : "DAY"}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const allocationRows: (typeof tipAllocations.$inferInsert)[] = [];
    const lineRows: (typeof tipAllocationLines.$inferInsert)[] = [];
    for (const [key, rows] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const [localDate, blockKey] = key.split("|");
      const allocationId = randomUUID();
      const block = blocks.find(candidate => candidate.id === blockKey) ?? null;
      const total = rows.reduce((sum, row) => sum + row.tipMinor, 0);
      let members: MemberDraft[] = [];
      let shares: { workerId: string; amountMinor: number }[];
      let unallocated: number;
      if (policy === "SHIFT_POOL" && block) {
        const weekday = isoWeekdayOf(localDate);
        const rostered = await tx.select({ workerId: tipBlockRoster.workerId, status: workers.status }).from(tipBlockRoster).innerJoin(workers, eq(workers.id, tipBlockRoster.workerId))
          .where(and(eq(tipBlockRoster.outletId, scope.locationId), eq(tipBlockRoster.blockId, block.id), eq(tipBlockRoster.isoWeekday, weekday), eq(workers.workerType, "REGULAR")));
        const casuals = await confirmedCasualsIn(tx, scope, blockInterval(block, localDate, location.timezone));
        members = [
          ...rostered.map(row => ({ workerId: row.workerId, workerType: "REGULAR" as const, membership: "ROSTER" as const, active: row.status === "ACTIVE" })),
          ...[...new Map(casuals.map(row => [row.workerId, row])).values()].map(row => ({ workerId: row.workerId, workerType: "CASUAL" as const, membership: "CONFIRMED_SHIFT" as const, active: row.status === "ACTIVE" })),
        ];
        // Inactive rostered staff did not work the block; they are shown to the check, not paid.
        shares = equalShares(total, members.filter(member => member.active).map(member => member.workerId));
        unallocated = shares.length ? 0 : total;
      } else {
        const split = directShares(rows.map(row => ({ workerId: row.disposition === "DIRECT" ? row.workerId : null, tipMinor: row.tipMinor })));
        shares = split.shares; unallocated = split.unallocatedMinor;
        members = shares.map(share => ({ workerId: share.workerId, workerType: "REGULAR" as const, membership: "POS_ROW" as const, active: staff.find(person => person.id === share.workerId)?.status === "ACTIVE" }));
      }
      for (const row of rows) row.allocationId = allocationId;
      const allocated = shares.reduce((sum, share) => sum + share.amountMinor, 0);
      const lines = shares.map(share => {
        const member = members.find(candidate => candidate.workerId === share.workerId)!;
        return { workerId: share.workerId, shareMinor: share.amountMinor, membership: member.membership, workerType: member.workerType };
      });
      const allocationFacts = { id: allocationId, outletId: scope.locationId, importId, policy, localDate, blockKey, blockId: block?.id ?? null, blockName: block?.name ?? null,
        blockStartMinute: block?.startMinute ?? null, blockEndMinute: block?.endMinute ?? null, totalTipMinor: total, allocatedMinor: allocated, unallocatedMinor: unallocated, currencyCode: location.currencyCode };
      const evidenceVersion = tipEvidenceVersion({
        allocation: allocationFacts, lines: lines.map(({ workerId, shareMinor, membership }) => ({ workerId, shareMinor, membership })),
        rows: rows.map(row => ({ id: row.id, rowRef: row.rowRef, at: row.transactionAt.toISOString(), staffRef: row.staffRef, workerId: row.workerId, billMinor: row.billMinor, tipMinor: row.tipMinor, disposition: row.disposition })),
        members: members.map(({ workerId, active }) => ({ workerId, active })),
      });
      allocationRows.push({ ...allocationFacts, organisationId: scope.organisationId, evidenceVersion });
      for (const line of lines) lineRows.push({ id: randomUUID(), allocationId, organisationId: scope.organisationId, outletId: scope.locationId, ...line, currencyCode: location.currencyCode, localDate });
    }
    if (allocationRows.length) await tx.insert(tipAllocations).values(allocationRows);
    if (lineRows.length) await tx.insert(tipAllocationLines).values(lineRows);
    if (drafts.length) await tx.insert(tipEvidenceRows).values(drafts.map(row => ({
      id: row.id, organisationId: scope.organisationId, outletId: scope.locationId, importId, source: row.source, rowRef: row.rowRef, transactionAt: row.transactionAt, localDate: row.localDate,
      staffRef: row.staffRef, workerId: row.workerId, billMinor: row.billMinor, tipMinor: row.tipMinor, currencyCode: location.currencyCode, blockId: row.blockId,
      allocationId: row.allocationId, disposition: row.disposition, importedAt: now,
    })));
    // One Pay Agent tip check per allocation with something to release (FS-TIP-AGENT-DEC-001).
    const eventIds: string[] = [];
    for (const allocation of allocationRows) {
      const nothing = allocation.allocatedMinor === 0;
      const [event] = await tx.insert(tipAgentEvents).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: scope.locationId, allocationId: allocation.id!,
        evidenceVersion: allocation.evidenceVersion, createdBy: scope.userId, status: nothing ? "SKIPPED" : "PENDING", outcomeCode: nothing ? "NOTHING_ALLOCATED" : null, completedAt: nothing ? now : null }).returning();
      if (!nothing) eventIds.push(event.id);
    }
    await audit(tx, scope, "TIP_EVIDENCE_IMPORTED", "tip_import", importId, { actorUserId: scope.userId, label: IMPORTED_POS_EVIDENCE, policy, rows: drafts.length,
      duplicates: parsed.duplicatesSkipped + (parsed.rows.length - fresh.length), allocations: allocationRows.length, totalTipMinor: drafts.reduce((sum, row) => sum + row.tipMinor, 0) });
    return { importId, created: true, rowsStored: drafts.length, rowsAlreadyRecorded: parsed.rows.length - fresh.length, duplicatesInFile: parsed.duplicatesSkipped,
      allocationIds: allocationRows.map(row => row.id!), eventIds };
  });
}

// ---------------------------------------------------------------------------------------------
// The casual shift-pay tip line (FS-TIP-DEC-002): at a DIRECT location a casual's POS tips stay on
// shift pay (FS-TIP-DEC-001 "allocated tips" line); in a SHIFT_POOL block their share comes
// through the pool, and their shift-pay tip line is zero for that block. Every tip row is paid
// exactly once. FairShift's casual payable does not yet carry a tip line, so DIRECT casual tips are
// recorded here and NOT paid by FairShift (stated on every view that shows them).
export async function casualShiftPayTipLine(db: DatabaseSession, scope: Pick<Scope, "organisationId" | "locationId">, workerId: string, shift: { startsAt: Date; endsAt: Date }) {
  const settings = await tipSettingsFor(db, scope);
  if (settings?.policy === "SHIFT_POOL") return { amountMinor: 0, basis: "POOLED" as const };
  const rows = await db.select({ tipMinor: tipEvidenceRows.tipMinor }).from(tipEvidenceRows).where(and(eq(tipEvidenceRows.outletId, scope.locationId), eq(tipEvidenceRows.organisationId, scope.organisationId),
    eq(tipEvidenceRows.workerId, workerId), eq(tipEvidenceRows.disposition, "CASUAL_SHIFT_PAY"), lt(tipEvidenceRows.transactionAt, shift.endsAt), gt(tipEvidenceRows.transactionAt, new Date(shift.startsAt.getTime() - 1))));
  return { amountMinor: rows.reduce((sum, row) => sum + row.tipMinor, 0), basis: "SHIFT_PAY_RECORDED_NOT_PAID" as const };
}
