import { describe,expect,it } from "vitest";
import { catalogue,commercialPlan,configuredPlan,assertCommercialPlan,planSelection } from "@/server/billing/plans";
import { legacyPlanFixture, planFixture, regularCycleOf } from "../helpers/subscription-plans";

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
  expect(terms.name).toMatch(/, 30-day trial$/);
  const env=Object.fromEntries(selections.map(([t,p],i)=>[catalogue[t][p].variable,`P-CHOICE${i}`]));
  expect(configuredPlan(selection,env)).toBe(env[terms.variable]);
  expect(assertCommercialPlan(planFixture("P-TEST",selection),selection,"P-TEST")).toMatchObject({id:"P-TEST"});
  expect(planSelection.safeParse({...selection,planId:"P-ATTACK",amount:terms.amount,currency:terms.currency}).success).toBe(false);
 });
 it("rejects Enterprise and arbitrary client billing terms",()=>{
  for(const extra of [{planId:"P-ATTACK"},{amount:"0.01"},{currency:"USD"},{locationLimit:100},{entitled:true}]) expect(planSelection.safeParse({tier:"SINGLE_OUTLET",billingPeriod:"MONTHLY",...extra}).success).toBe(false);
  expect(planSelection.safeParse({tier:"ENTERPRISE",billingPeriod:"MONTHLY"}).success).toBe(false);
 });
 const choice={tier:"SINGLE_OUTLET",billingPeriod:"MONTHLY"} as const;
 const altered=(change:(p:ReturnType<typeof planFixture>)=>void)=>{const p=planFixture("P-TEST");change(p);return p;};
 const trialOf=(p:ReturnType<typeof planFixture>)=>p.billing_cycles[0];
 it("fails closed on wrong price, currency, cadence, fees, taxes or quantity pricing",()=>{
  for(const plan of [
   altered(p=>{regularCycleOf(p).pricing_scheme!.fixed_price.value="0.29";}),
   altered(p=>{regularCycleOf(p).pricing_scheme!.fixed_price.currency_code="USD";}),
   altered(p=>{regularCycleOf(p).frequency.interval_unit="YEAR";}),
   altered(p=>{regularCycleOf(p).frequency.interval_count=2;}),
   altered(p=>{regularCycleOf(p).total_cycles=12;}),
   altered(p=>{delete regularCycleOf(p).pricing_scheme;}),
   altered(p=>{p.quantity_supported=true;}),
   {...planFixture("P-TEST"),payment_preferences:{setup_fee:{currency_code:"GBP",value:"1.00"}}},
   {...planFixture("P-TEST"),taxes:{percentage:"20"}},
   {...planFixture("P-TEST"),status:"INACTIVE"},
  ]) expect(()=>assertCommercialPlan(plan,choice,"P-TEST")).toThrow();
  const equivalent=planFixture("P-TEST");regularCycleOf(equivalent).pricing_scheme!.fixed_price.value="29";
  expect(()=>assertCommercialPlan(equivalent,choice,"P-TEST")).not.toThrow();
 });
 it("accepts only a free 30-day trial followed by the catalogue price at checkout",()=>{
  for(const plan of [
   altered(p=>{trialOf(p).frequency.interval_count=29;}),
   altered(p=>{trialOf(p).frequency.interval_count=31;}),
   altered(p=>{trialOf(p).frequency={interval_unit:"MONTH",interval_count:1};}),
   altered(p=>{trialOf(p).pricing_scheme={fixed_price:{currency_code:"GBP",value:"1.00"}};}),
   altered(p=>{trialOf(p).pricing_scheme={fixed_price:{currency_code:"GBP",value:"0"}};}),
   altered(p=>{trialOf(p).total_cycles=2;}),
   altered(p=>{p.billing_cycles.splice(1,0,{...trialOf(p),sequence:2});regularCycleOf(p).sequence=3;}),
   altered(p=>{trialOf(p).sequence=2;regularCycleOf(p).sequence=1;}),
   altered(p=>{trialOf(p).sequence=2;}),
   altered(p=>{p.billing_cycles.splice(1,1);}),
   altered(p=>{p.billing_cycles.splice(0,1);}),
   legacyPlanFixture("P-TEST"),
  ]) expect(()=>assertCommercialPlan(plan,choice,"P-TEST")).toThrow(/catalogue|pricing scheme/);
  const reversed=planFixture("P-TEST");reversed.billing_cycles.reverse();
  expect(()=>assertCommercialPlan(reversed,choice,"P-TEST")).not.toThrow();
 });
 it("reconciles an existing subscription on the trial or legacy shape, and nothing else",()=>{
  const reconcile=(plan:unknown)=>assertCommercialPlan(plan,choice,"P-TEST",false,["TRIAL","LEGACY"]);
  expect(()=>reconcile(planFixture("P-TEST"))).not.toThrow();
  expect(()=>reconcile(legacyPlanFixture("P-TEST"))).not.toThrow();
  expect(()=>reconcile({...legacyPlanFixture("P-TEST"),status:"INACTIVE"})).not.toThrow();
  const legacyTwelve=legacyPlanFixture("P-TEST");legacyTwelve.billing_cycles[0].total_cycles=12;
  const legacyWrongPrice=legacyPlanFixture("P-TEST");legacyWrongPrice.billing_cycles[0].pricing_scheme!.fixed_price.value="1.00";
  const legacyAtTwo=legacyPlanFixture("P-TEST");legacyAtTwo.billing_cycles[0].sequence=2;
  for(const plan of [legacyTwelve,legacyWrongPrice,legacyAtTwo,altered(p=>{trialOf(p).frequency.interval_count=14;}),altered(p=>{trialOf(p).pricing_scheme={fixed_price:{currency_code:"GBP",value:"5.00"}};})]) expect(()=>reconcile(plan)).toThrow();
 });
});
