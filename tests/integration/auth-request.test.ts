import { offerFromScheduleAction } from "@/app/schedule-actions";
import { createOrganisation } from "../helpers/onboarding";
import { personal, business, entitled, setupFields } from "../helpers/onboarding";
import { randomUUID } from "node:crypto";
import { and,eq } from "drizzle-orm";
import { afterEach,describe,expect,it,vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createTestDatabase } from "../helpers/database";
import { getDatabase } from "@/server/db/client";
import { registerIdentity,createIdentityToken,redeemIdentityToken,issueSession } from "@/server/auth/identity";
import { inviteMember,redeemInvitation } from "@/server/auth/tenancy";
import { resolveScope } from "@/server/auth/access";
import { requireFinancialScope,requireScope,requireMembershipScope,requireOperator,selectMembership } from "@/server/auth/request";
import { createPolicyAction,createRequirementAction,respondAssignmentAction,saveAvailabilityAction } from "@/app/operations-actions";
import { createDepartment,createWorkPolicy,createRequirement,offerAssignment } from "@/server/scheduling/operations";
import { users,shiftOffers,memberships,subscriptions,outlets,organisations } from "@/server/db/schema";
import { registerAction,redeemInvitationAction,signOutAction,completeWorkplaceAction,verifyEmailAction,signInAction,createLocationAction } from "@/app/auth-actions";
import OwnerLayout from "@/app/owner/layout";
import OwnerPage from "@/app/owner/page";
import { OwnerWorkspace, ownerAreas } from "@/app/owner/workspace";
import ManagerLayout from "@/app/manager/layout";
import WorkerLayout from "@/app/worker/layout";
import Subscribe from "@/app/subscribe/page";
import Register from "@/app/register/page";
import Onboarding from "@/app/onboarding/page";
import Account from "@/app/account/page";
import SettlementsPage from "@/app/settlements/page";
import { POST as createOrder } from "@/app/api/paypal/orders/route";
import { inviteAction, selectLocationAction, refreshSubscriptionAction, selectMembershipAction, savePersonalAction, saveBusinessAction } from "@/app/auth-actions";
import { importAttributedSalesAction, confirmPerformanceAction } from "@/app/operations-actions";
import { createTeamAction, createDepartmentAction, offerAssignmentAction, allocateAssignmentAction, confirmWorkAction, changeAssignmentAction, approvePayableAction, sendPayoutAction, refreshPayoutAction, saveOrganisationWorkloadPolicyAction, saveLocationWorkloadPolicyAction, clearOrganisationWorkloadPolicyAction, clearLocationWorkloadPolicyAction, saveRegularCoverageAction } from "@/app/operations-actions";
import { submitDemoIncentivePayoutAction } from "@/app/scheduling-actions";
import BillingReturn from "@/app/billing/return/page";
const jar=vi.hoisted(()=>new Map<string,string>());
vi.mock("next/headers",()=>({cookies:async()=>({get:(key:string)=>jar.has(key) ? {value:jar.get(key)!}:undefined,set:(key:string,value:string)=>jar.set(key,value),delete:(key:string)=>jar.delete(key)})}));
vi.mock("next/navigation",()=>({redirect:(path:string)=>{throw new Error(`REDIRECT:${path}`);},usePathname:()=>"/owner",useRouter:()=>({replace:vi.fn()})}));
vi.mock("next/cache",()=>({revalidatePath:vi.fn()}));
vi.mock("@/server/db/client",()=>({getDatabase:vi.fn()}));
vi.mock("@/server/billing/paypal",async importOriginal=>({...await importOriginal<typeof import("@/server/billing/paypal")>(),getSubscriptionAdapter:()=>null}));
vi.mock("@/server/notifications/email",async importOriginal=>({...await importOriginal<typeof import("@/server/notifications/email")>(),getEmailAdapter:()=>({send:async()=>({status:"UNCONFIGURED"})})}));
const password="test-password-for-account";
const form=(input:Record<string,string>)=>{const f=new FormData();for(const [key,value]of Object.entries(input))f.set(key,value);return f;};
async function bootstrap(db:ReturnType<typeof getDatabase>) {
 const u=await registerIdentity(db,{email:"owner@example.test",password});
 await redeemIdentityToken(db,await createIdentityToken(db,u.id,"VERIFY_EMAIL"),"VERIFY_EMAIL");
 const o=await createOrganisation(db,u.id,{...business,name:"One",locationName:"HQ"});
 await entitled(db,o.organisationId);
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
   await expect(registerAction(form({...personal,email:"join@example.test",password,role:"OWNER",organisationId:o.o.organisationId}))).rejects.toThrow("REDIRECT:/check-email");
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
    const u=await registerIdentity(t.db,{email,password});const m=await redeemInvitation(t.db,u.id,{token:i.token});joins.push({u,m});
   }
   const [d]=await createDepartment(t.db,"Sales",o.scope),[p]=await createWorkPolicy(t.db,{earningsModel:"DAILY",rateMinor:30000},"Daily",o.scope);
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
   expect(renderToStaticMarkup(await BillingReturn())).toContain("Setting up your FairShift account");
   expect((await t.db.select().from(subscriptions).where(eq(subscriptions.organisationId,o.o.organisationId)))[0].status).toBe("APPROVAL_PENDING");
   await expect(requireScope(["OWNER"])).rejects.toThrow("REDIRECT:/subscribe");
   await expect(completeWorkplaceAction({},form({...setupFields,name:"Second",locationName:"Second HQ"}))).resolves.toMatchObject({message:expect.stringContaining("couldn’t save")});
   expect(await t.db.select().from(memberships).where(eq(memberships.userId,o.u.id))).toHaveLength(1);
   await entitled(t.db,o.o.organisationId);
   jar.set("fairshift_location",randomUUID());await expect(requireScope(["OWNER"])).rejects.toThrow(/denied/);
   jar.delete("fairshift_location");
   await expect(createRequirementAction(form({departmentId:randomUUID(),policyId:randomUUID(),headcount:"1",startsAt:"2027-01-01T10:00",endsAt:"2027-01-01T16:00"}))).rejects.toThrow("status=error");
   expect(await t.db.select().from(outlets).where(and(eq(outlets.id,o.o.locationId),eq(outlets.organisationId,o.o.organisationId)))).toHaveLength(1);
  }finally{await t.close();}
 });
});

