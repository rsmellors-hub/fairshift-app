import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { payAgentCompany, workAt } from "../helpers/pay-agent";
import type { Scope } from "@/server/auth/access";
import { auditEvents, outlets, workPolicies } from "@/server/db/schema";
import { checkWage, WAGE_STATUS_LABEL, wageAllowsOffer, wageJurisdiction } from "@/server/domain/statutory-wage";
import { createDepartment, createRequirement, createWorkPolicy } from "@/server/scheduling/operations";
import { acknowledgeWageNotChecked, WAGE_NOT_CHECKED_ACKNOWLEDGED, wageNotCheckedAcknowledgement } from "@/server/scheduling/wage-acknowledgement";
import { WageReferencePanel } from "@/app/owner/wage-reference";

// Day 6, Step 3a: where FairShift holds no wage rule for the location's country or the shift's date, the
// minimum wage is "not checked", and shifts there are created and offered only after the Owner's audited
// acknowledgement for that location. Commission casual terms are refused everywhere.
const owner = (manager: Scope): Scope => ({ ...manager, role: "OWNER" });

describe("minimum wage not checked", () => {
  it("labels the case, blocks offers until the Owner acknowledges it, and records the acknowledgement", async () => {
    const t = await createTestDatabase();
    try {
      const c = await payAgentCompany(t.db, { country: "Kenya", locations: 2 });
      const [manager, other] = c.scopes;
      const jurisdiction = wageJurisdiction({ organisationCountry: "Kenya" });
      const check = checkWage({ jurisdiction, date: "2026-10-20", currencyCode: "GBP", terms: { earningsModel: "HOURLY", rateMinor: 100 } });
      expect(WAGE_STATUS_LABEL[check.status]).toBe("Minimum wage not checked");
      expect(wageAllowsOffer(check)).toBe(false);
      expect(wageAllowsOffer(check, true)).toBe(true);

      const [department] = await createDepartment(t.db, "Floor", manager);
      const [policy] = await createWorkPolicy(t.db, { earningsModel: "HOURLY", rateMinor: 1_000 }, "Casual", owner(manager));
      const shift = () => createRequirement(t.db, { departmentId: department.id, policyId: policy.id, startsAt: workAt(0), endsAt: workAt(6), requiredHeadcount: 1 }, manager);
      await expect(shift()).rejects.toMatchObject({ feedback: "wage-not-checked" });

      // Only the Owner can acknowledge, and only with the statement confirmed.
      await expect(acknowledgeWageNotChecked(t.db, manager, true)).rejects.toThrow();
      await expect(acknowledgeWageNotChecked(t.db, owner(manager), false)).rejects.toThrow();
      expect(await t.db.select().from(auditEvents).where(eq(auditEvents.action, WAGE_NOT_CHECKED_ACKNOWLEDGED))).toHaveLength(0);

      await acknowledgeWageNotChecked(t.db, owner(manager), true);
      const [row] = await t.db.select().from(auditEvents).where(eq(auditEvents.action, WAGE_NOT_CHECKED_ACKNOWLEDGED));
      expect(row).toMatchObject({ organisationId: c.organisationId, outletId: manager.locationId, entityType: "outlet" });
      expect(row.metadata).toMatchObject({ actorUserId: manager.userId, actorRole: "OWNER", country: "Kenya", countryKey: "kenya", reason: "NO_REFERENCE_FOR_COUNTRY" });
      await expect(shift()).resolves.toMatchObject({ outletId: manager.locationId });

      // Per location: the other location is still blocked.
      const [otherDepartment] = await createDepartment(t.db, "Floor", other);
      const [otherPolicy] = await createWorkPolicy(t.db, { earningsModel: "HOURLY", rateMinor: 1_000 }, "Casual", owner(other));
      await expect(createRequirement(t.db, { departmentId: otherDepartment.id, policyId: otherPolicy.id, startsAt: workAt(0), endsAt: workAt(6), requiredHeadcount: 1 }, other)).rejects.toMatchObject({ feedback: "wage-not-checked" });

      // The Owner sees the state and who acknowledged it.
      const acknowledgement = await wageNotCheckedAcknowledgement(t.db, manager);
      const page = renderToStaticMarkup(WageReferencePanel({ jurisdiction, today: "2026-10-20", locationName: "Store 1", currency: "GBP", acknowledgement }));
      expect(page).toContain("Minimum wage not checked");
      expect(page).toContain("Acknowledged by the Owner");
      const unacknowledged = renderToStaticMarkup(WageReferencePanel({ jurisdiction, today: "2026-10-20", locationName: "Store 2", currency: "GBP", acknowledgement: null }));
      expect(unacknowledged).toContain("Acknowledge and allow offers");

      // An acknowledgement lapses if the location's country changes.
      await t.db.update(outlets).set({ country: "Uganda" }).where(eq(outlets.id, manager.locationId));
      expect(await wageNotCheckedAcknowledgement(t.db, manager)).toBeNull();
      await expect(shift()).rejects.toMatchObject({ feedback: "wage-not-checked" });
    } finally { await t.close(); }
  });

  it("covers dates without a verified rate in a country that has one, but never pay below a known floor", async () => {
    const t = await createTestDatabase();
    try {
      const manager = (await payAgentCompany(t.db, { country: "South Africa" })).scopes[0];
      const [department] = await createDepartment(t.db, "Floor", manager);
      const [policy] = await createWorkPolicy(t.db, { earningsModel: "HOURLY", rateMinor: 3_900 }, "Casual", owner(manager));
      // 1 March 2027 onward isn't compared: not checked until the Owner acknowledges it.
      const later = { departmentId: department.id, policyId: policy.id, startsAt: new Date("2027-03-02T07:00:00Z"), endsAt: new Date("2027-03-02T13:00:00Z"), requiredHeadcount: 1 };
      await expect(createRequirement(t.db, later, manager)).rejects.toMatchObject({ feedback: "wage-not-checked" });
      await acknowledgeWageNotChecked(t.db, owner(manager), true);
      await expect(createRequirement(t.db, later, manager)).resolves.toMatchObject({ currencyCode: "ZAR" });
      // The acknowledgement never lets pay below the floor in force through.
      await t.db.update(workPolicies).set({ rateMinor: 2_000 }).where(eq(workPolicies.id, policy.id));
      await expect(createRequirement(t.db, { ...later, startsAt: workAt(0), endsAt: workAt(6) }, manager)).rejects.toMatchObject({ feedback: "wage-below-minimum" });
    } finally { await t.close(); }
  });

  it("refuses commission casual terms everywhere, even after an acknowledgement", async () => {
    const t = await createTestDatabase();
    try {
      const commission = { earningsModel: "COMMISSION", commissionBps: 500, commissionBasis: "VERIFIED_ATTRIBUTED_SALES" } as const;
      for (const country of ["United Kingdom", "South Africa", "Kenya"]) {
        const manager = (await payAgentCompany(t.db, { country })).scopes[0];
        await expect(createWorkPolicy(t.db, commission, "Commission", owner(manager))).rejects.toMatchObject({ feedback: "policy-commission" });
        // Terms written before this rule (here, set directly) are refused when used.
        await acknowledgeWageNotChecked(t.db, owner(manager), true);
        const [department] = await createDepartment(t.db, "Floor", manager);
        const [legacy] = await createWorkPolicy(t.db, { earningsModel: "HOURLY", rateMinor: 3_900 }, "Legacy", owner(manager));
        await t.db.update(workPolicies).set({ earningsModel: "COMMISSION", rateMinor: null, commissionBps: 500, commissionBasis: "VERIFIED_ATTRIBUTED_SALES" }).where(eq(workPolicies.id, legacy.id));
        await expect(createRequirement(t.db, { departmentId: department.id, policyId: legacy.id, startsAt: workAt(0), endsAt: workAt(6), requiredHeadcount: 1 }, manager)).rejects.toMatchObject({ feedback: "wage-not-checkable" });
      }
    } finally { await t.close(); }
  });
});
