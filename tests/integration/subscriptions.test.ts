import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe,expect,it,vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { paypalHeaders } from "../helpers/paypal";
import { users,subscriptions,subscriptionEvents } from "@/server/db/schema";
import { createOrganisation } from "@/server/auth/tenancy";
import { resolveScope } from "@/server/auth/access";
import { startSubscription,refreshSubscription,subscriptionFor,processSubscriptionWebhook } from "@/server/billing/service";
import type { SubscriptionAdapter } from "@/server/billing/paypal";
async function setup(db:Awaited<ReturnType<typeof createTestDatabase>>["db"]) {
 const userId=randomUUID();await db.insert(users).values({id:userId,email:"owner@example.test",name:"Owner",passwordHash:"not-used",emailVerifiedAt:new Date()});
 const org=await createOrganisation(db,userId,{name:"My Co",locationName:"HQ"});
 const scope=await resolveScope(db,userId,org.membershipId);
 let status:"ACTIVE"|"APPROVAL_PENDING"|"SUSPENDED"="APPROVAL_PENDING";
 const details=()=>({id:"I-EXAMPLE123",custom_id:scope.organisationId,plan_id:"P-EXAMPLE",status,links:[{rel:"approve",href:"https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=example"}]});
 const adapter:SubscriptionAdapter={create:vi.fn(async()=>details()),get:vi.fn(async()=>details()),verifyWebhookSignature:vi.fn(async()=>true)};
 return {scope,adapter,setStatus:(s:typeof status)=>{status=s;}};
}
const event=(id="WH-SUB-1")=>JSON.stringify({id,event_type:"BILLING.SUBSCRIPTION.ACTIVATED",resource:{id:"I-EXAMPLE123",status:"ACTIVE"}});
describe("organisation PayPal subscription authority",()=>{
 it("persists unconfigured and pending organisation state without browser-authoritative activation",async()=>{
  const t=await createTestDatabase();try {
   const {scope,adapter,setStatus}=await setup(t.db);
   expect(await subscriptionFor(t.db,scope)).toMatchObject({organisationId:scope.organisationId,status:"UNCONFIGURED",providerId:null});
   expect(await startSubscription(t.db,scope,null)).toMatchObject({status:"UNCONFIGURED"});
   setStatus("ACTIVE"); // Even a create response cannot replace verification.
   const created=await startSubscription(t.db,scope,adapter,"P-EXAMPLE");
   expect(created).toMatchObject({status:"APPROVAL_PENDING",providerId:"I-EXAMPLE123",verifiedAt:null});
   expect(await subscriptionFor(t.db,scope)).toMatchObject({status:"APPROVAL_PENDING"});
   expect(await refreshSubscription(t.db,scope,adapter)).toMatchObject({status:"ACTIVE",verifiedAt:expect.any(Date)});
   await startSubscription(t.db,scope,adapter,"P-EXAMPLE");expect(adapter.create).toHaveBeenCalledTimes(1);
  }finally{await t.close();}
 });
 it("verifies webhooks, GETs authoritative state, deduplicates and reconciles later state",async()=>{
  const t=await createTestDatabase();try {
   const {scope,adapter,setStatus}=await setup(t.db);await startSubscription(t.db,scope,adapter,"P-EXAMPLE");
   // Body says ACTIVE, authoritative API remains pending.
   expect(await processSubscriptionWebhook(t.db,adapter,event(),paypalHeaders())).toEqual({duplicate:false});
   expect((await subscriptionFor(t.db,scope))?.status).toBe("APPROVAL_PENDING");
   expect(await processSubscriptionWebhook(t.db,adapter,event(),paypalHeaders())).toEqual({duplicate:true});
   expect(adapter.get).toHaveBeenCalledTimes(1);
   setStatus("ACTIVE");await processSubscriptionWebhook(t.db,adapter,event("WH-SUB-2"),paypalHeaders());
   expect((await subscriptionFor(t.db,scope))?.status).toBe("ACTIVE");
   setStatus("SUSPENDED");await processSubscriptionWebhook(t.db,adapter,event("WH-SUB-3"),paypalHeaders());
   expect((await subscriptionFor(t.db,scope))?.status).toBe("SUSPENDED");
   expect(await t.db.select().from(subscriptionEvents)).toHaveLength(3);
   await expect(processSubscriptionWebhook(t.db,adapter,event().replace('"ACTIVE"','"SUSPENDED"'),paypalHeaders())).rejects.toMatchObject({code:"EVENT_CONTENT_MISMATCH"});
  }finally{await t.close();}
 });
 it("rejects forged/malformed events and mismatched organisation/plan without state corruption",async()=>{
  const t=await createTestDatabase();try {
   const {scope,adapter}=await setup(t.db);await startSubscription(t.db,scope,adapter,"P-EXAMPLE");
   await expect(processSubscriptionWebhook(t.db,{...adapter,verifyWebhookSignature:async()=>false},event(),paypalHeaders())).rejects.toMatchObject({status:401});
   await expect(processSubscriptionWebhook(t.db,adapter,"{bad",paypalHeaders())).rejects.toMatchObject({status:400});
   await expect(processSubscriptionWebhook(t.db,adapter,"{}",paypalHeaders())).rejects.toMatchObject({status:400});
   await expect(processSubscriptionWebhook(t.db,adapter,event(),new Headers())).rejects.toThrow();
   const original=await adapter.get("I-EXAMPLE123");
   await expect(refreshSubscription(t.db,scope,{...adapter,get:async()=>({...original,custom_id:randomUUID()})})).rejects.toThrow(/mismatch/);
   expect((await subscriptionFor(t.db,scope))?.status).toBe("APPROVAL_PENDING");
   expect(await t.db.select().from(subscriptionEvents)).toHaveLength(0);
   await expect(subscriptionFor(t.db,{...scope,role:"TEAM_MEMBER"})).rejects.toThrow(/denied/);
   await expect(subscriptionFor(t.db,{...scope,organisationId:randomUUID()})).rejects.toThrow(/denied/);
  }finally{await t.close();}
 });
 it("retains pending request identity across failures and blocks unsafe stale retries",async()=>{
  const t=await createTestDatabase();try {
   const {scope,adapter}=await setup(t.db),create=vi.fn(adapter.create).mockRejectedValueOnce(new Error("timeout"));
   await expect(startSubscription(t.db,scope,{...adapter,create},"P-EXAMPLE")).rejects.toThrow();
   const pending=await subscriptionFor(t.db,scope);expect(pending?.status).toBe("PENDING");
   await startSubscription(t.db,scope,{...adapter,create},"P-EXAMPLE");
   expect(create.mock.calls[0][0].requestId).toBe(create.mock.calls[1][0].requestId);
   await expect(t.db.insert(subscriptions).values({id:randomUUID(),organisationId:scope.organisationId,requestId:randomUUID()})).rejects.toThrow();
   await t.db.update(subscriptions).set({providerId:null,updatedAt:new Date(0),status:"PENDING"}).where(eq(subscriptions.organisationId,scope.organisationId));
   await expect(startSubscription(t.db,scope,adapter,"P-EXAMPLE")).rejects.toThrow(/reconciliation/);
  }finally{await t.close();}
 });
});