describe("Owner operating a location without a Manager account",()=>{
 it("shows an Owner shell in operations, offers a location switch only with a choice, and keeps a Manager to their location",async()=>{
  const t=await createTestDatabase();try {
   vi.mocked(getDatabase).mockReturnValue(t.db);const o=await bootstrap(t.db);
   jar.set("fairshift_session",await issueSession(t.db,o.u.id));
   // One location: Owner role and navigation, no selector, the only location already in scope.
   let html=renderToStaticMarkup(await ManagerLayout({children:"Operations"}));
   expect(html).toContain('aria-label="Owner navigation"');
   expect(html).not.toContain('aria-label="Manager navigation"');
   for (const href of ["/manager/plan","/manager/fill","/manager/allocations","/manager/team","/manager/review","/owner"]) expect(html).toContain(`href="${href}"`);
   expect(html).not.toContain("Operating location");
   expect((await requireScope(["OWNER","MANAGER"])).locationId).toBe(o.o.locationId);
   // A second active location brings the switch, listing only this organisation's active locations.
   const second=randomUUID();
   await t.db.insert(outlets).values({id:second,organisationId:o.o.organisationId,name:"Riverside",timezone:"Europe/London"});
   await t.db.insert(outlets).values({id:randomUUID(),organisationId:o.o.organisationId,name:"Closed site",timezone:"Europe/London",active:false});
   html=renderToStaticMarkup(await ManagerLayout({children:"Operations"}));
   expect(html).toContain("Operating location");
   expect(html).toContain("Riverside");
   expect(html).not.toContain("Closed site");
   // Switching returns to the operational page and every operation then resolves there.
   await expect(selectLocationAction(form({locationId:second,next:"/manager/fill"}))).rejects.toThrow("REDIRECT:/manager/fill");
   expect(await requireScope(["OWNER","MANAGER"])).toMatchObject({role:"OWNER",locationId:second,locationName:"Riverside"});
   // Only known operational paths are returned to.
   for (const next of ["https://elsewhere.example/manager/fill","//elsewhere.example","/manager/fill?date=2027-01-01","/worker"]) await expect(selectLocationAction(form({locationId:o.o.locationId,next}))).rejects.toThrow("REDIRECT:/owner/policies");
   await expect(selectLocationAction(form({locationId:randomUUID(),next:"/manager/fill"}))).rejects.toThrow(/denied/);
   expect(jar.get("fairshift_location")).toBe(o.o.locationId);
   // A Manager of the first location stays there, whatever location the browser names.
   const i=await inviteMember(t.db,{...o.scope,locationId:o.o.locationId},{role:"MANAGER",email:"manager@example.test",firstName:"Sam",surname:"Taylor",telephone:"+27111234567"});
   const mu=await registerIdentity(t.db,{email:"manager@example.test",password});await redeemInvitation(t.db,mu.id,{token:i.token});
   jar.set("fairshift_session",await issueSession(t.db,mu.id));jar.set("fairshift_location",second);
   expect(await requireScope(["OWNER","MANAGER"])).toMatchObject({role:"MANAGER",locationId:o.o.locationId});
   html=renderToStaticMarkup(await ManagerLayout({children:"Operations"}));
   expect(html).toContain('aria-label="Manager navigation"');
   expect(html).not.toContain("Operating location");
   expect(html).not.toContain('href="/owner');
   await expect(selectLocationAction(form({locationId:second,next:"/manager/fill"}))).rejects.toThrow("REDIRECT:/account");
  }finally{await t.close();}
 });
});

