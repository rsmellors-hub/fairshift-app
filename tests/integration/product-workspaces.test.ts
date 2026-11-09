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
import { operatorAreas } from "@/app/operator/workspace";
import { acceptDemoShiftAction, approveDemoIncentiveAction, publishDemoShiftAction, recordDemoPerformanceAction, refreshDemoIncentivePayoutAction, saveDemoPayoutDestinationAction, submitDemoIncentivePayoutAction } from "@/app/scheduling-actions";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { getPayPalPayoutClient } from "@/server/integrations/paypal/factory";
import { getOwnerWorkspace as scopedGetOwnerWorkspace, getWorkerWorkspace as scopedGetWorkerWorkspace } from "@/server/product/workspace";
import { organisations, outlets, shifts, workers, users, memberships, subscriptions } from "@/server/db/schema";
import { createTeamAction, createPolicyAction, respondAssignmentAction } from "@/app/operations-actions";
import { getOperations as scopedGetOperations } from "@/server/scheduling/operations";
import { publishDemoShift } from "@/server/scheduling/demo";
import { ensureDemoCasualWorker } from "@/server/scheduling/demo";
import { DEMO_ORGANISATION_ID, DEMO_OUTLET_ID, DEMO_CASUAL_WORKER_ID } from "@/server/constants";
import { createTestDatabase } from "../helpers/database";
import { legacyCommissionOffer, legacyCommissionShift } from "../helpers/legacy-commission";
const demoScope = { organisationId: DEMO_ORGANISATION_ID, locationId: DEMO_OUTLET_ID };
type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];
const getOwnerWorkspace = (db: Db) => scopedGetOwnerWorkspace(db, DEMO_ORGANISATION_ID);
const getWorkerWorkspace = (db: Db) => scopedGetWorkerWorkspace(db, { ...demoScope, workerId: DEMO_CASUAL_WORKER_ID });
const getOperations = (db: Db) => scopedGetOperations(db, demoScope);

vi.mock("@/server/auth/request", () => ({
 requireScope:vi.fn(async (roles:string[])=>({userId:"90000000-0000-4000-8000-000000000001",organisationId:"10000000-0000-4000-8000-000000000001",locationId:"20000000-0000-4000-8000-000000000001",workerId:roles.includes("TEAM_MEMBER") ? "30000000-0000-4000-8000-000000000001":undefined,role:roles.includes("TEAM_MEMBER") ? "TEAM_MEMBER":"OWNER",organisationName:"Demo",locationName:"Rosebank Kitchen"})),
 requireOperator:vi.fn(async()=>({id:"90000000-0000-4000-8000-000000000001"})),
}));
vi.mock("@/server/db/client", () => ({ getDatabase: vi.fn() }));
vi.mock("@/server/config/env", () => ({ getConfigurationStatus: vi.fn() }));
vi.mock("@/server/integrations/paypal/factory", () => ({ getPayPalPayoutClient: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); }, notFound: () => { throw new Error("NOT_FOUND"); }, usePathname: () => "/operator", useRouter: () => ({ refresh() {} }) }));
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

  it("rejects legacy fixed-identity writes and never calls the old payout adapter", async () => {
    const t = await createTestDatabase();
    try {
      await configure(t.db);
      const createPayout = vi.fn();
      vi.mocked(getPayPalPayoutClient).mockReturnValue({ createPayout } as unknown as ReturnType<typeof getPayPalPayoutClient>);
      await expect(saveDemoPayoutDestinationAction(form({ payoutEmail: "worker@example.test" }))).rejects.toThrow("REDIRECT:/worker/profile?status=saved");
      expect((await getWorkerWorkspace(t.db)).profile?.paypalPayoutEmail).toBe("worker@example.test");
      await expect(publishDemoShiftAction(form({ workerSelected: "yes" }))).rejects.toThrow("Access denied.");
      await expect(acceptDemoShiftAction(form({ shiftId: randomUUID() }))).rejects.toThrow("Access denied.");
      await expect(recordDemoPerformanceAction(form({ shiftId: randomUUID(), completed: "yes", performanceSales: "1" }))).rejects.toThrow("Access denied.");
      await expect(approveDemoIncentiveAction(form({ incentiveId: randomUUID() }))).rejects.toThrow("Access denied.");
      await expect(submitDemoIncentivePayoutAction(form({ incentiveId: randomUUID() }))).rejects.toThrow("Legacy incentive payout is unavailable.");
      await expect(refreshDemoIncentivePayoutAction(form({ incentiveId: randomUUID() }))).rejects.toThrow("Legacy incentive payout is unavailable.");
      expect(await t.db.select().from(shifts)).toHaveLength(0);
      expect(createPayout).not.toHaveBeenCalled();
      expect(getPayPalPayoutClient).not.toHaveBeenCalled();
      const manager = renderToStaticMarkup(await ManagerWorkspace({ area: "review" }));
      expect(manager).not.toContain("Send approved incentive with PayPal");
      expect(manager).not.toContain("Controlled demo assignment");
    } finally { await t.close(); }
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
      // Commission casual terms are refused when written (Day 6, Step 3a).
      await expect(createPolicyAction(form({name:"Commission policy",earningsModel:"COMMISSION",rate:"5"}))).rejects.toThrow("REDIRECT:/owner/policies?status=policy-commission");
      const demo = await publishDemoShift(t.db);
      ops = await getOperations(t.db);
      const departmentId = ops.departments[0].id;
      // Commission terms made before that rule are still shown to the worker with their basis, here written directly.
      const { shift: requirement } = await legacyCommissionShift(t.db, demoScope, { departmentId, startsAt: new Date("2026-12-01T10:00:00Z"), endsAt: new Date("2026-12-01T16:00:00Z"), requiredHeadcount: 2 });
      const offer = await legacyCommissionOffer(t.db, requirement.id, demo.worker.id);
      const shiftsHtml = renderToStaticMarkup(await WorkerWorkspace({area:"shifts"}));
      const commissionArticle = shiftsHtml.split("<article").find(a => a.includes("% commission"))!;
      expect(commissionArticle).toContain("of sales recorded to you");
      expect(commissionArticle).toContain("5% commission");
      expect(commissionArticle).not.toContain("You’ll earn this");
      expect(commissionArticle).toContain("I’ve read the details above and agree to this work and pay.");
      expect(commissionArticle).toContain('value="ACCEPTED" disabled=""');
      await expect(respondAssignmentAction(form({offerId:offer.id,termsVersion:"1",response:"ACCEPTED"}))).rejects.toThrow("status=error");
      await expect(respondAssignmentAction(form({offerId:offer.id,termsVersion:"1",response:"ACCEPTED",acknowledged:"yes"}))).rejects.toThrow("status=saved");
      const earningsHtml = renderToStaticMarkup(await WorkerWorkspace({area:"earnings"}));
      expect(earningsHtml).toContain("Commission awaiting verified attributed sales");
      const filtered = renderToStaticMarkup(await ManagerWorkspace({area:"fill",date:"2026-12-01",department:departmentId}));
      expect(filtered).toContain("2 needed");
      expect(filtered).toContain("1 accepted");
      expect(filtered).toContain("Sam Taylor");
      expect(filtered).toContain('name="planDate" value="2026-12-01"');
      await expect(ManagerAreaPage({params:Promise.resolve({area:"workers"}),searchParams:Promise.resolve({})})).rejects.toThrow("REDIRECT:/manager/team");
      await expect(WorkerAreaPage({params:Promise.resolve({area:"schedule"}),searchParams:Promise.resolve({})})).rejects.toThrow("REDIRECT:/worker/shifts");
    } finally {await t.close();}
  });

});
