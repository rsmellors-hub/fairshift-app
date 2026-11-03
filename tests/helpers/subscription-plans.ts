import { commercialPlan, TRIAL_DAYS, type PlanSelection } from "@/server/billing/plans";
type Cycle={tenure_type:string;sequence:number;total_cycles:number;frequency:{interval_unit:string;interval_count:number};pricing_scheme?:{fixed_price:{currency_code:string;value:string}}};
const regular=(selection:PlanSelection,sequence:number):Cycle=>{
 const terms=commercialPlan(selection);
 return {tenure_type:"REGULAR",sequence,total_cycles:0,frequency:{interval_unit:terms.interval,interval_count:1},pricing_scheme:{fixed_price:{currency_code:String(terms.currency),value:String(terms.amount)}}};
};
const plan=(id:string,billing_cycles:Cycle[])=>({id,product_id:"PROD-TESTCATALOGUE",status:"ACTIVE",quantity_supported:false,billing_cycles,payment_preferences:{}});
/** Controlled provider fixture, never used by runtime or seed data: a free 30-day trial, then the catalogue price. */
export function planFixture(id="P-EXAMPLE",selection:PlanSelection={tier:"SINGLE_OUTLET",billingPeriod:"MONTHLY"}) {
 return plan(id,[{tenure_type:"TRIAL",sequence:1,total_cycles:1,frequency:{interval_unit:"DAY",interval_count:TRIAL_DAYS}},regular(selection,2)]);
}
/** The original no-trial plan shape, used only by subscriptions created before the trial plans. */
export function legacyPlanFixture(id="P-EXAMPLE",selection:PlanSelection={tier:"SINGLE_OUTLET",billingPeriod:"MONTHLY"}) {
 return plan(id,[regular(selection,1)]);
}
/** The paid regular cycle of a fixture, for tests that alter its price. */
export const regularCycleOf=(p:ReturnType<typeof planFixture>)=>p.billing_cycles.find(c=>c.tenure_type === "REGULAR")!;
