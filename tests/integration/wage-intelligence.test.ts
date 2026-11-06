import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { entitled } from "../helpers/onboarding";
import { resolveScope, type Scope } from "@/server/auth/access";
import { workerRespond } from "@/server/auth/operations";
import { requireScope } from "@/server/auth/request";
import { inviteMember, redeemInvitation } from "@/server/auth/tenancy";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { auditEvents, memberships, organisations, outlets, shifts, subscriptions, users, workPayables, workPolicies } from "@/server/db/schema";
import { allocateAssignment, confirmWork, createDepartment, createRequirement, createWorkPolicy, getOperations, offerAssignment } from "@/server/scheduling/operations";
import { approveWorkPayable } from "@/server/payments/work-payouts";
import { finalPayableMinor } from "@/server/domain/work-payable";
import { createPolicyAction, createRequirementAction, offerAssignmentAction } from "@/app/operations-actions";
import { explainWageCheck } from "@/server/intelligence/wage-explanation";
import { wageJurisdiction } from "@/server/domain/statutory-wage";
import type { StaffingAssessmentProvider } from "@/server/integrations/openai/staffing-assessment";
import { ManagerWorkspace } from "@/app/manager/workspace";
import { OwnerWorkspace } from "@/app/owner/workspace";
import { WorkerWorkspace } from "@/app/worker/workspace";

vi.mock("@/server/auth/request", () => ({ requireScope: vi.fn() }));
vi.mock("@/server/db/client", () => ({ getDatabase: vi.fn() }));
vi.mock("@/server/config/env", () => ({ getConfigurationStatus: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); }, notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// Sunday 1 March 2026 in London: the demo minimum today is £12.21. Shifts below fall either side
// of the 1 April 2026 change to £12.71.
const NOW = new Date("2026-03-01T12:00:00Z");
beforeEach(() => { vi.useFakeTimers({ now: NOW, toFake: ["Date"] }); });
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];
let n = 0;
async function user(db: Db) {
  const id = randomUUID(), email = `w${++n}-${randomUUID().slice(0, 6)}@example.test`;
  await db.insert(users).values({ id, email, name: "Person", passwordHash: "x", emailVerifiedAt: new Date() });
  return { id, email };
}
// England is the confirmed demonstration jurisdiction (FS-WAGE-INTEL-DEC-002).
async function business(db: Db, country = "England", locations = ["Leeds Briggate"]) {
  const organisationId = randomUUID();
  await db.insert(organisations).values({ id: organisationId, name: "Reference Cafés", country });
  await db.insert(subscriptions).values({ id: randomUUID(), organisationId, requestId: randomUUID() });
  await entitled(db, organisationId);
  const rows = locations.map(name => ({ id: randomUUID(), organisationId, name, timezone: "Europe/London", country }));
  await db.insert(outlets).values(rows);
  const owner = await user(db), ownerMembership = randomUUID();
  await db.insert(memberships).values({ id: ownerMembership, userId: owner.id, organisationId, role: "OWNER" });
  const ownerScope = await resolveScope(db, owner.id, ownerMembership, rows[0].id);
  const invite = async (role: "MANAGER" | "TEAM_MEMBER", scope: Scope) => {
    const person = await user(db);
    const { token } = await inviteMember(db, scope, { role, email: person.email, firstName: role === "MANAGER" ? "Morgan" : "Casey", surname: `Person${++n}`, telephone: "+441130000000" });
    return resolveScope(db, person.id, (await redeemInvitation(db, person.id, { token })).id);
  };
  const at = (index: number) => resolveScope(db, owner.id, ownerMembership, rows[index].id);
  return { organisationId, rows, ownerScope, at, manager: async (index = 0) => invite("MANAGER", await at(index)), worker: (scope: Scope) => invite("TEAM_MEMBER", scope) };
}
function pages(db: Db, aiConfigured = false) {
  vi.mocked(getDatabase).mockReturnValue(db);
  vi.mocked(getConfigurationStatus).mockReturnValue({ databaseConfigured: true, aiConfigured, paypalPayoutConfigured: true } as ReturnType<typeof getConfigurationStatus>);
}
const as = (scope: Scope) => vi.mocked(requireScope).mockResolvedValue(scope);
const render = async (scope: Scope, element: () => Promise<React.ReactNode>) => { as(scope); return renderToStaticMarkup(await element()); };
const act = async (scope: Scope, action: (f: FormData) => Promise<unknown>, values: Record<string, string>) => {
  as(scope);
  const form = new FormData();
  for (const [key, value] of Object.entries(values)) form.set(key, value);
  return String(await action(form).catch((error: Error) => error.message));
};
// Shifts on 23 March 2026 (2025–26 rates, 21+ £12.21) and 20 April 2026 (2026–27 rates, 21+ £12.71).
const MARCH = new Date("2026-03-23T10:00:00Z"), APRIL = new Date("2026-04-20T09:00:00Z");
const hours = (start: Date, length: number) => ({ startsAt: start, endsAt: new Date(start.getTime() + length * 3_600_000) });
const decode = (html: string) => html.replaceAll("&#x27;", "'").replaceAll("&amp;", "&");

