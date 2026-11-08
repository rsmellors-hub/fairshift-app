import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Scope } from "@/server/auth/access";
import { auditEvents, staffDestinationEvents, staffStatementLinks, tipAgentEvents, tipAllocationLines, tipAllocations, tipEvidenceRows, tipHoldDecisions, tipHolds, tipImports, workers, workPayouts } from "@/server/db/schema";
import type { AssessmentRequest, AssessmentResponse } from "@/server/integrations/openai/staffing-assessment";
import type { PayPalPayoutAdapter, PayoutResult } from "@/server/integrations/paypal/payout-client";
import { mintPayAgentCredentialForManager, payAgentServiceVerifier } from "@/server/pay-agent/identity";
import { PAY_AGENT_DRY_RUN_ENV } from "@/server/pay-agent/settlement";
import { offerAssignment } from "@/server/scheduling/operations";
import { createTipAgent, decideTipHold, HOLD_TIP_ACTION, parseTipDecision, RELEASE_TIP_ACTION, settleReleasedLineHold, tipDecisionJsonSchema, tipModelView, loadTipAllocation } from "@/server/tips/agent";
import { TIP_CSV_HEADER } from "@/server/tips/policy";
import { addPermanentStaff, casualShiftPayTipLine, importTipEvidence, saveBlockRoster, saveShiftBlocks, saveTipSettings, setPermanentStaffStatus } from "@/server/tips/service";
import { createStatementLink, devStatementLinksEnabled, readStatement, STATEMENT_LINK_TTL_MS, updateStatementDestination } from "@/server/tips/statement";
import { createTestDatabase } from "../helpers/database";
import { seedTestFxRate } from "../helpers/fx";
import { allocatedWork, confirmedWork, payAgentCompany, testUser } from "../helpers/pay-agent";
import { sandboxFixture } from "../helpers/sandbox";

// Permanent-staff tips under FS-TIP-DEC-002 and FS-TIP-AGENT-DEC-001 (Owner decisions, 7 Nov 2026),
// over in-process PGlite, a fake model and a fake PayPal client. Synthetic demo data only.
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const DEV = { NODE_ENV: "development", FAIRSHIFT_DEV_STATEMENT_LINKS: "enabled" };

type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];
async function tenant(db: Db, options: { sandbox?: boolean } = {}) {
  const company = await payAgentCompany(db, { country: "South Africa" });
  if (options.sandbox !== false) sandboxFixture(company.organisationId);
  const manager = company.scopes[0];
  const owner: Scope = { ...manager, userId: await testUser(db), role: "OWNER" };
  return { ...company, manager, owner };
}
const csv = (rows: string[][]) => [TIP_CSV_HEADER.join(","), ...rows.map(row => row.join(","))].join("\n");
const tipRow = (ref: string, at: string, staff: string, tip: string, bill = "200.00", location = "Store 1") => ["Demo POS export", location, ref, at, staff, bill, tip, "ZAR"];
async function staffMember(db: Db, owner: Scope, name: string) {
  const worker = await addPermanentStaff(db, owner, { firstName: name, surname: "Permanent", email: `${name.toLowerCase()}@example.test`, paypalEmail: `${name.toLowerCase()}.sandbox@example.test` });
  return worker;
}
async function confirmDestination(db: Db, owner: Scope, workerId: string) {
  const link = await createStatementLink(db, owner, workerId, new Date(), DEV);
  await updateStatementDestination(db, link.path.split("#")[1], { action: "CONFIRM" });
}
function fakeTipModel(reply: (allocationId: string) => unknown = allocationId => ({ action: RELEASE_TIP_ACTION, allocationId })) {
  const assess = vi.fn(async (request: AssessmentRequest): Promise<AssessmentResponse> => {
    const { allocationId } = JSON.parse(request.input) as { allocationId: string };
    return { responseId: "resp_tip_test", responseModel: "test-model", text: JSON.stringify({ decision: reply(allocationId) }) };
  });
  return { provider: "OPENAI" as const, model: "test-model", assess };
}
function fakePayPal() {
  return {
    createPayout: vi.fn(async (input: { senderBatchId: string }): Promise<PayoutResult> => ({ batchId: `PPB${input.senderBatchId.slice(-8)}`, itemId: null, status: "PENDING", batchStatus: "PENDING", itemStatus: null, transactionId: null })),
    getPayout: vi.fn(),
  } as unknown as PayPalPayoutAdapter & { createPayout: ReturnType<typeof vi.fn> };
}
function agentFor(db: Db, model = fakeTipModel(), paypal = fakePayPal()) {
  return { agent: createTipAgent({ db, identityVerifier: payAgentServiceVerifier, model: () => model, paypal }), model, paypal };
}
const linesOf = (db: Db, allocationId: string) => db.select().from(tipAllocationLines).where(eq(tipAllocationLines.allocationId, allocationId)).orderBy(tipAllocationLines.workerId);

