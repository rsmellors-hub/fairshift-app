import Link from "next/link";
import { commercialPlan, PRICE_LIST, type PlanSelection } from "@/server/billing/plans";

type Tier = PlanSelection["tier"];
type Period = PlanSelection["billingPeriod"];

export const PLAN_COPY: Record<Tier, { name: string; limit: string; includes: string[] }> = {
  SINGLE_OUTLET: { name: "Venue", limit: "1 location", includes: ["Forecast by time of day and staffing gap", "AI-assisted priorities", "Shift offers on terms set in advance", "Confirmed pay and tips through PayPal"] },
  MULTI_OUTLET: { name: "Group", limit: "Up to 5 locations", includes: ["Everything in Venue", "Owner view across every location", "Managers scoped to their location", "One payments list for the business"] },
};

// Prices come from the server-owned catalogue, so a page can't quote a different one. Rand comes
// first, as the price including VAT. The US dollar amount PayPal bills is a secondary, labelled
// line, and no converted figure is ever shown as the charge (Owner decision, 8 November 2026).
export const rand = (amount: string) => `R${Number(amount).toLocaleString("en-GB", { maximumFractionDigits: 2 })}`;
const per = (billingPeriod: Period) => billingPeriod === "MONTHLY" ? "month" : "year";
export function billingLine(selection: PlanSelection) {
  const plan = commercialPlan(selection);
  return `${rand(plan.homeAmount)}/${per(selection.billingPeriod)} incl. ${PRICE_LIST.vatPercent}% VAT — billed by PayPal as US$${plan.amount}; your bank or PayPal converts at its own rate.`;
}

export function PlanPrice({ tier, billingPeriod }: { tier: Tier; billingPeriod: Period }) {
  const plan = commercialPlan({ tier, billingPeriod });
  return <>
    <p className="plan-price"><strong>{rand(plan.homeAmount)}</strong><span>/{per(billingPeriod)}</span><small>incl. {PRICE_LIST.vatPercent}% VAT</small></p>
    <p className="note">30 days free, then {billingLine({ tier, billingPeriod })} Approve in PayPal today; nothing is charged until the trial ends.</p>
  </>;
}

export function BillingToggle({ current, basePath }: { current: Period; basePath: string }) {
  return <nav className="billing-toggle" aria-label="Billing period">
    <Link aria-current={current === "ANNUAL" ? "page" : undefined} href={`${basePath}?period=ANNUAL`}>Annual <em>Save 17%</em></Link>
    <Link aria-current={current === "MONTHLY" ? "page" : undefined} href={`${basePath}?period=MONTHLY`}>Monthly</Link>
  </nav>;
}
