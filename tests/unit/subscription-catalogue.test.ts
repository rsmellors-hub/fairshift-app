import { describe,expect,it } from "vitest";
import { billingCurrencyFor,catalogue,commercialPlan,configuredPlan,assertCommercialPlan,planSelection,PRICE_LIST } from "@/server/billing/plans";
import { gbpTrialPlanFixture, legacyPlanFixture, planFixture, regularCycleOf, USD_SANDBOX_PLAN_IDS } from "../helpers/subscription-plans";

// Owner pricing decision, 8 November 2026: rand prices incl. 15% VAT, billed by PayPal in USD at the Owner's amounts.
const selections=[
 ["SINGLE_OUTLET","MONTHLY","499.00","30.17","MONTH",1],
 ["SINGLE_OUTLET","ANNUAL","4990.00","301.73","YEAR",1],
 ["MULTI_OUTLET","MONTHLY","1149.00","69.48","MONTH",5],
 ["MULTI_OUTLET","ANNUAL","11490.00","694.76","YEAR",5],
] as const;

describe("approved demo catalogue: rand prices billed in USD",()=>{
 it.each(selections)("pins %s %s: R%s, billed as US$%s, cadence and location entitlement",(tier,billingPeriod,homeAmount,amount,interval,locationLimit)=>{
  const selection={tier,billingPeriod},terms=commercialPlan(selection);
  expect(terms).toMatchObject({homeAmount,amount,currency:"USD",interval,locationLimit});
  expect(terms.name).toMatch(/\(USD\), 30-day trial$/);
  expect(configuredPlan(selection,USD_SANDBOX_PLAN_IDS)).toBe(USD_SANDBOX_PLAN_IDS[terms.variable]);
  expect(assertCommercialPlan(planFixture("P-TEST",selection),selection,"P-TEST")).toMatchObject({id:"P-TEST"});
  expect(planSelection.safeParse({...selection,planId:"P-ATTACK",amount:terms.amount,currency:terms.currency}).success).toBe(false);
 });
 it("annual is ten months of the monthly rand price",()=>{
  for(const tier of ["SINGLE_OUTLET","MULTI_OUTLET"] as const) expect(Number(catalogue[tier].ANNUAL.homeAmount)).toBe(10*Number(catalogue[tier].MONTHLY.homeAmount));
 });
 it("rejects Enterprise and arbitrary client billing terms",()=>{
  for(const extra of [{planId:"P-ATTACK"},{amount:"0.01"},{currency:"ZAR"},{locationLimit:100},{entitled:true}]) expect(planSelection.safeParse({tier:"SINGLE_OUTLET",billingPeriod:"MONTHLY",...extra}).success).toBe(false);
  expect(planSelection.safeParse({tier:"ENTERPRISE",billingPeriod:"MONTHLY"}).success).toBe(false);
 });
});

describe("plan selection by currency",()=>{
 it("bills in the home currency where PayPal supports it, otherwise USD",()=>{
  expect(billingCurrencyFor("ZAR")).toBe("USD");
  expect(billingCurrencyFor("USD")).toBe("USD");
  expect(billingCurrencyFor("GBP")).toBe("GBP");
  expect(billingCurrencyFor("EUR")).toBe("EUR");
 });
 it("prices the catalogue in rand and bills every plan in the currency the rule picks for rand",()=>{
  expect(PRICE_LIST).toEqual({homeCurrency:"ZAR",vatPercent:15});
  for(const [tier,billingPeriod] of selections) expect(commercialPlan({tier,billingPeriod}).currency).toBe(billingCurrencyFor(PRICE_LIST.homeCurrency));
 });
 it.each(selections)("checkout of %s %s selects the USD plan and refuses the earlier GBP plans",(tier,billingPeriod)=>{
  const selection={tier,billingPeriod};
  expect(()=>assertCommercialPlan(planFixture("P-TEST",selection),selection,"P-TEST")).not.toThrow();
  expect(()=>assertCommercialPlan(gbpTrialPlanFixture("P-TEST",selection),selection,"P-TEST")).toThrow(/catalogue/);
  expect(()=>assertCommercialPlan(legacyPlanFixture("P-TEST",selection),selection,"P-TEST")).toThrow(/catalogue/);
 });
 it("refuses a configuration that reuses one plan ID for two plans",()=>{
  expect(configuredPlan({tier:"SINGLE_OUTLET",billingPeriod:"MONTHLY"},{...USD_SANDBOX_PLAN_IDS,PAYPAL_MULTI_OUTLET_ANNUAL_PLAN_ID:USD_SANDBOX_PLAN_IDS.PAYPAL_SINGLE_OUTLET_MONTHLY_PLAN_ID})).toBeNull();
 });
});

