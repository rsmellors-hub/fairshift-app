import { z } from "zod";
export const planSelection = z.object({
  tier: z.enum(["SINGLE_OUTLET", "MULTI_OUTLET"]),
  billingPeriod: z.enum(["MONTHLY", "ANNUAL"]),
}).strict();
export type PlanSelection = z.infer<typeof planSelection>;

// Commercial terms are server-owned. Provider identifiers remain deployment configuration.
// Demo pricing (Owner decision, 8 November 2026, FS-HACK-SA-AMENDMENT-001 section 5): the price list
// is in the home currency, rand, including 15% VAT. PayPal can't bill in rand, so it bills the US
// dollar amounts the Owner set (ECB 6 November 2026, 16.5382). Those are fixed here, never computed
// at checkout, and FairShift never shows its own conversion as the charge. New checkouts use the
// 30-day trial plans (FS-SUBSCRIPTION-TRIAL-DEC-001). `previous` lists the earlier GBP provider
// plans, with and without the trial, kept read-only so subscriptions created on them still reconcile.
export const TRIAL_DAYS = 30;
export const PRICE_LIST = { homeCurrency: "ZAR", vatPercent: 15 } as const;

// PayPal's currency codes for REST payments (developer.paypal.com/api/rest/reference/currency-codes/).
// ZAR is not among them.
const PAYPAL_CURRENCIES: ReadonlySet<string> = new Set(["AUD", "BRL", "CAD", "CNY", "CZK", "DKK", "EUR", "HKD", "HUF", "ILS", "JPY", "MYR", "MXN", "TWD", "NZD", "NOK", "PHP", "PLN", "GBP", "SGD", "SEK", "CHF", "THB", "USD"]);
// Billing uses the home currency where PayPal supports it, otherwise USD (Owner decision, 8 November 2026).
export function billingCurrencyFor(homeCurrency: string) {
  return PAYPAL_CURRENCIES.has(homeCurrency) ? homeCurrency : "USD";
}

type Interval = "MONTH" | "YEAR";
// An earlier provider plan: TRIAL is a free 30-day trial then the price; LEGACY is the original no-trial plan.
type PreviousPlan = { name: string; amount: string; currency: string; shape: PlanShape };
const gbp = (label: string, amount: string): PreviousPlan[] => [
  { name: `${label}, 30-day trial`, amount, currency: "GBP", shape: "TRIAL" },
  { name: label, amount, currency: "GBP", shape: "LEGACY" },
];
export const catalogue = {
  SINGLE_OUTLET: {
    MONTHLY: {name:"Venue Monthly (USD), 30-day trial", amount:"30.17", currency:"USD", homeAmount:"499.00", interval:"MONTH", locationLimit:1, variable:"PAYPAL_SINGLE_OUTLET_MONTHLY_PLAN_ID", previous:gbp("Single Outlet Monthly","29.00")},
    ANNUAL: {name:"Venue Annual (USD), 30-day trial", amount:"301.73", currency:"USD", homeAmount:"4990.00", interval:"YEAR", locationLimit:1, variable:"PAYPAL_SINGLE_OUTLET_ANNUAL_PLAN_ID", previous:gbp("Single Outlet Annual","290.00")},
  },
  MULTI_OUTLET: {
    MONTHLY: {name:"Group Monthly (USD), 30-day trial", amount:"69.48", currency:"USD", homeAmount:"1149.00", interval:"MONTH", locationLimit:5, variable:"PAYPAL_MULTI_OUTLET_MONTHLY_PLAN_ID", previous:gbp("Multi Outlet Monthly","69.00")},
    ANNUAL: {name:"Group Annual (USD), 30-day trial", amount:"694.76", currency:"USD", homeAmount:"11490.00", interval:"YEAR", locationLimit:5, variable:"PAYPAL_MULTI_OUTLET_ANNUAL_PLAN_ID", previous:gbp("Multi Outlet Annual","690.00")},
  },
} as const;
export function commercialPlan(input:PlanSelection) {
  const {tier,billingPeriod}=planSelection.parse(input);
  return catalogue[tier][billingPeriod];
}
export function configuredPlan(input: PlanSelection, env: Record<string,string|undefined> = process.env) {
  const selected=commercialPlan(input);
  const ids=Object.values(catalogue).flatMap(periods=>Object.values(periods).map(plan=>env[plan.variable])).filter(Boolean);
  if (new Set(ids).size !== ids.length) return null;
  const id=env[selected.variable];
  return id && /^P-[A-Z0-9]+$/.test(id) ? id : null;
}
export const locationLimitFor = (tier: PlanSelection["tier"]) => commercialPlan({tier,billingPeriod:"MONTHLY"}).locationLimit;

