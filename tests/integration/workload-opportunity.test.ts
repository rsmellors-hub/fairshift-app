import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// This calculation suite supplies synthetic fixtures under an explicit mocked demo
// authority. Real configuration and ordinary-account rejection are tested separately.
vi.mock("@/server/intelligence/sales-history", async importOriginal => ({
  ...await importOriginal<typeof import("@/server/intelligence/sales-history")>(),
  syntheticHistoryAllowed: () => true,
}));
import { createTestDatabase } from "../helpers/database";
import { entitled } from "../helpers/onboarding";
import { configureFixture, hours, ingestTimedBills } from "../helpers/workload";
import { createActivatedTeamMember } from "../helpers/workers";
import type { Scope } from "@/server/auth/access";
import { requireScope } from "@/server/auth/request";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { memberships, organisations, outlets, saleTransactions, shiftOpportunityEvidence, shifts, subscriptions, users, workAcceptances } from "@/server/db/schema";
import { prepareAssessmentInput, ASSESSMENT_INSTRUCTIONS, assessmentJsonSchema } from "@/server/intelligence/ai-staffing-contract";
import { clearWorkloadPolicy, setWorkloadPolicy } from "@/server/intelligence/business-policy";
import { dayOpportunities, windowParam } from "@/server/intelligence/opportunity";
import { createShiftFromOpportunity, getShiftOpportunityEvidence } from "@/server/intelligence/opportunity-shifts";
import { getWeeklyStaffing } from "@/server/intelligence/staffing";
import { provisionReferenceHistory } from "@/server/reference/provision";
import { REFERENCE_STORE_CODES } from "@/server/reference/uk-hospitality";
import { allocateAssignment, createDepartment, createRequirement, createWorkPolicy, getOperations, offerAssignment, respondToAssignment } from "@/server/scheduling/operations";
import { createRequirementAction } from "@/app/operations-actions";
import { ManagerWorkspace } from "@/app/manager/workspace";
import { OwnerWorkspace } from "@/app/owner/workspace";
import { WorkerWorkspace } from "@/app/worker/workspace";
import OwnerLocationPage from "@/app/owner/locations/[locationId]/page";

vi.mock("@/server/auth/request", () => ({ requireScope: vi.fn() }));
vi.mock("@/server/db/client", () => ({ getDatabase: vi.fn() }));
vi.mock("@/server/config/env", () => ({ getConfigurationStatus: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); }, notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// Sunday 25 Oct 2026, London. Next week is Mon 26 Oct – Sun 1 Nov.
const NOW = new Date("2026-10-25T10:00:00Z");
const FRIDAY = "2026-10-30";
beforeEach(() => { vi.useFakeTimers({ now: NOW, toFake: ["Date"] }); });
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];
// Test-fixture business: 12 bills in the 14:00 local hour (13:10 UTC in the summer-time history), one person all day. Not reference policy.
const FIXTURE_POLICY = { transactionsPerStaffHour: 4, minimumStaffWhileOpen: 1 };
async function business(db: Db, name = "Fixture hospitality", locations = 2) {
  const organisationId = randomUUID();
  await db.insert(organisations).values({ id: organisationId, name, country: "United Kingdom" });
  await db.insert(subscriptions).values({ id: randomUUID(), organisationId, requestId: randomUUID() });
  await entitled(db, organisationId);
  const rows = Array.from({ length: locations }, (_, i) => ({ id: randomUUID(), organisationId, name: `${name} ${i + 1}`, timezone: "Europe/London" }));
  await db.insert(outlets).values(rows);
  const userId = randomUUID();
  await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: "Person", passwordHash: "x", emailVerifiedAt: NOW });
  await db.insert(memberships).values({ id: randomUUID(), userId, organisationId, role: "OWNER" });
  const scope = (locationId = rows[0].id, role: Scope["role"] = "MANAGER"): Scope => ({ userId, organisationId, locationId, role, organisationName: name, locationName: rows.find(row => row.id === locationId)?.name ?? "" });
  return { organisationId, rows, scope };
}
async function configured(db: Db, c: Awaited<ReturnType<typeof business>>, outletId: string, policy = true) {
  await ingestTimedBills(db, { organisationId: c.organisationId, outletId, through: "2026-10-18", bills: () => 12, at: "13:10:00Z", now: NOW, billMinor: 2_500, sourceSystem: `till-${outletId}` });
  await configureFixture(db, { organisationId: c.organisationId, outletId, policy: policy ? FIXTURE_POLICY : null, trading: [{ start: 12 * 60, end: 20 * 60 }], coverage: [hours(12, 20, 1)] });
}
// The historical locked terms, used only to prove pay stays untouched: daily £96, £25 at a £200 individual target.
async function goldenTerms(db: Db, scope: Scope) {
  const [department] = await createDepartment(db, `Front of house ${randomUUID().slice(0, 4)}`, scope);
  const [policy] = await createWorkPolicy(db, { earningsModel: "DAILY", rateMinor: 9_600, incentiveTargetMinor: 20_000, incentiveBonusMinor: 2_500 }, "Casual shift", scope);
  return { department, policy };
}
const pages = (db: Db, scope: Scope) => {
  vi.mocked(getDatabase).mockReturnValue(db);
  vi.mocked(getConfigurationStatus).mockReturnValue({ databaseConfigured: true, aiConfigured: false } as ReturnType<typeof getConfigurationStatus>);
  vi.mocked(requireScope).mockResolvedValue(scope);
};
const SHIFT = { startsAt: new Date(`${FRIDAY}T14:00:00Z`), endsAt: new Date(`${FRIDAY}T20:00:00Z`), requiredHeadcount: 2 };

