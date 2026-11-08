/** Explicit one-off Sandbox catalogue provisioning; never imported by application startup. */
import { createHash } from "node:crypto";
import { assertCommercialPlan, catalogue, TRIAL_DAYS, type PlanSelection } from "../src/server/billing/plans";

const base="https://api-m.sandbox.paypal.com";
const apply=process.argv.slice(2).includes("--apply");
const withWebhook=process.argv.slice(2).includes("--subscription-webhook");
if (process.argv.slice(2).some(arg=>!["--apply","--subscription-webhook"].includes(arg))) throw new Error("Use --apply and/or --subscription-webhook; omit --apply for read-only inspection.");
if (process.env.PAYPAL_ENVIRONMENT !== "sandbox" || (process.env.PAYPAL_ENV && process.env.PAYPAL_ENV !== "sandbox")) throw new Error("Explicit PayPal Sandbox configuration is required.");
if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) throw new Error("PayPal Sandbox credentials are unavailable.");

async function main() {
 const auth=await fetch(`${base}/v1/oauth2/token`,{method:"POST",headers:{Authorization:`Basic ${Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64")}`,"Content-Type":"application/x-www-form-urlencoded"},body:"grant_type=client_credentials",signal:AbortSignal.timeout(20000)});
 if (!auth.ok) throw new Error(`Sandbox OAuth HTTP ${auth.status}.`);
 const {access_token}=await auth.json();
 if (typeof access_token !== "string") throw new Error("Invalid Sandbox OAuth response.");
 async function request(path:string,body?:object) {
  const response=await fetch(`${base}${path}`,{method:body ? "POST":"GET",headers:{Authorization:`Bearer ${access_token}`,"Content-Type":"application/json",Prefer:"return=representation",...(body ? {"PayPal-Request-Id":createHash("sha256").update(`fairshift-plans-v2:${path}:${JSON.stringify(body)}`).digest("hex").slice(0,38)} : {})},...(body ? {body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
  // Never log credentials, raw provider responses or automatic retries on uncertain results.
  if (!response.ok) throw new Error(`Sandbox catalogue request HTTP ${response.status}. Stop and inspect before retrying.`);
  return response.json();
 }
 type Summary={id:string;name:string;product_id?:string;status?:string};
 async function list(path:string,key:"products"|"plans") {
  const all:Summary[]=[];
  for(let page=1;page<=100;page++) {
   const result=await request(`${path}?page_size=20&page=${page}&total_required=true`);
   if (!Array.isArray(result[key])) throw new Error("Invalid Sandbox catalogue listing.");
   all.push(...result[key]);
   if ((typeof result.total_pages === "number" && page>=result.total_pages) || result[key].length<20) return all;
  }
  throw new Error("Incomplete catalogue pagination. No mutation allowed.");
 }
 const webhookUrl="https://getafairshift.com/api/webhooks/paypal-subscriptions";
 const events=["CREATED","ACTIVATED","UPDATED","SUSPENDED","CANCELLED","EXPIRED"].map(name=>`BILLING.SUBSCRIPTION.${name}`).sort();
 type Hook={id:string;url:string;event_types:{name:string}[]};
 const hookShape=(hook:Hook)=>({id:hook.id,url:hook.url,events:hook.event_types.map(e=>e.name).sort()});
 const hooks:Hook[]=withWebhook ? (await request("/v1/notifications/webhooks")).webhooks : [];
 const candidates=hooks.filter(h=>h.url === webhookUrl || h.event_types.some(e=>e.name.startsWith("BILLING.SUBSCRIPTION.") || e.name === "*"));
 if (withWebhook && (candidates.length>1 || candidates.some(h=>h.url !== webhookUrl || JSON.stringify(hookShape(h).events) !== JSON.stringify(events)))) throw new Error("Existing subscription webhook configuration is ambiguous. No mutation allowed.");
 const products=await list("/v1/catalogs/products","products"),plans=await list("/v1/billing/plans","plans");
 const matches=products.filter(p=>/fair\s?shift/i.test(p.name));
 if (matches.length>1 || matches.some(p=>p.name !== "FairShift")) throw new Error("Ambiguous existing FairShift products. No mutation allowed.");
 let product=matches[0];
 const selections=(Object.keys(catalogue) as PlanSelection["tier"][]).flatMap(tier=>(["MONTHLY","ANNUAL"] as const).map(billingPeriod=>({selection:{tier,billingPeriod} as PlanSelection,terms:catalogue[tier][billingPeriod]})));
 // Every plan name FairShift has used: the current USD trial plans, and the earlier GBP plans
 // (trial and original no-trial), which stay read-only so subscriptions on them still reconcile.
 const known=new Map<string,{selection:PlanSelection;current:boolean}>();
 for(const {selection,terms} of selections) {
  known.set(terms.name,{selection,current:true});
  for(const previous of terms.previous) known.set(previous.name,{selection,current:false});
 }
 const related=plans.filter(p=>p.product_id === product?.id || known.has(p.name) || /fair\s?shift|single outlet|multi outlet/i.test(p.name));
 // Validate every existing candidate before creating any missing object.
 for(const existing of related) {
  const entry=known.get(existing.name);
  if (!product || existing.product_id !== product.id || !entry || related.filter(p=>p.name === existing.name).length !== 1) throw new Error("Ambiguous or conflicting existing FairShift plans. No mutation allowed.");
  assertCommercialPlan(await request(`/v1/billing/plans/${existing.id}`),entry.selection,existing.id,!entry.current);
 }
 if (product) {
  const details=await request(`/v1/catalogs/products/${product.id}`);
  if (details.name !== "FairShift" || details.type !== "SERVICE") throw new Error("Existing FairShift product needs review.");
 }
 if (!apply) {
  console.log(JSON.stringify({mode:"READ_ONLY",productId:product?.id??null,existingPlans:related.map(p=>({id:p.id,name:p.name,status:p.status??null,current:!!known.get(p.name)?.current})),subscriptionWebhook:withWebhook ? candidates[0]?.id??"MISSING" : "NOT_INSPECTED",missingPlans:selections.filter(p=>!related.some(e=>e.name === p.terms.name)).map(p=>p.terms.name)},null,2));return;
 }
 if (!product) product=await request("/v1/catalogs/products",{name:"FairShift",description:"FairShift organisation workforce planning subscription",type:"SERVICE",category:"SOFTWARE",home_url:"https://getafairshift.com"});
 if (!/^PROD-[A-Z0-9]+$/.test(product.id)) throw new Error("Invalid product identifier. Stop before creating plans.");
 console.log(`PAYPAL_PRODUCT_ID=${product.id}`);
 for(const {selection,terms} of selections) {
  let plan=related.find(p=>p.name === terms.name);
  if (!plan) plan=await request("/v1/billing/plans",{product_id:product.id,name:terms.name,status:"ACTIVE",quantity_supported:false,billing_cycles:[{frequency:{interval_unit:"DAY",interval_count:TRIAL_DAYS},tenure_type:"TRIAL",sequence:1,total_cycles:1},{frequency:{interval_unit:terms.interval,interval_count:1},tenure_type:"REGULAR",sequence:2,total_cycles:0,pricing_scheme:{fixed_price:{value:terms.amount,currency_code:terms.currency}}}],payment_preferences:{}});
  if (!plan?.id) throw new Error("Missing plan identifier. Stop before continuing.");
  const verified=assertCommercialPlan(await request(`/v1/billing/plans/${plan.id}`),selection,plan.id);
  if (verified.product_id !== product.id) throw new Error("Product mismatch. Stop before continuing.");
  console.log(`${terms.variable}=${verified.id}`);
 }
 if (withWebhook) {
  const hook:Hook=candidates[0]??await request("/v1/notifications/webhooks",{url:webhookUrl,event_types:events.map(name=>({name}))});
  const after:Hook[]=(await request("/v1/notifications/webhooks")).webhooks;
  if (!after.some(h=>h.id === hook.id && h.url === webhookUrl && JSON.stringify(hookShape(h).events) === JSON.stringify(events))) throw new Error("Subscription webhook verification failed.");
  for(const before of hooks) {
   const preserved=after.find(h=>h.id === before.id);
   if (!preserved || JSON.stringify(hookShape(before)) !== JSON.stringify(hookShape(preserved))) throw new Error("Existing webhook preservation check failed.");
  }
  console.log(`PAYPAL_SUBSCRIPTION_WEBHOOK_ID=${hook.id}`);
  console.log("Existing webhooks unchanged: PASS");
 }
}
main().catch((error:unknown)=>{console.error(error instanceof Error ? error.message : "Sandbox catalogue operation stopped.");console.error("No automatic retry. Inspect existing objects read-only before continuing.");process.exitCode=1;});
