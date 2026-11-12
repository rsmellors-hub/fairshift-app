import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { allocatedWork, fixtureHourlyRate, payAgentCompany, workAt } from "../helpers/pay-agent";
import { workerLocations } from "@/server/db/schema";
import { loadConfirmedWork, preModelCheck } from "@/server/pay-agent/evidence";
import { addWorkerLocation } from "@/server/people/worker-locations";
import { allocateAssignment, confirmWork, createDepartment, createRequirement, createWorkPolicy, offerAssignment, respondToAssignment } from "@/server/scheduling/operations";

// A casual worker can work at several locations of one business (Locations, design §1). Their confirmed
// work at a location other than their main one is checked by the Pay Agent like any other (12 Nov 2026);
// once they are removed from that location, it is not eligible.
describe("Pay Agent eligibility at a worker's other locations", () => {
  it("passes the authority checks for work at a location the worker was added to, and blocks it after removal", async () => {
    const t = await createTestDatabase();
    try {
      const c = await payAgentCompany(t.db, { country: "South Africa", locations: 2 });
      const [main, other] = c.scopes;
      const { worker } = await allocatedWork(t.db, main, { startsAt: workAt(0), endsAt: workAt(2) });
      expect(await addWorkerLocation(t.db, other, worker.id, other.locationId)).toBe(true);

      const [department] = await createDepartment(t.db, "Floor", other);
      const [policy] = await createWorkPolicy(t.db, { earningsModel: "HOURLY", rateMinor: await fixtureHourlyRate(t.db, other) }, "Casual terms", other);
      const shift = await createRequirement(t.db, { departmentId: department.id, policyId: policy.id, startsAt: workAt(4), endsAt: workAt(6), requiredHeadcount: 1 }, other);
      const offer = await offerAssignment(t.db, shift.id, worker.id, other);
      await respondToAssignment(t.db, worker.id, offer.id, shift.termsVersion, "ACCEPTED", true, other);
      await allocateAssignment(t.db, offer.id, other);
      const { payable } = await confirmWork(t.db, offer.id, other);

      const evidence = (await loadConfirmedWork(t.db, other, payable!.id))!;
      expect(evidence.worker).toMatchObject({ locationId: main.locationId, worksHere: true });
      expect(preModelCheck(evidence)).toBeNull();

      await t.db.update(workerLocations).set({ removedAt: new Date() }).where(and(eq(workerLocations.workerId, worker.id), eq(workerLocations.outletId, other.locationId)));
      const after = (await loadConfirmedWork(t.db, other, payable!.id))!;
      expect(after.worker).toMatchObject({ worksHere: false });
      expect(preModelCheck(after)).toEqual({ status: "BLOCKED", code: "WORKER_NOT_ELIGIBLE" });
      // The payable is read only in its own location's scope.
      expect((await loadConfirmedWork(t.db, main, payable!.id))).toBeNull();
    } finally { await t.close(); }
  });
});