describe("provider plan validation",()=>{
 const choice={tier:"SINGLE_OUTLET",billingPeriod:"MONTHLY"} as const;
 const altered=(change:(p:ReturnType<typeof planFixture>)=>void)=>{const p=planFixture("P-TEST");change(p);return p;};
 const trialOf=(p:ReturnType<typeof planFixture>)=>p.billing_cycles[0];
 it("fails closed on wrong price, currency, cadence, fees, taxes or quantity pricing",()=>{
  for(const plan of [
   altered(p=>{regularCycleOf(p).pricing_scheme!.fixed_price.value="0.30";}),
   altered(p=>{regularCycleOf(p).pricing_scheme!.fixed_price.value="499.00";}),
   altered(p=>{regularCycleOf(p).pricing_scheme!.fixed_price.currency_code="GBP";}),
   altered(p=>{regularCycleOf(p).pricing_scheme!.fixed_price.currency_code="ZAR";}),
   altered(p=>{regularCycleOf(p).frequency.interval_unit="YEAR";}),
   altered(p=>{regularCycleOf(p).frequency.interval_count=2;}),
   altered(p=>{regularCycleOf(p).total_cycles=12;}),
   altered(p=>{delete regularCycleOf(p).pricing_scheme;}),
   altered(p=>{p.quantity_supported=true;}),
   {...planFixture("P-TEST"),payment_preferences:{setup_fee:{currency_code:"USD",value:"1.00"}}},
   {...planFixture("P-TEST"),taxes:{percentage:"15"}},
   {...planFixture("P-TEST"),status:"INACTIVE"},
  ]) expect(()=>assertCommercialPlan(plan,choice,"P-TEST")).toThrow();
  // Whole amounts may come back without decimals ("29" for "29.00"): an earlier GBP plan still reconciles.
  const whole=legacyPlanFixture("P-TEST");whole.billing_cycles[0].pricing_scheme!.fixed_price.value="29";
  expect(()=>assertCommercialPlan(whole,choice,"P-TEST",true)).not.toThrow();
 });
 it("accepts only a free 30-day trial followed by the catalogue price at checkout",()=>{
  for(const plan of [
   altered(p=>{trialOf(p).frequency.interval_count=29;}),
   altered(p=>{trialOf(p).frequency.interval_count=31;}),
   altered(p=>{trialOf(p).frequency={interval_unit:"MONTH",interval_count:1};}),
   altered(p=>{trialOf(p).pricing_scheme={fixed_price:{currency_code:"USD",value:"1.00"}};}),
   altered(p=>{trialOf(p).pricing_scheme={fixed_price:{currency_code:"USD",value:"0"}};}),
   altered(p=>{trialOf(p).total_cycles=2;}),
   altered(p=>{p.billing_cycles.splice(1,0,{...trialOf(p),sequence:2});regularCycleOf(p).sequence=3;}),
   altered(p=>{trialOf(p).sequence=2;regularCycleOf(p).sequence=1;}),
   altered(p=>{trialOf(p).sequence=2;}),
   altered(p=>{p.billing_cycles.splice(1,1);}),
   altered(p=>{p.billing_cycles.splice(0,1);}),
  ]) expect(()=>assertCommercialPlan(plan,choice,"P-TEST")).toThrow(/catalogue|pricing scheme/);
  const reversed=planFixture("P-TEST");reversed.billing_cycles.reverse();
  expect(()=>assertCommercialPlan(reversed,choice,"P-TEST")).not.toThrow();
 });
 it("reconciles an existing subscription on the USD plan or an earlier GBP plan, and nothing else",()=>{
  const reconcile=(plan:unknown)=>assertCommercialPlan(plan,choice,"P-TEST",true);
  expect(()=>reconcile(planFixture("P-TEST"))).not.toThrow();
  expect(()=>reconcile(gbpTrialPlanFixture("P-TEST"))).not.toThrow();
  expect(()=>reconcile(legacyPlanFixture("P-TEST"))).not.toThrow();
  expect(()=>reconcile({...legacyPlanFixture("P-TEST"),status:"INACTIVE"})).not.toThrow();
  expect(()=>reconcile({...gbpTrialPlanFixture("P-TEST"),status:"INACTIVE"})).not.toThrow();
  const usdNoTrial=planFixture("P-TEST");usdNoTrial.billing_cycles.splice(0,1);regularCycleOf(usdNoTrial).sequence=1;
  const legacyTwelve=legacyPlanFixture("P-TEST");legacyTwelve.billing_cycles[0].total_cycles=12;
  const legacyWrongPrice=legacyPlanFixture("P-TEST");legacyWrongPrice.billing_cycles[0].pricing_scheme!.fixed_price.value="1.00";
  const legacyAtTwo=legacyPlanFixture("P-TEST");legacyAtTwo.billing_cycles[0].sequence=2;
  const gbpOtherTier=gbpTrialPlanFixture("P-TEST",{tier:"MULTI_OUTLET",billingPeriod:"MONTHLY"});
  for(const plan of [usdNoTrial,legacyTwelve,legacyWrongPrice,legacyAtTwo,gbpOtherTier,altered(p=>{trialOf(p).frequency.interval_count=14;}),altered(p=>{trialOf(p).pricing_scheme={fixed_price:{currency_code:"USD",value:"5.00"}};})]) expect(()=>reconcile(plan)).toThrow();
 });
});
