import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { entitled } from "../helpers/onboarding";
import { configureFixture, hours, ingestTimedBills } from "../helpers/workload";
import { AccessError, type Scope } from "@/server/auth/access";
import { requireScope } from "@/server/auth/request";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { auditEvents, demandContextDecisions, demandContextProposals, demandContextSignals, memberships, organisations, outlets, saleTransactions, shiftOpportunityEvidence, shifts, subscriptions, users, workloadPolicies } from "@/server/db/schema";
import { AiProviderError, type AssessmentRequest, type StaffingAssessmentProvider } from "@/server/integrations/openai/staffing-assessment";
import { prepareAssessmentInput } from "@/server/intelligence/ai-staffing-contract";
import { addManagerSignal, decideDemandContext, proposeDemandContext, withdrawManagerSignal } from "@/server/intelligence/demand-context-service";
import { dayOpportunities, outletOpportunities, windowParam } from "@/server/intelligence/opportunity";
import { createShiftFromOpportunity, getShiftOpportunityEvidence } from "@/server/intelligence/opportunity-shifts";
import { getWeeklyStaffing } from "@/server/intelligence/staffing";
import { provisionReferenceHistory } from "@/server/reference/provision";
import { REFERENCE_STORE_CODES } from "@/server/reference/uk-hospitality";
import { createDepartment, createWorkPolicy } from "@/server/scheduling/operations";
import { addManagerSignalAction, decideDemandContextAction, proposeDemandContextAction } from "@/app/demand-context-actions";
import { ManagerWorkspace } from "@/app/manager/workspace";
import { OwnerWorkspace } from "@/app/owner/workspace";

vi.mock("@/server/auth/request", () => ({ requireScope: vi.fn() }));
vi.mock("@/server/db/client", () => ({ getDatabase: vi.fn() }));
vi.mock("@/server/config/env", async original => ({ ...(await original<typeof import("@/server/config/env")>()), getConfigurationStatus: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); }, notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// Sunday 25 Oct 2026, London. Next week is Mon 26 Oct – Sun 1 Nov. Test-fixture business, not reference policy.
const NOW = new Date("2026-10-25T10:00:00Z");
const FRIDAY = "2026-10-30", SATURDAY = "2026-10-31";
beforeEach(() => { vi.useFakeTimers({ now: NOW, toFake: ["Date"] }); vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.resetAllMocks(); });

type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];
const FIXTURE_POLICY = { transactionsPerStaffHour: 4, minimumStaffWhileOpen: 1 };
async function business(db: Db, name = "Fixture hospitality", locations = 2) {
  const organisationId = randomUUID();
  await db.insert(organisations).values({ id: organisationId, name, country: "United Kingdom" });
  await db.insert(subscriptions).values({ id: randomUUID(), organisationId, requestId: randomUUID() });
  await entitled(db, organisationId);
  const rows = Array.from({ length: locations }, (_, i) => ({ id: randomUUID(), organisationId, name: `${name} ${i + 1}`, timezone: "Europe/London", province: "England", country: "United Kingdom" }));
  await db.insert(outlets).values(rows);
  const userId = randomUUID();
  await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: "Person", passwordHash: "x", emailVerifiedAt: NOW });
  await db.insert(memberships).values({ id: randomUUID(), userId, organisationId, role: "OWNER" });
  const scope = (locationId = rows[0].id, role: Scope["role"] = "MANAGER"): Scope => ({ userId, organisationId, locationId, role, organisationName: name, locationName: rows.find(row => row.id === locationId)?.name ?? "" });
  for (const row of rows) {
    await ingestTimedBills(db, { organisationId, outletId: row.id, through: "2026-10-18", bills: () => 12, at: "13:10:00Z", now: NOW, billMinor: 2_500, sourceSystem: `till-${row.id}` });
    await configureFixture(db, { organisationId, outletId: row.id, policy: row === rows[0] ? FIXTURE_POLICY : null, trading: [{ start: 12 * 60, end: 20 * 60 }], coverage: [hours(12, 20, 1)] });
  }
  return { organisationId, rows, scope };
}
// A model answering from its request, as supplied. Each is a fixture, never genuine provider evidence.
function provider(answer: (request: AssessmentRequest, ids: string[]) => unknown): StaffingAssessmentProvider & { assess: ReturnType<typeof vi.fn> } {
  return { provider: "OPENAI", model: "fixture-model", assess: vi.fn(async (request: AssessmentRequest) => {
    const ids = (JSON.parse(request.input) as { signals: { id: string; type: string }[] }).signals.filter(row => row.type === "MANAGER_ENTERED").map(row => row.id);
    return { responseId: "resp_fixture", responseModel: "fixture-model", text: JSON.stringify(answer(request, ids)) };
  }) } as never;
}
const moderateUp = () => provider((_, ids) => ({ scenario: "MODERATE_UP", citedSignalIds: ids, reason: "The market outside is likely to bring extra footfall." }));
const note = (date = FRIDAY) => ({ validFrom: date, validTo: date, summary: "Street market outside until late afternoon", direction: "UP" });
const dayOf = async (db: Db, scope: Scope, date = FRIDAY) => {
  const outlet = (await getWeeklyStaffing(db, scope, NOW)).outlets.find(row => row.outletId === scope.locationId)!;
  return { outlet, day: outlet.days.find(row => row.planningDate === date)!, context: outlet.demandContext!.days.find(row => row.date === date)! };
};
async function accepted(db: Db, scope: Scope, date = FRIDAY) {
  await addManagerSignal(db, scope, note(date), NOW);
  const { record } = await proposeDemandContext(db, scope, date, moderateUp(), NOW);
  await decideDemandContext(db, scope, { proposalId: record.id, action: "ACCEPTED" }, NOW);
  return record;
}
const pages = (db: Db, scope: Scope, aiConfigured = true) => {
  vi.mocked(getDatabase).mockReturnValue(db);
  vi.mocked(getConfigurationStatus).mockReturnValue({ databaseConfigured: true, aiConfigured } as ReturnType<typeof getConfigurationStatus>);
  vi.mocked(requireScope).mockResolvedValue(scope);
};
const form = (values: Record<string, string>) => { const data = new FormData(); for (const [key, value] of Object.entries(values)) data.set(key, value); return data; };