describe("permanent staff records", () => {
  it("are lightweight REGULAR records, never offered casual work, and managed only by the Owner at their location", async () => {
    const t = await createTestDatabase();
    try {
      const { owner, manager } = await tenant(t.db);
      const staff = await staffMember(t.db, owner, "Zanele");
      expect(staff).toMatchObject({ workerType: "REGULAR", userId: null, locationId: owner.locationId, status: "ACTIVE" });
      // Not in the casual pool: a shift can't be offered to them.
      const { shift } = await allocatedWork(t.db, manager);
      await expect(offerAssignment(t.db, shift.id, staff.id, manager)).rejects.toThrow();
      // Managers have no tip or staff-record actions.
      await expect(addPermanentStaff(t.db, manager, { firstName: "A", surname: "B", email: "a@example.test", paypalEmail: "a.pp@example.test" })).rejects.toThrow(/Access denied/);
      await expect(saveTipSettings(t.db, manager, { policy: "DIRECT", autoReleaseCapMinor: 150_000 })).rejects.toThrow(/Access denied/);
      await expect(setPermanentStaffStatus(t.db, { ...owner, locationId: randomUUID() }, staff.id, "INACTIVE")).rejects.toThrow(/Access denied/);
      // Another business's Owner can't reach this location.
      const other = await tenant(t.db, { sandbox: false });
      await expect(saveTipSettings(t.db, { ...other.owner, locationId: owner.locationId }, { policy: "DIRECT", autoReleaseCapMinor: 1 })).rejects.toThrow(/Access denied/);
    } finally { await t.close(); }
  });
});

describe("tip evidence import", () => {
  it("requires the policy first, validates the whole file and is idempotent for files and rows", async () => {
    const t = await createTestDatabase();
    try {
      const { owner } = await tenant(t.db);
      const staff = await staffMember(t.db, owner, "Thabo");
      const file = csv([tipRow("T-1", "2026-11-06T09:00:00+02:00", staff.attributionCode, "24.50"), tipRow("T-2", "2026-11-06T10:00:00+02:00", "", "5.00")]);
      await expect(importTipEvidence(t.db, owner, file)).rejects.toMatchObject({ feedback: "tip-policy-required" });
      await saveTipSettings(t.db, owner, { policy: "DIRECT", autoReleaseCapMinor: 150_000 });
      // Malformed amount, wrong currency or another location: nothing is stored.
      await expect(importTipEvidence(t.db, owner, csv([tipRow("T-9", "2026-11-06T09:00:00+02:00", "", "-1.00")]))).rejects.toMatchObject({ feedback: "tip-csv-invalid" });
      await expect(importTipEvidence(t.db, owner, csv([tipRow("T-9", "2026-11-06T09:00:00+02:00", "", "1.00", "10.00", "Rosebank")]))).rejects.toMatchObject({ feedback: "tip-csv-invalid" });
      expect(await t.db.select().from(tipEvidenceRows)).toHaveLength(0);
      const first = await importTipEvidence(t.db, owner, file);
      expect(first).toMatchObject({ created: true, rowsStored: 2 });
      expect(await importTipEvidence(t.db, owner, file)).toMatchObject({ created: false, importId: first.importId, rowsStored: 0 });
      // A new file repeating T-1 stores only the new row.
      const second = await importTipEvidence(t.db, owner, csv([tipRow("T-1", "2026-11-06T09:00:00+02:00", staff.attributionCode, "24.50"), tipRow("T-3", "2026-11-06T11:00:00+02:00", staff.attributionCode, "3.00")]));
      expect(second).toMatchObject({ created: true, rowsStored: 1, rowsAlreadyRecorded: 1 });
      expect(await t.db.select().from(tipEvidenceRows)).toHaveLength(3);
      const [stored] = await t.db.select().from(tipImports).where(eq(tipImports.id, first.importId));
      expect(stored).toMatchObject({ label: "IMPORTED_POS_EVIDENCE", policy: "DIRECT", currencyCode: "ZAR", totalTipMinor: 2_950 });
    } finally { await t.close(); }
  });
});

