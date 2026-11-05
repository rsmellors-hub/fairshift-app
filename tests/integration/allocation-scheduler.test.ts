import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ManagerAreaPage from "@/app/manager/[area]/page";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { DEMO_CASUAL_WORKER_ID, DEMO_ORGANISATION_ID, DEMO_OUTLET_ID } from "@/server/constants";
import { organisations, outlets, shifts, shiftOffers, workers } from "@/server/db/schema";
import { getAllocationSchedule } from "@/server/scheduling/allocations";
import { acceptDemoShift, publishDemoShift, startNewDemoCycle } from "@/server/scheduling/demo";
import { markDemoShiftCompleted, recordDemoPerformance } from "@/server/incentives/demo";
import { createTestDatabase } from "../helpers/database";
const demoScope = { organisationId: DEMO_ORGANISATION_ID, locationId: DEMO_OUTLET_ID };

vi.mock("@/server/auth/request",()=>({requireScope:async()=>({userId:"90000000-0000-4000-8000-000000000001",organisationId:"10000000-0000-4000-8000-000000000001",locationId:"20000000-0000-4000-8000-000000000001",role:"MANAGER",organisationName:"Demo",locationName:"Rosebank Kitchen"})}));
vi.mock("@/server/db/client", () => ({ getDatabase: vi.fn() }));
vi.mock("@/server/config/env", () => ({ getConfigurationStatus: vi.fn() }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); }, useRouter: () => ({ refresh() {} }) }));

async function page() {
  return renderToStaticMarkup(await ManagerAreaPage({ params: Promise.resolve({ area: "allocations" }), searchParams: Promise.resolve({}) }));
}

describe("Manager allocation schedule", () => {
  it("renders empty, populated and failed reads distinctly; retains accepted/completed history", async () => {
    const testDb = await createTestDatabase();
    try {
      vi.mocked(getConfigurationStatus).mockReturnValue({ databaseConfigured: true } as ReturnType<typeof getConfigurationStatus>);
      vi.mocked(getDatabase).mockReturnValue(testDb.db);
      expect(await page()).toContain("No shift allocations");
      const first = await publishDemoShift(testDb.db);
      expect((await getAllocationSchedule(testDb.db, demoScope)).events[0].state).toBe("Offered · awaiting response");
      await acceptDemoShift(testDb.db, undefined, true);
      expect((await getAllocationSchedule(testDb.db, demoScope)).events[0].state).toBe("Accepted · awaiting allocation");
      await markDemoShiftCompleted(testDb.db);
      await recordDemoPerformance(testDb.db, 0);
      const second = await startNewDemoCycle(testDb.db);
      const schedule = await getAllocationSchedule(testDb.db, demoScope);
      expect(schedule.events.filter((row) => row.kind === "OFFER").map((row) => row.id)).toEqual([second.offer.id, first.offer.id]);
      expect(schedule.events[1].state).toBe("Completed work");
      expect(schedule.assignments).toContainEqual({ id: first.offer.id, eventId: first.offer.id, resourceId: first.worker.id });
      const html = await page();
      expect(html).toContain("Weekly schedule");
      expect(html).toContain("Loading schedule timeline");
      expect(html).toContain("Completed work");
      expect(html).toContain("Alex Morgan");
      expect(html).toContain("FairShift checks every change on the server");
      expect(html).not.toContain("No shift allocations");
      expect(html).not.toContain("paypalBatchId");
      vi.mocked(getDatabase).mockReturnValue({ select: () => { throw new Error("Database unavailable"); } } as unknown as ReturnType<typeof getDatabase>);
      const failed = await page();
      expect(failed).toContain("Workspace information is unavailable");
      expect(failed).not.toContain("No shift allocations");
      expect(failed).not.toContain("Database unavailable");
    } finally { vi.clearAllMocks(); await testDb.close(); }
  });

  it("excludes other locations, organisations and workers and projects no financial diagnostics", async () => {
    const testDb = await createTestDatabase();
    try {
      const current = await publishDemoShift(testDb.db);
      const otherOrg = randomUUID(), otherOutlet = randomUUID(), sameOrgOutlet = randomUUID(), otherWorker = randomUUID();
      await testDb.db.insert(organisations).values({ id: otherOrg, name: "Private company" });
      await testDb.db.insert(outlets).values([
        { id: otherOutlet, organisationId: otherOrg, name: "Other org", timezone: "UTC" },
        { id: sameOrgOutlet, organisationId: DEMO_ORGANISATION_ID, name: "Other location", timezone: "UTC" },
      ]);
      await testDb.db.insert(workers).values({ id: otherWorker, organisationId: DEMO_ORGANISATION_ID, displayName: "Unrelated worker", workerType: "CASUAL" });
      for (const [outletId, workerId] of [[otherOutlet, DEMO_CASUAL_WORKER_ID], [sameOrgOutlet, DEMO_CASUAL_WORKER_ID], [current.shift.outletId, otherWorker]]) {
        const shiftId = randomUUID();
        await testDb.db.insert(shifts).values({ ...current.shift, id: shiftId, outletId, departmentId: outletId === current.shift.outletId ? current.shift.departmentId : null });
        await testDb.db.insert(shiftOffers).values({ id: randomUUID(), shiftId, workerId });
      }
      const schedule = await getAllocationSchedule(testDb.db, demoScope);
      expect(schedule.resources).toEqual([{ id: current.worker.id, name: current.worker.displayName }]);
      expect(schedule.events).toHaveLength(1);
      expect(schedule.events[0].id).toBe(current.offer.id);
      expect(schedule.assignments).toHaveLength(1);
      expect(JSON.stringify(schedule)).not.toMatch(/paypal|incentive|submittedAt|Unrelated worker/);
    } finally { await testDb.close(); }
  });
});