describe("signal isolation", () => {
  it("keeps a Manager's signal to their own organisation, location and dates", async () => {
    const t = await createTestDatabase();
    try {
      const a = await business(t.db, "A"), b = await business(t.db, "B");
      await addManagerSignal(t.db, a.scope(), note(), NOW);
      const signalsAt = async (scope: Scope, date = FRIDAY) => (await dayOf(t.db, scope, date)).context.signals.filter(row => row.type === "MANAGER_ENTERED").length;
      expect(await signalsAt(a.scope())).toBe(1);
      expect(await signalsAt(a.scope(), SATURDAY)).toBe(0);
      expect(await signalsAt(a.scope(a.rows[1].id))).toBe(0);
      expect(await signalsAt(b.scope())).toBe(0);
    } finally { await t.close(); }
  }, 120_000);

  it("refuses at the database a signal naming a location of another organisation", async () => {
    const t = await createTestDatabase();
    try {
      const a = await business(t.db, "A", 1), b = await business(t.db, "B", 1);
      await expect(t.db.insert(demandContextSignals).values({ id: `ctx_${"c".repeat(24)}`, organisationId: a.organisationId, outletId: b.rows[0].id, signalType: "MANAGER_ENTERED", validFrom: FRIDAY, validTo: FRIDAY, direction: "UP", provenance: "MANAGER_ENTERED", sourceLabel: "x", summary: "x", enteredBy: a.scope().userId })).rejects.toThrow();
      // A Manager's note can't claim any other provenance.
      await expect(t.db.insert(demandContextSignals).values({ id: `ctx_${"d".repeat(24)}`, organisationId: a.organisationId, outletId: a.rows[0].id, signalType: "MANAGER_ENTERED", validFrom: FRIDAY, validTo: FRIDAY, direction: "UP", provenance: "OFFICIAL_SNAPSHOT", sourceLabel: "x", summary: "x", enteredBy: a.scope().userId })).rejects.toThrow();
    } finally { await t.close(); }
  }, 120_000);

  it("won't let a Manager withdraw another location's or organisation's signal, and refuses bad input", async () => {
    const t = await createTestDatabase();
    try {
      const a = await business(t.db, "A"), b = await business(t.db, "B", 1);
      const signal = await addManagerSignal(t.db, a.scope(), note(), NOW);
      await expect(withdrawManagerSignal(t.db, a.scope(a.rows[1].id), signal.id, NOW)).rejects.toThrow("no longer available");
      await expect(withdrawManagerSignal(t.db, b.scope(), signal.id, NOW)).rejects.toThrow("no longer available");
      for (const bad of [{ ...note(), summary: "" }, { ...note(), direction: "HUGE" }, { ...note(), outletId: b.rows[0].id }, { ...note(), validTo: "2026-10-01" }, { ...note(), validFrom: "2026-10-01", validTo: "2026-10-02" }, { validFrom: FRIDAY, validTo: "2026-12-30", summary: "Too long a stretch", direction: "UP" }]) await expect(addManagerSignal(t.db, a.scope(), bad, NOW)).rejects.toThrow();
      expect(await t.db.select().from(demandContextSignals)).toHaveLength(1);
      // The record keeps what it said: it can only be withdrawn.
      await expect(t.db.update(demandContextSignals).set({ summary: "Edited" }).where(eq(demandContextSignals.id, signal.id))).rejects.toThrow();
      await expect(t.db.delete(demandContextSignals).where(eq(demandContextSignals.id, signal.id))).rejects.toThrow();
    } finally { await t.close(); }
  }, 120_000);

  it("rejects a model citing another location's signal", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db);
      const other = await addManagerSignal(t.db, c.scope(c.rows[1].id), note(), NOW);
      await addManagerSignal(t.db, c.scope(), note(), NOW);
      const { record } = await proposeDemandContext(t.db, c.scope(), FRIDAY, provider(() => ({ scenario: "MODERATE_UP", citedSignalIds: [other.id], reason: "Busy nearby." })), NOW);
      expect(record).toMatchObject({ status: "FAILED", failureCode: "VALIDATION_UNKNOWN_SIGNAL", scenario: null });
    } finally { await t.close(); }
  }, 120_000);

  it("states when the nation isn't known, and doesn't guess bank holidays", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db, "N", 1);
      expect((await dayOf(t.db, c.scope())).context.holidayStatus).toBe("NO_HOLIDAY_ON_DATE");
      await t.db.update(outlets).set({ province: "West Yorkshire" }).where(eq(outlets.id, c.rows[0].id));
      expect((await dayOf(t.db, c.scope())).context.holidayStatus).toBe("NATION_NOT_STATED");
    } finally { await t.close(); }
  }, 120_000);
});