describe("reference company baseline", () => {
  it("shows five hospitality venues under the frozen policy, and is unavailable again if the policy is removed", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db, "Reference", 5);
      const mapping = Object.fromEntries(REFERENCE_STORE_CODES.map((code, i) => [code, c.rows[i].id])) as Record<typeof REFERENCE_STORE_CODES[number], string>;
      await provisionReferenceHistory(t.db, { organisationId: c.organisationId, outlets: mapping, from: "2026-09-28", through: "2026-10-18" });
      const owner = c.scope(c.rows[0].id, "OWNER");
      pages(t.db, owner);
      let forecast = renderToStaticMarkup(await OwnerWorkspace({ area: "forecast" }));
      for (const text of ["Expected sales by location", "Expected transactions by location", "Casual requirement by location", "Busiest ", "Reference sales history"]) expect(forecast).toContain(text);
      expect(forecast).not.toContain("Configuration required");
      const page = renderToStaticMarkup(await OwnerLocationPage({ params: Promise.resolve({ locationId: c.rows[0].id }) }));
      for (const text of ["By time of day", "Expected transactions", "Regular coverage", "7 transactions per staff hour, at least 2 staff while open"]) expect(page).toContain(text);
      const policies = renderToStaticMarkup(await OwnerWorkspace({ area: "policies" }));
      for (const text of ["7 transactions per staff hour, at least 2 staff while open", "reference company configuration"]) expect(policies).toContain(text);
      pages(t.db, c.scope());
      const plan = renderToStaticMarkup(await ManagerWorkspace({ area: "plan" }));
      for (const text of ["By time of day", "Reference sales history · synthetic", "Where casual cover is needed"]) expect(plan).toContain(text);
      expect(plan).not.toContain("Configuration required");

      // Removing the policy never reads as zero or as no staff needed.
      await clearWorkloadPolicy(t.db, owner, "ORGANISATION");
      pages(t.db, owner);
      forecast = renderToStaticMarkup(await OwnerWorkspace({ area: "forecast" }));
      for (const text of ["Configuration required", "service capacity and minimum cover", "doesn’t mean no staff are needed", "doesn’t assume a value", "Set up staffing inputs"]) expect(forecast).toContain(text);
      expect(forecast.slice(forecast.indexOf("Casual requirement by location"), forecast.indexOf("Staffing working by location"))).not.toMatch(/>0 h<|Covered/);
      pages(t.db, c.scope());
      const unset = renderToStaticMarkup(await ManagerWorkspace({ area: "plan" }));
      expect(unset).toContain("Ask the business owner");
      expect(unset).not.toContain("Where casual cover is needed");
    } finally { await t.close(); }
  }, 180_000);
});