describe("deterministic allocation", () => {
  it("DIRECT: each row to the staff member on it, to the cent; unattributed rows unallocated; a casual's tips stay on shift pay", async () => {
    const t = await createTestDatabase();
    try {
      const { owner, manager } = await tenant(t.db);
      await saveTipSettings(t.db, owner, { policy: "DIRECT", autoReleaseCapMinor: 150_000 });
      const [a, b] = [await staffMember(t.db, owner, "Ama"), await staffMember(t.db, owner, "Bo")];
      const casualWork = await confirmedWork(t.db, manager);
      const [casual] = await t.db.select().from(workers).where(eq(workers.id, casualWork.worker.id));
      const result = await importTipEvidence(t.db, owner, csv([
        tipRow("D-1", "2026-10-20T10:00:00+02:00", a.attributionCode, "24.50"), tipRow("D-2", "2026-10-20T11:00:00+02:00", a.attributionCode, "10.01"),
        tipRow("D-3", "2026-10-20T12:00:00+02:00", b.attributionCode, "0.99"), tipRow("D-4", "2026-10-20T13:00:00+02:00", "FS-UNKNOWN", "7.77"),
        tipRow("D-5", "2026-10-20T14:00:00+02:00", "", "5.00"), tipRow("D-6", "2026-10-20T15:00:00+02:00", casual.attributionCode, "12.00"),
      ]));
      expect(result.allocationIds).toHaveLength(1);
      const [allocation] = await t.db.select().from(tipAllocations).where(eq(tipAllocations.id, result.allocationIds[0]));
      expect(allocation).toMatchObject({ policy: "DIRECT", blockKey: "DAY", totalTipMinor: 4_827, allocatedMinor: 3_550, unallocatedMinor: 1_277 });
      expect((await linesOf(t.db, allocation.id)).map(line => [line.workerId, line.shareMinor]).sort()).toEqual([[a.id, 3_451], [b.id, 99]].sort());
      const [casualRow] = await t.db.select().from(tipEvidenceRows).where(eq(tipEvidenceRows.rowRef, "D-6"));
      expect(casualRow).toMatchObject({ disposition: "CASUAL_SHIFT_PAY", allocationId: null, workerId: casual.id });
      expect(await casualShiftPayTipLine(t.db, manager, casual.id, { startsAt: casualWork.shift.startsAt, endsAt: casualWork.shift.endsAt })).toEqual({ amountMinor: 1_200, basis: "SHIFT_PAY_RECORDED_NOT_PAID" });
    } finally { await t.close(); }
  });

  it("SHIFT_POOL: equal shares per block with the remainder in staff-ID order, two shares for two blocks, casual overlap membership, outside-block rows unallocated", async () => {
    const t = await createTestDatabase();
    try {
      const { owner, manager } = await tenant(t.db);
      await saveTipSettings(t.db, owner, { policy: "SHIFT_POOL", autoReleaseCapMinor: 150_000 });
      const blocks = await saveShiftBlocks(t.db, owner, "Morning 07:00-12:00, Afternoon 12:00-17:00, Evening 17:00-23:00");
      const [morning, afternoon, evening] = blocks;
      const [front, back] = [await staffMember(t.db, owner, "Front"), await staffMember(t.db, owner, "Back")];
      // Tuesday 20 Oct 2026 (ISO weekday 2): front works Morning and Afternoon, back works Morning.
      await saveBlockRoster(t.db, owner, front.id, [{ isoWeekday: 2, blockId: morning.id }, { isoWeekday: 2, blockId: afternoon.id }]);
      await saveBlockRoster(t.db, owner, back.id, [{ isoWeekday: 2, blockId: morning.id }]);
      // The casual's confirmed shift is 10:00-16:00 local: it overlaps Morning and Afternoon, not Evening.
      const casualWork = await confirmedWork(t.db, manager);
      const result = await importTipEvidence(t.db, owner, csv([
        tipRow("P-1", "2026-10-20T08:00:00+02:00", "", "100.00"), tipRow("P-2", "2026-10-20T11:59:00+02:00", "", "0.01"),
        tipRow("P-3", "2026-10-20T12:00:00+02:00", "", "50.01"), tipRow("P-4", "2026-10-20T18:00:00+02:00", "", "9.00"),
        tipRow("P-5", "2026-10-20T23:30:00+02:00", "", "4.00"),
      ]));
      const allocations = await t.db.select().from(tipAllocations).where(eq(tipAllocations.importId, result.importId));
      const byBlock = (id: string) => allocations.find(row => row.blockId === id)!;
      const sorted = (ids: string[]) => [...ids].sort();
      // Morning R100.01 among three members: 33.34, 33.34, 33.33 by ascending staff ID.
      const morningLines = await linesOf(t.db, byBlock(morning.id).id);
      const ids = sorted([front.id, back.id, casualWork.worker.id]);
      expect(morningLines.map(line => [line.workerId, line.shareMinor])).toEqual([[ids[0], 3_334], [ids[1], 3_334], [ids[2], 3_333]]);
      expect(morningLines.find(line => line.workerId === casualWork.worker.id)).toMatchObject({ workerType: "CASUAL", membership: "CONFIRMED_SHIFT" });
      // Afternoon R50.01 between front and the casual: someone in two blocks takes a share in each.
      const afternoonLines = await linesOf(t.db, byBlock(afternoon.id).id);
      expect(afternoonLines.map(line => line.workerId)).toEqual(sorted([front.id, casualWork.worker.id]));
      expect(afternoonLines.reduce((sum, line) => sum + line.shareMinor, 0)).toBe(5_001);
      // Evening has tips but no members: all unallocated and visible.
      expect(byBlock(evening.id)).toMatchObject({ totalTipMinor: 900, allocatedMinor: 0, unallocatedMinor: 900 });
      const [outside] = await t.db.select().from(tipEvidenceRows).where(eq(tipEvidenceRows.rowRef, "P-5"));
      expect(outside).toMatchObject({ disposition: "OUTSIDE_BLOCKS", allocationId: null });
      // In a pooled block the casual's shift-pay tip line is zero: the pool pays their share.
      expect(await casualShiftPayTipLine(t.db, manager, casualWork.worker.id, { startsAt: casualWork.shift.startsAt, endsAt: casualWork.shift.endsAt })).toEqual({ amountMinor: 0, basis: "POOLED" });
    } finally { await t.close(); }
  });

  it("pays every tip row exactly once: totals reconcile, rows and allocations are immutable, and each line has at most one payout", async () => {
    const t = await createTestDatabase();
    try {
      const { owner } = await tenant(t.db);
      await saveTipSettings(t.db, owner, { policy: "SHIFT_POOL", autoReleaseCapMinor: 150_000 });
      const [morning] = await saveShiftBlocks(t.db, owner, "Morning 07:00-12:00");
      const staff = await staffMember(t.db, owner, "Once");
      await saveBlockRoster(t.db, owner, staff.id, [{ isoWeekday: 5, blockId: morning.id }]);
      const result = await importTipEvidence(t.db, owner, csv([tipRow("O-1", "2026-11-06T08:00:00+02:00", "", "10.00"), tipRow("O-2", "2026-11-06T13:00:00+02:00", "", "2.00")]));
      const rows = await t.db.select().from(tipEvidenceRows).where(eq(tipEvidenceRows.importId, result.importId));
      const allocations = await t.db.select().from(tipAllocations).where(eq(tipAllocations.importId, result.importId));
      const pooled = rows.filter(row => row.allocationId).reduce((sum, row) => sum + row.tipMinor, 0);
      expect(pooled + rows.filter(row => !row.allocationId).reduce((sum, row) => sum + row.tipMinor, 0)).toBe(1_200);
      expect(allocations.reduce((sum, row) => sum + row.totalTipMinor, 0)).toBe(pooled);
      await expect(t.db.update(tipEvidenceRows).set({ allocationId: null, disposition: "OUTSIDE_BLOCKS" }).where(eq(tipEvidenceRows.rowRef, "O-1"))).rejects.toBeTruthy();
      await expect(t.db.update(tipAllocations).set({ allocatedMinor: 0, unallocatedMinor: 1_000 })).rejects.toBeTruthy();
      await expect(t.db.update(tipAllocationLines).set({ shareMinor: 1 })).rejects.toBeTruthy();
      await expect(t.db.execute(sql`delete from tip_evidence_rows`)).rejects.toBeTruthy();
      // A payout must match its line exactly, and a line can't be paid twice.
      const [line] = await t.db.select().from(tipAllocationLines);
      const payout = { organisationId: line.organisationId, outletId: line.outletId, workerId: line.workerId, tipLineId: line.id, currencyCode: "ZAR", providerCurrency: "USD", providerAmountMinor: 53, fxRateMicros: 18_540_000, fxRateSource: "ECB_EUROFXREF_DAILY:2026-11-06", recipient: "x@example.test", status: "SUBMITTING", reservedAt: new Date() };
      await expect(t.db.insert(workPayouts).values({ ...payout, id: randomUUID(), amountMinor: line.shareMinor + 1, senderBatchId: "B0", senderItemId: "I0" })).rejects.toBeTruthy();
      await t.db.insert(workPayouts).values({ ...payout, id: randomUUID(), amountMinor: line.shareMinor, senderBatchId: "B1", senderItemId: "I1" });
      await expect(t.db.insert(workPayouts).values({ ...payout, id: randomUUID(), amountMinor: line.shareMinor, senderBatchId: "B2", senderItemId: "I2" })).rejects.toBeTruthy();
    } finally { await t.close(); }
  });
});