describe("human control", () => {
  it("changes nothing on a proposal, nothing on a dismissal, and the forecast only on acceptance", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db), scope = c.scope();
      const before = (await dayOf(t.db, scope)).day;
      expect(before.expectedMilliTransactions).toBe(12_000);
      expect(before.requiredMinutes).toBe(180 + 7 * 60);
      expect(before.context).toBeUndefined();

      await addManagerSignal(t.db, scope, note(), NOW);
      expect((await dayOf(t.db, scope)).day).toEqual(before);
      const { record } = await proposeDemandContext(t.db, scope, FRIDAY, moderateUp(), NOW);
      expect(record).toMatchObject({ status: "AVAILABLE", scenario: "MODERATE_UP", responseModel: "fixture-model" });
      let view = await dayOf(t.db, scope);
      expect(view.day).toEqual(before);
      expect(view.context.state).toBe("PROPOSED");
      expect(view.context.preview).toMatchObject({ expectedMilliTransactions: 13_200, requiredMinutes: 210 + 7 * 60 });
      expect(view.context.proposal).toMatchObject({ adjustmentBps: 1000 });
      expect(await t.db.select().from(demandContextDecisions)).toEqual([]);

      await decideDemandContext(t.db, scope, { proposalId: record.id, action: "DISMISSED" }, NOW);
      view = await dayOf(t.db, scope);
      expect(view.day).toEqual(before);
      expect(view.context.state).toBe("DISMISSED");

      await decideDemandContext(t.db, scope, { proposalId: record.id, action: "WITHDRAWN" }, NOW);
      await decideDemandContext(t.db, scope, { proposalId: record.id, action: "ACCEPTED" }, NOW);
      view = await dayOf(t.db, scope);
      expect(view.context.state).toBe("ACCEPTED");
      expect(view.day.expectedMilliTransactions).toBe(13_200);
      expect(view.day.requiredMinutes).toBe(210 + 7 * 60);
      expect(view.day.casualGapMinutes).toBe(150);
      expect(view.day.context).toMatchObject({ scenario: "MODERATE_UP", adjustmentBps: 1000, policyVersion: "fs-demand-context-policy-v1" });
      expect(view.day.context!.baseline).toMatchObject({ expectedMilliTransactions: 12_000, casualGapMinutes: 120 });
      expect(view.outlet.baselineTotals!.casualGapMinutes).toBe(view.outlet.totals!.casualGapMinutes - 30);
      // Another day is untouched.
      expect((await dayOf(t.db, scope, SATURDAY)).day.context).toBeUndefined();

      const decisions = await t.db.select().from(demandContextDecisions).orderBy(demandContextDecisions.sequence);
      expect(decisions.map(row => row.action)).toEqual(["DISMISSED", "WITHDRAWN", "ACCEPTED"]);
      expect(decisions[2]).toMatchObject({ decidedBy: scope.userId, decidedByRole: "MANAGER", scenario: "MODERATE_UP", adjustmentBps: 1000, policyVersion: "fs-demand-context-policy-v1", inputFingerprint: record.inputFingerprint, signalIds: record.citedSignalIds });
      expect(decisions[2].outputFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect((await t.db.select().from(auditEvents).where(eq(auditEvents.action, "DEMAND_CONTEXT_ACCEPTED")))).toHaveLength(1);

      // Pressing the button again records nothing further.
      await decideDemandContext(t.db, scope, { proposalId: record.id, action: "ACCEPTED" }, NOW);
      expect(await t.db.select().from(demandContextDecisions)).toHaveLength(3);
      // Withdrawing returns the day to exactly its baseline.
      await decideDemandContext(t.db, scope, { proposalId: record.id, action: "WITHDRAWN" }, NOW);
      expect((await dayOf(t.db, scope)).day).toEqual(before);
    } finally { await t.close(); }
  }, 180_000);

  it("won't let a later model call replace a decision, or put the same evidence to the model twice", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db), scope = c.scope();
      const first = await accepted(t.db, scope);
      const other = provider((_, ids) => ({ scenario: "MINOR_DOWN", citedSignalIds: ids, reason: "Different answer." }));
      const again = await proposeDemandContext(t.db, scope, FRIDAY, other, NOW);
      expect(again).toMatchObject({ generated: false, record: { id: first.id, scenario: "MODERATE_UP" } });
      expect(other.assess).not.toHaveBeenCalled();
      expect((await dayOf(t.db, scope)).day.context?.scenario).toBe("MODERATE_UP");
    } finally { await t.close(); }
  }, 120_000);

  it("stops applying an acceptance when its evidence changes, says so, and requires a fresh one", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db), scope = c.scope();
      const first = await accepted(t.db, scope);
      expect((await dayOf(t.db, scope)).day.expectedMilliTransactions).toBe(13_200);
      // Another Manager note on that day changes the evidence the scenario weighed.
      const second = await addManagerSignal(t.db, scope, { ...note(), summary: "Road closed outside all day", direction: "DOWN" }, NOW);
      let view = await dayOf(t.db, scope);
      expect(view.context.state).toBe("STALE_ACCEPTANCE");
      expect(view.context.staleDecision).toMatchObject({ scenario: "MODERATE_UP" });
      expect(view.day.expectedMilliTransactions).toBe(12_000);
      expect(view.day.context).toBeUndefined();
      // The old proposal can't be accepted against the new evidence.
      await expect(decideDemandContext(t.db, scope, { proposalId: first.id, action: "ACCEPTED" }, NOW)).rejects.toThrow("evidence has changed");
      const fresh = await proposeDemandContext(t.db, scope, FRIDAY, provider((_, ids) => ({ scenario: "NONE", citedSignalIds: ids, reason: "These notes pull in opposite directions." })), NOW);
      expect(fresh.record.id).not.toBe(first.id);
      await decideDemandContext(t.db, scope, { proposalId: fresh.record.id, action: "ACCEPTED" }, NOW);
      view = await dayOf(t.db, scope);
      expect(view.context.state).toBe("ACCEPTED");
      expect(view.day.expectedMilliTransactions).toBe(12_000);
      // Withdrawing the note makes that acceptance stale in turn.
      await withdrawManagerSignal(t.db, scope, second.id, NOW);
      expect((await dayOf(t.db, scope)).context.state).toBe("STALE_ACCEPTANCE");
    } finally { await t.close(); }
  }, 180_000);

  it("stops applying an acceptance when the history behind the baseline changes", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db, "H", 1), scope = c.scope();
      await accepted(t.db, scope);
      await ingestTimedBills(t.db, { organisationId: c.organisationId, outletId: c.rows[0].id, through: "2026-10-18", bills: () => 4, at: "13:30:00Z", now: NOW, billMinor: 2_500, sourceSystem: "till-extra" });
      const view = await dayOf(t.db, scope);
      expect(view.context.state).toBe("STALE_ACCEPTANCE");
      expect(view.day.context).toBeUndefined();
    } finally { await t.close(); }
  }, 120_000);

  it("has immutable proposals and decisions, which must match each other", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db, "I", 1), scope = c.scope();
      const proposal = await accepted(t.db, scope);
      await expect(t.db.update(demandContextProposals).set({ scenario: "MODERATE_DOWN" }).where(eq(demandContextProposals.id, proposal.id))).rejects.toThrow();
      await expect(t.db.update(demandContextDecisions).set({ adjustmentBps: 1000, scenario: "MODERATE_UP", action: "DISMISSED" })).rejects.toThrow();
      await expect(t.db.delete(demandContextDecisions)).rejects.toThrow();
      const forge = { id: randomUUID(), organisationId: c.organisationId, outletId: c.rows[0].id, targetDate: FRIDAY, sequence: 9, proposalId: proposal.id, action: "ACCEPTED", policyVersion: proposal.policyVersion, inputFingerprint: proposal.inputFingerprint, outputFingerprint: "x", signalIds: [], decidedBy: scope.userId, decidedByRole: "MANAGER" };
      // A scenario other than the one proposed, and a number outside the policy.
      await expect(t.db.insert(demandContextDecisions).values({ ...forge, scenario: "MINOR_UP", adjustmentBps: 500 })).rejects.toThrow();
      await expect(t.db.insert(demandContextDecisions).values({ ...forge, scenario: "MODERATE_UP", adjustmentBps: 2500 })).rejects.toThrow();
    } finally { await t.close(); }
  }, 120_000);
});

