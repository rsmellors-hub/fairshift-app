import { sandboxFixture } from "../helpers/sandbox";
import Subscribe from "@/app/subscribe/page";
import { planFixture } from "../helpers/subscription-plans";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { createTestDatabase } from "../helpers/database";
import { setupFields } from "../helpers/onboarding";
import { getDatabase } from "@/server/db/client";
import { registerIdentity,createIdentityToken,redeemIdentityToken,issueSession } from "@/server/auth/identity";
import { ensureCustomerOrganisation } from "@/server/auth/tenancy";
import { organisations,outlets,subscriptions,users } from "@/server/db/schema";
import { getSubscriptionAdapter, type SubscriptionAdapter } from "@/server/billing/paypal";
import { checkSubscriptionStatusAction,completeWorkplaceAction } from "@/app/auth-actions";
import BillingReturn from "@/app/billing/return/page";
import Onboarding from "@/app/onboarding/page";
import { WorkplaceForm } from "@/app/components/workplace-form";
const jar=vi.hoisted(()=>new Map<string,string>());
vi.mock("next/headers",()=>({cookies:async()=>({get:(key:string)=>jar.has(key) ? {value:jar.get(key)!}:undefined,delete:(key:string)=>jar.delete(key)})}));
vi.mock("next/navigation",()=>({redirect:(path:string)=>{throw new Error(`REDIRECT:${path}`);},useRouter:()=>({replace:vi.fn()})}));
vi.mock("@/server/db/client",()=>({getDatabase:vi.fn()}));
vi.mock("@/server/billing/paypal",async original=>({...await original<typeof import("@/server/billing/paypal")>(),getSubscriptionAdapter:vi.fn<()=>SubscriptionAdapter|null>(()=>null)}));
const form=(values:Record<string,string>)=>{const result=new FormData();for(const [key,value] of Object.entries(values))result.set(key,value);return result;};
async function customer(db:ReturnType<typeof getDatabase>) {
 vi.mocked(getDatabase).mockReturnValue(db);
 const u=await registerIdentity(db,{email:"owner@example.test",password:"test-password-for-account"});
 await redeemIdentityToken(db,await createIdentityToken(db,u.id,"VERIFY_EMAIL"),"VERIFY_EMAIL");
 const m=await ensureCustomerOrganisation(db,u.id);
 sandboxFixture(m.organisationId);
 jar.set("fairshift_session",await issueSession(db,u.id));
 await db.update(subscriptions).set({status:"APPROVAL_PENDING",providerId:"I-JOURNEY",planId:"P-JOURNEY",tier:"SINGLE_OUTLET",billingPeriod:"MONTHLY",locationLimit:1}).where(eq(subscriptions.organisationId,m.organisationId));
 const adapter:SubscriptionAdapter={getPlan:vi.fn(async id=>planFixture(id)),create:vi.fn(),get:vi.fn(async()=>({id:"I-JOURNEY",plan_id:"P-JOURNEY",custom_id:m.organisationId,status:"ACTIVE" as const})),verifyWebhookSignature:vi.fn()};
 return {u,m,adapter};
}
afterEach(()=>{vi.unstubAllEnvs();jar.clear();vi.clearAllMocks();vi.mocked(getSubscriptionAdapter).mockReturnValue(null);});
describe("confirmation to workplace journey",()=>{
 it("keeps browser return non-authoritative and renders human confirmation for every non-active state",async()=>{
  const t=await createTestDatabase();try {
   const {m,adapter}=await customer(t.db);
   for(const status of ["APPROVAL_PENDING","APPROVED","PENDING","SUSPENDED","CANCELLED","EXPIRED"]) {
    await t.db.update(subscriptions).set({status}).where(eq(subscriptions.organisationId,m.organisationId));
    const html=renderToStaticMarkup(await BillingReturn());
    expect(html).toContain("Setting up your FairShift account");expect(html).toContain("confirming the details with PayPal");
    expect(html).toContain('aria-current="step"');expect(html).toContain("Ready");
    for(const technical of [status,"webhook","reconciliation","I-JOURNEY","P-JOURNEY","API","browser return","Team","Check payment status"]) expect(html).not.toContain(technical);
    expect((await t.db.select().from(subscriptions).where(eq(subscriptions.organisationId,m.organisationId)))[0]).toMatchObject({status,verifiedAt:null});
   }
   expect(adapter.create).not.toHaveBeenCalled();
  }finally{await t.close();}
 });
 it("reuses authoritative reconciliation for recovery and advances incomplete then completed setup without checkout creation",async()=>{
  const t=await createTestDatabase();try {
   const {m,adapter}=await customer(t.db);vi.mocked(getSubscriptionAdapter).mockReturnValue(adapter);
   expect(await checkSubscriptionStatusAction()).toEqual({destination:"/onboarding"});
   expect(adapter.get).toHaveBeenCalledWith("I-JOURNEY");
   await expect(BillingReturn()).rejects.toThrow("REDIRECT:/onboarding");
   const data={...setupFields,name:"Actual Business",locationName:"Actual Location",email:"forged@example.test"};
   delete (data as Partial<typeof data>).title;
   await expect(completeWorkplaceAction({},form(data))).rejects.toThrow("REDIRECT:/owner");
   expect((await t.db.select().from(organisations).where(eq(organisations.id,m.organisationId)))[0].setupCompletedAt).toBeInstanceOf(Date);
   expect((await t.db.select().from(outlets).where(eq(outlets.organisationId,m.organisationId)))[0]).toMatchObject({address:setupFields.locationAddress,city:setupFields.locationCity});
   expect((await t.db.select().from(users).where(eq(users.email,"owner@example.test")))[0].email).toBe("owner@example.test");
   await expect(BillingReturn()).rejects.toThrow("REDIRECT:/owner");
   await expect(Onboarding()).rejects.toThrow("REDIRECT:/owner");
   expect(await checkSubscriptionStatusAction()).toEqual({destination:"/owner"});expect(adapter.create).not.toHaveBeenCalled();
  }finally{await t.close();}
 });
 it("returns plain recovery errors when authoritative reconciliation fails without changing entitlement",async()=>{
  const t=await createTestDatabase();try {
   const {m,adapter}=await customer(t.db);vi.mocked(getSubscriptionAdapter).mockReturnValue(adapter);
   vi.mocked(adapter.get).mockRejectedValue(new Error("private-provider-error"));
   const result=await checkSubscriptionStatusAction();
   expect(result).toEqual({destination:null,message:expect.stringContaining("couldn’t confirm")});
   expect(JSON.stringify(result)).not.toMatch(/private-provider|API|webhook|charged/);
   expect((await t.db.select().from(subscriptions).where(eq(subscriptions.organisationId,m.organisationId)))[0].status).toBe("APPROVAL_PENDING");
   expect(adapter.create).not.toHaveBeenCalled();
  }finally{await t.close();}
 });
 it("renders the compact fields with safe prefills and no duplicate email, honorific, region or business-address inputs",async()=>{
  const t=await createTestDatabase();try {
   const {m,u}=await customer(t.db);
   await t.db.update(subscriptions).set({status:"ACTIVE",verifiedAt:new Date()}).where(eq(subscriptions.organisationId,m.organisationId));
   await t.db.update(users).set({firstName:"Alex",surname:"River",position:"Owner",telephone:"+441234567890"}).where(eq(users.id,u.id));
   await t.db.update(organisations).set({name:"River Business"}).where(eq(organisations.id,m.organisationId));
   const html=renderToStaticMarkup(await Onboarding());
   for(const name of ["firstName","surname","position","telephone","name","locationName","locationAddress","locationCity","locationPostalCode","locationCountry"]) expect(html).toContain(`name="${name}"`);
   for(const name of ["title","email","province","locationProvince","businessAddress","city","postalCode","country"]) expect(html).not.toContain(`name="${name}"`);
   for(const value of ["Alex","River","Owner","+441234567890","River Business","owner@example.test","Continue to FairShift","Last name","A few details, then your first location."]) expect(html).toContain(value);
   expect(html).toContain('name="sameAddress"');expect(html).toContain('checked=""');expect(html).not.toContain("Team");
   const separate=renderToStaticMarkup(WorkplaceElement(false));
   for(const name of ["businessAddress","city","postalCode","country"]) expect(separate).toContain(`name="${name}"`);
   expect(separate).not.toContain('name="province"');
  }finally{await t.close();}
 });
 it("returns adjacent field errors without persisting partial setup and accepts a corrected resubmission",async()=>{
  const t=await createTestDatabase();try {
   const {m}=await customer(t.db);
   await t.db.update(subscriptions).set({status:"ACTIVE",verifiedAt:new Date()}).where(eq(subscriptions.organisationId,m.organisationId));
   const data={...setupFields,name:"Entered Business",locationName:"Entered Location",firstName:"",telephone:"bad"};
   const result=await completeWorkplaceAction({},form(data));
   expect(result.errors).toMatchObject({firstName:"Enter your first name.",telephone:expect.stringContaining("phone")});
   expect((await t.db.select().from(organisations).where(eq(organisations.id,m.organisationId)))[0].setupCompletedAt).toBeNull();
   await expect(completeWorkplaceAction(result,form({...data,firstName:"Alex",telephone:"+441234567890"}))).rejects.toThrow("REDIRECT:/owner");
   expect((await t.db.select().from(organisations).where(eq(organisations.id,m.organisationId)))[0].name).toBe("Entered Business");
  }finally{await t.close();}
 });
});
function WorkplaceElement(sameAddress:boolean) {
 return createElement(WorkplaceForm,{email:"owner@example.test",initial:{...setupFields,name:"Known Business",locationName:"Known Location",sameAddress}});
}
import { createElement } from "react";


