import { describe,expect,it } from "vitest";
import { catalogue,commercialPlan,configuredPlan,assertCommercialPlan,planSelection } from "@/server/billing/plans";
import { planFixture } from "../helpers/subscription-plans";

describe("approved GBP commercial catalogue",()=>{
 const selections=[
  ["SINGLE_OUTLET","MONTHLY","29.00","MONTH",1],
  ["SINGLE_OUTLET","ANNUAL","290.00","YEAR",1],
  ["MULTI_OUTLET","MONTHLY","69.00","MONTH",5],
  ["MULTI_OUTLET","ANNUAL","690.00","YEAR",5],
 ] as const;
 it.each(selections)("pins %s %s price, cadence and location entitlement",(tier,billingPeriod,amount,interval,locationLimit)=>{
  const selection={tier,billingPeriod},terms=commercialPlan(selection);
  expect(terms).toMatchObject({amount,currency:"GBP",interval,locationLimit});
  const env=Object.fromEntries(selections.map(([t,p],i)=>[catalogue[t][p].variable,`P-CHOICE${i}`]));
  expect(configuredPlan(selection,env)).toBe(env[terms.variable]);
  expect(assertCommercialPlan(planFixture("P-TEST",selection),selection,"P-TEST")).toMatchObject({id:"P-TEST"});
  expect(planSelection.safeParse({...selection,planId:"P-ATTACK",amount:terms.amount,currency:terms.currency}).success).toBe(false);
 });
 it("rejects Enterprise and arbitrary client billing terms",()=>{
  for(const extra of [{planId:"P-ATTACK"},{amount:"0.01"},{currency:"USD"},{locationLimit:100},{entitled:true}]) expect(planSelection.safeParse({tier:"SINGLE_OUTLET",billingPeriod:"MONTHLY",...extra}).success).toBe(false);
  expect(planSelection.safeParse({tier:"ENTERPRISE",billingPeriod:"MONTHLY"}).success).toBe(false);
 });
 it("fails closed on wrong price, currency, cadence, trials, fees, taxes or quantity pricing",()=>{
  const choice={tier:"SINGLE_OUTLET",billingPeriod:"MONTHLY"} as const;
  const altered=(change:(p:ReturnType<typeof planFixture>)=>void)=>{const p=planFixture("P-TEST");change(p);return p;};
  for(const plan of [
   altered(p=>{p.billing_cycles[0].pricing_scheme.fixed_price.value="0.29";}),
   altered(p=>{p.billing_cycles[0].pricing_scheme.fixed_price.currency_code="USD" as never;}),
   altered(p=>{p.billing_cycles[0].frequency.interval_unit="YEAR";}),
   altered(p=>{p.billing_cycles[0].frequency.interval_count=2;}),
   altered(p=>{p.billing_cycles.push({...p.billing_cycles[0],tenure_type:"TRIAL"});}),
   altered(p=>{p.billing_cycles[0].total_cycles=12;}),
   altered(p=>{p.quantity_supported=true;}),
   {...planFixture("P-TEST"),payment_preferences:{setup_fee:{currency_code:"GBP",value:"1.00"}}},
   {...planFixture("P-TEST"),taxes:{percentage:"20"}},
   {...planFixture("P-TEST"),status:"INACTIVE"},
  ]) expect(()=>assertCommercialPlan(plan,choice,"P-TEST")).toThrow();
  const equivalent=planFixture("P-TEST");equivalent.billing_cycles[0].pricing_scheme.fixed_price.value="29";
  expect(()=>assertCommercialPlan(equivalent,choice,"P-TEST")).not.toThrow();
 });
});
