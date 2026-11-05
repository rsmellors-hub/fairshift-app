import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { createDepartment as scopedCreateDepartment, createWorkPolicy as scopedCreateWorkPolicy, createRequirement as scopedCreateRequirement, offerAssignment as scopedOfferAssignment, respondToAssignment as scopedRespondToAssignment, allocateAssignment as scopedAllocateAssignment, getOperations as scopedGetOperations, confirmWork as scopedConfirmWork } from "@/server/scheduling/operations";
import { workAcceptances, shiftOffers, shifts, workAllocations, workers, attributedSales, shiftIncentives } from "@/server/db/schema";
import { DEMO_ORGANISATION_ID, DEMO_OUTLET_ID, DEMO_CASUAL_WORKER_ID } from "@/server/constants";
import { getAllocationSchedule as scopedGetAllocationSchedule } from "@/server/scheduling/allocations";
import { getWorkerWorkspace as scopedGetWorkerWorkspace } from "@/server/product/workspace";
import { publishDemoShift, getDemoWorkerShift, DEMO_SHIFT_TERMS } from "@/server/scheduling/demo";
import { activateWorker, createActivatedTeamMember } from "../helpers/workers";

const member = { firstName: "Sam", surname: "Taylor", telephone: "+27111234567", email: "sam@example.test" };
const scope = { organisationId: DEMO_ORGANISATION_ID, locationId: DEMO_OUTLET_ID };
type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];
const createDepartment = (db: Db, name: string) => scopedCreateDepartment(db, name, scope);
const createWorkPolicy = (db: Db, input: Parameters<typeof scopedCreateWorkPolicy>[1], name: string) => scopedCreateWorkPolicy(db, input, name, scope);
const createRequirement = (db: Db, input: Parameters<typeof scopedCreateRequirement>[1]) => scopedCreateRequirement(db, input, scope);
const offerAssignment = (db: Db, shiftId: string, workerId: string) => scopedOfferAssignment(db, shiftId, workerId, scope);
const respondToAssignment = (db: Db, workerId: string, offerId: string, version: number, response: "ACCEPTED" | "DECLINED", acknowledged: boolean) => scopedRespondToAssignment(db, workerId, offerId, version, response, acknowledged, scope);
const allocateAssignment = (db: Db, offerId: string) => scopedAllocateAssignment(db, offerId, scope);
const getOperations = (db: Db) => scopedGetOperations(db, scope);
const confirmWork = (db: Db, offerId: string) => scopedConfirmWork(db, offerId, scope);
const getAllocationSchedule = (db: Db) => scopedGetAllocationSchedule(db, scope);
const getWorkerWorkspace = (db: Db) => scopedGetWorkerWorkspace(db, { ...scope, workerId: DEMO_CASUAL_WORKER_ID });
async function setup(db: Awaited<ReturnType<typeof createTestDatabase>>["db"], model: "HOURLY" | "DAILY" | "COMMISSION" = "HOURLY", headcount = 2) {
  const [department] = await createDepartment(db, "Mobile & Computing");
  const [policy] = await createWorkPolicy(db, model === "COMMISSION" ? { earningsModel: model, commissionBps: 500, commissionBasis: "VERIFIED_ATTRIBUTED_SALES" } : { earningsModel: model, rateMinor: model === "DAILY" ? 15000 : 2000 }, "Approved terms");
  const requirement = await createRequirement(db, {departmentId: department.id, policyId: policy.id, startsAt: new Date("2026-01-10T08:00:00Z"), endsAt: new Date("2026-01-10T14:00:00Z"), requiredHeadcount: headcount});
  return { department, policy, requirement };
}
describe("operating workflows and audited work terms", () => {
  it("creates location team members with unique stable attribution and honest invitations", async () => {
    const t = await createTestDatabase();
    try {
      await expect(createActivatedTeamMember(t.db, {...member, surname: ""})).rejects.toThrow();
      const first = await createActivatedTeamMember(t.db, member), second = await createActivatedTeamMember(t.db, {...member, firstName: "Robin"});
      expect(first.worker).toMatchObject({...member, locationId: DEMO_OUTLET_ID, paypalPayoutEmail: null});
      expect(first.worker.attributionCode).not.toBe(second.worker.attributionCode);
      expect(first.invitation).toMatchObject({workerId: first.worker.id, state: "CREATED_NOT_SENT"});
      expect(first.invitation.token.length).toBeGreaterThan(20);
      expect((await getOperations(t.db)).team).toHaveLength(2);
      await t.db.update(workers).set({telephone: "+27119999999"}).where(eq(workers.id, first.worker.id));
      expect((await t.db.select().from(workers).where(eq(workers.id, first.worker.id)))[0].attributionCode).toBe(first.worker.attributionCode);
      await expect(t.db.update(workers).set({attributionCode: "changed"}).where(eq(workers.id, first.worker.id))).rejects.toThrow();
    } finally {await t.close();}
  });
  it("supports multiple workers per requirement, independent acceptance, allocation and roster resources", async () => {
    const t = await createTestDatabase();
    try {
      const {requirement, department} = await setup(t.db);
      const a = await createActivatedTeamMember(t.db, member), b = await createActivatedTeamMember(t.db, {...member, firstName: "Robin"});
      const oa = await offerAssignment(t.db, requirement.id, a.worker.id), ob = await offerAssignment(t.db, requirement.id, b.worker.id);
      expect(requirement).toMatchObject({departmentId: department.id, earningsModel: "HOURLY", expectedEarningsMinor: 12000});
      await expect(allocateAssignment(t.db, oa.id)).rejects.toThrow(/Accept/);
      await expect(respondToAssignment(t.db, a.worker.id, oa.id, 1, "ACCEPTED", false)).rejects.toThrow(/acknowledge/);
      await respondToAssignment(t.db, a.worker.id, oa.id, 1, "ACCEPTED", true);
      expect(await t.db.select().from(workAllocations)).toHaveLength(0);
      await allocateAssignment(t.db, oa.id);
      await respondToAssignment(t.db, b.worker.id, ob.id, 1, "ACCEPTED", true);
      await allocateAssignment(t.db, ob.id);
      const schedule = await getAllocationSchedule(t.db);
      expect(schedule.resources).toHaveLength(2);
      expect(schedule.events).toHaveLength(2);
      expect(new Set(schedule.events.map(e => e.id)).size).toBe(2);
      expect(schedule.events.every(e => e.state === "Allocated")).toBe(true);
      await confirmWork(t.db, oa.id);
      expect((await getOperations(t.db)).offers.find(o => o.offer.id === oa.id)?.allocation?.confirmedAt).toBeInstanceOf(Date);
    } finally {await t.close();}
  });
  it("snapshots immutable accepted terms, invalidates acceptance and allocation on material change, and reaccepts a new version", async () => {
    const t = await createTestDatabase();
    try {
      const {requirement} = await setup(t.db);
      const {worker} = await createActivatedTeamMember(t.db, member);
      const offer = await offerAssignment(t.db, requirement.id, worker.id);
      await respondToAssignment(t.db, worker.id, offer.id, 1, "ACCEPTED", true);
      await allocateAssignment(t.db, offer.id);
      const [acceptance] = await t.db.select().from(workAcceptances);
      expect(acceptance.snapshot).toMatchObject({workerId: worker.id, assignmentId: requirement.id, locationId: DEMO_OUTLET_ID, departmentName: "Mobile & Computing", earningsModel: "HOURLY", rateMinor: 2000, expectedEarningsMinor: 12000, termsVersion: 1, acknowledged: true});
      await expect(t.db.update(workAcceptances).set({snapshot: {}})).rejects.toThrow();
      await t.db.update(shifts).set({startsAt: new Date("2026-01-11T08:00:00Z"), endsAt: new Date("2026-01-11T14:00:00Z"), shiftDate: "2026-01-11"}).where(eq(shifts.id, requirement.id));
      expect((await t.db.select().from(shiftOffers))[0]).toMatchObject({status:"OFFERED", acceptedAt:null});
      expect((await t.db.select().from(workAllocations))[0].state).toBe("REACCEPTANCE_REQUIRED");
      await expect(respondToAssignment(t.db, worker.id, offer.id, 1, "ACCEPTED", true)).rejects.toThrow(/changed/);
      await expect(allocateAssignment(t.db, offer.id)).rejects.toThrow();
      await respondToAssignment(t.db, worker.id, offer.id, 2, "ACCEPTED", true);
      await allocateAssignment(t.db, offer.id);
      const snapshots = await t.db.select().from(workAcceptances);
      expect(snapshots).toHaveLength(2);
      expect(snapshots.find(s => s.termsVersion === 1)).toEqual(acceptance);
    } finally {await t.close();}
  });
  it("preserves daily and commission basis and does not create commission payables or attributed sales", async () => {
    for (const model of ["DAILY", "COMMISSION"] as const) {
      const t = await createTestDatabase();
      try {
        const {requirement} = await setup(t.db, model);
        const {worker} = await createActivatedTeamMember(t.db, member);
        const offer = await offerAssignment(t.db, requirement.id, worker.id);
        await respondToAssignment(t.db, worker.id, offer.id, 1, "ACCEPTED", true);
        expect(requirement.expectedEarningsMinor).toBe(model === "DAILY" ? 15000 : null);
        const [accepted] = await t.db.select().from(workAcceptances);
        expect(accepted.snapshot).toMatchObject(model === "DAILY" ? {earningsModel: "DAILY", rateMinor: 15000, expectedEarningsMinor:15000} : {earningsModel:"COMMISSION", rateMinor:null, expectedEarningsMinor:null, commissionBps:500, commissionBasis:"VERIFIED_ATTRIBUTED_SALES"});
        expect(await t.db.select().from(attributedSales)).toHaveLength(0);
        expect(await t.db.select().from(shiftIncentives)).toHaveLength(0);
      } finally {await t.close();}
    }
  });
  it("rejects other workers' responses, declined allocations and accepted overlaps", async () => {
    const t = await createTestDatabase();
    try {
      const {requirement, policy, department} = await setup(t.db);
      const a = await createActivatedTeamMember(t.db, member), b = await createActivatedTeamMember(t.db, {...member, firstName:"Robin"});
      const oa = await offerAssignment(t.db, requirement.id, a.worker.id), ob = await offerAssignment(t.db, requirement.id, b.worker.id);
      await expect(respondToAssignment(t.db, b.worker.id, oa.id, 1, "ACCEPTED", true)).rejects.toThrow(/unavailable/);
      await respondToAssignment(t.db, b.worker.id, ob.id, 1, "DECLINED", false);
      await expect(allocateAssignment(t.db, ob.id)).rejects.toThrow();
      const overlap = await createRequirement(t.db, {departmentId:department.id, policyId:policy.id, startsAt: requirement.startsAt, endsAt:requirement.endsAt, requiredHeadcount:1});
      const overlapOffer = await offerAssignment(t.db, overlap.id, a.worker.id);
      await respondToAssignment(t.db, a.worker.id, oa.id, 1, "ACCEPTED", true);
      await expect(respondToAssignment(t.db, a.worker.id, overlapOffer.id, 1, "ACCEPTED", true)).rejects.toThrow(/overlaps/);
      await expect(offerAssignment(t.db, overlap.id, a.worker.id)).rejects.toThrow(/overlaps/);
      await t.db.update(workers).set({status:"INACTIVE"}).where(eq(workers.id, b.worker.id));
      await expect(offerAssignment(t.db, overlap.id, b.worker.id)).rejects.toThrow(/unavailable/);
      expect(await t.db.select().from(workAllocations)).toHaveLength(0);
    } finally {await t.close();}
  });
  it("keeps team and work policies within the location and worker views private", async () => {
    const t = await createTestDatabase();
    try {
      const {requirement, policy} = await setup(t.db);
      const {worker} = await createActivatedTeamMember(t.db, member);
      await t.db.update(workers).set({locationId:null}).where(eq(workers.id,worker.id));
      await expect(offerAssignment(t.db,requirement.id,worker.id)).rejects.toThrow(/unavailable/);
      expect((await getOperations(t.db)).team).toHaveLength(0);
      const demo = await publishDemoShift(t.db);
      await activateWorker(t.db, demo.worker.id);
      const [sameNameDepartment] = await createDepartment(t.db, DEMO_SHIFT_TERMS.roleName);
      const sameNameRequirement = await createRequirement(t.db, { departmentId:sameNameDepartment.id, policyId:policy.id, startsAt:new Date("2027-01-10T08:00:00Z"),endsAt:new Date("2027-01-10T14:00:00Z"),requiredHeadcount:1 });
      await offerAssignment(t.db, sameNameRequirement.id, demo.worker.id);
      expect((await getDemoWorkerShift(t.db))?.shift.id).toBe(demo.shift.id);
      const privateWorker = await createActivatedTeamMember(t.db, member);
      await offerAssignment(t.db,requirement.id,privateWorker.worker.id);
      const view = await getWorkerWorkspace(t.db);
      expect(view.assignments.every(row => row.offer.workerId === demo.worker.id)).toBe(true);
      expect(JSON.stringify(view)).not.toContain(privateWorker.worker.attributionCode);
      await expect(createRequirement(t.db, {departmentId: randomUUID(), policyId: randomUUID(), startsAt:requirement.startsAt, endsAt:requirement.endsAt, requiredHeadcount:1})).rejects.toThrow();
      expect(await t.db.select().from(workAcceptances).where(and(eq(workAcceptances.workerId, privateWorker.worker.id),eq(workAcceptances.termsVersion,1)))).toHaveLength(0);
    } finally {await t.close();}
  });
  it("versions commission and incentive changes, preserves nonmaterial updates, and locks confirmed work terms", async () => {
    const t = await createTestDatabase();
    try {
      const {requirement} = await setup(t.db, "COMMISSION");
      const {worker} = await createActivatedTeamMember(t.db, member);
      const offer = await offerAssignment(t.db, requirement.id, worker.id);
      await respondToAssignment(t.db, worker.id, offer.id, 1, "ACCEPTED", true);
      await t.db.update(shifts).set({updatedAt:new Date()}).where(eq(shifts.id, requirement.id));
      expect((await t.db.select().from(shifts).where(eq(shifts.id,requirement.id)))[0].termsVersion).toBe(1);
      await t.db.update(shifts).set({commissionBps:600}).where(eq(shifts.id,requirement.id));
      await respondToAssignment(t.db, worker.id, offer.id, 2, "ACCEPTED", true);
      await t.db.update(shifts).set({incentivePolicy:"Revised no-incentive terms"}).where(eq(shifts.id,requirement.id));
      await respondToAssignment(t.db, worker.id, offer.id, 3, "ACCEPTED", true);
      await allocateAssignment(t.db, offer.id);
      await confirmWork(t.db, offer.id);
      await expect(t.db.update(shifts).set({commissionBps:700}).where(eq(shifts.id,requirement.id))).rejects.toThrow();
      const accepted = await t.db.select().from(workAcceptances);
      expect(accepted.map(a => a.termsVersion)).toEqual([1,2,3]);
      expect(accepted[0].snapshot).toMatchObject({commissionBps:500});
      expect(accepted[2].snapshot).toMatchObject({commissionBps:600, incentivePolicy:"Revised no-incentive terms"});
    } finally {await t.close();}
  });

});
