import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { entitled } from "../helpers/onboarding";
import { AccessError, resolveScope, type Scope } from "@/server/auth/access";
import { inviteMember, redeemInvitation } from "@/server/auth/tenancy";
import { memberships, organisations, outlets, regularCoverageWindows, saleTransactions, subscriptions, users, workers, workloadPolicies, workPayables, workPayouts, workPolicies } from "@/server/db/schema";
import { resolveLocationCurrency } from "@/server/domain/currency";
import { checkWage, termsForWageCheck, wageAllowsOffer, wageJurisdiction } from "@/server/domain/statutory-wage";
import { saWageIndicator } from "@/server/domain/sa-wage-reference";
import { getWeeklyStaffing } from "@/server/intelligence/staffing";
import { provisionSaReferenceBusiness } from "@/server/reference/sa-provision";
import { SA_REFERENCE_DATASET, SA_REFERENCE_LOCATIONS, SA_REFERENCE_ORGANISATION, SA_REFERENCE_WORKLOAD_POLICY } from "@/server/reference/sa-reference";
import { createDepartment, createRequirement, createWorkPolicy, getOperations, offerAssignment } from "@/server/scheduling/operations";

// The SA business is the configured demo organisation here, so its labelled reference history is eligible.
vi.mock("@/server/demo/config", () => ({ demoConfig: () => ({ organisationId: "846ff1bc-fe0a-45fb-b0f0-3ab44ba1f1e4" }) }));

type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];
// Sunday 1 November 2026, 12:00 in Johannesburg: the planning week is Mon 2 – Sun 8 November,
// which includes the 4 November election public holiday.
const NOW = new Date("2026-11-01T10:00:00Z");
const RANGE = { from: "2026-10-04", through: "2026-10-31" };
const ORG = SA_REFERENCE_ORGANISATION.id;

let n = 0;
async function person(db: Db) {
  const id = randomUUID(), email = `sa${++n}-${randomUUID().slice(0, 6)}@example.test`;
  await db.insert(users).values({ id, email, name: "Person", passwordHash: "x", emailVerifiedAt: new Date() });
  return { id, email };
}
// The provisioned business with an Owner, an entitlement fixture and invitation-based people.
async function business(db: Db) {
  await provisionSaReferenceBusiness(db, RANGE, NOW);
  await db.insert(subscriptions).values({ id: randomUUID(), organisationId: ORG, requestId: randomUUID() });
  await entitled(db, ORG);
  const owner = await person(db), ownerMembership = randomUUID();
  await db.insert(memberships).values({ id: ownerMembership, userId: owner.id, organisationId: ORG, role: "OWNER" });
  const at = (code: string) => resolveScope(db, owner.id, ownerMembership, SA_REFERENCE_LOCATIONS.find(row => row.code === code)!.id);
  const invite = async (role: "MANAGER" | "TEAM_MEMBER", scope: Scope) => {
    const who = await person(db);
    const { token } = await inviteMember(db, scope, { role, email: who.email, firstName: role === "MANAGER" ? "Lindiwe" : "Sipho", surname: `Person${++n}`, telephone: "+27110000000" });
    return { userId: who.id, membershipId: (await redeemInvitation(db, who.id, { token })).id };
  };
  return { owner, ownerMembership, at, invite };
}

