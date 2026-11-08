import { commercialPlan, TRIAL_DAYS, type PlanSelection } from "@/server/billing/plans";
type Cycle={tenure_type:string;sequence:number;total_cycles:number;frequency:{interval_unit:string;interval_count:number};pricing_scheme?:{fixed_price:{currency_code:string;value:string}}};
type Price={amount:string;currency:string};
const regular=(selection:PlanSelection,sequence:number,price:Price=commercialPlan(selection)):Cycle=>({tenure_type:"REGULAR",sequence,total_cycles:0,frequency:{interval_unit:commercialPlan(selection).interval,interval_count:1},pricing_scheme:{fixed_price:{currency_code:String(price.currency),value:String(price.amount)}}});
// A new object each time: tests alter fixtures in place.
const trial=():Cycle=>({tenure_type:"TRIAL",sequence:1,total_cycles:1,frequency:{interval_unit:"DAY",interval_count:TRIAL_DAYS}});
const plan=(id:string,billing_cycles:Cycle[])=>({id,product_id:"PROD-TESTCATALOGUE",status:"ACTIVE",quantity_supported:false,billing_cycles,payment_preferences:{}});
const earlier=(selection:PlanSelection,shape:"TRIAL"|"LEGACY")=>commercialPlan(selection).previous.find(p=>p.shape === shape)!;

// The USD trial plans created in the FairShift PayPal Sandbox on 8 November 2026 (Owner pricing decision).
export const USD_SANDBOX_PLAN_IDS = {
 PAYPAL_SINGLE_OUTLET_MONTHLY_PLAN_ID:"P-5U646656F53669406NLYFG4A",
 PAYPAL_SINGLE_OUTLET_ANNUAL_PLAN_ID:"P-03N78956GR621793BNLYFG4Q",
 PAYPAL_MULTI_OUTLET_MONTHLY_PLAN_ID:"P-8D21565845075562BNLYFG5A",
 PAYPAL_MULTI_OUTLET_ANNUAL_PLAN_ID:"P-5B101351GN843403KNLYFG5I",
} as const;

/** Controlled provider fixture, never used by runtime or seed data: a free 30-day trial, then the catalogue's USD price. */
export function planFixture(id="P-EXAMPLE",selection:PlanSelection={tier:"SINGLE_OUTLET",billingPeriod:"MONTHLY"}) {
 return plan(id,[trial(),regular(selection,2)]);
}
/** The original no-trial GBP plan, used only by subscriptions created before the trial plans. */
export function legacyPlanFixture(id="P-EXAMPLE",selection:PlanSelection={tier:"SINGLE_OUTLET",billingPeriod:"MONTHLY"}) {
 return plan(id,[regular(selection,1,earlier(selection,"LEGACY"))]);
}
/** The earlier GBP 30-day trial plan, used only by subscriptions created before the USD plans. */
export function gbpTrialPlanFixture(id="P-EXAMPLE",selection:PlanSelection={tier:"SINGLE_OUTLET",billingPeriod:"MONTHLY"}) {
 return plan(id,[trial(),regular(selection,2,earlier(selection,"TRIAL"))]);
}
/** The paid regular cycle of a fixture, for tests that alter its price. */
export const regularCycleOf=(p:ReturnType<typeof planFixture>)=>p.billing_cycles.find(c=>c.tenure_type === "REGULAR")!;
