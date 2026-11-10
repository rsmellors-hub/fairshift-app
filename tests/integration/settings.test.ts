import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { business, createOrganisation } from "../helpers/onboarding";
import { resolveScope, type Scope } from "@/server/auth/access";
import { createIdentityToken, redeemIdentityToken, registerIdentity } from "@/server/auth/identity";
import { inviteMember } from "@/server/auth/tenancy";
import { auditEvents, organisations, shifts, users, workPolicies, workers } from "@/server/db/schema";
import { completeInvitedSignUp } from "@/server/people/sign-up";
import { createDepartment, createRequirement, createWorkPolicy, getOperations, reviseWorkPolicy } from "@/server/scheduling/operations";
import { loadHoursRule, loadShiftRules } from "@/server/scheduling/shift-rules";
import { setHoursRule, setShiftRules, updateBusinessDetails, updateOwnAccountDetails, updateOwnDetails } from "@/server/settings/settings";

// Day 6, item 3: everything an Owner sets is editable; rules and pay terms are saved as new dated
// versions, accepted work keeps its terms, and every change is audited.
type DB = Awaited<ReturnType<typeof createTestDatabase>>["db"];
const password = "a-long-test-password-42";
async function identity(db: DB, email: string, verify = true) {
  const user = await registerIdentity(db, { email, password });
  if (verify) await redeemIdentityToken(db, await createIdentityToken(db, user.id, "VERIFY_EMAIL"), "VERIFY_EMAIL");
  return user;
}
async function company(db: DB) {
  const owner = await identity(db, "owner@example.test");
  const org = await createOrganisation(db, owner.id, { ...business, name: "Settings Test Cafe", locationName: "Main" });
  return { owner, scope: await resolveScope(db, owner.id, org.membershipId), ...org };
}
const actions = async (db: DB, action: string) => (await db.select().from(auditEvents).where(eq(auditEvents.action, action)));