describe("forecast into Fill Shifts", () => {
  it("carries location, date, window and evidence into the form, and freezes why the shift exists", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db);
      const a = c.rows[0].id, manager = c.scope(a);
      await configured(t.db, c, a);
      const terms = await goldenTerms(t.db, manager);
      pages(t.db, manager);
      const plan = renderToStaticMarkup(await ManagerWorkspace({ area: "plan" }));
      const link = `/manager/fill?date=${FRIDAY}&amp;window=14:00-15:00#add-requirement`;
      expect(plan).toContain(link);
      const context = renderToStaticMarkup(await ManagerWorkspace({ area: "fill", date: FRIDAY, window: "14:00-15:00" }));
      for (const text of [c.rows[0].name, "Fri, 30 Oct 2026 · 14:00–15:00", "FairShift identified a casual requirement", "Expected transactions", "Required staff capacity", "Up to 2 people at once", `value="${FRIDAY}T14:00"`, `value="${FRIDAY}T15:00"`, 'name="opportunityWindow" value="14:00-15:00"', `name="opportunityDate" value="${FRIDAY}"`]) expect(context).toContain(text);
      expect(context).toMatch(/name="headcount"[^>]*value="2"/);

      // The Manager can still adjust the actual shift: here, the full 14:00–20:00.
      const form = new FormData();
      for (const [key, value] of Object.entries({ departmentId: terms.department.id, policyId: terms.policy.id, headcount: "2", startsAt: `${FRIDAY}T14:00`, endsAt: `${FRIDAY}T20:00`, opportunityDate: FRIDAY, opportunityWindow: "14:00-15:00", planDate: FRIDAY, planWindow: "14:00-15:00" })) form.set(key, value);
      // A forged evidence field in the form is simply ignored.
      form.set("evidence", JSON.stringify({ expectedTransactions: 9999 }));
      form.set("expectedTransactions", "9999");
      await expect(createRequirementAction(form)).rejects.toThrow("status=saved");
      const [shift] = (await getOperations(t.db, manager)).requirements;
      expect(shift).toMatchObject({ outletId: a, shiftDate: FRIDAY, requiredHeadcount: 2, expectedEarningsMinor: 9_600, incentiveAmountMinor: 2_500, incentiveTargetMinor: 20_000 });
      const [record] = await t.db.select().from(shiftOpportunityEvidence).where(eq(shiftOpportunityEvidence.shiftId, shift.id));
      expect(record).toMatchObject({ organisationId: c.organisationId, outletId: a, localDate: FRIDAY, windowStartsAt: new Date(`${FRIDAY}T14:00:00Z`), windowEndsAt: new Date(`${FRIDAY}T15:00:00Z`), createdBy: manager.userId });
      expect(record.evidence).toMatchObject({ windowStart: "14:00", windowEnd: "15:00", expectedTransactions: 12, requiredMinutes: 180, regularMinutes: 60, remainingCasualMinutes: 120, state: "OPEN", workloadPolicyVersion: "organisation-v1", workloadMethodVersion: "transaction-windows-recency-v1", provenance: { source: "IMPORTED", synthetic: false } });
      expect(renderToStaticMarkup(await ManagerWorkspace({ area: "fill", date: FRIDAY }))).toContain("Why this shift was created");
    } finally { await t.close(); }
  });

  it("changing the evidence can't change accepted pay, and the evidence record can't be rewritten", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db);
      const a = c.rows[0].id, manager = c.scope(a);
      await configured(t.db, c, a);
      const terms = await goldenTerms(t.db, manager);
      const shift = await createShiftFromOpportunity(t.db, { departmentId: terms.department.id, policyId: terms.policy.id, ...SHIFT, date: FRIDAY, window: "14:00-15:00" }, manager, NOW);
      const { worker } = await createActivatedTeamMember(t.db, { firstName: "Casual", surname: "Worker", telephone: "+441132000000", email: `casual-${randomUUID().slice(0, 6)}@example.test` }, manager);
      const offer = await offerAssignment(t.db, shift.id, worker.id, manager);
      await respondToAssignment(t.db, worker.id, offer.id, 1, "ACCEPTED", true, manager);
      await allocateAssignment(t.db, offer.id, manager);
      const [before] = await t.db.select().from(workAcceptances).where(eq(workAcceptances.offerId, offer.id));
      const evidenceBefore = (await getShiftOpportunityEvidence(t.db, manager, [shift.id])).get(shift.id)!;

      // The forecast and the policy move: the shift's terms, acceptance and frozen evidence don't.
      await t.db.delete(saleTransactions).where(eq(saleTransactions.outletId, a));
      await ingestTimedBills(t.db, { organisationId: c.organisationId, outletId: a, through: "2026-10-18", bills: () => 80, at: "13:20:00Z", now: NOW, billMinor: 100, sourceSystem: "other" });
      await setWorkloadPolicy(t.db, c.scope(a, "OWNER"), "LOCATION", { transactionsPerStaffHour: 1, minimumStaffWhileOpen: 5 });
      const moved = (await getWeeklyStaffing(t.db, manager, NOW)).outlets[0].days.find(day => day.planningDate === FRIDAY)!;
      expect(moved.requiredMinutes).toBeGreaterThan(480);
      const [after] = await t.db.select().from(shifts).where(eq(shifts.id, shift.id));
      expect(after).toMatchObject({ expectedEarningsMinor: 9_600, incentiveAmountMinor: 2_500, incentiveTargetMinor: 20_000, rateMinor: 9_600, termsVersion: 1 });
      expect(after.expectedEarningsMinor! + after.incentiveAmountMinor).toBe(12_100); // £96 + £25 = £121.
      expect((await t.db.select().from(workAcceptances).where(eq(workAcceptances.offerId, offer.id)))[0].snapshot).toEqual(before.snapshot);
      expect((await getShiftOpportunityEvidence(t.db, manager, [shift.id])).get(shift.id)).toEqual(evidenceBefore);

      await expect(t.db.update(shiftOpportunityEvidence).set({ evidence: { expectedTransactions: 1 } }).where(eq(shiftOpportunityEvidence.shiftId, shift.id))).rejects.toThrow();
      await expect(t.db.delete(shiftOpportunityEvidence).where(eq(shiftOpportunityEvidence.shiftId, shift.id))).rejects.toThrow();

      // Workers see their terms, never the demand evidence or location figures.
      pages(t.db, { ...manager, role: "TEAM_MEMBER", workerId: worker.id });
      const workerPage = renderToStaticMarkup(await WorkerWorkspace({ area: "shifts" }));
      for (const hidden of ["Why this shift", "expected transactions", "Casual requirement", "workload"]) expect(workerPage.toLowerCase()).not.toContain(hidden.toLowerCase());
    } finally { await t.close(); }
  });

  it("refuses a stale, forged, malformed, non-overlapping, other-location or other-tenant opportunity, creating nothing", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db), other = await business(t.db, "Other tenant");
      const [a, b] = c.rows.map(row => row.id);
      await configured(t.db, c, a);
      await configured(t.db, other, other.rows[0].id);
      const manager = c.scope(a);
      const terms = await goldenTerms(t.db, manager);
      const input = { departmentId: terms.department.id, policyId: terms.policy.id, ...SHIFT };
      const run = (date: string, window: string, scope = manager, shift = input) => createShiftFromOpportunity(t.db, { ...shift, date, window }, scope, NOW);
      for (const [date, window] of [[FRIDAY, "09:00-10:00"], [FRIDAY, "<script>"], [FRIDAY, ""], ["2030-01-01", "14:00-15:00"], ["not-a-date", "14:00-15:00"]]) await expect(run(date, window)).rejects.toMatchObject({ feedback: "opportunity-changed" });
      // No overlap with the window it claims to cover.
      await expect(run(FRIDAY, "14:00-15:00", manager, { ...input, startsAt: new Date(`${FRIDAY}T17:00:00Z`) })).rejects.toMatchObject({ feedback: "opportunity-outside-window" });
      // Another location's manager has no such opportunity: their location has no configuration.
      await expect(run(FRIDAY, "14:00-15:00", c.scope(b))).rejects.toMatchObject({ feedback: "opportunity-changed" });
      // Another tenant's manager can't use this business's department or policy.
      await expect(run(FRIDAY, "14:00-15:00", other.scope(other.rows[0].id))).rejects.toThrow("Department or work policy unavailable.");
      // Forged scope naming this location from another organisation sees no outlet at all.
      await expect(run(FRIDAY, "14:00-15:00", { ...other.scope(other.rows[0].id), locationId: a })).rejects.toMatchObject({ feedback: "opportunity-changed" });
      expect(await t.db.select().from(shifts)).toEqual([]);
      expect(await t.db.select().from(shiftOpportunityEvidence)).toEqual([]);

      // A database-level insert can't attach evidence to another location or tenant.
      const shift = await createRequirement(t.db, input, manager);
      await expect(t.db.insert(shiftOpportunityEvidence).values({ shiftId: shift.id, organisationId: c.organisationId, outletId: b, localDate: FRIDAY, windowStartsAt: SHIFT.startsAt, windowEndsAt: SHIFT.endsAt, evidence: {} })).rejects.toThrow();
      await expect(t.db.insert(shiftOpportunityEvidence).values({ shiftId: shift.id, organisationId: other.organisationId, outletId: a, localDate: FRIDAY, windowStartsAt: SHIFT.startsAt, windowEndsAt: SHIFT.endsAt, evidence: {} })).rejects.toThrow();
      // And one manager's read never returns another location's reasons.
      expect((await getShiftOpportunityEvidence(t.db, c.scope(b), [shift.id])).size).toBe(0);
    } finally { await t.close(); }
  });

  it("scopes staffing and opportunities by location and tenant", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db), other = await business(t.db, "Other tenant");
      const [a, b] = c.rows.map(row => row.id);
      await configured(t.db, c, a);
      await configured(t.db, other, other.rows[0].id, false);
      // A Manager of location B never gets location A's figures.
      const managerB = await getWeeklyStaffing(t.db, c.scope(b), NOW);
      expect(managerB.outlets.map(row => row.outletId)).toEqual([b]);
      expect(managerB.outlets[0].days[0]).toMatchObject({ unavailable: "NO_FORECAST", expectedMilliTransactions: null });
      // The policy of one organisation never reaches another.
      expect((await getWeeklyStaffing(t.db, other.scope(other.rows[0].id), NOW)).outlets[0].policy).toBeNull();
      await expect(getWeeklyStaffing(t.db, { ...c.scope(a), role: "TEAM_MEMBER" }, NOW)).rejects.toThrow("Access denied");
      // Owner page for another tenant's location: not found.
      pages(t.db, other.scope(other.rows[0].id, "OWNER"));
      await expect(OwnerLocationPage({ params: Promise.resolve({ locationId: a }) })).rejects.toThrow("NOT_FOUND");
    } finally { await t.close(); }
  });
});

