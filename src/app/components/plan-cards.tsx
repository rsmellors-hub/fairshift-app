import Link from "next/link";
import { commercialPlan, type PlanSelection } from "@/server/billing/plans";

type Tier = PlanSelection["tier"];
type Period = PlanSelection["billingPeriod"];

export const PLAN_COPY: Record<Tier, { name: string; limit: string; includes: string[] }> = {
  SINGLE_OUTLET: { name: "Single Outlet", limit: "1 location", includes: ["Forecast by time of day and staffing gap", "AI-assisted priorities", "Shift offers and live targets", "Approved pay through PayPal"] },
  MULTI_OUTLET: { name: "Multi Outlet", limit: "2–5 locations", includes: ["Everything in Single Outlet", "Owner view across every location", "Managers scoped to their location", "One payments list for the business"] },
};

const pounds = (amount: string) => `£${amount.replace(/\.00$/, "")}`;
// Prices come from the server-owned catalogue, so a page can't quote a different one.
const annualEquivalent = (amount: string) => `£${(Number(amount) / 12).toFixed(2)}`;

export function PlanPrice({ tier, billingPeriod }: { tier: Tier; billingPeriod: Period }) {
  const plan = commercialPlan({ tier, billingPeriod });
  const trial = (price: string) => <p className="note">30 days free, then {price}. Approve in PayPal today; nothing is charged until the trial ends.</p>;
  if (billingPeriod === "MONTHLY") return <><p className="plan-price"><strong>{pounds(plan.amount)}</strong><span>/month</span><small>Billed monthly</small></p>{trial(`${pounds(plan.amount)}/month`)}</>;
  return <><p className="plan-price"><strong>{annualEquivalent(plan.amount)}</strong><span>/month</span><small>{pounds(plan.amount)} billed annually</small></p>{trial(`${pounds(plan.amount)} billed annually`)}</>;
}

export function BillingToggle({ current, basePath }: { current: Period; basePath: string }) {
  return <nav className="billing-toggle" aria-label="Billing period">
    <Link aria-current={current === "ANNUAL" ? "page" : undefined} href={`${basePath}?period=ANNUAL`}>Annual <em>Save 17%</em></Link>
    <Link aria-current={current === "MONTHLY" ? "page" : undefined} href={`${basePath}?period=MONTHLY`}>Monthly</Link>
  </nav>;
}