describe("FS-HACK-SA-SUBMISSION-001: South African reference business", () => {
  it("provisions exactly one five-location business in ZAR and Africa/Johannesburg, idempotently, with no people or pay", async () => {
    const t = await createTestDatabase();
    try {
      const first = await provisionSaReferenceBusiness(t.db, RANGE, NOW);
      expect(first).toMatchObject({ dataset: SA_REFERENCE_DATASET.version, provenance: "REFERENCE", currency: "ZAR", regularCoverageRows: 35 });
      expect(first.inserted).toBe(first.expected);
      expect(first.inserted).toBeGreaterThan(0);
      expect(await provisionSaReferenceBusiness(t.db, RANGE, NOW)).toMatchObject({ inserted: 0, expected: first.expected });

      // The test database already holds the legacy single-location demo; only one SA reference business exists beside it.
      const orgs = await t.db.select().from(organisations).where(eq(organisations.name, "Jacaranda Table Demo"));
      expect(orgs).toHaveLength(1);
      expect(orgs[0]).toMatchObject({ id: ORG, name: "Jacaranda Table Demo", country: "South Africa" });
      const ids = SA_REFERENCE_LOCATIONS.map(row => row.id);
      const locations = await t.db.select().from(outlets).where(eq(outlets.organisationId, ORG));
      expect(locations.map(row => row.name).sort()).toEqual(["Cape Town Gardens", "Durban North", "Pretoria Central", "Rosebank", "Sandton"]);
      expect(new Set(locations.map(row => row.id))).toEqual(new Set(SA_REFERENCE_LOCATIONS.map(row => row.id)));
      for (const row of locations) {
        expect(row).toMatchObject({ timezone: "Africa/Johannesburg", country: "South Africa", venueContextSource: "REFERENCE", venueProfile: null });
        expect(row.latitude).toBeLessThan(-25);
        expect(resolveLocationCurrency({ locationCountry: row.country, organisationCountry: orgs[0].country })).toBe("ZAR");
      }
      const sales = await t.db.select({ source: saleTransactions.source, currencyCode: saleTransactions.currencyCode, sourceSystem: saleTransactions.sourceSystem }).from(saleTransactions).where(inArray(saleTransactions.outletId, ids));
      expect(sales).toHaveLength(first.expected);
      expect(new Set(sales.map(row => `${row.source}:${row.currencyCode}:${row.sourceSystem}`))).toEqual(new Set([`REFERENCE:ZAR:${SA_REFERENCE_DATASET.version}`]));
      expect(await t.db.select().from(regularCoverageWindows).where(eq(regularCoverageWindows.organisationId, ORG))).toHaveLength(35);
      expect(await t.db.select().from(workloadPolicies).where(eq(workloadPolicies.organisationId, ORG))).toEqual([expect.objectContaining({ ...SA_REFERENCE_WORKLOAD_POLICY, source: "REFERENCE", outletId: null })]);
      // No fabricated people, pay terms, payables or payouts.
      expect(await t.db.select().from(workers).where(eq(workers.organisationId, ORG))).toHaveLength(0);
      expect(await t.db.select().from(memberships).where(eq(memberships.organisationId, ORG))).toHaveLength(0);
      expect(await t.db.select().from(workPolicies).where(inArray(workPolicies.outletId, ids))).toHaveLength(0);
      expect(await t.db.select().from(workPayables).where(eq(workPayables.organisationId, ORG))).toHaveLength(0);
      expect(await t.db.select({ id: workPayouts.id }).from(workPayouts).innerJoin(workPayables, eq(workPayables.id, workPayouts.payableId)).where(eq(workPayables.organisationId, ORG))).toHaveLength(0);

      // A second company under the same name is refused before any write.
      await t.db.update(organisations).set({ name: "Renamed" }).where(eq(organisations.id, ORG));
      await t.db.insert(organisations).values({ id: randomUUID(), name: "Jacaranda Table Demo", country: "South Africa" });
      await expect(provisionSaReferenceBusiness(t.db, RANGE, NOW)).rejects.toThrow("refusing to create a second reference business");
      expect(await t.db.select().from(outlets).where(eq(outlets.organisationId, ORG))).toHaveLength(5);
    } finally { await t.close(); }
  });

  it("feeds the existing forecast and staffing for all five locations, holiday week included, without a holiday effect", async () => {
    const t = await createTestDatabase();
    try {
      await provisionSaReferenceBusiness(t.db, RANGE, NOW);
      const owner: Scope = { userId: randomUUID(), organisationId: ORG, locationId: SA_REFERENCE_LOCATIONS[0].id, role: "OWNER", organisationName: "Jacaranda Table Demo", locationName: "Rosebank", demo: { persona: "OWNER", group: "sa-test" } };
      const staffing = await getWeeklyStaffing(t.db, owner, NOW);
      expect(staffing.outlets).toHaveLength(5);
      for (const outlet of staffing.outlets) {
        expect(outlet).toMatchObject({ currency: "ZAR", timezone: "Africa/Johannesburg", regularCoverage: "REFERENCE", tradingHours: "REFERENCE",
          policy: { ...SA_REFERENCE_WORKLOAD_POLICY, source: "REFERENCE", level: "ORGANISATION" }, evidence: { source: "REFERENCE", kind: "HISTORICAL", dataThrough: "2026-10-31", dataset: SA_REFERENCE_DATASET.version } });
        expect(outlet.days.map(day => day.planningDate)).toEqual(["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"]);
        // The election holiday is forecast from history like any Wednesday: open, with demand and cover.
        const holiday = outlet.days.find(day => day.planningDate === "2026-11-04")!;
        expect(holiday.requiredMinutes).toBeGreaterThan(0);
        expect(holiday.regularMinutes).toBe(2 * 12 * 60);
      }
      expect(await getWeeklyStaffing(t.db, owner, NOW)).toEqual(staffing);
    } finally { await t.close(); }
  });

  it("keeps Owner, Manager and casual worker access to the right locations, and worker pools apart", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db);
      // The Owner reaches every location.
      for (const row of SA_REFERENCE_LOCATIONS) expect((await c.at(row.code)).locationId).toBe(row.id);
      const sandton = await c.at("SA02"), rosebank = await c.at("SA01");
      const manager = await c.invite("MANAGER", sandton);
      expect((await resolveScope(t.db, manager.userId, manager.membershipId)).locationId).toBe(sandton.locationId);
      await expect(resolveScope(t.db, manager.userId, manager.membershipId, rosebank.locationId)).rejects.toBeInstanceOf(AccessError);
      const managerScope = await resolveScope(t.db, manager.userId, manager.membershipId);
      const casual = await c.invite("TEAM_MEMBER", managerScope);
      const worker = await resolveScope(t.db, casual.userId, casual.membershipId);
      expect(worker).toMatchObject({ role: "TEAM_MEMBER", locationId: sandton.locationId });
      const [record] = await t.db.select().from(workers).where(eq(workers.id, worker.workerId!));
      expect(record).toMatchObject({ workerType: "CASUAL", locationId: sandton.locationId, organisationId: ORG });
      // Pools are per location: Sandton's casual isn't in Rosebank's pool and can't be offered its work.
      expect((await getOperations(t.db, sandton)).team.map(row => row.worker.id)).toEqual([worker.workerId]);
      expect((await getOperations(t.db, rosebank)).team).toHaveLength(0);
      const [department] = await createDepartment(t.db, "Floor", rosebank);
      const [policy] = await createWorkPolicy(t.db, { earningsModel: "HOURLY", rateMinor: 4_500 }, "Casual hourly", rosebank);
      const shift = await createRequirement(t.db, { departmentId: department.id, policyId: policy.id, startsAt: new Date("2026-11-10T07:00:00Z"), endsAt: new Date("2026-11-10T15:00:00Z"), requiredHeadcount: 1 }, rosebank);
      await expect(offerAssignment(t.db, shift.id, worker.workerId!, rosebank)).rejects.toThrow();
      // The provisioned locations hold no foreign organisation's people.
      expect(await t.db.select().from(workers).where(inArray(workers.locationId, SA_REFERENCE_LOCATIONS.map(row => row.id)))).toHaveLength(1);
    } finally { await t.close(); }
  });

  it("enforces the R30.23 floor on ZAR terms and leaves earnings calculation unchanged", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db);
      const sandton = await c.at("SA02");
      const invited = await c.invite("MANAGER", sandton);
      const manager = await resolveScope(t.db, invited.userId, invited.membershipId);
      const casual = await c.invite("TEAM_MEMBER", manager);
      const worker = await resolveScope(t.db, casual.userId, casual.membershipId);
      const [department] = await createDepartment(t.db, "Floor", sandton);
      const jurisdiction = wageJurisdiction({ locationCountry: "South Africa", organisationCountry: "South Africa" });
      // Day 6, Step 3a: South Africa's own rule is the floor (R30.23 an hour from 1 March 2026), enforced.
      expect(jurisdiction).toMatchObject({ jurisdiction: "SOUTH_AFRICA" });
      for (const { day, rateMinor, status } of [{ day: 10, rateMinor: 4_500, status: "ABOVE_REFERENCE" }, { day: 11, rateMinor: 3_023, status: "EQUAL_TO_REFERENCE" }]) {
        const [policy] = await createWorkPolicy(t.db, { earningsModel: "HOURLY", rateMinor }, `Hourly ${rateMinor}`, sandton);
        expect(policy.currencyCode).toBe("ZAR");
        // 8 hours, 09:00–17:00 local time, 10–11 November 2026.
        const shift = await createRequirement(t.db, { departmentId: department.id, policyId: policy.id, startsAt: new Date(`2026-11-${day}T07:00:00Z`), endsAt: new Date(`2026-11-${day}T15:00:00Z`), requiredHeadcount: 1 }, manager);
        expect(shift).toMatchObject({ currencyCode: "ZAR", rateMinor, expectedEarningsMinor: rateMinor * 8, guaranteedBasePayMinor: rateMinor * 8 });
        const terms = termsForWageCheck(shift, shift);
        expect(saWageIndicator({ country: jurisdiction.country, date: shift.shiftDate, currencyCode: shift.currencyCode, terms })).toMatchObject({ status, offeredHourlyMinor: rateMinor, referenceMinor: 3_023, blocking: false });
        const check = checkWage({ jurisdiction, date: shift.shiftDate, currencyCode: shift.currencyCode, terms: terms! });
        expect(check).toMatchObject({ enforced: true, floorMinor: 3_023, floorCurrency: "ZAR", status: "RATE_CHECKED" });
        expect(wageAllowsOffer(check)).toBe(true);
        expect(await offerAssignment(t.db, shift.id, worker.workerId!, manager)).toMatchObject({ status: "OFFERED" });
      }
      // Below the floor: the terms are refused with the floor shown, and a shift on older below-floor terms can't be made.
      await expect(createWorkPolicy(t.db, { earningsModel: "HOURLY", rateMinor: 2_500 }, "Hourly 2500", sandton)).rejects.toMatchObject({ feedback: "policy-below-wage-floor", message: expect.stringContaining("R30.23 an hour, the South African National Minimum Wage") });
      const [legacy] = await t.db.insert(workPolicies).values({ id: randomUUID(), outletId: sandton.locationId, name: "Older terms", earningsModel: "HOURLY", rateMinor: 2_500, currencyCode: "ZAR" }).returning();
      await expect(createRequirement(t.db, { departmentId: department.id, policyId: legacy.id, startsAt: new Date("2026-11-12T07:00:00Z"), endsAt: new Date("2026-11-12T15:00:00Z"), requiredHeadcount: 1 }, manager)).rejects.toMatchObject({ feedback: "wage-below-minimum", message: expect.stringContaining("South African National Minimum Wage") });
      expect(await t.db.select().from(workPayables).where(eq(workPayables.organisationId, ORG))).toHaveLength(0);
      expect(await t.db.select({ id: workPayouts.id }).from(workPayouts).innerJoin(workPayables, eq(workPayables.id, workPayouts.payableId)).where(eq(workPayables.organisationId, ORG))).toHaveLength(0);

      // A second company under the same name is refused before any write.
      await t.db.update(organisations).set({ name: "Renamed" }).where(eq(organisations.id, ORG));
      await t.db.insert(organisations).values({ id: randomUUID(), name: "Jacaranda Table Demo", country: "South Africa" });
      await expect(provisionSaReferenceBusiness(t.db, RANGE, NOW)).rejects.toThrow("refusing to create a second reference business");
      expect(await t.db.select().from(outlets).where(eq(outlets.organisationId, ORG))).toHaveLength(5);
    } finally { await t.close(); }
  });

  it("feeds the existing forecast and staffing for all five locations, holiday week included, without a holiday effect", async () => {
    const t = await createTestDatabase();
    try {
      await provisionSaReferenceBusiness(t.db, RANGE, NOW);
      const owner: Scope = { userId: randomUUID(), organisationId: ORG, locationId: SA_REFERENCE_LOCATIONS[0].id, role: "OWNER", organisationName: "Jacaranda Table Demo", locationName: "Rosebank", demo: { persona: "OWNER", group: "sa-test" } };
      const staffing = await getWeeklyStaffing(t.db, owner, NOW);
      expect(staffing.outlets).toHaveLength(5);
      for (const outlet of staffing.outlets) {
        expect(outlet).toMatchObject({ currency: "ZAR", timezone: "Africa/Johannesburg", regularCoverage: "REFERENCE", tradingHours: "REFERENCE",
          policy: { ...SA_REFERENCE_WORKLOAD_POLICY, source: "REFERENCE", level: "ORGANISATION" }, evidence: { source: "REFERENCE", kind: "HISTORICAL", dataThrough: "2026-10-31", dataset: SA_REFERENCE_DATASET.version } });
        expect(outlet.days.map(day => day.planningDate)).toEqual(["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"]);
        // The election holiday is forecast from history like any Wednesday: open, with demand and cover.
        const holiday = outlet.days.find(day => day.planningDate === "2026-11-04")!;
        expect(holiday.requiredMinutes).toBeGreaterThan(0);
        expect(holiday.regularMinutes).toBe(2 * 12 * 60);
      }
      expect(await getWeeklyStaffing(t.db, owner, NOW)).toEqual(staffing);
    } finally { await t.close(); }
  });

  it("keeps Owner, Manager and casual worker access to the right locations, and worker pools apart", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db);
      // The Owner reaches every location.
      for (const row of SA_REFERENCE_LOCATIONS) expect((await c.at(row.code)).locationId).toBe(row.id);
      const sandton = await c.at("SA02"), rosebank = await c.at("SA01");
      const manager = await c.invite("MANAGER", sandton);
      expect((await resolveScope(t.db, manager.userId, manager.membershipId)).locationId).toBe(sandton.locationId);
      await expect(resolveScope(t.db, manager.userId, manager.membershipId, rosebank.locationId)).rejects.toBeInstanceOf(AccessError);
      const managerScope = await resolveScope(t.db, manager.userId, manager.membershipId);
      const casual = await c.invite("TEAM_MEMBER", managerScope);
      const worker = await resolveScope(t.db, casual.userId, casual.membershipId);
      expect(worker).toMatchObject({ role: "TEAM_MEMBER", locationId: sandton.locationId });
      const [record] = await t.db.select().from(workers).where(eq(workers.id, worker.workerId!));
      expect(record).toMatchObject({ workerType: "CASUAL", locationId: sandton.locationId, organisationId: ORG });
      // Pools are per location: Sandton's casual isn't in Rosebank's pool and can't be offered its work.
      expect((await getOperations(t.db, sandton)).team.map(row => row.worker.id)).toEqual([worker.workerId]);
      expect((await getOperations(t.db, rosebank)).team).toHaveLength(0);
      const [department] = await createDepartment(t.db, "Floor", rosebank);
      const [policy] = await createWorkPolicy(t.db, { earningsModel: "HOURLY", rateMinor: 4_500 }, "Casual hourly", rosebank);
      const shift = await createRequirement(t.db, { departmentId: department.id, policyId: policy.id, startsAt: new Date("2026-11-10T07:00:00Z"), endsAt: new Date("2026-11-10T15:00:00Z"), requiredHeadcount: 1 }, rosebank);
      await expect(offerAssignment(t.db, shift.id, worker.workerId!, rosebank)).rejects.toThrow();
      // The provisioned locations hold no foreign organisation's people.
      expect(await t.db.select().from(workers).where(inArray(workers.locationId, SA_REFERENCE_LOCATIONS.map(row => row.id)))).toHaveLength(1);
    } finally { await t.close(); }
  });

  it("enforces the R30.23 floor on ZAR terms and leaves earnings calculation unchanged", async () => {
    const t = await createTestDatabase();
    try {
      const c = await business(t.db);
      const sandton = await c.at("SA02");
      const invited = await c.invite("MANAGER", sandton);
      const manager = await resolveScope(t.db, invited.userId, invited.membershipId);
      const casual = await c.invite("TEAM_MEMBER", manager);
      const worker = await resolveScope(t.db, casual.userId, casual.membershipId);
      const [department] = await createDepartment(t.db, "Floor", sandton);
      const jurisdiction = wageJurisdiction({ locationCountry: "South Africa", organisationCountry: "South Africa" });
      // Day 6, Step 3a: South Africa's own rule is the floor (R30.23 an hour from 1 March 2026), enforced.
      for (const { day, rateMinor, status } of [{ day: 10, rateMinor: 4_500, status: "ABOVE_REFERENCE" }, { day: 11, rateMinor: 3_023, status: "EQUAL_TO_REFERENCE" }]) {
        const [policy] = await createWorkPolicy(t.db, { earningsModel: "HOURLY", rateMinor }, `Hourly ${rateMinor}`, sandton);
        const shift = await createRequirement(t.db, { departmentId: department.id, policyId: policy.id, startsAt: new Date(`2026-11-${day}T07:00:00Z`), endsAt: new Date(`2026-11-${day}T15:00:00Z`), requiredHeadcount: 1 }, manager);
        expect(shift).toMatchObject({ currencyCode: "ZAR", rateMinor, expectedEarningsMinor: rateMinor * 8, guaranteedBasePayMinor: rateMinor * 8 });
        const terms = termsForWageCheck(shift, shift);
        expect(saWageIndicator({ country: jurisdiction.country, date: shift.shiftDate, currencyCode: shift.currencyCode, terms })).toMatchObject({ status, offeredHourlyMinor: rateMinor, referenceMinor: 3_023, blocking: false });
        expect(wageAllowsOffer(checkWage({ jurisdiction, date: shift.shiftDate, currencyCode: shift.currencyCode, terms: terms! }))).toBe(true);
        expect(await offerAssignment(t.db, shift.id, worker.workerId!, manager)).toMatchObject({ status: "OFFERED" });
      }
      await expect(createWorkPolicy(t.db, { earningsModel: "HOURLY", rateMinor: 2_500 }, "Hourly 2500", sandton)).rejects.toMatchObject({ feedback: "policy-below-wage-floor" });
      expect(await t.db.select().from(workPayables).where(eq(workPayables.organisationId, ORG))).toHaveLength(0);
    } finally { await t.close(); }
  });
});