describe("AI remains interpretation only", () => {
  it("receives the authoritative figures, and its contract can only explain and rank", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db);
      await configured(t.db, c, c.rows[0].id);
      const staffing = await getWeeklyStaffing(t.db, c.scope(c.rows[0].id, "OWNER"), NOW);
      const { input } = prepareAssessmentInput(staffing, "ORGANISATION");
      const location = input.locations.find(row => row.week)!;
      expect(input).toMatchObject({ inputVersion: "fs-staffing-ai-input-v4", staffingMethodVersion: "transaction-capacity-windows-v1", workloadMethodVersion: "transaction-windows-recency-v1" });
      expect(location).toMatchObject({ workloadPolicyVersion: "organisation-v1" });
      // Seven hours at the fixture minimum of 60 minutes, plus three hours for the busy one.
      expect(location.days[0]).toMatchObject({ expectedTransactions: 12, requiredMinutes: 600, regularMinutes: 480, casualGapMinutes: 120 });
      const friday = location.opportunities.find(row => row.date === FRIDAY)!;
      expect(friday).toMatchObject({ start: "14:00", end: "15:00", state: "OPEN", expectedTransactions: 12, remainingCasualMinutes: 120 });
      // Nothing it can return sets anything: no field for pay, workers, shifts, capacity or demand.
      const fields = JSON.stringify(assessmentJsonSchema(input));
      for (const forbidden of ["transactionsPerStaffHour", "minimumStaff", "workerId", "createShift", "rateMinor", "approve", "payout"]) expect(fields).not.toContain(forbidden);
      expect(ASSESSMENT_INSTRUCTIONS).toContain("You cannot create shifts, choose or allocate");
      expect(ASSESSMENT_INSTRUCTIONS).toContain("Never suggest a value for service capacity or minimum cover");
      expect(ASSESSMENT_INSTRUCTIONS).toContain("Do not invent");
    } finally { await t.close(); }
  });
});

describe("opportunity selection in the page", () => {
  it("falls back to the largest open window, says when a named one has gone, and never invents one", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db);
      const a = c.rows[0].id, manager = c.scope(a);
      await configured(t.db, c, a);
      await goldenTerms(t.db, manager);
      pages(t.db, manager);
      expect(renderToStaticMarkup(await ManagerWorkspace({ area: "fill", date: FRIDAY }))).toContain('name="opportunityWindow" value="14:00-15:00"');
      const gone = renderToStaticMarkup(await ManagerWorkspace({ area: "fill", date: FRIDAY, window: "09:00-10:00" }));
      expect(gone).toContain("That time no longer has an open casual requirement");
      expect(gone).not.toContain('name="opportunityWindow"');
      // Directly from the opportunity list: same record, same key.
      const staffing = await getWeeklyStaffing(t.db, manager, NOW);
      const outlet = staffing.outlets[0];
      const [row] = dayOpportunities(outlet, outlet.days.find(day => day.planningDate === FRIDAY)!);
      expect(windowParam(row)).toBe("14:00-15:00");
    } finally { await t.close(); }
  });
});