it("offers a saved Sandbox approval link only to the configured isolated organisation", async () => {
 const t=await createTestDatabase();try {
  const {m,adapter}=await customer(t.db);
  vi.mocked(getSubscriptionAdapter).mockReturnValue(adapter);
  await t.db.update(subscriptions).set({approvalUrl:"https://www.sandbox.paypal.com/approve?token=fixture"}).where(eq(subscriptions.organisationId,m.organisationId));
  const page=()=>Subscribe({searchParams:Promise.resolve({})});
  expect(renderToStaticMarkup(await page())).toContain("Continue in PayPal");
  vi.mocked(getSubscriptionAdapter).mockClear();
  vi.stubEnv("FAIRSHIFT_DEPLOYMENT_MODE","LIVE_CUSTOMER");
  const live=renderToStaticMarkup(await page());
  expect(live).not.toContain("Continue in PayPal");
  expect(live).not.toContain("https://www.sandbox.paypal.com/approve");
  expect(getSubscriptionAdapter).not.toHaveBeenCalled();
  sandboxFixture("22222222-2222-4222-8222-222222222222");
  expect(renderToStaticMarkup(await page())).not.toContain("Continue in PayPal");
  expect(getSubscriptionAdapter).not.toHaveBeenCalled();
 }finally{await t.close();}
});