describe("AI failure falls back to the baseline", () => {
  const failures: [string, StaffingAssessmentProvider][] = [
    ["TIMEOUT", { provider: "OPENAI", model: "m", assess: async () => { throw new AiProviderError("TIMEOUT"); } }],
    ["HTTP_503", { provider: "OPENAI", model: "m", assess: async () => { throw new AiProviderError("HTTP_503"); } }],
    ["PROVIDER_ERROR", { provider: "OPENAI", model: "m", assess: async () => { throw new Error("boom"); } }],
    ["VALIDATION_MALFORMED", { provider: "OPENAI", model: "m", assess: async () => ({ responseId: null, responseModel: "m", text: "{not json" }) }],
    ["VALIDATION_UNEXPECTED_FIELD", provider((_, ids) => ({ scenario: "MODERATE_UP", citedSignalIds: ids, reason: "Busy.", adjustmentPercent: 40 }))],
    ["VALIDATION_UNKNOWN_SCENARIO", provider((_, ids) => ({ scenario: "MAJOR_UP", citedSignalIds: ids, reason: "Busy." }))],
    ["VALIDATION_NO_CITATION", provider(() => ({ scenario: "MODERATE_UP", citedSignalIds: [], reason: "Busy." }))],
    ["VALIDATION_UNKNOWN_SIGNAL", provider(() => ({ scenario: "MODERATE_UP", citedSignalIds: [`ctx_${"f".repeat(24)}`], reason: "Busy." }))],
  ];
  it("records each failure, shows no scenario, and leaves planning and Fill Shifts working", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db, "F", 1), scope = c.scope();
      await addManagerSignal(t.db, scope, note(), NOW);
      const before = await dayOf(t.db, scope);
      for (const [code, failing] of failures) {
        const { record } = await proposeDemandContext(t.db, scope, FRIDAY, failing, NOW);
        expect(record).toMatchObject({ status: "FAILED", failureCode: code, scenario: null, reason: null });
        const after = await dayOf(t.db, scope);
        expect(after.day).toEqual(before.day);
        expect(after.outlet.totals).toEqual(before.outlet.totals);
        expect(after.context.state).toBe("FAILED");
        expect(after.context.proposal).toBeNull();
      }
      // The failure can't be decided on.
      const [failed] = await t.db.select().from(demandContextProposals);
      await expect(decideDemandContext(t.db, scope, { proposalId: failed.id, action: "ACCEPTED" }, NOW)).rejects.toThrow("no longer available");
      // A later good answer is still possible.
      expect((await proposeDemandContext(t.db, scope, FRIDAY, moderateUp(), NOW)).record.status).toBe("AVAILABLE");
      const [department] = await createDepartment(t.db, "Front", scope);
      const [policy] = await createWorkPolicy(t.db, { earningsModel: "DAILY", rateMinor: 9_600 }, "Casual", scope);
      const opportunity = dayOpportunities(before.outlet, before.day)[0];
      await expect(createShiftFromOpportunity(t.db, { departmentId: department.id, policyId: policy.id, startsAt: new Date(opportunity.startsAt), endsAt: new Date(opportunity.endsAt), requiredHeadcount: 2, date: FRIDAY, window: windowParam(opportunity) }, scope, NOW)).resolves.toBeTruthy();
    } finally { await t.close(); }
  }, 240_000);

  it("carries on from the baseline if the contextual layer itself can't be read", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db, "U", 1), scope = c.scope();
      const before = await dayOf(t.db, scope);
      await t.db.execute(sql`drop table demand_context_decisions cascade`);
      const staffing = await getWeeklyStaffing(t.db, scope, NOW);
      expect(staffing.outlets[0].demandContext?.status).toBe("UNAVAILABLE");
      expect(staffing.outlets[0].days.find(day => day.planningDate === FRIDAY)).toEqual(before.day);
      expect(staffing.outlets[0].totals).toEqual(before.outlet.totals);
      pages(t.db, scope);
      const plan = renderToStaticMarkup(await ManagerWorkspace({ area: "plan" }));
      expect(plan).toContain("Contextual demand can’t be loaded right now");
      expect(plan).toContain("Where casual cover is needed");
    } finally { await t.close(); }
  }, 120_000);

  it("doesn't fake an answer when AI isn't configured, and says so", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db, "N", 1), scope = c.scope();
      await addManagerSignal(t.db, scope, note(), NOW);
      pages(t.db, scope, false);
      await expect(proposeDemandContextAction(form({ date: FRIDAY }))).rejects.toThrow(`REDIRECT:/manager/plan?date=${FRIDAY}&context=not-configured#demand-context`);
      expect(await t.db.select().from(demandContextProposals)).toEqual([]);
      const plan = renderToStaticMarkup(await ManagerWorkspace({ area: "plan", date: FRIDAY }));
      expect(plan).toContain("AI isn’t configured in this environment");
      expect(plan).not.toContain("Ask AI for a scenario");
      expect(plan).toContain("Where casual cover is needed");
    } finally { await t.close(); }
  }, 120_000);

  it("won't call a model with no signal to weigh, and never claims normal conditions", async () => {
    const t = await createTestDatabase();
    try {
      const organisationId = randomUUID();
      await t.db.insert(organisations).values({ id: organisationId, name: "T", country: "United Kingdom" });
      await t.db.insert(subscriptions).values({ id: randomUUID(), organisationId, requestId: randomUUID() });
      await entitled(t.db, organisationId);
      const outletId = randomUUID(), userId = randomUUID();
      await t.db.insert(outlets).values({ id: outletId, organisationId, name: "T", timezone: "Europe/London" });
      await t.db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: "P", passwordHash: "x", emailVerifiedAt: NOW });
      // Under three weeks in each period, so no momentum comparison exists.
      await ingestTimedBills(t.db, { organisationId, outletId, through: "2026-10-18", bills: () => 12, at: "13:10:00Z", now: NOW, days: 28, sourceSystem: "till" });
      await configureFixture(t.db, { organisationId, outletId, policy: FIXTURE_POLICY, trading: [{ start: 720, end: 1200 }], coverage: [hours(12, 20, 1)] });
      const scope: Scope = { userId, organisationId, locationId: outletId, role: "MANAGER", organisationName: "T", locationName: "T" };
      const view = await dayOf(t.db, scope);
      expect(view.context.signals).toEqual([]);
      expect(view.context.state).toBe("NO_SIGNAL");
      const model = moderateUp();
      await expect(proposeDemandContext(t.db, scope, FRIDAY, model, NOW)).rejects.toThrow("no context for that day");
      expect(model.assess).not.toHaveBeenCalled();
      pages(t.db, scope);
      const plan = renderToStaticMarkup(await ManagerWorkspace({ area: "plan", date: FRIDAY }));
      expect(plan).toContain("That means unknown, not normal");
      expect(plan).not.toMatch(/normal conditions/i);
    } finally { await t.close(); }
  }, 120_000);
});