describe("editable settings", () => {
  it("revises pay terms as a new dated version; created shifts keep their terms; the wage floor still applies", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      const [department] = await createDepartment(t.db, "Floor", c.scope);
      const [first] = await createWorkPolicy(t.db, { earningsModel: "HOURLY", rateMinor: 3_900 }, "Casual", c.scope);
      const window = { departmentId: department.id, startsAt: new Date(Date.now() + 86_400_000), endsAt: new Date(Date.now() + 86_400_000 + 6 * 3_600_000), requiredHeadcount: 1 };
      const before = await createRequirement(t.db, { ...window, policyId: first.id }, c.scope);
      // Below the South African minimum wage: refused, and the current terms stay current.
      await expect(reviseWorkPolicy(t.db, first.id, { earningsModel: "HOURLY", rateMinor: 2_000 }, "Casual", c.scope)).rejects.toMatchObject({ feedback: "policy-below-wage-floor" });
      expect((await getOperations(t.db, c.scope)).policies.map(p => p.id)).toEqual([first.id]);
      const next = await reviseWorkPolicy(t.db, first.id, { earningsModel: "HOURLY", rateMinor: 4_500, incentiveTargetMinor: 60_000, incentiveBonusMinor: 3_000 }, "Casual (Nov)", c.scope);
      expect(next).toMatchObject({ rateMinor: 4_500, replacesPolicyId: first.id, name: "Casual (Nov)" });
      expect((await t.db.select().from(workPolicies).where(eq(workPolicies.id, first.id)))[0].supersededAt).toBeInstanceOf(Date);
      expect((await getOperations(t.db, c.scope)).policies.map(p => p.id)).toEqual([next.id]);
      // The shift created earlier keeps R39.00; the old version can't be used for new shifts, nor revised again.
      expect((await t.db.select().from(shifts).where(eq(shifts.id, before.id)))[0].rateMinor).toBe(3_900);
      await expect(createRequirement(t.db, { ...window, policyId: first.id }, c.scope)).rejects.toThrow(/unavailable/);
      await expect(reviseWorkPolicy(t.db, first.id, { earningsModel: "HOURLY", rateMinor: 5_000 }, "Again", c.scope)).rejects.toMatchObject({ feedback: "policy-unavailable" });
      await expect(createRequirement(t.db, { ...window, policyId: next.id }, c.scope)).resolves.toMatchObject({ rateMinor: 4_500 });
      expect((await actions(t.db, "PAY_TERMS_REVISED"))[0].metadata).toMatchObject({ previousPolicyId: first.id, previous: { rateMinor: 3_900 }, next: { rateMinor: 4_500 } });
    } finally { await t.close(); }
  });

  it("saves shift rules, offer rounds and the hours alert as new versions, Owner only, with validation", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      const manager: Scope = { ...c.scope, role: "MANAGER" };
      const rules = { minMinutes: 240, maxMinutes: 480, preferredMinutes: 360, firstRoundMinutes: 120, firstRoundCutoffMinutes: 720 };
      await expect(setShiftRules(t.db, manager, rules)).rejects.toThrow();
      await expect(setShiftRules(t.db, c.scope, { ...rules, minMinutes: 250 })).rejects.toMatchObject({ feedback: "shift-rules-invalid" });
      await expect(setShiftRules(t.db, c.scope, { ...rules, preferredMinutes: 600 })).rejects.toMatchObject({ feedback: "shift-rules-invalid" });
      await setShiftRules(t.db, c.scope, rules);
      await setShiftRules(t.db, c.scope, { ...rules, preferredMinutes: 300, firstRoundMinutes: 60 });
      expect((await loadShiftRules(t.db, c.organisationId, [c.locationId])).get(c.locationId)).toMatchObject({ preferredMinutes: 300, firstRoundMinutes: 60, source: "OWNER" });
      expect(await actions(t.db, "SHIFT_RULES_SET")).toHaveLength(2);
      await expect(setHoursRule(t.db, c.scope, { weeklyThresholdMinutes: 0, referenceWeeks: 12 })).rejects.toMatchObject({ feedback: "hours-rule-invalid" });
      await setHoursRule(t.db, c.scope, { weeklyThresholdMinutes: 1_200, referenceWeeks: 12 });
      expect(await loadHoursRule(t.db, c.organisationId)).toMatchObject({ weeklyThresholdMinutes: 1_200, referenceWeeks: 12, source: "OWNER" });
      expect(await actions(t.db, "HOURS_RULE_SET")).toHaveLength(1);
    } finally { await t.close(); }
  });

  it("edits business details but never the country, and lets people edit their own details", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      await expect(updateBusinessDetails(t.db, c.scope, { name: "", businessAddress: "x", city: "y", province: "", postalCode: "1" })).rejects.toMatchObject({ feedback: "business-invalid" });
      await expect(updateBusinessDetails(t.db, c.scope, { name: "Settings Cafe Group", businessAddress: "9 New Road", city: "Pretoria", province: "Gauteng", postalCode: "0002", country: "Kenya" })).rejects.toMatchObject({ feedback: "business-invalid" });
      await expect(updateBusinessDetails(t.db, c.scope, { name: "Settings Cafe Group", businessAddress: "9 New Road", city: "Pretoria", province: "Gauteng", postalCode: "0002" })).resolves.toMatchObject({ changed: expect.arrayContaining(["name", "businessAddress", "city", "postalCode"]) });
      expect((await t.db.select().from(organisations).where(eq(organisations.id, c.organisationId)))[0]).toMatchObject({ name: "Settings Cafe Group", city: "Pretoria", country: "South Africa" });
      expect(await actions(t.db, "BUSINESS_UPDATED")).toHaveLength(1);

      await updateOwnAccountDetails(t.db, c.owner.id, { firstName: "Samantha", surname: "Taylor", telephone: "" });
      expect((await t.db.select().from(users).where(eq(users.id, c.owner.id)))[0]).toMatchObject({ firstName: "Samantha", telephone: null });
      const invite = await inviteMember(t.db, c.scope, { role: "TEAM_MEMBER", email: "nia@example.test", firstName: "Nia", surname: "Botha" });
      const nia = await identity(t.db, "nia@example.test", false);
      const membership = await completeInvitedSignUp(t.db, nia, invite.token, { firstName: "Nia", surname: "Botha", telephone: "", availability: Array(7).fill("AVAILABLE"), payoutEmail: "nia@example.test", confirmPayoutEmail: "nia@example.test" });
      const worker = await resolveScope(t.db, nia.id, membership.id);
      await updateOwnDetails(t.db, worker, { firstName: "Nia", surname: "Botha-Smith", telephone: "+27 82 111 2222" });
      expect((await t.db.select().from(workers).where(eq(workers.id, membership.workerId!)))[0]).toMatchObject({ displayName: "Nia Botha-Smith", telephone: "+27 82 111 2222" });
      await expect(updateOwnDetails(t.db, worker, { firstName: "", surname: "x", telephone: "" })).rejects.toMatchObject({ feedback: "details-invalid" });
    } finally { await t.close(); }
  });
});
