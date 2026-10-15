import { randomUUID } from "node:crypto";
import { and,eq } from "drizzle-orm";
import { afterEach,describe,expect,it,vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createTestDatabase } from "../helpers/database";
import { getDatabase } from "@/server/db/client";
import { registerIdentity,createIdentityToken,redeemIdentityToken,issueSession } from "@/server/auth/identity";
import { createOrganisation,inviteMember,redeemInvitation } from "@/server/auth/tenancy";
import { resolveScope } from "@/server/auth/access";
import { requireScope,requireOperator,selectMembership } from "@/server/auth/request";
import { createPolicyAction,createRequirementAction,respondAssignmentAction } from "@/app/operations-actions";
import { createDepartment,createWorkPolicy,createRequirement,offerAssignment } from "@/server/scheduling/operations";
import { users,shiftOffers,memberships,subscriptions,outlets } from "@/server/db/schema";
import { registerAction,redeemInvitationAction,signOutAction,createOrganisationAction } from "@/app/auth-actions";
import BillingReturn from "@/app/billing/return/page";
const jar=vi.hoisted(()=>new Map<string,string>());
vi.mock("next/headers",()=>({cookies:async()=>({get:(key:string)=>jar.has(key) ? {value:jar.get(key)!}:undefined,set:(key:string,value:string)=>jar.set(key,value),delete:(key:string)=>jar.delete(key)})}));
vi.mock("next/navigation",()=>({redirect:(path:string)=>{throw new Error(`REDIRECT:${path}`);}}));
vi.mock("next/cache",()=>({revalidatePath:vi.fn()}));
vi.mock("@/server/db/client",()=>({getDatabase:vi.fn()}));
vi.mock("@/server/billing/paypal",async importOriginal=>({...await importOriginal<typeof import("@/server/billing/paypal")>(),getSubscriptionAdapter:()=>null}));
vi.mock("@/server/notifications/email",async importOriginal=>({...await importOriginal<typeof import("@/server/notifications/email")>(),getEmailAdapter:()=>({send:async()=>({status:"UNCONFIGURED"})})}));
const password="test-password-for-account";
const form=(input:Record<string,string>)=>{const f=new FormData();for(const [key,value]of Object.entries(input))f.set(key,value);return f;};
async function bootstrap(db:ReturnType<typeof getDatabase>) {
 const u=await registerIdentity(db,{email:"owner@example.test",name:"Owner",password});
 await redeemIdentityToken(db,await createIdentityToken(db,u.id,"VERIFY_EMAIL"),"VERIFY_EMAIL");
 const o=await createOrganisation(db,u.id,{name:"One",locationName:"HQ"});
 return {u,o,scope:await resolveScope(db,u.id,o.membershipId)};
}
afterEach(()=>{jar.clear();vi.clearAllMocks();vi.unstubAllEnvs();});
describe("authenticated HTTP action boundary",()=>{
 it("rejects unauthenticated and tampered sessions before protected mutations",async()=>{
  const t=await createTestDatabase();try {
   vi.mocked(getDatabase).mockReturnValue(t.db);
   await expect(createPolicyAction(form({name:"Injected",rate:"5",earningsModel:"DAILY"}))).rejects.toThrow("REDIRECT:/sign-in");
   jar.set("fairshift_session","forged");
   await expect(requireScope(["OWNER"])).rejects.toThrow("REDIRECT:/sign-in");
   expect(await t.db.select().from(memberships)).toHaveLength(0);
  }finally{await t.close();}
 });
 it("registration creates identity/session only and invitation action ignores submitted authority",async()=>{
  const t=await createTestDatabase();try {
   vi.mocked(getDatabase).mockReturnValue(t.db);
   const o=await bootstrap(t.db);
   const invitation=await inviteMember(t.db,o.scope,{role:"TEAM_MEMBER",email:"join@example.test",firstName:"Sam",surname:"Taylor",telephone:"+27111234567"});
   await expect(registerAction(form({name:"Join",email:"join@example.test",password,role:"OWNER",organisationId:o.o.organisationId}))).rejects.toThrow("REDIRECT:/account");
   const [u]=await t.db.select().from(users).where(eq(users.email,"join@example.test"));
   expect(await t.db.select().from(memberships).where(eq(memberships.userId,u.id))).toHaveLength(0);
   await expect(redeemInvitationAction(form({token:invitation.token,role:"OWNER",locationId:randomUUID()}))).rejects.toThrow("REDIRECT:/worker");
   expect(await requireScope(["TEAM_MEMBER"])).toMatchObject({userId:u.id,role:"TEAM_MEMBER",locationId:o.o.locationId});
   await expect(createPolicyAction(form({name:"Escalation",rate:"5",earningsModel:"DAILY"}))).rejects.toThrow("REDIRECT:/account");
   await expect(requireOperator()).rejects.toThrow(/denied/);
   await expect(signOutAction()).rejects.toThrow("REDIRECT:/sign-in");
   await expect(requireScope(["TEAM_MEMBER"])).rejects.toThrow("REDIRECT:/sign-in");
  }finally{await t.close();}
 });
 it("rejects worker IDOR through real actions, Owner IDs through session selection, and revoked memberships",async()=>{
  const t=await createTestDatabase();try {
   vi.mocked(getDatabase).mockReturnValue(t.db);const o=await bootstrap(t.db);
   const joins=[];
   for(const email of ["a@example.test","b@example.test"]) {
    const i=await inviteMember(t.db,o.scope,{role:"TEAM_MEMBER",email,firstName:"Sam",surname:"Taylor",telephone:"+27111234567"});
    const u=await registerIdentity(t.db,{email,name:"Sam",password});const m=await redeemInvitation(t.db,u.id,{token:i.token});joins.push({u,m});
   }
   const [d]=await createDepartment(t.db,"Sales",o.scope),[p]=await createWorkPolicy(t.db,{earningsModel:"DAILY",rateMinor:10000},"Daily",o.scope);
   const shift=await createRequirement(t.db,{departmentId:d.id,policyId:p.id,startsAt:new Date("2027-01-01T08:00Z"),endsAt:new Date("2027-01-01T14:00Z"),requiredHeadcount:2},o.scope);
   const offer=await offerAssignment(t.db,shift.id,joins[1].m.workerId!,o.scope);
   jar.set("fairshift_session",await issueSession(t.db,joins[0].u.id));
   await expect(respondAssignmentAction(form({offerId:offer.id,termsVersion:"1",response:"ACCEPTED",acknowledged:"yes",workerId:joins[1].m.workerId!}))).rejects.toThrow("status=error");
   expect((await t.db.select().from(shiftOffers).where(eq(shiftOffers.id,offer.id)))[0].status).toBe("OFFERED");
   await expect(selectMembership(o.o.membershipId)).rejects.toThrow(/denied/);
   await t.db.update(memberships).set({state:"REVOKED"}).where(eq(memberships.id,joins[0].m.id));
   await expect(requireScope(["TEAM_MEMBER"])).rejects.toThrow("REDIRECT:/account");
  }finally{await t.close();}
 });
 it("uses authoritative stored subscription on browser return and rejects foreign location IDs",async()=>{
  const t=await createTestDatabase();try {
   vi.mocked(getDatabase).mockReturnValue(t.db);const o=await bootstrap(t.db);
   jar.set("fairshift_session",await issueSession(t.db,o.u.id));
   await t.db.update(subscriptions).set({status:"APPROVAL_PENDING",providerId:"I-MOCK",planId:"P-MOCK"}).where(eq(subscriptions.organisationId,o.o.organisationId));
   expect(renderToStaticMarkup(await BillingReturn())).toContain("APPROVAL_PENDING");
   expect((await t.db.select().from(subscriptions).where(eq(subscriptions.organisationId,o.o.organisationId)))[0].status).toBe("APPROVAL_PENDING");
   jar.set("fairshift_location",randomUUID());await expect(requireScope(["OWNER"])).rejects.toThrow(/denied/);
   jar.delete("fairshift_location");
   jar.set("fairshift_location",o.o.locationId);
   await expect(createOrganisationAction(form({name:"Second",locationName:"Second HQ"}))).rejects.toThrow("REDIRECT:/owner/settings");
   const secondScope=await requireScope(["OWNER"]);expect(secondScope.organisationId).not.toBe(o.o.organisationId);
   expect(secondScope.locationName).toBe("Second HQ");
   await expect(createRequirementAction(form({departmentId:randomUUID(),policyId:randomUUID(),headcount:"1",startsAt:"2027-01-01T10:00",endsAt:"2027-01-01T16:00"}))).rejects.toThrow("status=error");
   expect(await t.db.select().from(outlets).where(and(eq(outlets.id,o.o.locationId),eq(outlets.organisationId,o.o.organisationId)))).toHaveLength(1);
  }finally{await t.close();}
 });
});