describe("the workload firewall", () => {
  it("doesn't change sales, pay, policy or history, and adds no transactions", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db, "W", 1), scope = c.scope();
      const before = await dayOf(t.db, scope);
      const sales = await t.db.select().from(saleTransactions);
      const policies = await t.db.select().from(workloadPolicies);
      await accepted(t.db, scope);
      const after = await dayOf(t.db, scope);
      expect(await t.db.select().from(saleTransactions)).toEqual(sales);
      expect(await t.db.select().from(workloadPolicies)).toEqual(policies);
      expect(after.day.forecastSalesMinor).toBe(before.day.forecastSalesMinor);
      expect(after.day.blocks.map(block => block.expectedSalesMinor)).toEqual(before.day.blocks.map(block => block.expectedSalesMinor));
      expect(after.outlet.totals!.forecastSalesMinor).toBe(before.outlet.totals!.forecastSalesMinor);
      expect(after.outlet.policy).toEqual(before.outlet.policy);
      expect(after.day.regularMinutes).toBe(before.day.regularMinutes);
    } finally { await t.close(); }
  }, 120_000);

  it("leaves a baseline week's AI assessment input exactly as it was, and labels an accepted day", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db, "A", 1), scope = c.scope();
      const baseline = prepareAssessmentInput(await getWeeklyStaffing(t.db, scope, NOW), "LOCATION");
      await addManagerSignal(t.db, scope, note(), NOW);
      expect(prepareAssessmentInput(await getWeeklyStaffing(t.db, scope, NOW), "LOCATION").fingerprint).toBe(baseline.fingerprint);
      await accepted(t.db, scope, SATURDAY);
      const after = prepareAssessmentInput(await getWeeklyStaffing(t.db, scope, NOW), "LOCATION");
      expect(after.fingerprint).not.toBe(baseline.fingerprint);
      expect(after.input.locations[0].days.find(day => day.date === SATURDAY)?.acceptedContextScenario).toBe("MODERATE_UP");
    } finally { await t.close(); }
  }, 120_000);

  it("holds the frozen reference outputs through the real loader: 64.25 h, 32 windows, 20 of 35", async () => {
    const t = await createTestDatabase();
    const today = new Date("2026-11-02T10:00:00Z");
    try {
      const organisationId = randomUUID();
      await t.db.insert(organisations).values({ id: organisationId, name: "Reference", country: "United Kingdom" });
      const rows = REFERENCE_STORE_CODES.map((code, i) => ({ id: randomUUID(), organisationId, name: `${i + 1} ${code}`, timezone: "Europe/London" }));
      await t.db.insert(outlets).values(rows);
      await provisionReferenceHistory(t.db, { organisationId, outlets: Object.fromEntries(REFERENCE_STORE_CODES.map((code, i) => [code, rows[i].id])) as never, through: "2026-11-01" }, today);
      const owner: Scope = { userId: randomUUID(), organisationId, locationId: rows[0].id, role: "OWNER", organisationName: "Reference", locationName: rows[0].name };
      const staffing = await getWeeklyStaffing(t.db, owner, today);
      expect(staffing.consolidated!.totals.casualGapMinutes).toBe(64.25 * 60);
      expect(staffing.outlets.flatMap(outlet => outletOpportunities(outlet).filter(row => row.state === "OPEN"))).toHaveLength(32);
      expect(staffing.outlets.flatMap(outlet => outlet.days).filter(day => (day.casualGapMinutes ?? 0) > 0)).toHaveLength(20);
      expect(staffing.outlets.every(outlet => outlet.days.every(day => !day.context))).toBe(true);
    } finally { await t.close(); }
  }, 400_000);
});

