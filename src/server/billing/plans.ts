import { z } from "zod";
export const planSelection = z.object({
  tier: z.enum(["SINGLE_OUTLET", "MULTI_OUTLET"]),
  billingPeriod: z.enum(["MONTHLY", "ANNUAL"]),
}).strict();
export type PlanSelection = z.infer<typeof planSelection>;

// Commercial terms are server-owned. Provider identifiers remain deployment configuration.
// New checkouts use the trial plans (FS-SUBSCRIPTION-TRIAL-DEC-001). legacyName identifies the
// original no-trial plans, kept read-only so subscriptions created on them still reconcile.
export const TRIAL_DAYS = 30;
export const catalogue = {
  SINGLE_OUTLET: {
    MONTHLY: {name:"Single Outlet Monthly, 30-day trial", legacyName:"Single Outlet Monthly", amount:"29.00", currency:"GBP", interval:"MONTH", locationLimit:1, variable:"PAYPAL_SINGLE_OUTLET_MONTHLY_PLAN_ID"},
    ANNUAL: {name:"Single Outlet Annual, 30-day trial", legacyName:"Single Outlet Annual", amount:"290.00", currency:"GBP", interval:"YEAR", locationLimit:1, variable:"PAYPAL_SINGLE_OUTLET_ANNUAL_PLAN_ID"},
  },
  MULTI_OUTLET: {
    MONTHLY: {name:"Multi Outlet Monthly, 30-day trial", legacyName:"Multi Outlet Monthly", amount:"69.00", currency:"GBP", interval:"MONTH", locationLimit:5, variable:"PAYPAL_MULTI_OUTLET_MONTHLY_PLAN_ID"},
    ANNUAL: {name:"Multi Outlet Annual, 30-day trial", legacyName:"Multi Outlet Annual", amount:"690.00", currency:"GBP", interval:"YEAR", locationLimit:5, variable:"PAYPAL_MULTI_OUTLET_ANNUAL_PLAN_ID"},
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
type Terms=ReturnType<typeof commercialPlan>;
// TRIAL: a free 30-day trial cycle, then the catalogue price. LEGACY: the original no-trial plans.
export type PlanShape="TRIAL"|"LEGACY";
// Compare decimal money exactly, including provider responses such as "29" or "29.0".
const pence=(value:string)=>{const [whole,fraction=""]=value.split(".");return BigInt(whole)*100n+BigInt(fraction.padEnd(2,"0"));};
const regularCycle=(cycle:Cycle|undefined,sequence:number,expected:Terms)=>!!cycle && !!cycle.pricing_scheme &&
  cycle.tenure_type === "REGULAR" && cycle.sequence === sequence && cycle.total_cycles === 0 &&
  cycle.frequency.interval_unit === expected.interval && cycle.frequency.interval_count === 1 &&
  !cycle.pricing_scheme.pricing_model && !cycle.pricing_scheme.tiers?.length &&
  cycle.pricing_scheme.fixed_price.currency_code === expected.currency && pence(cycle.pricing_scheme.fixed_price.value) === pence(expected.amount);
// A free trial has no pricing scheme at all; any priced trial is rejected.
const freeTrialCycle=(cycle:Cycle|undefined)=>!!cycle && cycle.tenure_type === "TRIAL" && cycle.sequence === 1 && cycle.total_cycles === 1 &&
  cycle.frequency.interval_unit === "DAY" && cycle.frequency.interval_count === TRIAL_DAYS && cycle.pricing_scheme === undefined;
const cyclesMatch=(cycles:Cycle[],shape:PlanShape,expected:Terms)=>shape === "LEGACY"
  ? cycles.length === 1 && regularCycle(cycles[0],1,expected)
  : cycles.length === 2 && freeTrialCycle(cycles.find(c=>c.tenure_type === "TRIAL")) && regularCycle(cycles.find(c=>c.tenure_type === "REGULAR"),2,expected);
// Checkout accepts only the trial shape by default. Reconciliation of existing subscriptions may also allow LEGACY.
export function assertCommercialPlan(value:unknown,input:PlanSelection,id:string,requireActive=true,shapes:readonly PlanShape[]=["TRIAL"]) {
  const plan=providerPlan.parse(value), expected=commercialPlan(input);
  if (plan.id !== id || (requireActive && plan.status !== "ACTIVE") || plan.quantity_supported ||
      !shapes.some(shape=>cyclesMatch(plan.billing_cycles,shape,expected)) ||
      (plan.payment_preferences.setup_fee && (plan.payment_preferences.setup_fee.currency_code !== expected.currency || pence(plan.payment_preferences.setup_fee.value) !== 0n)) ||
      (plan.taxes && !/^0+(\.0+)?$/.test(plan.taxes.percentage))) {
    throw new Error("PayPal plan does not match the FairShift catalogue. Checkout requires configuration review.");
  }
  return plan;
}
export function enterpriseContact(env:Record<string,string|undefined> = process.env) {
  const parsed=z.string().email().safeParse(env.FAIRSHIFT_ENTERPRISE_CONTACT_EMAIL);
  return parsed.success ? parsed.data : null;
}
