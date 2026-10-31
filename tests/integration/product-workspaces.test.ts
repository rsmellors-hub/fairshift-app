import { entitled } from "../helpers/onboarding";
import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import ManagerAreaPage from "@/app/manager/[area]/page";
import WorkerAreaPage from "@/app/worker/[area]/page";
import OwnerAreaPage from "@/app/owner/[area]/page";
import OperatorAreaPage from "@/app/operator/[area]/page";
import { ManagerWorkspace, managerAreas } from "@/app/manager/workspace";
import { WorkerWorkspace, workerAreas } from "@/app/worker/workspace";
import { OwnerWorkspace, ownerAreas } from "@/app/owner/workspace";
import { OperatorWorkspace, operatorAreas } from "@/app/operator/workspace";
import { startNewDemoCycleAction } from "@/app/operator/actions";
import { acceptDemoShiftAction, approveDemoIncentiveAction, publishDemoShiftAction, recordDemoPerformanceAction, refreshDemoIncentivePayoutAction, saveDemoPayoutDestinationAction, submitDemoIncentivePayoutAction } from "@/app/scheduling-actions";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { getPayPalPayoutClient } from "@/server/integrations/paypal/factory";
import { getDemoWorkerShift } from "@/server/scheduling/demo";
import { getDemoIncentive } from "@/server/incentives/demo";
import { getOwnerWorkspace, getWorkerWorkspace } from "@/server/product/workspace";
import { organisations, outlets, shiftIncentives, shifts, workers, users, memberships, subscriptions } from "@/server/db/schema";
import { createTeamAction, createPolicyAction, createRequirementAction, respondAssignmentAction } from "@/app/operations-actions";
import { getOperations, offerAssignment } from "@/server/scheduling/operations";
import { publishDemoShift } from "@/server/scheduling/demo";
import { ensureDemoCasualWorker } from "@/server/scheduling/demo";
import { DEMO_ORGANISATION_ID, DEMO_OUTLET_ID, DEMO_CASUAL_WORKER_ID } from "@/server/constants";
import { createTestDatabase } from "../helpers/database";

vi.mock("@/server/auth/request", () => ({
 requireScope:vi.fn(async (roles:string[])=>({userId:"90000000-0000-4000-8000-000000000001",organisationId:"10000000-0000-4000-8000-000000000001",locationId:"20000000-0000-4000-8000-000000000001",workerId:roles.includes("TEAM_MEMBER") ? "30000000-0000-4000-8000-000000000001":undefined,role:roles.includes("TEAM_MEMBER") ? "TEAM_MEMBER":"OWNER",organisationName:"Demo",locationName:"Rosebank Kitchen"})),
 requireOperator:vi.fn(async()=>({id:"90000000-0000-4000-8000-000000000001"})),
}));
vi.mock("@/server/db/client", () => ({ getDatabase: vi.fn() }));
vi.mock("@/server/config/env", () => ({ getConfigurationStatus: vi.fn() }));
vi.mock("@/server/integrations/paypal/factory", () => ({ getPayPalPayoutClient: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); }, notFound: () => { throw new Error("NOT_FOUND"); }, usePathname: () => "/operator" }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

function form(values: Record<string, string>) {
  const result = new FormData();
  for (const [key, value] of Object.entries(values)) result.set(key, value);
  return result;
}
async function configure(db: Awaited<ReturnType<typeof createTestDatabase>>["db"]) {
  await db.insert(users).values({id:"90000000-0000-4000-8000-000000000001",email:"owner@example.test",name:"Owner",passwordHash:"test",emailVerifiedAt:new Date()});
  await db.insert(memberships).values({id:randomUUID(),userId:"90000000-0000-4000-8000-000000000001",organisationId:DEMO_ORGANISATION_ID,role:"OWNER"});
  await db.insert(subscriptions).values({id:randomUUID(),organisationId:DEMO_ORGANISATION_ID,requestId:randomUUID()});
  await entitled(db,DEMO_ORGANISATION_ID);
  await ensureDemoCasualWorker(db);
  await db.update(workers).set({userId:"90000000-0000-4000-8000-000000000001",locationId:DEMO_OUTLET_ID}).where(eq(workers.id,DEMO_CASUAL_WORKER_ID));
  vi.mocked(getDatabase).mockReturnValue(db);
  vi.mocked(getConfigurationStatus).mockReturnValue({ databaseConfigured: true, paypalConfigured: false, paypalPayoutConfigured: true, aiConfigured: false, environment: "SANDBOX", currency: "USD", amount: "5.00" });
}
afterEach(() => vi.clearAllMocks());