describe("permissions", () => {
  it("refuses a worker every contextual operation and the planning figures", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db, "P", 1);
      const proposal = await accepted(t.db, c.scope());
      const worker = c.scope(c.rows[0].id, "TEAM_MEMBER");
      await expect(addManagerSignal(t.db, worker, note(), NOW)).rejects.toThrow(AccessError);
      await expect(withdrawManagerSignal(t.db, worker, "x", NOW)).rejects.toThrow(AccessError);
      await expect(proposeDemandContext(t.db, worker, FRIDAY, moderateUp(), NOW)).rejects.toThrow(AccessError);
      await expect(decideDemandContext(t.db, worker, { proposalId: proposal.id, action: "WITHDRAWN" }, NOW)).rejects.toThrow(AccessError);
      await expect(getWeeklyStaffing(t.db, worker, NOW)).rejects.toThrow(AccessError);
    } finally { await t.close(); }
  }, 120_000);

  it("won't let a Manager decide another location's or organisation's proposal", async () => {
    const t = await createTestDatabase();
    try {
      const a = await business(t.db, "A"), b = await business(t.db, "B", 1);
      await addManagerSignal(t.db, a.scope(), note(), NOW);
      const { record } = await proposeDemandContext(t.db, a.scope(), FRIDAY, moderateUp(), NOW);
      for (const scope of [a.scope(a.rows[1].id), b.scope()]) await expect(decideDemandContext(t.db, scope, { proposalId: record.id, action: "ACCEPTED" }, NOW)).rejects.toThrow("no longer available");
      expect(await t.db.select().from(demandContextDecisions)).toEqual([]);
      // A Manager reads only their own location's contextual week.
      expect((await getWeeklyStaffing(t.db, a.scope(a.rows[1].id), NOW)).outlets.map(row => row.outletId)).toEqual([a.rows[1].id]);
    } finally { await t.close(); }
  }, 120_000);

  it("takes the location from the session in every action, never from a form", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db), scope = c.scope();
      pages(t.db, scope);
      await expect(addManagerSignalAction(form({ date: FRIDAY, validFrom: FRIDAY, validTo: FRIDAY, summary: "Street market outside", direction: "UP", outletId: c.rows[1].id, organisationId: randomUUID() }))).rejects.toThrow("context=signal-saved");
      expect(vi.mocked(requireScope).mock.calls[0][0]).toEqual(["OWNER", "MANAGER"]);
      const [row] = await t.db.select().from(demandContextSignals);
      expect(row).toMatchObject({ outletId: c.rows[0].id, organisationId: c.organisationId, provenance: "MANAGER_ENTERED", enteredBy: scope.userId });
    } finally { await t.close(); }
  }, 120_000);

  it("takes the decision's scenario from the stored proposal, whatever the form says", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db, "D", 1), scope = c.scope();
      await addManagerSignal(t.db, scope, note(), NOW);
      const { record } = await proposeDemandContext(t.db, scope, FRIDAY, moderateUp(), NOW);
      pages(t.db, scope);
      await expect(decideDemandContextAction(form({ date: FRIDAY, proposalId: record.id, decision: "ACCEPTED", scenario: "MODERATE_DOWN", adjustmentBps: "9000" }))).rejects.toThrow("context=accepted");
      expect((await dayOf(t.db, scope)).day.context).toMatchObject({ scenario: "MODERATE_UP", adjustmentBps: 1000 });
      await expect(decideDemandContextAction(form({ date: FRIDAY, proposalId: "not-a-uuid", decision: "ACCEPTED" }))).rejects.toThrow("context=context-not-found");
    } finally { await t.close(); }
  }, 120_000);
});