const money=z.object({currency_code:z.string(),value:z.string().regex(/^\d{1,12}(\.\d{1,2})?$/)});
export const providerPlan = z.object({
  id:z.string(), product_id:z.string().regex(/^PROD-[A-Z0-9]+$/), status:z.string(),
  quantity_supported:z.boolean().optional(),
  billing_cycles:z.array(z.object({
    tenure_type:z.string(), sequence:z.number().int(), total_cycles:z.number().int(),
    frequency:z.object({interval_unit:z.string(),interval_count:z.number().int()}),
    pricing_scheme:z.object({fixed_price:money,pricing_model:z.string().optional(),tiers:z.array(z.unknown()).optional()}).optional(),
  }).refine(cycle=>cycle.tenure_type === "TRIAL" || !!cycle.pricing_scheme,"A regular billing cycle requires a pricing scheme.")),
  payment_preferences:z.object({setup_fee:money.optional()}),
  taxes:z.object({percentage:z.string()}).optional(),
});
type Cycle=z.infer<typeof providerPlan>["billing_cycles"][number];
type Price={amount:string;currency:string;interval:Interval};
// TRIAL: a free 30-day trial cycle, then the price. LEGACY: the original no-trial plans.
export type PlanShape="TRIAL"|"LEGACY";
// Compare decimal money exactly, including provider responses such as "29" or "29.0".
const pence=(value:string)=>{const [whole,fraction=""]=value.split(".");return BigInt(whole)*100n+BigInt(fraction.padEnd(2,"0"));};
const regularCycle=(cycle:Cycle|undefined,sequence:number,expected:Price)=>!!cycle && !!cycle.pricing_scheme &&
  cycle.tenure_type === "REGULAR" && cycle.sequence === sequence && cycle.total_cycles === 0 &&
  cycle.frequency.interval_unit === expected.interval && cycle.frequency.interval_count === 1 &&
  !cycle.pricing_scheme.pricing_model && !cycle.pricing_scheme.tiers?.length &&
  cycle.pricing_scheme.fixed_price.currency_code === expected.currency && pence(cycle.pricing_scheme.fixed_price.value) === pence(expected.amount);
// A free trial has no pricing scheme at all; any priced trial is rejected.
const freeTrialCycle=(cycle:Cycle|undefined)=>!!cycle && cycle.tenure_type === "TRIAL" && cycle.sequence === 1 && cycle.total_cycles === 1 &&
  cycle.frequency.interval_unit === "DAY" && cycle.frequency.interval_count === TRIAL_DAYS && cycle.pricing_scheme === undefined;
const cyclesMatch=(cycles:Cycle[],shape:PlanShape,expected:Price)=>shape === "LEGACY"
  ? cycles.length === 1 && regularCycle(cycles[0],1,expected)
  : cycles.length === 2 && freeTrialCycle(cycles.find(c=>c.tenure_type === "TRIAL")) && regularCycle(cycles.find(c=>c.tenure_type === "REGULAR"),2,expected);
// The provider plans a subscription on this selection may be bound to: the current USD trial plan
// for checkout; when reconciling an existing subscription, also any earlier plan.
function acceptedPlans(input:PlanSelection,reconciling:boolean) {
  const current=commercialPlan(input);
  const now={amount:current.amount,currency:current.currency,interval:current.interval,shape:"TRIAL" as PlanShape};
  return reconciling ? [now,...current.previous.map(p=>({...p,interval:current.interval}))] : [now];
}
function matchesPlan(plan:z.infer<typeof providerPlan>,expected:Price&{shape:PlanShape}) {
  return cyclesMatch(plan.billing_cycles,expected.shape,expected) &&
    !(plan.payment_preferences.setup_fee && (plan.payment_preferences.setup_fee.currency_code !== expected.currency || pence(plan.payment_preferences.setup_fee.value) !== 0n));
}
// Checkout accepts only the current USD trial plan. Reconciliation of an existing subscription
// (`reconciling`) also accepts the earlier GBP plans, and does not require the plan to be active.
export function assertCommercialPlan(value:unknown,input:PlanSelection,id:string,reconciling=false) {
  const plan=providerPlan.parse(value);
  if (plan.id !== id || (!reconciling && plan.status !== "ACTIVE") || plan.quantity_supported ||
      !acceptedPlans(input,reconciling).some(expected=>matchesPlan(plan,expected)) ||
      (plan.taxes && !/^0+(\.0+)?$/.test(plan.taxes.percentage))) {
    throw new Error("PayPal plan does not match the FairShift catalogue. Checkout requires configuration review.");
  }
  return plan;
}
export function enterpriseContact(env:Record<string,string|undefined> = process.env) {
  const parsed=z.string().email().safeParse(env.FAIRSHIFT_ENTERPRISE_CONTACT_EMAIL);
  return parsed.success ? parsed.data : null;
}
