import { z } from "zod";
export const planSelection = z.object({
  tier: z.enum(["SINGLE_OUTLET", "MULTI_OUTLET"]),
  billingPeriod: z.enum(["MONTHLY", "ANNUAL"]),
}).strict();
export type PlanSelection = z.infer<typeof planSelection>;
export const planVariables = {
  SINGLE_OUTLET: {MONTHLY:"PAYPAL_SINGLE_OUTLET_MONTHLY_PLAN_ID", ANNUAL:"PAYPAL_SINGLE_OUTLET_ANNUAL_PLAN_ID"},
  MULTI_OUTLET: {MONTHLY:"PAYPAL_MULTI_OUTLET_MONTHLY_PLAN_ID", ANNUAL:"PAYPAL_MULTI_OUTLET_ANNUAL_PLAN_ID"},
} as const;
export function configuredPlan(input: PlanSelection, env: Record<string,string|undefined> = process.env) {
  const {tier,billingPeriod}=planSelection.parse(input);
  const ids=Object.values(planVariables).flatMap(periods=>Object.values(periods).map(key=>env[key])).filter(Boolean);
  // A provider plan must never accidentally represent two different commercial selections.
  if (new Set(ids).size !== ids.length) return null;
  const id=env[planVariables[tier][billingPeriod]];
  return id && /^P-[A-Z0-9]+$/.test(id) ? id : null;
}
export const locationLimitFor = (tier: PlanSelection["tier"]) => tier === "SINGLE_OUTLET" ? 1 : 5;

export function enterpriseContact(env:Record<string,string|undefined> = process.env) {
  const parsed=z.string().email().safeParse(env.FAIRSHIFT_ENTERPRISE_CONTACT_EMAIL);
  return parsed.success ? parsed.data : null;
}