describe("forecast into Fill Shifts", () => {
  it("carries the accepted recalculation, freezes it with the shift, and never touches pay", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db, "S", 1), scope = c.scope();
      const proposal = await accepted(t.db, scope);
      const { outlet, day } = await dayOf(t.db, scope);
      const opportunity = dayOpportunities(outlet, day).find(row => row.state === "OPEN")!;
      expect(opportunity).toMatchObject({ remainingCasualMinutes: 150, peakCasualStaff: 3, acceptedContext: { scenario: "MODERATE_UP", adjustmentBps: 1000, proposalId: proposal.id } });
      expect(opportunity.commercial?.expectedSalesMinor).toBe(day.context!.baseline.periods.find(row => row.state === "OPEN")!.expectedSalesMinor);

      pages(t.db, scope);
      const fill = renderToStaticMarkup(await ManagerWorkspace({ area: "fill", date: FRIDAY, window: windowParam(opportunity) }));
      expect(fill).toContain("Includes the accepted scenario Moderate increase (+10%)");
      expect(fill).toContain("2.5 h");

      const [department] = await createDepartment(t.db, "Front", scope);
      const [policy] = await createWorkPolicy(t.db, { earningsModel: "DAILY", rateMinor: 9_600, incentiveTargetMinor: 20_000, incentiveBonusMinor: 2_500 }, "Casual", scope);
      const shift = await createShiftFromOpportunity(t.db, { departmentId: department.id, policyId: policy.id, startsAt: new Date(opportunity.startsAt), endsAt: new Date(opportunity.endsAt), requiredHeadcount: 3, date: FRIDAY, window: windowParam(opportunity) }, scope, NOW);
      const [frozen] = await t.db.select().from(shiftOpportunityEvidence).where(eq(shiftOpportunityEvidence.shiftId, shift.id));
      expect(frozen.evidence).toMatchObject({ remainingCasualMinutes: 150, acceptedContext: { scenario: "MODERATE_UP", adjustmentBps: 1000 } });
      const [row] = await t.db.select().from(shifts).where(eq(shifts.id, shift.id));
      expect(row).toMatchObject({ guaranteedBasePayMinor: 9_600, incentiveAmountMinor: 2_500, incentiveTargetMinor: 20_000 });
      const reasons = await getShiftOpportunityEvidence(t.db, scope, [shift.id]);
      expect(reasons.get(shift.id)?.acceptedContext?.scenario).toBe("MODERATE_UP");

      // The frozen record stands even when the decision is later withdrawn.
      await decideDemandContext(t.db, scope, { proposalId: proposal.id, action: "WITHDRAWN" }, NOW);
      expect((await getShiftOpportunityEvidence(t.db, scope, [shift.id])).get(shift.id)).toMatchObject({ remainingCasualMinutes: 150 });
    } finally { await t.close(); }
  }, 180_000);

  it("recalculates on the server: a dismissed or stale scenario, or a forged form, can't carry", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db, "G", 1), scope = c.scope();
      const proposal = await accepted(t.db, scope);
      await decideDemandContext(t.db, scope, { proposalId: proposal.id, action: "WITHDRAWN" }, NOW);
      await decideDemandContext(t.db, scope, { proposalId: proposal.id, action: "DISMISSED" }, NOW);
      const { outlet, day } = await dayOf(t.db, scope);
      const opportunity = dayOpportunities(outlet, day).find(row => row.state === "OPEN")!;
      expect(opportunity.acceptedContext).toBeUndefined();
      const [department] = await createDepartment(t.db, "Front", scope);
      const [policy] = await createWorkPolicy(t.db, { earningsModel: "DAILY", rateMinor: 9_600 }, "Casual", scope);
      const forged = { acceptedContext: { scenario: "MODERATE_UP", adjustmentBps: 1000 }, remainingCasualMinutes: 9_000 };
      const shift = await createShiftFromOpportunity(t.db, { departmentId: department.id, policyId: policy.id, startsAt: new Date(opportunity.startsAt), endsAt: new Date(opportunity.endsAt), requiredHeadcount: 2, date: FRIDAY, window: windowParam(opportunity), ...forged } as never, scope, NOW);
      const [frozen] = await t.db.select().from(shiftOpportunityEvidence).where(eq(shiftOpportunityEvidence.shiftId, shift.id));
      expect(frozen.evidence).toMatchObject({ remainingCasualMinutes: 120 });
      expect((frozen.evidence as { acceptedContext?: unknown }).acceptedContext).toBeUndefined();
    } finally { await t.close(); }
  }, 120_000);

  it("refuses a window that no longer exists once an accepted scenario has moved the figures", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db, "M", 1), scope = c.scope();
      const before = await dayOf(t.db, scope);
      const opportunity = dayOpportunities(before.outlet, before.day).find(row => row.state === "OPEN")!;
      await addManagerSignal(t.db, scope, { ...note(), direction: "DOWN" }, NOW);
      const { record } = await proposeDemandContext(t.db, scope, FRIDAY, provider((_, ids) => ({ scenario: "MODERATE_DOWN", citedSignalIds: ids, reason: "A road closure will limit footfall." })), NOW);
      await decideDemandContext(t.db, scope, { proposalId: record.id, action: "ACCEPTED" }, NOW);
      const after = await dayOf(t.db, scope);
      expect(after.day.expectedMilliTransactions).toBe(10_800);
      expect(after.day.casualGapMinutes).toBe(105);
      // Same window here, smaller requirement: the server's figure is used, not the old one.
      expect(dayOpportunities(after.outlet, after.day).find(row => row.windowStart === opportunity.windowStart)?.remainingCasualMinutes).toBe(105);
      const [department] = await createDepartment(t.db, "Front", scope);
      const [policy] = await createWorkPolicy(t.db, { earningsModel: "DAILY", rateMinor: 9_600 }, "Casual", scope);
      await expect(createShiftFromOpportunity(t.db, { departmentId: department.id, policyId: policy.id, startsAt: new Date(opportunity.startsAt), endsAt: new Date(opportunity.endsAt), requiredHeadcount: 2, date: FRIDAY, window: "09:00-10:00" }, scope, NOW)).rejects.toThrow("has changed");
    } finally { await t.close(); }
  }, 120_000);
});