describe("Pay Agent tip contract", () => {
  const allocationId = randomUUID();
  it("accepts exactly the two allowlisted actions for the server's allocation, and nothing else", () => {
    expect(parseTipDecision(JSON.stringify({ decision: { action: RELEASE_TIP_ACTION, allocationId } }), allocationId)).toMatchObject({ ok: true });
    expect(parseTipDecision(JSON.stringify({ decision: { action: HOLD_TIP_ACTION, allocationId, reasonCode: "TIP_OUTLIER", summary: "Row R-4 tip exceeds its bill." } }), allocationId)).toMatchObject({ ok: true });
    expect(parseTipDecision(JSON.stringify({ decision: { action: "pay_now", allocationId } }), allocationId)).toEqual({ ok: false, reason: "UNSUPPORTED_ACTION" });
    expect(parseTipDecision(JSON.stringify({ decision: { action: HOLD_TIP_ACTION, allocationId, reasonCode: "CONFIRMATION_DELAY", summary: "x" } }), allocationId)).toEqual({ ok: false, reason: "UNKNOWN_REASON" });
    expect(parseTipDecision(JSON.stringify({ decision: { action: RELEASE_TIP_ACTION, allocationId: randomUUID() } }), allocationId)).toEqual({ ok: false, reason: "WRONG_ALLOCATION" });
    expect(parseTipDecision(JSON.stringify({ decision: { action: RELEASE_TIP_ACTION, allocationId, amountMinor: 1 } }), allocationId)).toEqual({ ok: false, reason: "EXTRA_FIELDS" });
    expect(parseTipDecision("Released, all good.", allocationId)).toEqual({ ok: false, reason: "MALFORMED_JSON" });
    expect(JSON.stringify(tipDecisionJsonSchema(allocationId))).not.toMatch(/amount|currency|recipient|merchant|funding|rate/i);
  });
});

