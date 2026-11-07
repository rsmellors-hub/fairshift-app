import { sandboxFixture } from "../helpers/sandbox";
import { planFixture } from "../helpers/subscription-plans";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { personal, business, locationAddress } from "../helpers/onboarding";
import { registerIdentity, createIdentityToken, redeemIdentityToken } from "@/server/auth/identity";
import { ensureCustomerOrganisation } from "@/server/auth/tenancy";
import { completeWorkplace, personalDetails } from "@/server/auth/onboarding";
import { organisationEntitled, isEntitled, ownerDestination, requireEntitlement } from "@/server/billing/entitlement";
import { createLocation } from "@/server/billing/locations";
import { configuredPlan } from "@/server/billing/plans";
import { startSubscription, refreshSubscription } from "@/server/billing/service";
import { memberships, organisations, outlets, subscriptions, users } from "@/server/db/schema";
import type { SubscriptionAdapter } from "@/server/billing/paypal";
import { getSubscriptionAdapter } from "@/server/billing/paypal";
async function customer(db:Awaited<ReturnType<typeof createTestDatabase>>["db"]) {
 const u=await registerIdentity(db,{email:"owner@example.test",password:"long-test-password-42"});
 await redeemIdentityToken(db,await createIdentityToken(db,u.id,"VERIFY_EMAIL"),"VERIFY_EMAIL");
 const m=await ensureCustomerOrganisation(db,u.id);
 sandboxFixture(m.organisationId);
 return {u,m,scope:{userId:u.id,organisationId:m.organisationId,role:"OWNER"}};
}
async function activate(db:Awaited<ReturnType<typeof createTestDatabase>>["db"],scope:Awaited<ReturnType<typeof customer>>["scope"],tier:"SINGLE_OUTLET"|"MULTI_OUTLET"="SINGLE_OUTLET") {
 const planId=tier === "SINGLE_OUTLET" ? "P-SINGLE" : "P-MULTI";
 vi.stubEnv(tier === "SINGLE_OUTLET" ? "PAYPAL_SINGLE_OUTLET_MONTHLY_PLAN_ID" : "PAYPAL_MULTI_OUTLET_MONTHLY_PLAN_ID",planId);
 const details={id:"I-EXAMPLE",custom_id:scope.organisationId,plan_id:planId,status:"ACTIVE" as const};
 const adapter:SubscriptionAdapter={getPlan:async id=>planFixture(id,{tier,billingPeriod:"MONTHLY"}),create:vi.fn(async()=>details),get:vi.fn(async()=>details),verifyWebhookSignature:async()=>true};
 await startSubscription(db,scope,adapter,{tier,billingPeriod:"MONTHLY"});
 expect(await organisationEntitled(db,scope.organisationId)).toBe(false);
 await refreshSubscription(db,scope,adapter);
 return adapter;
}
const workplace={...personal,...business,...locationAddress,sameAddress:true,name:"FairShift Demo",locationName:"Johannesburg store"};
afterEach(()=>vi.unstubAllEnvs());
describe("subscription-first acquisition",()=>{
 it("migrates a blank database through 0009 and retains nullable profile fields",async()=>{
  const t=await createTestDatabase();try {
   expect((await t.db.execute(sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`)).rows[0]).toMatchObject({count:30});
   const user=await registerIdentity(t.db,{email:" OWNER@EXAMPLE.TEST ",password:"long-test-password-42"});
   expect((await t.db.select().from(users).where(eq(users.id,user.id)))[0]).toMatchObject({email:"owner@example.test",name:"",firstName:null,telephone:null});
   expect(await t.db.select().from(memberships)).toHaveLength(0);
   await expect(ensureCustomerOrganisation(t.db,user.id)).rejects.toThrow(/Verify/);
   await expect(registerIdentity(t.db,{email:"other@example.test",password:"long-test-password-42",role:"OWNER"})).rejects.toThrow();
   await expect(t.db.execute(sql`UPDATE auth_users SET title='Invalid'`)).rejects.toThrow();
  }finally{await t.close();}
 });
 it("creates/reuses one empty customer shell and routes activation through setup before operations",async()=>{
  const t=await createTestDatabase();try {
   const {u,m,scope}=await customer(t.db);
   expect(await ensureCustomerOrganisation(t.db,u.id)).toMatchObject({id:m.id});
   expect(await t.db.select().from(memberships)).toHaveLength(1);
   expect((await t.db.select().from(organisations).where(eq(organisations.id,m.organisationId)))[0]).toMatchObject({name:"",businessAddress:null,setupCompletedAt:null});
   expect(await t.db.select().from(outlets).where(eq(outlets.organisationId,m.organisationId))).toHaveLength(0);
   expect(await ownerDestination(t.db,m.organisationId)).toBe("/subscribe");
   await expect(completeWorkplace(t.db,scope,workplace)).rejects.toThrow(/active organisation/);
   await activate(t.db,scope);
   expect(await ownerDestination(t.db,m.organisationId)).toBe("/onboarding");
   await expect(requireEntitlement(t.db,m.organisationId)).rejects.toThrow(/Complete workplace/);
   const loc=await completeWorkplace(t.db,scope,workplace);
   expect(loc).toMatchObject({name:workplace.locationName,organisationId:m.organisationId});
   expect(await ownerDestination(t.db,m.organisationId)).toBe("/owner");
   expect((await t.db.select().from(users).where(eq(users.id,u.id)))[0]).toMatchObject({...personal,email:"owner@example.test"});
   expect((await t.db.select().from(organisations).where(eq(organisations.id,m.organisationId)))[0]).toMatchObject({...business,name:"FairShift Demo",setupCompletedAt:expect.any(Date)});
   expect((await completeWorkplace(t.db,scope,{...workplace,locationName:"Duplicate"})).id).toBe(loc.id);
   expect(await t.db.select().from(outlets).where(eq(outlets.organisationId,m.organisationId))).toHaveLength(1);
   await expect(completeWorkplace(t.db,{...scope,organisationId:randomUUID()},workplace)).rejects.toThrow(/denied/);
   await t.db.update(subscriptions).set({status:"CANCELLED"}).where(eq(subscriptions.organisationId,m.organisationId));
   expect(await ownerDestination(t.db,m.organisationId)).toBe("/subscribe");
  }finally{await t.close();}
 });
 it("validates post-payment fields and rolls back setup if first location cannot persist",async()=>{
  const t=await createTestDatabase();try {
   const {u,m,scope}=await customer(t.db);await activate(t.db,scope);
   for (const key of Object.keys(personal).filter(key=>key !== "title")) await expect(completeWorkplace(t.db,scope,{...workplace,[key]:""})).rejects.toThrow();
   expect(personalDetails.safeParse({...personal,title:"Invalid"}).success).toBe(false);
   await t.db.execute(sql`CREATE FUNCTION fail_location_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled location failure'; END $$`);
   await t.db.execute(sql`CREATE TRIGGER fail_location_fixture BEFORE INSERT ON outlets FOR EACH ROW EXECUTE FUNCTION fail_location_fixture()`);
   await expect(completeWorkplace(t.db,scope,workplace)).rejects.toThrow();
   expect((await t.db.select().from(organisations).where(eq(organisations.id,m.organisationId)))[0]).toMatchObject({name:"",setupCompletedAt:null});
   expect((await t.db.select().from(users).where(eq(users.id,u.id)))[0].firstName).toBeNull();
   expect(await organisationEntitled(t.db,m.organisationId)).toBe(true);
  }finally{await t.close();}
 });
 it.each([['SINGLE_OUTLET',1],['MULTI_OUTLET',5]] as const)("enforces %s active location limit %i in server mutations",async(tier,limit)=>{
  const t=await createTestDatabase();try {
   const {scope,m}=await customer(t.db);await activate(t.db,scope,tier);await completeWorkplace(t.db,scope,workplace);
   for(let i=1;i<limit;i++) await createLocation(t.db,scope,{name:`Location ${i+1}`});
   await expect(createLocation(t.db,scope,{name:"Too many"})).rejects.toThrow(new RegExp(`allows ${limit}`));
   if(tier === "MULTI_OUTLET") await expect(createLocation(t.db,scope,{name:"Sixth location"})).rejects.toThrow(/6\+ locations.*Enterprise/);
   expect(await t.db.select().from(outlets).where(eq(outlets.organisationId,m.organisationId))).toHaveLength(limit);
   await expect(createLocation(t.db,{...scope,role:"MANAGER"},{name:"Escalation"})).rejects.toThrow(/denied/);
   await expect(createLocation(t.db,{...scope,organisationId:randomUUID()},{name:"Other organisation"})).rejects.toThrow(/denied/);
   const [retired]=await t.db.select().from(outlets).where(eq(outlets.organisationId,m.organisationId));
   await t.db.update(outlets).set({active:false}).where(eq(outlets.id,retired.id));
   await createLocation(t.db,scope,{name:"Replacement active location"});
   await t.db.update(subscriptions).set({tier:"ENTERPRISE",locationLimit:limit+1}).where(eq(subscriptions.organisationId,m.organisationId));
   await createLocation(t.db,scope,{name:"Custom entitlement"});
   await expect(createLocation(t.db,scope,{name:"Beyond custom"})).rejects.toThrow(/allows/);
  }finally{await t.close();}
 });
 it("reuses an incomplete legacy organisation and existing first location without duplicate membership",async()=>{
  const t=await createTestDatabase();try {
   const {u,m,scope}=await customer(t.db);
   await t.db.update(organisations).set({name:"FairShift Demo"}).where(eq(organisations.id,m.organisationId));
   const id=randomUUID();await t.db.insert(outlets).values({id,organisationId:m.organisationId,name:"Johannesburg",timezone:"UTC"});
   expect((await ensureCustomerOrganisation(t.db,u.id)).id).toBe(m.id);
   await activate(t.db,scope);
   expect((await completeWorkplace(t.db,scope,workplace)).id).toBe(id);
   expect(await t.db.select().from(memberships)).toHaveLength(1);
   expect(await t.db.select().from(outlets).where(eq(outlets.organisationId,m.organisationId))).toHaveLength(1);
  }finally{await t.close();}
 });
 it("maps all four plan choices independently, rejects Enterprise, missing/duplicate mappings and plan substitution",async()=>{
  const env={PAYPAL_SINGLE_OUTLET_MONTHLY_PLAN_ID:"P-SM",PAYPAL_SINGLE_OUTLET_ANNUAL_PLAN_ID:"P-SA",PAYPAL_MULTI_OUTLET_MONTHLY_PLAN_ID:"P-MM",PAYPAL_MULTI_OUTLET_ANNUAL_PLAN_ID:"P-MA"};
  for(const [tier,period,id] of [["SINGLE_OUTLET","MONTHLY","P-SM"],["SINGLE_OUTLET","ANNUAL","P-SA"],["MULTI_OUTLET","MONTHLY","P-MM"],["MULTI_OUTLET","ANNUAL","P-MA"]] as const) expect(configuredPlan({tier,billingPeriod:period},env)).toBe(id);
  expect(configuredPlan({tier:"SINGLE_OUTLET",billingPeriod:"MONTHLY"},{})).toBeNull();
  expect(configuredPlan({tier:"SINGLE_OUTLET",billingPeriod:"MONTHLY"},{...env,PAYPAL_MULTI_OUTLET_MONTHLY_PLAN_ID:"P-SM"})).toBeNull();
  const t=await createTestDatabase();try {
   const {scope,m}=await customer(t.db);
   await expect(startSubscription(t.db,scope,null,{tier:"ENTERPRISE",billingPeriod:"MONTHLY"} as never)).rejects.toThrow();
   const adapter:SubscriptionAdapter={getPlan:async id=>planFixture(id),create:vi.fn(async()=>({id:"I-OTHER",custom_id:m.organisationId,plan_id:"P-WRONG",status:"ACTIVE" as const})),get:vi.fn(),verifyWebhookSignature:async()=>true};
   await expect(startSubscription(t.db,scope,adapter,{tier:"SINGLE_OUTLET",billingPeriod:"MONTHLY"})).rejects.toThrow(/unavailable/);
   expect(adapter.create).not.toHaveBeenCalled();
   vi.stubEnv("PAYPAL_SINGLE_OUTLET_MONTHLY_PLAN_ID","P-SINGLE");
   await expect(startSubscription(t.db,scope,adapter,{tier:"SINGLE_OUTLET",billingPeriod:"MONTHLY"})).rejects.toThrow(/mismatch/);
   const [sub]=await t.db.select().from(subscriptions).where(eq(subscriptions.organisationId,m.organisationId));
   expect(sub).toMatchObject({status:"PENDING",providerId:null,tier:"SINGLE_OUTLET",billingPeriod:"MONTHLY",locationLimit:1});
   expect(await organisationEntitled(t.db,m.organisationId)).toBe(false);
   vi.stubEnv("PAYPAL_MULTI_OUTLET_MONTHLY_PLAN_ID","P-MULTI");
   await expect(startSubscription(t.db,scope,adapter,{tier:"MULTI_OUTLET",billingPeriod:"MONTHLY"})).rejects.toThrow(/different plan/);
  }finally{await t.close();}
 });
 it("rejects selecting a plan below the existing active location count before any provider call",async()=>{
  const t=await createTestDatabase();try {
   const {scope,m}=await customer(t.db);
   await t.db.insert(outlets).values(["One","Two"].map(name=>({id:randomUUID(),organisationId:m.organisationId,name,timezone:"UTC"})));
   vi.stubEnv("PAYPAL_SINGLE_OUTLET_MONTHLY_PLAN_ID","P-SINGLE");
   const adapter:SubscriptionAdapter={getPlan:async id=>planFixture(id),create:vi.fn(),get:vi.fn(),verifyWebhookSignature:async()=>true};
   await expect(startSubscription(t.db,scope,adapter,{tier:"SINGLE_OUTLET",billingPeriod:"MONTHLY"})).rejects.toThrow(/existing active locations/);
   expect(adapter.create).not.toHaveBeenCalled();
   expect((await t.db.select().from(subscriptions).where(eq(subscriptions.organisationId,m.organisationId)))[0]).toMatchObject({status:"UNCONFIGURED",tier:null,planId:null});
  }finally{await t.close();}
 });
 it("keeps the Sandbox reconciliation adapter available independently of checkout mapping",()=>{
  sandboxFixture();
  vi.stubEnv("PAYPAL_CLIENT_ID","fixture");vi.stubEnv("PAYPAL_CLIENT_SECRET","fixture");vi.stubEnv("PAYPAL_SUBSCRIPTION_WEBHOOK_ID","fixture");
  expect(getSubscriptionAdapter()).not.toBeNull();
  vi.stubEnv("PAYPAL_WEBHOOK_ID","fixture");expect(getSubscriptionAdapter()).toBeNull();
  vi.stubEnv("PAYPAL_WEBHOOK_ID","payout-only");
  vi.stubEnv("PAYPAL_ENVIRONMENT","production");expect(getSubscriptionAdapter()).toBeNull();
  vi.stubEnv("PAYPAL_ENVIRONMENT","sandbox");vi.stubEnv("PAYPAL_ENV","live");expect(getSubscriptionAdapter()).toBeNull();
 });
});
describe("subscription entitlement decision",()=>{
 const verified={providerId:"I-VERIFIED",planId:"P-VERIFIED",verifiedAt:new Date()};
 it.each(["UNCONFIGURED","PENDING","APPROVAL_PENDING","APPROVED","SUSPENDED","CANCELLED","EXPIRED","FAILED","UNKNOWN"])("denies %s even if previously verified",status=>expect(isEntitled({...verified,status})).toBe(false));
 it("requires authoritative ACTIVE identity and plan",()=>{
  expect(isEntitled({...verified,status:"ACTIVE"})).toBe(true);
  for(const key of ["verifiedAt","providerId","planId"]) expect(isEntitled({...verified,status:"ACTIVE",[key]:null})).toBe(false);
  expect(isEntitled(null)).toBe(false);
 });
});

describe("first-location address completion",()=>{
 it.each([true,false])("persists same-address=%s without requiring honorific or region",async sameAddress=>{
  const t=await createTestDatabase();try {
   const {u,m,scope}=await customer(t.db);await activate(t.db,scope);
   const loc=await completeWorkplace(t.db,scope,{...workplace,title:undefined,province:undefined,locationProvince:undefined,sameAddress,
    locationAddress:"42 Location Street",locationCity:"London",locationPostalCode:"SW1A 1AA",locationCountry:"United Kingdom"});
   expect(loc).toMatchObject({address:"42 Location Street",city:"London",postalCode:"SW1A 1AA",country:"United Kingdom",province:null});
   const [org]=await t.db.select().from(organisations).where(eq(organisations.id,m.organisationId));
   expect(org).toMatchObject({businessAddress:sameAddress ? "42 Location Street":business.businessAddress,city:sameAddress ? "London":business.city,
    postalCode:sameAddress ? "SW1A 1AA":business.postalCode,country:sameAddress ? "United Kingdom":business.country,province:null,setupCompletedAt:expect.any(Date)});
   expect((await t.db.select().from(users).where(eq(users.id,u.id)))[0]).toMatchObject({title:null,email:"owner@example.test"});
   await expect(createLocation(t.db,scope,{name:"Over the Single Outlet limit"})).rejects.toThrow(/allows 1/);
  }finally{await t.close();}
 });
 it("requires an independent business address when copying is disabled",async()=>{
  const t=await createTestDatabase();try {
   const {scope,m}=await customer(t.db);await activate(t.db,scope);
   await expect(completeWorkplace(t.db,scope,{...workplace,sameAddress:false,businessAddress:""})).rejects.toThrow();
   expect((await t.db.select().from(organisations).where(eq(organisations.id,m.organisationId)))[0].setupCompletedAt).toBeNull();
   expect(await t.db.select().from(outlets).where(eq(outlets.organisationId,m.organisationId))).toHaveLength(0);
  }finally{await t.close();}
 });
 it("rolls back location and profile when the final organisation write fails",async()=>{
  const t=await createTestDatabase();try {
   const {scope,m,u}=await customer(t.db);await activate(t.db,scope);
   await t.db.execute(sql`CREATE FUNCTION fail_setup_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled setup failure'; END $$`);
   await t.db.execute(sql`CREATE TRIGGER fail_setup_fixture BEFORE UPDATE ON organisations FOR EACH ROW EXECUTE FUNCTION fail_setup_fixture()`);
   await expect(completeWorkplace(t.db,scope,workplace)).rejects.toThrow();
   expect(await t.db.select().from(outlets).where(eq(outlets.organisationId,m.organisationId))).toHaveLength(0);
   expect((await t.db.select().from(users).where(eq(users.id,u.id)))[0].firstName).toBeNull();
   expect((await t.db.select().from(organisations).where(eq(organisations.id,m.organisationId)))[0]).toMatchObject({name:"",setupCompletedAt:null,businessAddress:null});
  }finally{await t.close();}
 });
});
