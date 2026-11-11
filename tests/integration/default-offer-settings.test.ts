import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { fixtureHourlyRate, payAgentCompany, workAt } from "../helpers/pay-agent";
import { randomUUID } from "node:crypto";
import { locationShiftRules } from "@/server/db/schema";
import { createDepartment, createRequirement, createWorkPolicy } from "@/server/scheduling/operations";
import { DEFAULT_SHIFT_RULES, ensureDefaultRules } from "@/server/scheduling/default-rules";
import { loadShiftRules } from "@/server/scheduling/shift-rules";

// Default offer settings and hand-made shift lengths (Owner, 11 Nov 2026).
describe("default offer settings", () => {
  it("are added once, never over the Owner's own, and hand-made shifts keep to the location's lengths", async () => {
    const t = await createTestDatabase();
    try {
      const manager = (await payAgentCompany(t.db)).scopes[0];
      const [department] = await createDepartment(t.db, "Floor", manager);
      const [policy] = await createWorkPolicy(t.db, { earningsModel: "HOURLY", rateMinor: await fixtureHourlyRate(t.db, manager) }, "Floor", manager);
      const shift = (hours: number) => createRequirement(t.db, { departmentId: department.id, policyId: policy.id, startsAt: workAt(0), endsAt: workAt(hours), requiredHeadcount: 1 }, manager, { handMade: true });
      // No saved settings: the default 4–8 h applies.
      await expect(shift(0.5)).rejects.toMatchObject({ feedback: "shift-length" });
      await expect(shift(9)).rejects.toMatchObject({ feedback: "shift-length" });
      await expect(shift(6)).resolves.toMatchObject({ cancellationPercent: 50 });

      expect(await ensureDefaultRules(t.db, manager.organisationId, manager.locationId)).toEqual({ shiftRules: true, hoursRule: true });
      expect(await ensureDefaultRules(t.db, manager.organisationId, manager.locationId)).toEqual({ shiftRules: false, hoursRule: false });
      expect((await loadShiftRules(t.db, manager.organisationId, [manager.locationId])).get(manager.locationId)).toMatchObject({ ...DEFAULT_SHIFT_RULES, source: "DEFAULT" });

      // An Owner's own settings at another location are left as they are.
      const other = (await payAgentCompany(t.db)).scopes[0];
      await t.db.insert(locationShiftRules).values({ id: randomUUID(), organisationId: other.organisationId, outletId: other.locationId, minMinutes: 180, maxMinutes: 600, preferredMinutes: 300, firstRoundMinutes: 60, firstRoundCutoffMinutes: 360, source: "OWNER" });
      expect((await ensureDefaultRules(t.db, other.organisationId, other.locationId)).shiftRules).toBe(false);
      expect((await loadShiftRules(t.db, other.organisationId, [other.locationId])).get(other.locationId)).toMatchObject({ minMinutes: 180, maxMinutes: 600, source: "OWNER" });
    } finally { await t.close(); }
  });
});