async function releasedScenario(options: { cap?: number; tip?: string; dryRun?: boolean; confirm?: boolean } = {}) {
  const t = await createTestDatabase();
  const { owner, manager, organisationId } = await tenant(t.db);
  if (options.dryRun === false) vi.stubEnv(PAY_AGENT_DRY_RUN_ENV, "false");
  await seedTestFxRate(t.db);
  await saveTipSettings(t.db, owner, { policy: "DIRECT", autoReleaseCapMinor: options.cap ?? 150_000 });
  const staff = await staffMember(t.db, owner, "Lindiwe");
  if (options.confirm !== false) await confirmDestination(t.db, owner, staff.id);
  const result = await importTipEvidence(t.db, owner, csv([tipRow("R-1", "2026-11-06T09:00:00+02:00", staff.attributionCode, options.tip ?? "120.00")]));
  return { t, owner, manager, organisationId, staff, result, credential: mintPayAgentCredentialForManager(owner) };
}

describe("AI-checked release through the settlement gates", () => {
  it("releases within the cap under dry run: every gate passes, nothing is reserved or sent, nothing is called paid", async () => {
    const s = await releasedScenario();
    try {
      const { agent, model, paypal } = agentFor(s.t.db);
      const run = await agent.process({ eventId: s.result.eventIds[0] }, s.credential);
      expect(run).toMatchObject({ status: "SETTLED", outcomeCode: "DRY_RUN_ELIGIBLE:1" });
      expect(run.event).toMatchObject({ decision: "RELEASE", responseId: "resp_tip_test", dryRun: true });
      expect(model.assess).toHaveBeenCalledTimes(1);
      const view = JSON.parse(model.assess.mock.calls[0][0].input) as Record<string, unknown>;
      expect(JSON.stringify(view)).not.toMatch(/Lindiwe|example\.test|sandbox|paypal/i);
      expect(paypal.createPayout).not.toHaveBeenCalled();
      expect(await s.t.db.select().from(workPayouts)).toHaveLength(0);
      const statement = await readStatement(s.t.db, (await createStatementLink(s.t.db, s.owner, s.staff.id, new Date(), DEV)).path.split("#")[1]);
      expect(statement?.credits).toEqual([expect.objectContaining({ shareMinor: 12_000, status: "recorded" })]);
    } finally { await s.t.close(); }
  });

  it("fails closed without a confirmed destination, outside the Sandbox organisation, and without a fresh ECB rate", async () => {
    const s = await releasedScenario({ confirm: false });
    try {
      const { agent } = agentFor(s.t.db);
      expect(await agent.process({ eventId: s.result.eventIds[0] }, s.credential)).toMatchObject({ status: "SETTLED", outcomeCode: "BLOCKED:1" });
      expect((await s.t.db.select().from(tipAllocationLines))[0].gateOutcome).toBe("BLOCKED:staff-destination-unconfirmed");
    } finally { await s.t.close(); }
    const fx = await createTestDatabase();
    try {
      const { owner } = await tenant(fx.db);
      await saveTipSettings(fx.db, owner, { policy: "DIRECT", autoReleaseCapMinor: 150_000 });
      const staff = await staffMember(fx.db, owner, "Nofx");
      await confirmDestination(fx.db, owner, staff.id);
      const result = await importTipEvidence(fx.db, owner, csv([tipRow("F-1", "2026-11-06T09:00:00+02:00", staff.attributionCode, "10.00")]));
      expect(await agentFor(fx.db).agent.process({ eventId: result.eventIds[0] }, mintPayAgentCredentialForManager(owner))).toMatchObject({ outcomeCode: "BLOCKED:1" });
      expect((await fx.db.select().from(tipAllocationLines))[0].gateOutcome).toBe("BLOCKED:provider-fx-rate-unavailable");
    } finally { await fx.close(); }
  });

  it("holds a share above the daily cap with a deterministic reason; only the Owner may decide, with a written reason, append-only", async () => {
    const s = await releasedScenario({ cap: 10_000, tip: "120.00" });
    try {
      const { agent, paypal } = agentFor(s.t.db);
      expect(await agent.process({ eventId: s.result.eventIds[0] }, s.credential)).toMatchObject({ status: "SETTLED", outcomeCode: "HELD:1" });
      const [hold] = await s.t.db.select().from(tipHolds);
      expect(hold).toMatchObject({ source: "DETERMINISTIC", reasonCode: "AUTO_RELEASE_CAP_EXCEEDED", lineId: expect.any(String), tipAgentEventId: null });
      // Managers have no role in the tip flow; a reason is required.
      await expect(decideTipHold(s.t.db, paypal, s.manager, { holdId: hold.id, decision: "RELEASED", reason: "ok" })).rejects.toThrow(/Access denied/);
      await expect(decideTipHold(s.t.db, paypal, s.owner, { holdId: hold.id, decision: "RELEASED", reason: "   " })).rejects.toMatchObject({ feedback: "tip-hold-reason" });
      await expect(s.t.db.insert(tipHoldDecisions).values({ id: randomUUID(), holdId: hold.id, organisationId: hold.organisationId, outletId: hold.outletId, decision: "KEPT_HELD", decidedBy: s.owner.userId, reason: " " })).rejects.toBeTruthy();
      await decideTipHold(s.t.db, paypal, s.owner, { holdId: hold.id, decision: "KEPT_HELD", reason: "Checking the large tip with the shift lead first." });
      const { record } = await decideTipHold(s.t.db, paypal, s.owner, { holdId: hold.id, decision: "RELEASED", reason: "Confirmed with the till receipt." });
      await expect(decideTipHold(s.t.db, paypal, s.owner, { holdId: hold.id, decision: "KEPT_HELD", reason: "again" })).rejects.toMatchObject({ feedback: "tip-hold-resolved" });
      // Each decision request is recorded with who, role, session type, time and outcome, refusals included.
      const requested = await s.t.db.select().from(auditEvents).where(eq(auditEvents.action, "TIP_HOLD_DECISION_REQUESTED")).orderBy(asc(auditEvents.createdAt));
      const owner = { actorUserId: s.owner.userId, actorRole: "OWNER", sessionType: "SIGNED_IN" };
      expect(requested.map(row => row.metadata)).toEqual([
        expect.objectContaining({ actorUserId: s.manager.userId, actorRole: "MANAGER", sessionType: "SIGNED_IN", outcome: "REFUSED:access-denied" }),
        expect.objectContaining({ ...owner, outcome: "REFUSED:tip-hold-reason" }),
        expect.objectContaining({ ...owner, outcome: "KEPT_HELD" }),
        expect.objectContaining({ ...owner, outcome: "RELEASED" }),
        expect.objectContaining({ ...owner, outcome: "REFUSED:tip-hold-resolved" }),
      ]);
      expect(requested.every(row => row.entityId === hold.id && row.createdAt instanceof Date)).toBe(true);
      expect((await s.t.db.select().from(auditEvents).where(eq(auditEvents.action, "TIP_HOLD_RELEASED")))[0].metadata).toMatchObject({ ...owner, outcome: "RELEASED" });
      // Append-only: holds and decisions can't be edited or deleted.
      await expect(s.t.db.update(tipHolds).set({ summary: "edited" })).rejects.toBeTruthy();
      await expect(s.t.db.update(tipHoldDecisions).set({ reason: "edited" }).where(eq(tipHoldDecisions.id, record.id))).rejects.toBeTruthy();
      await expect(s.t.db.delete(tipHoldDecisions)).rejects.toBeTruthy();
      await expect(s.t.db.delete(tipHolds)).rejects.toBeTruthy();
      expect(await s.t.db.select().from(tipHoldDecisions)).toHaveLength(2);
      // The released line goes through the gates on the Owner's authority, as calculated.
      expect(await settleReleasedLineHold(s.t.db, paypal, s.owner, hold)).toBe("DRY_RUN_ELIGIBLE");
      // The staff statement shows the hold history, with plain reasons and the Owner's words.
      const statement = await readStatement(s.t.db, (await createStatementLink(s.t.db, s.owner, s.staff.id, new Date(), DEV)).path.split("#")[1]);
      expect(statement?.holds).toEqual([expect.objectContaining({ reason: "Your share was above the daily automatic release limit", decisions: [
        expect.objectContaining({ outcome: "Kept on hold by the owner", reason: "Checking the large tip with the shift lead first." }),
        expect.objectContaining({ outcome: "Released by the owner", reason: "Confirmed with the till receipt." }),
      ] })]);
      expect(JSON.stringify(statement)).not.toMatch(/AUTO_RELEASE_CAP_EXCEEDED|DRY_RUN|BLOCKED/);
    } finally { await s.t.close(); }
  });

  it("records a model HOLD permanently; an Owner release settles on the Owner's authority without asking the model again", async () => {
    const s = await releasedScenario();
    try {
      const model = fakeTipModel(allocationId => ({ action: HOLD_TIP_ACTION, allocationId, reasonCode: "TIP_OUTLIER", summary: "Row R-1 tip is large against its bill." }));
      const { agent, paypal } = agentFor(s.t.db, model);
      expect(await agent.process({ eventId: s.result.eventIds[0] }, s.credential)).toMatchObject({ status: "DECIDED_HOLD" });
      const [hold] = await s.t.db.select().from(tipHolds);
      expect(hold).toMatchObject({ source: "MODEL", reasonCode: "TIP_OUTLIER", summary: "Row R-1 tip is large against its bill.", lineId: null, tipAgentEventId: s.result.eventIds[0] });
      await decideTipHold(s.t.db, paypal, s.owner, { holdId: hold.id, decision: "RELEASED", reason: "Regular customer; tip confirmed." });
      expect(await agent.process({ eventId: s.result.eventIds[0] }, s.credential)).toMatchObject({ status: "SETTLED", outcomeCode: "DRY_RUN_ELIGIBLE:1" });
      expect(model.assess).toHaveBeenCalledTimes(1);
      expect((await s.t.db.select().from(tipAgentEvents))[0]).toMatchObject({ releasedBy: s.owner.userId, decision: "HOLD" });
    } finally { await s.t.close(); }
  });

  it("with dry run off, reserves exactly one frozen-USD payout per line on the Owner's standing authority, and never calls it paid", async () => {
    const s = await releasedScenario({ dryRun: false });
    try {
      const { agent, paypal } = agentFor(s.t.db);
      expect(await agent.process({ eventId: s.result.eventIds[0] }, s.credential)).toMatchObject({ status: "SETTLED", outcomeCode: "PAYOUT_RESERVED:1" });
      expect(await agent.process({ eventId: s.result.eventIds[0] }, s.credential, { manual: true })).toMatchObject({ status: "SETTLED", outcomeCode: "PAYOUT_EXISTS:1" });
      const payouts = await s.t.db.select().from(workPayouts);
      expect(payouts).toHaveLength(1);
      // R120.00 at the test rate 18.54 is $6.47 (rounded down), frozen with the ECB source.
      expect(payouts[0]).toMatchObject({ payableId: null, amountMinor: 12_000, currencyCode: "ZAR", providerCurrency: "USD", providerAmountMinor: 647, fxRateMicros: 18_540_000, status: "PROCESSING", paidAt: null, requestedBy: s.owner.userId });
      expect(payouts[0].senderBatchId).toMatch(/^FSTP-B-/);
      expect(paypal.createPayout).toHaveBeenCalledTimes(1);
      const [reserved] = await s.t.db.select().from(auditEvents).where(and(eq(auditEvents.action, "PAYOUT_RESERVED"), eq(auditEvents.entityId, payouts[0].id)));
      expect(reserved.metadata).toMatchObject({ approverOfRecord: s.owner.userId, approverDecision: "FS-TIP-AGENT-DEC-001", approverBasis: expect.stringMatching(/Standing tip policy DIRECT .*Pay Agent decision .*resp_tip_test/) });
      const statement = await readStatement(s.t.db, (await createStatementLink(s.t.db, s.owner, s.staff.id, new Date(), DEV)).path.split("#")[1]);
      expect(statement?.credits[0].status).toBe("released");
    } finally { await s.t.close(); }
  });
});