describe("FS-WAGE-INTEL-DEC-002: the adult demo minimum for England shifts", () => {
  it("9. shows the Owner the adult benchmark and its source, prefills new terms, and never changes an existing rate", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db);
      pages(t.db);
      const [existing] = await createWorkPolicy(t.db, { earningsModel: "HOURLY", rateMinor: 1_200 }, "Existing casual", c.ownerScope);
      expect(await act(c.ownerScope, createPolicyAction, { name: "Owner's own", earningsModel: "HOURLY", rate: "13.40" })).toContain("status=saved");
      const before = await t.db.select().from(workPolicies).orderBy(workPolicies.name);
      expect(before.find(row => row.name === "Owner's own")!.rateMinor).toBe(1_340);

      const page = decode(await render(c.ownerScope, () => OwnerWorkspace({ area: "policies" })));
      for (const text of ["Minimum wage reference · Leeds Briggate", "England demo jurisdiction · England", "FairShift demo minimum · today", "£12.21 an hour", "in force 1 April 2025 to 31 March 2026",
        "FairShift competition policy", "Younger workers and apprentices can have lower statutory minimums", "21 and over", "National Living Wage", "£10.00", "£7.55",
        "From 1 April 2026", "£12.71", "It isn’t in force yet", "https://www.gov.uk/national-minimum-wage-rates", "checked 4 November 2026", "fs-uk-nmw-v1",
        "Minimum wage check · today", "Rate checked", "Below FairShift demo minimum", "One set of terms is below the FairShift demo minimum", "Your rates are kept as you set them",
        'value="12.21"', "the FairShift demo minimum today"]) expect(page).toContain(text);
      expect(page).not.toMatch(/legally compliant|fully compliant|Verification required/i);
      // Showing, checking, flagging and prefilling change nothing the Owner set.
      expect(await t.db.select().from(workPolicies).orderBy(workPolicies.name)).toEqual(before);
      expect(existing.rateMinor).toBe(1_200);
    } finally { await t.close(); }
  });

  it("11. tells an Owner outside the verified reference that no reference applies, and prefills nothing", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db, "South Africa");
      pages(t.db);
      const page = decode(await render(c.ownerScope, () => OwnerWorkspace({ area: "policies" })));
      expect(page).toContain("Statutory reference unavailable");
      expect(page).toContain("holds a verified minimum wage reference for the UK only");
      expect(page).not.toContain("Prefilled with");
    } finally { await t.close(); }
  });

  it("7, 3, 10, 11. refuses to create shifts below the adult minimum for their date, on the server", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db);
      pages(t.db);
      const manager = await c.manager();
      const [department] = await createDepartment(t.db, "Floor", c.ownerScope);
      const policy = async (rateMinor: number, earningsModel: "HOURLY" | "DAILY" = "HOURLY") => (await createWorkPolicy(t.db, { earningsModel, rateMinor }, `Terms ${rateMinor} ${earningsModel}`, c.ownerScope))[0];
      const shift = (policyId: string, at: Date, length = 8) => createRequirement(t.db, { departmentId: department.id, policyId, ...hours(at, length), requiredHeadcount: 1 }, manager);
      const [twelve, between, adult2026, youth, daily] = [await policy(1_200), await policy(1_250), await policy(1_271), await policy(1_085), await policy(9_600, "DAILY")];

      // 7. Below the floor: refused by the service and by the form, whichever date.
      await expect(shift(twelve.id, APRIL)).rejects.toMatchObject({ feedback: "wage-below-minimum" });
      await expect(shift(twelve.id, MARCH)).rejects.toMatchObject({ feedback: "wage-below-minimum" });
      expect(await act(manager, createRequirementAction, { departmentId: department.id, policyId: twelve.id, headcount: "1", startsAt: "2026-04-20T10:00", endsAt: "2026-04-20T18:00" })).toContain("status=wage-below-minimum");
      // 10. The 18–20 rate is reference information only: it doesn't lower the demo floor.
      await expect(shift(youth.id, APRIL)).rejects.toMatchObject({ feedback: "wage-below-minimum" });
      // A fixed amount is checked per hour: £96 over 8 hours is £12.00 an hour.
      await expect(shift(daily.id, APRIL, 8)).rejects.toMatchObject({ feedback: "wage-below-minimum" });
      // 11. Where no verified rate exists for the date, nothing is created.
      await expect(shift(adult2026.id, new Date("2028-04-10T09:00:00Z"))).rejects.toMatchObject({ feedback: "wage-reference-unavailable" });
      const [commission] = await createWorkPolicy(t.db, { earningsModel: "COMMISSION", commissionBps: 1_000, commissionBasis: "VERIFIED_ATTRIBUTED_SALES" }, "Commission", c.ownerScope);
      await expect(shift(commission.id, APRIL)).rejects.toMatchObject({ feedback: "wage-not-checkable" });
      expect((await getOperations(t.db, manager)).requirements).toEqual([]);

      // 3. £12.50 is above the March floor and below the April floor; £12.71 meets April's exactly.
      expect(await shift(between.id, MARCH)).toMatchObject({ rateMinor: 1_250 });
      await expect(shift(between.id, APRIL)).rejects.toMatchObject({ feedback: "wage-below-minimum" });
      expect(await shift(adult2026.id, APRIL)).toMatchObject({ rateMinor: 1_271, expectedEarningsMinor: 10_168 });
      expect(await shift(daily.id, APRIL, 7)).toMatchObject({ rateMinor: 9_600 });
    } finally { await t.close(); }
  });

  it("8. refuses to send an offer on terms below the minimum, on the server, and the Fill page says why", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db);
      pages(t.db);
      const manager = await c.manager(), worker = await c.worker(manager), other = await c.worker(manager);
      const [department] = await createDepartment(t.db, "Floor", c.ownerScope);
      const [adult] = await createWorkPolicy(t.db, { earningsModel: "HOURLY", rateMinor: 1_271 }, "Adult rate", c.ownerScope);
      const good = await createRequirement(t.db, { departmentId: department.id, policyId: adult.id, ...hours(APRIL, 8), requiredHeadcount: 1 }, manager);
      expect(await offerAssignment(t.db, good.id, worker.workerId!, manager)).toMatchObject({ status: "OFFERED" });

      // A shift whose recorded terms are now below the floor (as one created before this rule could be).
      const legacy = await createRequirement(t.db, { departmentId: department.id, policyId: adult.id, ...hours(new Date("2026-04-21T09:00:00Z"), 8), requiredHeadcount: 1 }, manager);
      await t.db.update(shifts).set({ rateMinor: 1_200, expectedEarningsMinor: 9_600, guaranteedBasePayMinor: 9_600 }).where(eq(shifts.id, legacy.id));
      await expect(offerAssignment(t.db, legacy.id, other.workerId!, manager)).rejects.toMatchObject({ feedback: "wage-below-minimum" });
      expect(await act(manager, offerAssignmentAction, { shiftId: legacy.id, workerId: other.workerId! })).toContain("status=wage-below-minimum");
      // The same rule on the Owner's own operations at this location.
      await expect(offerAssignment(t.db, legacy.id, other.workerId!, c.ownerScope)).rejects.toMatchObject({ feedback: "wage-below-minimum" });
      expect((await getOperations(t.db, manager)).offers.filter(row => row.offer.shiftId === legacy.id)).toEqual([]);

      const fill = decode(await render(manager, () => ManagerWorkspace({ area: "fill" })));
      const card = (id: string) => fill.slice(fill.indexOf(`id="requirement-${id}"`), fill.indexOf("</article>", fill.indexOf(`id="requirement-${id}"`)));
      expect(card(good.id)).toContain("At or above the FairShift demo minimum (the 21-and-over rate) for 20 April 2026");
      expect(card(legacy.id)).toContain("Below FairShift demo minimum");
      expect(card(legacy.id)).toContain("Pay is below the FairShift demo minimum, so this shift can’t be offered");
      expect(card(legacy.id)).not.toContain("Send offer");
      expect(card(good.id)).not.toContain("Pay is below");
    } finally { await t.close(); }
  });

  it.each([
    // FS-HACK-SA-SUBMISSION-001: the SA minimum wage reference is shown instead, and never enforced.
    { country: "South Africa", currency: "ZAR", badge: "Below minimum wage reference" },
    // Same GOV.UK rates, but outside the approved England demo scope: behaviour as before this package.
    { country: "Scotland", currency: "GBP", badge: "Outside demo jurisdiction" },
    { country: "Wales", currency: "GBP", badge: "Outside demo jurisdiction" },
  ])("11. leaves locations outside the England demo scope unchanged: $country", async ({ country, currency, badge }) => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db, country);
      pages(t.db);
      const manager = await c.manager(), worker = await c.worker(manager);
      const [department] = await createDepartment(t.db, "Floor", c.ownerScope);
      const [policy] = await createWorkPolicy(t.db, { earningsModel: "HOURLY", rateMinor: 500 }, "Local", c.ownerScope);
      const shift = await createRequirement(t.db, { departmentId: department.id, policyId: policy.id, ...hours(APRIL, 8), requiredHeadcount: 1 }, manager);
      expect(shift).toMatchObject({ currencyCode: currency, rateMinor: 500 });
      expect(await offerAssignment(t.db, shift.id, worker.workerId!, manager)).toMatchObject({ status: "OFFERED" });
      const fill = decode(await render(manager, () => ManagerWorkspace({ area: "fill" })));
      expect(fill).toContain(badge);
      expect(fill).not.toMatch(/Rate checked|Below FairShift demo minimum/);
    } finally { await t.close(); }
  });

  it("13, 14, 15. shows guaranteed base pay apart from variable earnings, and approved earnings only once approved", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db);
      pages(t.db);
      const manager = await c.manager(), worker = await c.worker(manager);
      const [department] = await createDepartment(t.db, "Floor", c.ownerScope);
      const [bonus] = await createWorkPolicy(t.db, { earningsModel: "HOURLY", rateMinor: 1_300, incentiveTargetMinor: 65_000, incentiveBonusMinor: 2_500 }, "Casual with bonus", c.ownerScope);
      const [plain] = await createWorkPolicy(t.db, { earningsModel: "HOURLY", rateMinor: 1_271 }, "Casual", c.ownerScope);
      const bonusShift = await createRequirement(t.db, { departmentId: department.id, policyId: bonus.id, ...hours(APRIL, 8), requiredHeadcount: 1 }, manager);
      const plainShift = await createRequirement(t.db, { departmentId: department.id, policyId: plain.id, ...hours(new Date("2026-04-22T09:00:00Z"), 6), requiredHeadcount: 1 }, manager);
      await offerAssignment(t.db, bonusShift.id, worker.workerId!, manager);
      await offerAssignment(t.db, plainShift.id, worker.workerId!, manager);

      const page = decode(await render(worker, () => WorkerWorkspace({ area: "shifts" })));
      const cards = page.split("<article").slice(1);
      const bonusCard = cards.find(card => card.includes("Monday 20 April"))!, plainCard = cards.find(card => card.includes("Wednesday 22 April"))!;
      // 13. Guaranteed base pay, with where, when, how long and the hourly wage.
      for (const text of ["Leeds Briggate", "10:00 to 18:00", "8 hours", "Guaranteed base pay", "£104.00", "£13.00 an hour × 8 hours", "at or above the 21-and-over National Living Wage for this date", "Accept shift"]) expect(bonusCard).toContain(text);
      // 14. Variable earnings are labelled as not guaranteed, with no tip or holiday-pay amount invented.
      for (const text of ["Potential variable earnings", "Not guaranteed", "£25.00", "Up to", "£129.00", "your own sales for this shift reach £650.00", "Tips", "FairShift doesn’t allocate tips",
        "Final approved earnings", "then approves the total", "Holiday pay isn’t calculated in FairShift"]) expect(bonusCard).toContain(text);
      expect(bonusCard.indexOf("Guaranteed base pay")).toBeLessThan(bonusCard.indexOf("Potential variable earnings"));
      expect(bonusCard.indexOf("Potential variable earnings")).toBeLessThan(bonusCard.indexOf("Final approved earnings"));
      for (const text of ["£76.26", "£12.71 an hour × 6 hours", "No sales bonus on this shift"]) expect(plainCard).toContain(text);
      expect(plainCard).not.toContain("Up to");
      expect(page).not.toMatch(/Tips<\/strong>\s*£|holiday pay[^<]*£/i);

      // Accept, allocate, finish and confirm the plain shift: the payable equals what was shown (15).
      const offerId = (await getOperations(t.db, manager)).offers.find(row => row.offer.shiftId === plainShift.id)!.offer.id;
      await workerRespond(t.db, worker, offerId, plainShift.termsVersion, "ACCEPTED", true);
      await allocateAssignment(t.db, offerId, manager);
      vi.setSystemTime(new Date("2026-04-22T16:00:00Z"));
      const { payable } = await confirmWork(t.db, offerId, manager);
      expect(payable).toMatchObject({ rateMinor: 1_271, baseAmountMinor: 7_626, earningsModel: "HOURLY" });
      expect(finalPayableMinor(payable!)).toBe(7_626);

      // Before approval the total is not presented as final.
      let earnings = decode(await render(worker, () => WorkerWorkspace({ area: "earnings" })));
      expect(earnings).toContain("Not final until your manager approves it");
      expect(earnings).not.toContain("Final approved earnings");
      expect(earnings).toContain("FairShift doesn’t allocate tips or calculate holiday pay");
      await approveWorkPayable(t.db, manager, payable!.id);
      earnings = decode(await render(worker, () => WorkerWorkspace({ area: "earnings" })));
      expect(earnings).toContain("Final approved earnings");
      expect(earnings).toContain("£76.26");
      expect(earnings).not.toContain("Not final until your manager approves it");
      expect((await t.db.select().from(workPayables).where(eq(workPayables.id, payable!.id)))[0]).toMatchObject({ status: "APPROVED", approvedAmountMinor: 7_626 });
    } finally { await t.close(); }
  });

  it("12. keeps Owner operations at the selected location and Managers at their own", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db, "England", ["Leeds Briggate", "York Stonegate"]);
      const [department] = await createDepartment(t.db, "Floor", c.ownerScope);
      const [policy] = await createWorkPolicy(t.db, { earningsModel: "HOURLY", rateMinor: 1_271 }, "Casual", c.ownerScope);
      // The Owner acts at the selected location; £12.71 × 8 hours is £101.68 (15: same arithmetic as before).
      const shift = await createRequirement(t.db, { departmentId: department.id, policyId: policy.id, ...hours(APRIL, 8), requiredHeadcount: 1 }, c.ownerScope);
      expect(shift).toMatchObject({ rateMinor: 1_271, expectedEarningsMinor: 10_168, guaranteedBasePayMinor: 10_168, currencyCode: "GBP" });
      // York's Manager can't use Leeds' policy or offer Leeds' shift.
      const york = await c.manager(1), yorkWorker = await c.worker(york);
      await expect(createRequirement(t.db, { departmentId: department.id, policyId: policy.id, ...hours(APRIL, 8), requiredHeadcount: 1 }, york)).rejects.toThrow(/unavailable/);
      await expect(offerAssignment(t.db, shift.id, yorkWorker.workerId!, york)).rejects.toThrow(/unavailable/);
      // Nor can a Leeds Manager offer Leeds work to a York worker.
      const leeds = await c.manager(0);
      await expect(offerAssignment(t.db, shift.id, yorkWorker.workerId!, leeds)).rejects.toThrow(/unavailable/);
    } finally { await t.close(); }
  });

  it("keeps the AI explanation optional, Owner-only, words-only and unstored", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db);
      pages(t.db, false);
      const manager = await c.manager();
      const jurisdiction = wageJurisdiction({ locationCountry: "England" });
      let seen = "";
      const provider = (explanation: string): StaffingAssessmentProvider => ({ provider: "OPENAI", model: "test-model", assess: async request => { seen = request.input; return { responseId: "resp_1", responseModel: "test-model", text: JSON.stringify({ explanation }) }; } });
      const words = "This rate is under the FairShift demo minimum, which follows the statutory rate for workers aged twenty-one and over on that date.";

      await expect(explainWageCheck(t.db, manager, { rateMinor: 1_200, date: "2026-04-20", jurisdiction }, provider(words))).rejects.toThrow();
      expect(await explainWageCheck(t.db, c.ownerScope, { rateMinor: 1_200, date: "2026-04-20", jurisdiction }, null)).toEqual({ state: "UNAVAILABLE", reason: "NOT_CONFIGURED" });
      expect(await explainWageCheck(t.db, c.ownerScope, { rateMinor: 1_200, date: "2026-04-20", jurisdiction }, provider(words))).toEqual({ state: "GENERATED", explanation: words, model: "test-model" });
      expect(JSON.parse(seen)).toMatchObject({ status: "BELOW_DEMO_MINIMUM", offeredHourlyRateMinor: 1_200, enforcedFloorCategory: "AGE_21_AND_OVER" });
      expect(seen).not.toContain("Leeds");
      expect(await explainWageCheck(t.db, c.ownerScope, { rateMinor: 1_200, date: "2026-04-20", jurisdiction }, provider("It is fine because it is above £12.71 for everyone working here."))).toEqual({ state: "UNAVAILABLE", reason: "REJECTED_OUTPUT" });
      const failing: StaffingAssessmentProvider = { provider: "OPENAI", model: "m", assess: async () => { throw new Error("down"); } };
      expect(await explainWageCheck(t.db, c.ownerScope, { rateMinor: 1_200, date: "2026-04-20", jurisdiction }, failing)).toEqual({ state: "UNAVAILABLE", reason: "PROVIDER_FAILED" });

      // Without AI the Owner still gets the full deterministic check and can create terms; nothing is offered by AI.
      const page = decode(await render(c.ownerScope, () => OwnerWorkspace({ area: "policies" })));
      expect(page).toContain("FairShift demo minimum · today");
      expect(page).not.toContain("Explain this rate with AI");
      expect(await act(c.ownerScope, createPolicyAction, { name: "No AI needed", earningsModel: "HOURLY", rate: "12.71" })).toContain("status=saved");
      const events = await t.db.select().from(auditEvents).where(eq(auditEvents.organisationId, c.organisationId));
      expect(events.map(row => row.action).filter(action => action.startsWith("WAGE_"))).toEqual(["WAGE_EXPLANATION_GENERATED", "WAGE_EXPLANATION_REJECTED"]);
      expect(JSON.stringify(events)).not.toContain("twenty-one and over on that date");
      expect((await t.db.select().from(workPolicies)).map(row => row.rateMinor)).toEqual([1_271]);
    } finally { await t.close(); }
  });
});
