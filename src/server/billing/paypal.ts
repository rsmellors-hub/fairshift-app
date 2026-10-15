import { z } from "zod";
import { PayPalClient } from "@/server/integrations/paypal/client";
import type { PayPalTransmissionHeaders } from "@/server/integrations/paypal/client";
import { applicationOrigin } from "@/server/notifications/email";
export const subscriptionDetails = z.object({id:z.string().regex(/^I-[A-Z0-9]+$/),plan_id:z.string().min(1),custom_id:z.string().uuid(),status:z.enum(["APPROVAL_PENDING","APPROVED","ACTIVE","SUSPENDED","CANCELLED","EXPIRED"]),links:z.array(z.object({rel:z.string(),href:z.string().url()})).optional()});
export type SubscriptionDetails=z.infer<typeof subscriptionDetails>;
export interface SubscriptionAdapter {
 create(input:{organisationId:string;requestId:string;planId:string}):Promise<SubscriptionDetails>;
 get(id:string):Promise<SubscriptionDetails>;
 verifyWebhookSignature(headers:PayPalTransmissionHeaders,event:unknown):Promise<boolean>;
}
export class PayPalSubscriptions extends PayPalClient implements SubscriptionAdapter {
 async create(input:{organisationId:string;requestId:string;planId:string}) {
  return subscriptionDetails.parse(await this.authorizedRequest("/v1/billing/subscriptions",{method:"POST",headers:{"Content-Type":"application/json","PayPal-Request-Id":input.requestId,Prefer:"return=representation"},body:JSON.stringify({plan_id:input.planId,custom_id:input.organisationId,application_context:{brand_name:"FairShift",user_action:"SUBSCRIBE_NOW",shipping_preference:"NO_SHIPPING",return_url:`${applicationOrigin()}/billing/return`,cancel_url:`${applicationOrigin()}/owner/settings?billing=cancelled`}})}));
 }
 async get(id:string) {return subscriptionDetails.parse(await this.authorizedRequest(`/v1/billing/subscriptions/${encodeURIComponent(id)}`,{method:"GET"}));}
}
export function getSubscriptionAdapter():SubscriptionAdapter|null {
 const parsed=z.object({PAYPAL_CLIENT_ID:z.string().min(1),PAYPAL_CLIENT_SECRET:z.string().min(1),PAYPAL_SUBSCRIPTION_PLAN_ID:z.string().regex(/^P-[A-Z0-9]+$/),PAYPAL_SUBSCRIPTION_WEBHOOK_ID:z.string().min(1),PAYPAL_ENVIRONMENT:z.literal("sandbox").default("sandbox")}).safeParse(process.env);
 if (!parsed.success) return null;
 return new PayPalSubscriptions({...parsed.data,PAYPAL_ENV:"sandbox",PAYPAL_WEBHOOK_ID:parsed.data.PAYPAL_SUBSCRIPTION_WEBHOOK_ID,APP_BASE_URL:applicationOrigin(),PAYPAL_SANDBOX_CURRENCY:"USD",PAYPAL_SANDBOX_AMOUNT:"5.00",apiBaseUrl:"https://api-m.sandbox.paypal.com"});
}
export function approvalLink(details:SubscriptionDetails) {
 const href=details.links?.find(l => l.rel === "approve")?.href;
 if (!href) return null;
 const url=new URL(href);
 if (url.protocol !== "https:" || url.hostname !== "www.sandbox.paypal.com") throw new Error("Invalid PayPal approval URL.");
 return href;
}