describe("the Manager's page", () => {
  it("shows baseline, signals and provenance, the proposal, the assumption and the decision, in that order", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db, "Page", 1), scope = c.scope();
      await addManagerSignal(t.db, scope, note(), NOW);
      pages(t.db, scope);
      let plan = renderToStaticMarkup(await ManagerWorkspace({ area: "plan", date: FRIDAY }));
      const order = ["What history predicts", "What FairShift knows", "What AI proposes", "What changes if you accept"].map(text => plan.indexOf(text));
      expect(order.every(index => index >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      for (const text of ["Calculated baseline, no AI", "Manager-entered context, not independently verified", "Street market outside until late afternoon", "Calculated from sales history, not AI", "Ask AI for a scenario", "Nothing changes. Only the baseline drives staffing", "unknown, not normal"]) expect(plan).toContain(text);
      expect(plan).not.toMatch(/verified event|weather-aware/i);

      const { record } = await proposeDemandContext(t.db, scope, FRIDAY, moderateUp(), NOW);
      plan = renderToStaticMarkup(await ManagerWorkspace({ area: "plan", date: FRIDAY, context: "proposed" }));
      for (const text of ["AI proposal", "Moderate increase (+10%)", "The market outside is likely to bring extra footfall.", "Accept scenario", "Dismiss", "If accepted", "not a measured effect", "Only the baseline drives staffing until you decide", ">13<"]) expect(plan).toContain(text);

      await decideDemandContext(t.db, scope, { proposalId: record.id, action: "ACCEPTED" }, NOW);
      plan = renderToStaticMarkup(await ManagerWorkspace({ area: "plan", date: FRIDAY }));
      for (const text of ["Accepted", "With accepted scenario", "Withdraw and return to baseline", "Fill shifts for this day", "includes accepted scenario +10%", "This week includes one accepted scenario"]) expect(plan).toContain(text);
      // The Owner reads the same recalculated figures and is told they include it.
      pages(t.db, c.scope(c.rows[0].id, "OWNER"));
      const owner = renderToStaticMarkup(await OwnerWorkspace({ area: "forecast" }));
      expect(owner).toContain("Includes contextual scenarios accepted by a Manager, as planning assumptions rather than measured effects");
    } finally { await t.close(); }
  }, 180_000);
});