describe("subscription gate at real application boundaries",()=>{
 it("keeps active payment returns in the operational workspace and restricts an inactive Manager to settlements",async()=>{
  const t=await createTestDatabase();try {
   vi.mocked(getDatabase).mockReturnValue(t.db);
   vi.stubEnv("DATABASE_URL","postgresql://localhost/not-used");
   vi.stubEnv("FAIRSHIFT_DEPLOYMENT_MODE","LIVE_CUSTOMER");
   const o=await bootstrap(t.db);
   const invitation=await inviteMember(t.db,o.scope,{role:"MANAGER",email:"manager@example.test",firstName:"Pat",surname:"Manager",telephone:"+441130000001"});
   const manager=await registerIdentity(t.db,{email:"manager@example.test",password});
   await redeemInvitation(t.db,manager.id,{token:invitation.token});
   jar.set("fairshift_session",await issueSession(t.db,manager.id));
   await expect(SettlementsPage({searchParams:Promise.resolve({status:"saved"})})).rejects.toThrow("REDIRECT:/manager/review?status=saved");
   const active=renderToStaticMarkup(await ManagerLayout({children:"Schedule"}));
   expect(active).toContain('href="/manager/allocations"');
   expect(active).toContain('href="/manager/review"');
   await t.db.update(subscriptions).set({status:"EXPIRED"}).where(eq(subscriptions.organisationId,o.o.organisationId));
   await expect(ManagerLayout({children:"Schedule"})).rejects.toThrow("subscription-required");
   await expect(createRequirementAction(new FormData())).rejects.toThrow("subscription-required");
   await expect(offerFromScheduleAction({shiftId:randomUUID(),workerId:randomUUID()})).rejects.toThrow("subscription-required");
   const html=renderToStaticMarkup(await SettlementsPage({searchParams:Promise.resolve({})}));
   expect(html).toContain("Payments &amp; approvals");
   expect(html).toContain("Confirm completed work");
   for(const href of ["/manager/allocations","/manager/fill","/manager/plan"]) expect(html).not.toContain(`href="${href}"`);
  }finally{await t.close();}
 });
 it("denies direct Owner routes and protected mutations for every non-entitled state, with no operational navigation in setup",async()=>{
  const t=await createTestDatabase();try {
   vi.mocked(getDatabase).mockReturnValue(t.db);
   vi.stubEnv("DATABASE_URL","postgresql://localhost/not-used");
   vi.stubEnv("FAIRSHIFT_DEPLOYMENT_MODE","LIVE_CUSTOMER");
   const o=await bootstrap(t.db);jar.set("fairshift_session",await issueSession(t.db,o.u.id));
   for (const status of ["UNCONFIGURED","PENDING","APPROVAL_PENDING","APPROVED","SUSPENDED","CANCELLED","EXPIRED"]) {
    await t.db.update(subscriptions).set({status}).where(eq(subscriptions.organisationId,o.o.organisationId));
    await expect(OwnerLayout({children:"Protected"})).rejects.toThrow("REDIRECT:/subscribe");
    for (const area of ownerAreas) await expect(OwnerWorkspace({area})).rejects.toThrow("REDIRECT:/subscribe");
    for (const action of [createPolicyAction,createRequirementAction,createTeamAction,createDepartmentAction,offerAssignmentAction,allocateAssignmentAction,changeAssignmentAction,inviteAction,selectLocationAction,submitDemoIncentivePayoutAction,saveOrganisationWorkloadPolicyAction,saveLocationWorkloadPolicyAction,clearOrganisationWorkloadPolicyAction,clearLocationWorkloadPolicyAction,saveRegularCoverageAction,importAttributedSalesAction,confirmPerformanceAction]) {
     await expect(action(new FormData())).rejects.toThrow("REDIRECT:/subscribe");
    }
    await expect(ManagerLayout({children:"Protected"})).rejects.toThrow("REDIRECT:/subscribe");
    await expect(offerFromScheduleAction({shiftId:randomUUID(),workerId:randomUUID()})).rejects.toThrow("REDIRECT:/subscribe");
    expect(await requireFinancialScope(["OWNER","MANAGER"])).toMatchObject({organisationId:o.o.organisationId,role:"OWNER"});
    const settlements=renderToStaticMarkup(await SettlementsPage({searchParams:Promise.resolve({})}));
    expect(settlements).toContain("Payments &amp; approvals");
    expect(settlements).toContain("Confirm completed work");
    expect(settlements).toContain("No finished allocated work is waiting for confirmation.");
    for (const operational of ["Create a shift","Send offer","Finalise allocation","Confirm sales results","Forecast &amp; staffing"]) expect(settlements).not.toContain(operational);
    for (const action of [confirmWorkAction,approvePayableAction]) await expect(action(new FormData())).rejects.toThrow("REDIRECT:/settlements?status=error");
    for (const action of [sendPayoutAction,refreshPayoutAction]) await expect(action(new FormData())).rejects.toThrow("REDIRECT:/settlements?status=sandbox-isolation-required");
   }
   await expect(Onboarding()).rejects.toThrow("REDIRECT:/subscribe");
   await expect(savePersonalAction(form({...personal,firstName:"Changed",userId:randomUUID(),email:"forged@example.test"}))).rejects.toThrow("REDIRECT:/subscribe");
   await expect(saveBusinessAction(form({...business,name:"One",organisationId:randomUUID()}))).rejects.toThrow("REDIRECT:/onboarding?status=error");
   const account=renderToStaticMarkup(await Account({searchParams:Promise.resolve({})}));
   expect(account).toContain("Choose your plan");expect(account).not.toContain("Open workspace");
   await expect(refreshSubscriptionAction()).rejects.toThrow("REDIRECT:/subscribe");
   await expect(selectMembershipAction(form({membershipId:o.o.membershipId}))).rejects.toThrow("REDIRECT:/subscribe");
   const response=await createOrder(new Request("http://localhost/api/paypal/orders",{method:"POST"}));
   expect(response.status).toBe(403); // Platform-only API cannot be used as an Owner billing/payout bypass.
   await entitled(t.db,o.o.organisationId);
   expect(renderToStaticMarkup(await OwnerLayout({children:"Protected"}))).toContain("Owner navigation");
   expect(await requireScope(["OWNER"])).toMatchObject({organisationId:o.o.organisationId});
  }finally{await t.close();}
 });
 it("keeps invitation redemption/account establishment available but denies Manager and Worker operational access without organisation entitlement",async()=>{
  const t=await createTestDatabase();try {
   vi.mocked(getDatabase).mockReturnValue(t.db);const o=await bootstrap(t.db);
   const invites=[];
   for(const role of ["MANAGER","TEAM_MEMBER"] as const) invites.push(await inviteMember(t.db,o.scope,{role,email:`${role.toLowerCase()}@example.test`,firstName:"Sam",surname:"Taylor",telephone:"+27111234567"}));
   await t.db.update(subscriptions).set({status:"SUSPENDED"}).where(eq(subscriptions.organisationId,o.o.organisationId));
   for(const i of invites) {
    const u=await registerIdentity(t.db,{email:i.invitation.email,password});
    jar.set("fairshift_session",await issueSession(t.db,u.id));
    await expect(redeemInvitationAction(form({token:i.token,role:"OWNER"}))).rejects.toThrow("REDIRECT:/account?status=subscription-required");
    const role=i.invitation.role as "MANAGER"|"TEAM_MEMBER";
    const scope=await requireMembershipScope([role]);expect(scope.organisationId).toBe(o.o.organisationId);
    await expect(OwnerLayout({children:"Protected"})).rejects.toThrow("REDIRECT:/account");
    await expect(OwnerPage({})).rejects.toThrow("REDIRECT:/account");
    await expect(requireScope([role])).rejects.toThrow("REDIRECT:/account?status=subscription-required");
    const layout=role === "MANAGER" ? ManagerLayout:WorkerLayout;
    await expect(layout({children:"Protected"})).rejects.toThrow("REDIRECT:/account?status=subscription-required");
    if(role === "MANAGER") expect(await requireFinancialScope(["OWNER","MANAGER"])).toMatchObject({role:"MANAGER",organisationId:o.o.organisationId,locationId:o.o.locationId});
    await t.db.update(subscriptions).set({status:"ACTIVE"}).where(eq(subscriptions.organisationId,o.o.organisationId));
    await t.db.update(organisations).set({setupCompletedAt:null}).where(eq(organisations.id,o.o.organisationId));
    await expect(requireScope([role])).rejects.toThrow("REDIRECT:/account?status=setup-required");
    await expect(layout({children:"Protected"})).rejects.toThrow("REDIRECT:/account?status=setup-required");
    await t.db.update(organisations).set({setupCompletedAt:new Date()}).where(eq(organisations.id,o.o.organisationId));
    await t.db.update(subscriptions).set({status:"SUSPENDED"}).where(eq(subscriptions.organisationId,o.o.organisationId));
    if(role === "MANAGER") {
     await expect(createTeamAction(new FormData())).rejects.toThrow("subscription-required");
     await expect(inviteMember(t.db,scope,{role:"TEAM_MEMBER",email:"blocked@example.test",...personal})).rejects.toThrow(/active organisation subscription/);
    } else {
     await expect(respondAssignmentAction(new FormData())).rejects.toThrow("subscription-required");
     await expect(saveAvailabilityAction(new FormData())).rejects.toThrow("subscription-required");
    }
    const html=renderToStaticMarkup(await Account({searchParams:Promise.resolve({status:"subscription-required"})}));
    expect(html).toContain("Contact your Owner");expect(html).not.toContain("Open workspace");
    await expect(redeemInvitationAction(form({token:i.token}))).rejects.toThrow("REDIRECT:/invite?status=error");
   }
   jar.set("fairshift_session",await issueSession(t.db,o.u.id));
   await expect(inviteMember(t.db,o.scope,{role:"MANAGER",email:"blocked@example.test",...personal})).rejects.toThrow(/active organisation subscription/);
   await entitled(t.db,o.o.organisationId);
   expect(await requireScope(["OWNER"])).toMatchObject({role:"OWNER"});
  }finally{await t.close();}
 });
});