describe("functional product workspaces", () => {
  it("renders every canonical destination and rejects unknown destinations", async () => {
    const testDb = await createTestDatabase();
    try {
      await configure(testDb.db);
      for (const [page, areas] of [[ManagerAreaPage, managerAreas], [WorkerAreaPage, workerAreas], [OwnerAreaPage, ownerAreas], [OperatorAreaPage, operatorAreas]] as const) {
        for (const area of areas) {
          const html = renderToStaticMarkup(await page({ params: Promise.resolve({ area }), searchParams: Promise.resolve({}) }));
          expect(html.length).toBeGreaterThan(80);
          expect(html).not.toContain("Coming next");
        }
        await expect(page({ params: Promise.resolve({ area: "unknown" }), searchParams: Promise.resolve({}) })).rejects.toThrow("NOT_FOUND");
      }
      expect(renderToStaticMarkup(await ManagerWorkspace({ area: "overview" }))).not.toContain("performanceSales");
      expect(renderToStaticMarkup(await WorkerWorkspace({ area: "home" }))).not.toContain('name="payoutEmail"');
      expect(renderToStaticMarkup(await OwnerWorkspace({ area: "overview" }))).not.toContain("Publish shift");
      expect(getPayPalPayoutClient).not.toHaveBeenCalled();
    } finally { await testDb.close(); }
  });

  it("runs the golden path through its functional actions, profile and operator cycle control", async () => {
    const testDb = await createTestDatabase();
    try {
      await configure(testDb.db);
      const createPayout = vi.fn(async () => ({ batchId: "MOCK-BATCH", itemId: "MOCK-ITEM", status: "PENDING" }));
      const getPayout = vi.fn(async () => ({ batchId: "MOCK-BATCH", itemId: "MOCK-ITEM", status: "SUCCESS" }));
      vi.mocked(getPayPalPayoutClient).mockReturnValue({ createPayout, getPayout } as unknown as ReturnType<typeof getPayPalPayoutClient>);

      await expect(saveDemoPayoutDestinationAction(form({ payoutEmail: "worker@example.test" }))).rejects.toThrow("REDIRECT:/worker/profile?status=saved");
      expect((await getWorkerWorkspace(testDb.db)).profile?.paypalPayoutEmail).toBe("worker@example.test");
      expect(await testDb.db.select().from(shifts)).toHaveLength(0);
      expect(createPayout).not.toHaveBeenCalled();
      const profileHtml = renderToStaticMarkup(await WorkerWorkspace({ area: "profile" }));
      expect(profileHtml).toContain('name="payoutEmail"');
      expect(profileHtml).not.toContain("worker@example.test");

      await expect(publishDemoShiftAction(form({}))).rejects.toThrow("status=error");
      await expect(publishDemoShiftAction(form({ workerSelected: "yes" }))).rejects.toThrow("REDIRECT:/manager/plan?status=saved");
      const current = (await getDemoWorkerShift(testDb.db))!;
      expect(renderToStaticMarkup(await WorkerWorkspace({ area: "shifts" }))).toContain("Accept shift");
      expect(renderToStaticMarkup(await WorkerWorkspace({ area: "shifts" }))).toContain("Awaiting your response");
      await expect(acceptDemoShiftAction(form({ shiftId: current.shift.id, acknowledged: "yes", termsVersion: String(current.shift.termsVersion) }))).rejects.toThrow("REDIRECT:/worker/shifts?status=saved");
      expect(renderToStaticMarkup(await WorkerWorkspace({ area: "shifts" }))).toContain("Offer accepted");

      await expect(recordDemoPerformanceAction(form({ shiftId: randomUUID(), performanceSales: "720.00", completed: "yes" }))).rejects.toThrow("status=error");
      expect(await getDemoIncentive(testDb.db)).toBeNull();
      await expect(recordDemoPerformanceAction(form({ shiftId: current.shift.id, performanceSales: "720.00", completed: "yes" }))).rejects.toThrow("REDIRECT:/manager/review?status=saved");
      const earned = (await getDemoIncentive(testDb.db))!.incentive;
      expect(earned).toMatchObject({ earnedAmountMinor: 2500, status: "EARNED", shiftId: current.shift.id });
      let paymentHtml = renderToStaticMarkup(await ManagerWorkspace({ area: "review" }));
      expect(paymentHtml).toContain("Approve incentive");
      expect(paymentHtml).not.toContain("Send approved incentive with PayPal");
      await expect(submitDemoIncentivePayoutAction(form({ incentiveId: earned.id }))).rejects.toThrow("status=error");
      expect(createPayout).not.toHaveBeenCalled();
      await expect(approveDemoIncentiveAction(form({ incentiveId: earned.id }))).rejects.toThrow("REDIRECT:/manager/review?status=saved");
      paymentHtml = renderToStaticMarkup(await ManagerWorkspace({ area: "review" }));
      expect(paymentHtml).toContain("Send approved incentive with PayPal");
      await expect(submitDemoIncentivePayoutAction(form({ incentiveId: earned.id }))).rejects.toThrow("status=saved");
      await expect(submitDemoIncentivePayoutAction(form({ incentiveId: earned.id }))).rejects.toThrow("status=error");
      expect(createPayout).toHaveBeenCalledTimes(1);
      await expect(refreshDemoIncentivePayoutAction(form({ incentiveId: earned.id }))).rejects.toThrow("status=saved");
      expect(getPayout).toHaveBeenCalledWith("MOCK-BATCH", earned.paypalSenderItemId);
      const historical = (await getDemoIncentive(testDb.db))!.incentive;
      expect(historical.status).toBe("PAID");
      const earningsHtml = renderToStaticMarkup(await WorkerWorkspace({ area: "earnings" }));
      expect(earningsHtml).toContain("Paid");
      expect(earningsHtml).toContain("$25.00");
      expect(earningsHtml).not.toContain("MOCK-BATCH");
      expect(renderToStaticMarkup(await WorkerWorkspace({ area: "earnings" }))).not.toContain("720");
      expect(JSON.stringify(await getWorkerWorkspace(testDb.db))).not.toContain("performanceSalesMinor");
      expect(renderToStaticMarkup(await OwnerWorkspace({ area: "payments" }))).toContain("Paid");

      for (const area of managerAreas) expect(renderToStaticMarkup(await ManagerWorkspace({ area }))).not.toContain("Start new demo cycle");
      expect(renderToStaticMarkup(await OperatorWorkspace({ area: "environment" }))).toContain("Start new demo cycle");
      await expect(startNewDemoCycleAction()).rejects.toThrow("REDIRECT:/operator/environment?status=saved");
      const next = (await getDemoWorkerShift(testDb.db))!;
      expect(next.shift.id).not.toBe(current.shift.id);
      expect(next.worker.paypalPayoutEmail).toBe("worker@example.test");
      const [preserved] = await testDb.db.select().from(shiftIncentives).where(eq(shiftIncentives.id, historical.id));
      expect(preserved).toEqual(historical);
      await expect(acceptDemoShiftAction(form({ shiftId: current.shift.id, acknowledged: "yes", termsVersion: String(current.shift.termsVersion) }))).rejects.toThrow("status=error");
      await expect(submitDemoIncentivePayoutAction(form({ incentiveId: historical.id }))).rejects.toThrow("status=error");
      expect(createPayout).toHaveBeenCalledTimes(1);
      expect((await getDemoWorkerShift(testDb.db))?.offer.status).toBe("OFFERED");
    } finally { await testDb.close(); }
  });

  it("keeps owner queries within the organisation and worker queries within the worker", async () => {
    const testDb = await createTestDatabase();
    try {
      const organisationId = randomUUID();
      await testDb.db.insert(organisations).values({ id: organisationId, name: "Unrelated company" });
      await testDb.db.insert(outlets).values({ id: randomUUID(), organisationId, name: "Private other location", timezone: "UTC" });
      await testDb.db.insert(workers).values({ id: randomUUID(), organisationId, displayName: "Private other worker", workerType: "CASUAL" });
      const owner = await getOwnerWorkspace(testDb.db);
      expect(owner.locations).toHaveLength(1);
      expect(JSON.stringify(owner)).not.toContain("Private other");
      expect((await getWorkerWorkspace(testDb.db)).assignments).toEqual([]);
    } finally { await testDb.close(); }
  });
  it("uses real team/policy/requirement actions and shows commission terms with acknowledgement before acceptance", async () => {
    const t = await createTestDatabase();
    try {
      await configure(t.db);
      await expect(createTeamAction(form({ firstName:"Sam", surname:"Taylor", telephone:"+27111234567", email:"sam@example.test" }))).rejects.toThrow("REDIRECT:/manager/team?status=saved");
      let ops = await getOperations(t.db);
      expect(ops.team.find(row=>row.worker.displayName === "Sam Taylor")).toMatchObject({worker:{displayName:"Sam Taylor"},invitation:{state:"CREATED_NOT_SENT"}});
      const teamHtml = renderToStaticMarkup(await ManagerWorkspace({area:"team"}));
      expect(teamHtml).toContain("Sam Taylor");
      expect(teamHtml).toContain("Prepared · not sent");
      expect(teamHtml).not.toContain('name="payoutEmail"');
      expect(teamHtml).not.toContain("Worker Pool");
      await expect(createPolicyAction(form({name:"Commission policy",earningsModel:"COMMISSION",rate:"5"}))).rejects.toThrow("REDIRECT:/owner/policies?status=saved");
      const demo = await publishDemoShift(t.db);
      ops = await getOperations(t.db);
      const departmentId = ops.departments[0].id;
      await expect(createRequirementAction(form({ departmentId, policyId:ops.policies[0].id, headcount:"2", startsAt:"2026-12-01T10:00", endsAt:"2026-12-01T16:00", planDate:"2026-12-01" }))).rejects.toThrow("REDIRECT:/manager/plan?date=2026-12-01&status=saved");
      const requirement = (await getOperations(t.db)).requirements.find(r => r.policyId === ops.policies[0].id)!;
      const offer = await offerAssignment(t.db, requirement.id, demo.worker.id);
      const shiftsHtml = renderToStaticMarkup(await WorkerWorkspace({area:"shifts"}));
      const commissionArticle = shiftsHtml.split("<article").find(a => a.includes("Commission rate"))!;
      expect(commissionArticle).toContain("Verified attributed sales");
      expect(commissionArticle).toContain("5%");
      expect(commissionArticle).not.toContain("Expected work earnings");
      expect(commissionArticle).toContain("I have reviewed and accept the terms of this work assignment");
      expect(commissionArticle).toContain('value="ACCEPTED" disabled=""');
      await expect(respondAssignmentAction(form({offerId:offer.id,termsVersion:"1",response:"ACCEPTED"}))).rejects.toThrow("status=error");
      await expect(respondAssignmentAction(form({offerId:offer.id,termsVersion:"1",response:"ACCEPTED",acknowledged:"yes"}))).rejects.toThrow("status=saved");
      const earningsHtml = renderToStaticMarkup(await WorkerWorkspace({area:"earnings"}));
      expect(earningsHtml).toContain("Commission awaiting verified attributed sales");
      const filtered = renderToStaticMarkup(await ManagerWorkspace({area:"plan",date:"2026-12-01",department:departmentId}));
      expect(filtered).toContain("2 required");
      expect(filtered).toContain("1 accepted");
      expect(filtered).toContain("Sam Taylor");
      expect(filtered).toContain('name="planDate" value="2026-12-01"');
      await expect(ManagerAreaPage({params:Promise.resolve({area:"workers"}),searchParams:Promise.resolve({})})).rejects.toThrow("REDIRECT:/manager/team");
      await expect(WorkerAreaPage({params:Promise.resolve({area:"schedule"}),searchParams:Promise.resolve({})})).rejects.toThrow("REDIRECT:/worker/shifts");
    } finally {await t.close();}
  });

});
