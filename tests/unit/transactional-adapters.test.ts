import { describe,expect,it,vi } from "vitest";
import { ResendEmail } from "@/server/notifications/email";
import { PayPalSubscriptions } from "@/server/billing/paypal";
import { paypalHeaders } from "../helpers/paypal";
import { readPayPalTransmissionHeaders } from "@/server/integrations/paypal/webhook";
const email={to:"worker@example.test",subject:"FairShift offer",text:"Review your offer",idempotencyKey:"notification/test"};
describe("transactional provider boundaries",()=>{
 it("leaves unconfigured email unsent and records only acknowledged sends",async()=>{
  expect(await new ResendEmail().send(email)).toEqual({status:"UNCONFIGURED"});
  const fetchImpl=vi.fn(async()=>Response.json({id:"resend-1"}));
  expect(await new ResendEmail("test","FairShift <mail@example.test>",fetchImpl).send(email)).toEqual({status:"ACCEPTED",messageId:"resend-1"});
  expect(fetchImpl.mock.calls[0]).toMatchObject(["https://api.resend.com/emails",{headers:{"Idempotency-Key":"notification/test"}}]);
  await expect(new ResendEmail("test","mail@example.test",async()=>Response.json({error:"no"},{status:422})).send(email)).rejects.toThrow();
  await expect(new ResendEmail("test","mail@example.test",async()=>Response.json({})).send(email)).rejects.toThrow();
 });
 it("uses OAuth, stable request ID and organisation reference for sandbox subscriptions",async()=>{
  const fetchImpl=vi.fn<typeof fetch>();
  fetchImpl.mockResolvedValueOnce(Response.json({access_token:"test-token",expires_in:3600,token_type:"Bearer"}));
  const organisationId="11111111-1111-4111-8111-111111111111";
  fetchImpl.mockResolvedValueOnce(Response.json({id:"I-EXAMPLE",plan_id:"P-EXAMPLE",custom_id:organisationId,status:"APPROVAL_PENDING"}));
  const client=new PayPalSubscriptions({PAYPAL_ENV:"sandbox",PAYPAL_CLIENT_ID:"test",PAYPAL_CLIENT_SECRET:"test",PAYPAL_WEBHOOK_ID:"test",APP_BASE_URL:"http://localhost:3000",PAYPAL_SANDBOX_CURRENCY:"USD",PAYPAL_SANDBOX_AMOUNT:"5.00",apiBaseUrl:"https://api-m.sandbox.paypal.com"},fetchImpl);
  await client.create({organisationId,requestId:"stable-id",planId:"P-EXAMPLE"});
  const call=fetchImpl.mock.calls[1];expect(call[0]).toBe("https://api-m.sandbox.paypal.com/v1/billing/subscriptions");
  expect(call[1]?.headers).toMatchObject({"PayPal-Request-Id":"stable-id"});
  expect(JSON.parse(String(call[1]?.body))).toMatchObject({custom_id:organisationId,plan_id:"P-EXAMPLE",application_context:{user_action:"SUBSCRIBE_NOW"}});
 });
 it("posts all transmission fields, the subscription listener ID and the unfiltered event to PayPal verification",async()=>{
  const fetchImpl=vi.fn<typeof fetch>();
  fetchImpl.mockResolvedValueOnce(Response.json({access_token:"test-token",expires_in:3600,token_type:"Bearer"}));
  fetchImpl.mockResolvedValueOnce(Response.json({verification_status:"SUCCESS"}));
  const client=new PayPalSubscriptions({PAYPAL_ENV:"sandbox",PAYPAL_CLIENT_ID:"test",PAYPAL_CLIENT_SECRET:"test",PAYPAL_WEBHOOK_ID:"subscription-listener-id",APP_BASE_URL:"http://localhost:3000",PAYPAL_SANDBOX_CURRENCY:"USD",PAYPAL_SANDBOX_AMOUNT:"5.00",apiBaseUrl:"https://api-m.sandbox.paypal.com"},fetchImpl);
  const event={id:"WH-EXAMPLE",event_type:"BILLING.SUBSCRIPTION.ACTIVATED",resource:{id:"I-EXAMPLE",status:"ACTIVE",provider_extension:{preserved:true}}};
  const transmission=readPayPalTransmissionHeaders(paypalHeaders());
  expect(await client.verifyWebhookSignature(transmission,event)).toBe(true);
  const call=fetchImpl.mock.calls[1];
  expect(call[0]).toBe("https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature");
  expect(call[1]?.headers).toMatchObject({Authorization:"Bearer test-token","Content-Type":"application/json"});
  expect(JSON.parse(String(call[1]?.body))).toEqual({auth_algo:transmission.authAlgo,cert_url:transmission.certUrl,transmission_id:transmission.transmissionId,transmission_sig:transmission.transmissionSig,transmission_time:transmission.transmissionTime,webhook_id:"subscription-listener-id",webhook_event:event});
 });
});
