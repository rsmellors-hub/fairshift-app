import type { Metadata } from "next";
import Link from "next/link";
import { PublicShell } from "@/app/components/public-shell";
import { BillingToggle, PlanPrice, PLAN_COPY } from "@/app/components/plan-cards";
import { enterpriseContact } from "@/server/billing/plans";

export const metadata: Metadata = { title: "Pricing" };
export const dynamic = "force-dynamic";

export default async function PricingPage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const { period } = await searchParams;
  const billingPeriod = period === "MONTHLY" ? "MONTHLY" : "ANNUAL";
  const contact = enterpriseContact();
  return <PublicShell>
    <section className="page-intro"><div className="site-width">
      <h1>Simple pricing, by location</h1>
      <p className="lede">Every plan includes the full product. Plans differ by how many locations you run.</p>
      <BillingToggle current={billingPeriod} basePath="/pricing" />
    </div></section>
    <section className="site-section"><div className="site-width">
      <div className="plan-grid">
        {(["SINGLE_OUTLET", "MULTI_OUTLET"] as const).map(tier => <article className="plan-card" key={tier}>
          <h2>{PLAN_COPY[tier].name}</h2>
          <p className="plan-limit">{PLAN_COPY[tier].limit}</p>
          <PlanPrice tier={tier} billingPeriod={billingPeriod} />
          <ul>{PLAN_COPY[tier].includes.map(line => <li key={line}>{line}</li>)}</ul>
          <Link className="primary-button button-link" href="/register">Start your business</Link>
        </article>)}
        <article className="plan-card">
          <h2>Enterprise</h2>
          <p className="plan-limit">6+ locations</p>
          <p className="plan-price"><strong>Custom</strong></p>
          <ul><li>Everything in Multi Outlet</li><li>A location limit set for your group</li><li>Commercial terms agreed with you</li></ul>
          {contact ? <a className="secondary-button button-link" href={`mailto:${contact}?subject=FairShift%20Enterprise%20enquiry`}>Contact FairShift</a> : <p className="note">Contact FairShift to discuss your locations. Enterprise isn’t available through online checkout.</p>}
        </article>
      </div>
      <p className="note plan-footnote">Every plan starts with a 30-day free trial. Prices in GBP. No setup fee and no per-worker fee. Subscriptions are approved in PayPal (PayPal Sandbox in this environment). Your plan pays for FairShift; worker pay is separate.</p>
    </div></section>
  </PublicShell>;
}