describe("staff statement links", () => {
  it("are hashed, bound, time-limited, reveal nothing when invalid, and allow one destination action", async () => {
    const t = await createTestDatabase();
    try {
      const { owner } = await tenant(t.db);
      const staff = await staffMember(t.db, owner, "Sizwe");
      const now = new Date();
      const link = await createStatementLink(t.db, owner, staff.id, now, DEV);
      const token = link.path.split("#")[1];
      expect(link.path).toMatch(/^\/staff\/statement#[A-Za-z0-9_-]{43}$/);
      const [stored] = await t.db.select().from(staffStatementLinks);
      expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(stored.tokenHash).not.toContain(token);
      expect(await readStatement(t.db, token, now)).toMatchObject({ firstName: "Sizwe", destination: { masked: "s•••@example.test", confirmed: false, changeAvailable: true } });
      // Invalid, unknown, malformed and expired links all look the same.
      expect(await readStatement(t.db, "x".repeat(43), now)).toBeNull();
      expect(await readStatement(t.db, "not a token", now)).toBeNull();
      expect(await readStatement(t.db, token, new Date(now.getTime() + STATEMENT_LINK_TTL_MS + 1))).toBeNull();
      // One destination action per link; a replay is refused.
      await updateStatementDestination(t.db, token, { action: "CONFIRM" }, now);
      await expect(updateStatementDestination(t.db, token, { action: "CHANGE", email: "attacker@example.test" }, now)).rejects.toMatchObject({ feedback: "statement-link-used" });
      expect((await t.db.select().from(workers).where(eq(workers.id, staff.id)))[0].paypalPayoutEmail).toBe("sizwe.sandbox@example.test");
      // Bound to its staff member: another business's Owner can't mint a link for them.
      const other = await tenant(t.db, { sandbox: false });
      await expect(createStatementLink(t.db, { ...other.owner }, staff.id, now, DEV)).rejects.toThrow(/Access denied/);
      await expect(createStatementLink(t.db, s(owner, "MANAGER"), staff.id, now, DEV)).rejects.toThrow(/Access denied/);
    } finally { await t.close(); }
  });

  it("can't be opened through the development path in a production build, whatever the flag says", async () => {
    expect(devStatementLinksEnabled({ NODE_ENV: "production", FAIRSHIFT_DEV_STATEMENT_LINKS: "enabled" })).toBe(false);
    expect(devStatementLinksEnabled({ NODE_ENV: "development" })).toBe(false);
    expect(devStatementLinksEnabled(DEV)).toBe(true);
    const t = await createTestDatabase();
    try {
      const { owner } = await tenant(t.db);
      const staff = await staffMember(t.db, owner, "Prod");
      await expect(createStatementLink(t.db, owner, staff.id, new Date(), { NODE_ENV: "production", FAIRSHIFT_DEV_STATEMENT_LINKS: "enabled" })).rejects.toMatchObject({ feedback: "statement-delivery-unavailable" });
      expect(await t.db.select().from(staffStatementLinks)).toHaveLength(0);
    } finally { await t.close(); }
  });

  it("holds a payout to a destination changed in the last 24 hours until the Owner releases it", async () => {
    const s = await releasedScenario({ confirm: false });
    try {
      const link = await createStatementLink(s.t.db, s.owner, s.staff.id, new Date(), DEV);
      await updateStatementDestination(s.t.db, link.path.split("#")[1], { action: "CHANGE", email: "lindiwe.new@example.test" });
      expect((await s.t.db.select().from(staffDestinationEvents).where(eq(staffDestinationEvents.workerId, s.staff.id))).map(row => row.kind).sort()).toEqual(["CHANGED", "RECORDED"]);
      const { agent, paypal } = agentFor(s.t.db);
      expect(await agent.process({ eventId: s.result.eventIds[0] }, s.credential)).toMatchObject({ outcomeCode: "HELD:1" });
      const [hold] = await s.t.db.select().from(tipHolds);
      expect(hold).toMatchObject({ source: "DETERMINISTIC", reasonCode: "DESTINATION_RECENTLY_CHANGED" });
      await decideTipHold(s.t.db, paypal, s.owner, { holdId: hold.id, decision: "RELEASED", reason: "Staff member confirmed the new account in person." });
      expect(await settleReleasedLineHold(s.t.db, paypal, s.owner, hold)).toBe("DRY_RUN_ELIGIBLE");
    } finally { await s.t.close(); }
  });
});

function s(scope: Scope, role: Scope["role"]): Scope { return { ...scope, role }; }
void loadTipAllocation; void tipModelView;
