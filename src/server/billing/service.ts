import { assertSandboxDeployment, assertSandboxFinancialScope, assertSandboxOrganisation } from "@/server/config/deployment";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Database, DatabaseSession } from "@/server/db/client";
import { assertCommercialPlan, configuredPlan, planSelection, locationLimitFor, type PlanSelection } from "./plans";
import { requireCustomerOwner as owner, type CustomerScope } from "./ownership";
import { organisations, outlets, subscriptions, subscriptionEvents } from "@/server/db/schema";
import { tokenHash } from "@/server/auth/identity";
import { UserFacingError } from "@/server/domain/errors";
import { readPayPalTransmissionHeaders, WebhookError } from "@/server/integrations/paypal/webhook";
import { approvalLink, subscriptionDetails, type SubscriptionAdapter } from "./paypal";
import { audited, type AuditFound, type AuditTarget } from "@/server/auth/audit-actor";
export async function subscriptionFor(db:DatabaseSession,scope:CustomerScope) {
 await owner(db,scope);
 const [row]=await db.select().from(subscriptions).where(eq(subscriptions.organisationId,scope.organisationId));
 return row ?? null;
}
// Checkout and status checks call PayPal, so each request leaves one audit row (who, role, session type,
// time, outcome): the subscription's status, an existing subscription, a refusal or a PayPal error code.
const subscriptionAudit=(scope:CustomerScope,action:string):AuditTarget=>({organisationId:scope.organisationId,action,entityType:"organisation_subscription",correlationId:`subscription:${scope.organisationId}`,actor:scope});
export async function startSubscription(db:Database,scope:CustomerScope,adapter:SubscriptionAdapter|null,selection?:PlanSelection) {
 let existing=false;
 return audited(db,subscriptionAudit(scope,"SUBSCRIPTION_CHECKOUT_REQUESTED"),found=>checkout(db,scope,adapter,selection,found,()=>{existing=true;}),
  row=>existing ? `EXISTING_SUBSCRIPTION:${row.status}` : `CREATED:${row.status}`);
}
async function checkout(db:Database,scope:CustomerScope,adapter:SubscriptionAdapter|null,selection:PlanSelection|undefined,found:AuditFound,onExisting:()=>void) {
 assertSandboxFinancialScope(scope);
 await owner(db,scope);
 const choice=selection ? planSelection.parse(selection) : null;
 if (choice) found.detail={tier:choice.tier,billingPeriod:choice.billingPeriod};
 const planId=choice ? configuredPlan(choice) : null;
 if (!adapter || !planId || !choice) throw new UserFacingError("subscription-unavailable","This subscription option is currently unavailable. No checkout was created.");
 // Persist the chosen mapping before calling PayPal; retries cannot change its tier or period.
 await db.transaction(async tx=>{
  await tx.select().from(organisations).where(eq(organisations.id,scope.organisationId)).for("update");
  const active=await tx.select({id:outlets.id}).from(outlets).where(and(eq(outlets.organisationId,scope.organisationId),eq(outlets.active,true)));
  if (active.length > locationLimitFor(choice.tier)) throw new UserFacingError("subscription-location-limit","This plan does not cover your existing active locations. Choose a suitable plan or contact FairShift.");
  await tx.update(subscriptions).set({status:"PENDING",planId,tier:choice.tier,billingPeriod:choice.billingPeriod,locationLimit:locationLimitFor(choice.tier),requestId:randomUUID(),updatedAt:new Date()}).where(and(eq(subscriptions.organisationId,scope.organisationId),eq(subscriptions.status,"UNCONFIGURED")));
 });
 return db.transaction(async tx => {
  const [row]=await tx.select().from(subscriptions).where(eq(subscriptions.organisationId,scope.organisationId)).for("update");
  if (!row) throw new Error("Subscription record unavailable.");
  if (row.planId !== planId || row.tier !== choice.tier || row.billingPeriod !== choice.billingPeriod) throw new UserFacingError("subscription-different-plan","An existing subscription uses a different plan. Contact FairShift before changing plans.");
  if (row.providerId) {found.entityId=row.providerId;onExisting();return row;}
  if (!row.planId || row.status !== "PENDING") throw new UserFacingError("subscription-needs-review","Subscription needs review.");
  // PayPal retains create request IDs for 72 hours. Do not recreate after that protection expires.
  if (Date.now()-row.updatedAt.getTime()>48*3600_000) throw new UserFacingError("subscription-needs-reconciliation","Pending subscription requires provider reconciliation before retry.");
  assertCommercialPlan(await adapter.getPlan(row.planId),choice,row.planId);
  const details=subscriptionDetails.parse(await adapter.create({organisationId:scope.organisationId,requestId:row.requestId,planId:row.planId}));
  found.entityId=details.id;
  if (details.custom_id !== scope.organisationId || details.plan_id !== row.planId || details.plan_overridden || (details.quantity && details.quantity !== "1")) throw new UserFacingError("subscription-identity-mismatch","Subscription identity mismatch.");
  const [updated]=await tx.update(subscriptions).set({providerId:details.id,status:"APPROVAL_PENDING",approvalUrl:approvalLink(details),updatedAt:new Date()}).where(eq(subscriptions.id,row.id)).returning();
  return updated;
 });
}
async function reconcile(db:DatabaseSession,adapter:SubscriptionAdapter,id:string) {
 const [row]=await db.select().from(subscriptions).where(eq(subscriptions.providerId,id)).for("update");
 if (!row) throw new Error("Unknown subscription.");
 assertSandboxOrganisation(row.organisationId);
 const details=subscriptionDetails.parse(await adapter.get(id));
 const overridden=details.plan_overridden || (details.quantity && details.quantity !== "1");
 if (details.id !== row.providerId || details.custom_id !== row.organisationId || details.plan_id !== row.planId || (details.status === "ACTIVE" && overridden)) throw new Error("Subscription identity mismatch.");
 // Legacy subscriptions without a tier retain their existing identity binding. New catalogue
 // subscriptions also verify price/cadence; cancellation must still withdraw entitlement
 // if a provider plan has since become inactive or its commercial configuration changed.
 if (details.status === "ACTIVE" && row.tier && row.tier !== "ENTERPRISE") {
  const choice=planSelection.parse({tier:row.tier,billingPeriod:row.billingPeriod});
  if (row.locationLimit !== locationLimitFor(choice.tier)) throw new Error("Subscription entitlement mismatch.");
  // Subscriptions created on an earlier GBP plan (with or without the trial) keep that plan.
  assertCommercialPlan(await adapter.getPlan(row.planId!),choice,row.planId!,true);
 }
 const [updated]=await db.update(subscriptions).set({status:details.status,verifiedAt:new Date(),updatedAt:new Date()}).where(eq(subscriptions.id,row.id)).returning();
 return updated;
}
// A status check asks PayPal for the subscription only when there is one to ask about; only then is it
// an action that can call PayPal, and only then is it recorded.
export async function refreshSubscription(db:Database,scope:CustomerScope,adapter:SubscriptionAdapter|null) {
 assertSandboxFinancialScope(scope);
 await owner(db,scope);
 const row=await subscriptionFor(db,scope);
 if (!adapter || !row?.providerId) return row;
 const providerId=row.providerId;
 return audited(db,{...subscriptionAudit(scope,"SUBSCRIPTION_STATUS_CHECKED"),entityId:providerId},()=>db.transaction(tx => reconcile(tx,adapter,providerId)),updated=>`STATUS:${updated.status}`);
}
export async function processSubscriptionWebhook(db:Database,adapter:SubscriptionAdapter,rawBody:string,headers:Headers) {
 assertSandboxDeployment();
 const transmission=readPayPalTransmissionHeaders(headers);
 let payload:unknown;
 try {payload=JSON.parse(rawBody);} catch {throw new WebhookError("INVALID_JSON",400);}
 const parsed=z.object({id:z.string().min(1).max(255),event_type:z.string().regex(/^BILLING\.SUBSCRIPTION\.[A-Z_]+(\.[A-Z_]+)?$/),resource:z.object({id:z.string().regex(/^I-[A-Z0-9]+$/)})}).safeParse(payload);
 if (!parsed.success) throw new WebhookError("INVALID_EVENT",400);
 if (!await adapter.verifyWebhookSignature(transmission,payload)) throw new WebhookError("SIGNATURE_VERIFICATION_FAILED",401);
 const event=parsed.data, hash=tokenHash(rawBody);
 return db.transaction(async tx => {
  // Serialize on the subscription before deduplication and authoritative GET.
  const [sub]=await tx.select().from(subscriptions).where(eq(subscriptions.providerId,event.resource.id)).for("update");
  if (!sub) throw new WebhookError("UNKNOWN_SUBSCRIPTION",503);
  assertSandboxOrganisation(sub.organisationId);
  const [existing]=await tx.select().from(subscriptionEvents).where(eq(subscriptionEvents.id,event.id));
  if (existing) {
   if (existing.payloadHash !== hash) throw new WebhookError("EVENT_CONTENT_MISMATCH",400);
   return {duplicate:true};
  }
  await reconcile(tx,adapter,sub.providerId!);
  await tx.insert(subscriptionEvents).values({id:event.id,payloadHash:hash,providerId:event.resource.id,eventType:event.event_type});
  return {duplicate:false};
 });
}
