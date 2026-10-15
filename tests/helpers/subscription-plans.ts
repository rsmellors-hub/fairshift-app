import { commercialPlan, type PlanSelection } from "@/server/billing/plans";
/** Controlled provider fixture, never used by runtime or seed data. */
export function planFixture(id="P-EXAMPLE",selection:PlanSelection={tier:"SINGLE_OUTLET",billingPeriod:"MONTHLY"}) {
 const terms=commercialPlan(selection);
 return {id,product_id:"PROD-TESTCATALOGUE",status:"ACTIVE",quantity_supported:false,billing_cycles:[{tenure_type:"REGULAR",sequence:1,total_cycles:0,frequency:{interval_unit:terms.interval,interval_count:1},pricing_scheme:{fixed_price:{currency_code:String(terms.currency),value:String(terms.amount)}}}],payment_preferences:{}};
}