describe("subscription-first UI and verification continuation",()=>{
 it("keeps email/password registration minimal and continues the same verified session without another login",async()=>{
  const t=await createTestDatabase();try {
   vi.mocked(getDatabase).mockReturnValue(t.db);
   const page=renderToStaticMarkup(await Register({searchParams:Promise.resolve({})}));
   expect(page).toContain('name="email"');expect(page).toContain('name="password"');
   for(const name of ["title","firstName","surname","telephone","position","businessAddress","locationName"]) expect(page).not.toContain(`name="${name}"`);
   const u=await registerIdentity(t.db,{email:"new-owner@example.test",password});
   jar.set("fairshift_session",await issueSession(t.db,u.id));
   const session=jar.get("fairshift_session");
   await expect(Subscribe({searchParams:Promise.resolve({})})).rejects.toThrow("REDIRECT:/account?status=verify-email");
   const token=await createIdentityToken(t.db,u.id,"VERIFY_EMAIL");
   await expect(verifyEmailAction(form({token}))).rejects.toThrow("REDIRECT:/subscribe");
   expect(jar.get("fairshift_session")).toBe(session);
   const plans=renderToStaticMarkup(await Subscribe({searchParams:Promise.resolve({period:"ANNUAL"})}));
   for(const text of ["Venue","Group","Enterprise","Contact FairShift","1 location","Up to 5 locations","R4,990","R11,490","R4,990/year incl. 15% VAT — billed by PayPal as US$301.73; your bank or PayPal converts at its own rate.","R11,490/year incl. 15% VAT — billed by PayPal as US$694.76; your bank or PayPal converts at its own rate.","Save 17%","6+ locations","Checkout isn’t available"]) expect(plans).toContain(text);
   expect(plans).not.toContain("£");expect(plans).not.toMatch(/no (currency )?conversion fees?/i);
   for(const name of ["firstName","businessAddress","locationName"]) expect(plans).not.toContain(`name="${name}"`);
   expect(plans).not.toContain('value="ENTERPRISE"');expect(plans).not.toContain("/owner/");
   expect(await t.db.select().from(memberships).where(eq(memberships.userId,u.id))).toHaveLength(0);
   await expect(verifyEmailAction(form({token}))).rejects.toThrow("REDIRECT:/verify-email?status=error");
  }finally{await t.close();}
 });
 it("verifies links in another browser without creating/switching its login session",async()=>{
  const t=await createTestDatabase();try {
   vi.mocked(getDatabase).mockReturnValue(t.db);
   const u=await registerIdentity(t.db,{email:"new-owner@example.test",password});
   const token=await createIdentityToken(t.db,u.id,"VERIFY_EMAIL");
   await expect(verifyEmailAction(form({token}))).rejects.toThrow("REDIRECT:/sign-in?status=verified");
   expect(jar.has("fairshift_session")).toBe(false);
   await expect(signInAction(form({email:u.email,password}))).rejects.toThrow("REDIRECT:/subscribe");
   const originalSession=jar.get("fairshift_session");
   const another=await registerIdentity(t.db,{email:"different-owner@example.test",password});
   const anotherToken=await createIdentityToken(t.db,another.id,"VERIFY_EMAIL");
   await expect(verifyEmailAction(form({token:anotherToken}))).rejects.toThrow("REDIRECT:/sign-in?status=verified");
   expect(jar.get("fairshift_session")).toBe(originalSession);
  }finally{await t.close();}
 });
 it("routes authoritative ACTIVE but incomplete setup away from operations and reuses its existing workplace",async()=>{
  const t=await createTestDatabase();try {
   vi.mocked(getDatabase).mockReturnValue(t.db);const o=await bootstrap(t.db);
   jar.set("fairshift_session",await issueSession(t.db,o.u.id));
   await t.db.update(organisations).set({setupCompletedAt:null}).where(eq(organisations.id,o.o.organisationId));
   await expect(Subscribe({searchParams:Promise.resolve({})})).rejects.toThrow("REDIRECT:/onboarding");
   await expect(OwnerLayout({children:"Protected"})).rejects.toThrow("REDIRECT:/onboarding");
   await expect(createLocationAction(form({name:"Bypass"}))).rejects.toThrow("REDIRECT:/onboarding");
   const setup=renderToStaticMarkup(await Onboarding());
   expect(setup).toContain("Set up your workplace");expect(setup).toContain("HQ");expect(setup).toContain('name="locationName"');
   await expect(completeWorkplaceAction({},form({...setupFields,name:"One",locationName:"HQ",organisationId:randomUUID(),email:"injected@example.test"}))).rejects.toThrow("REDIRECT:/owner");
   expect(await t.db.select().from(outlets).where(eq(outlets.organisationId,o.o.organisationId))).toHaveLength(1);
   expect((await t.db.select().from(users).where(eq(users.id,o.u.id)))[0].email).toBe(o.u.email);
   await expect(Subscribe({searchParams:Promise.resolve({})})).rejects.toThrow("REDIRECT:/owner");
  }finally{await t.close();}
 });
});
