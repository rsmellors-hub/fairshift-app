import Link from "next/link";
import { rand } from "@/app/components/plan-cards";
import { PublicShell, WorkedExample } from "@/app/components/public-shell";
import { commercialPlan } from "@/server/billing/plans";

// Public copy follows the decision record: DEC-SA-011 and FS-APPROVER-DEC-001 (casual pay on
// preauthorised terms, confirmed by a manager), DEC-SA-012 (ZAR earnings paid in US dollars at the
// latest ECB reference rate, locked at reservation), FS-TIP-DEC-002 and FS-TIP-AGENT-DEC-001 (tip
// policy, AI release or hold, holds to the Owner) and the 8 November 2026 demand-signal decisions.
const LOOP = [
  ["Commerce", "Sales history for each location"],
  ["Forecast", "Expected sales and transactions for the next seven days, with local signals"],
  ["Staffing gap", "Staff capacity needed by time of day, minus the cover you already have"],
  ["Shift offer", "Pay terms set in advance, sent to available workers"],
  ["Confirmed work", "The manager confirms the completed shift"],
  ["PayPal payment", "Rand earnings paid in US dollars at the ECB reference rate"],
] as const;

const JOBS = [
  ["Plan", "See each location’s next seven days of demand, and where your regular team won’t cover it.", ["Sales and transaction forecast with a planning range", "Weather, public holidays and local events, used for staffing only when a manager accepts them", "Staff capacity needed, minus regular cover, equals the gap"]],
  ["Staff", "Managers turn a gap into a shift and offer it to available workers at their location.", ["Every offer shows the date, times and the pay terms the Owner set in advance", "Terms are fixed once a worker accepts", "One timeline shows who is working when"]],
  ["Tips", "The Owner sets one tip policy per location: DIRECT, where each tip goes to the person on its POS row, or SHIFT_POOL, shared equally within each shift block.", ["Amounts and recipients follow the policy, never AI", "AI checks the tip evidence and releases or holds each allocation", "Holds go to the Owner, who releases them as calculated or keeps them held"]],
  ["Pay", "After the shift, the manager confirms the work. The FairShift Pay Agent checks it, and FairShift’s server pays it through PayPal.", ["Earnings come from the terms the worker accepted before the shift", "Rand converted to US dollars at the latest ECB reference rate, locked when the payout is reserved", "Marked Paid only when PayPal confirms it"]],
] as const;

const ROLES = [
  ["Owner", "Every location on one screen", "Next week’s demand and staffing gap by location. Sets pay terms and each location’s tip policy, and decides any tip the AI holds."],
  ["Manager", "Plan, fill, confirm", "Works their location. Sees the gap and the local signals, sends offers, finalises who works, and confirms completed shifts."],
  ["Worker", "A phone app, not a portal", "Shift offers with clear terms, and earnings and tips split into earned, pending and paid."],
] as const;

const RULES = [
  ["AI suggests, people decide", "AI explains the forecast and suggests what to staff first. It never books a shift, chooses a worker or sets pay."],
  ["Pay follows the agreed terms", "The amount comes from the terms the worker accepted before the shift, by a fixed rule."],
  ["No payment without confirmed work", "A manager confirms each completed shift before anything goes to PayPal, and no AI sets an amount or a recipient."],
  ["Your figures are yours", "Workers see their own earnings and tips, never a ranking of colleagues."],
] as const;

export default function Home() {
  return <PublicShell>
    <section className="home-hero"><div className="site-width home-hero-grid">
      <div>
        <h1>The right people. The right place. The right time. The right pay.</h1>
        <p className="lede">FairShift turns your sales history into a forecast by time of day and a clear staffing gap, and shows how weather, public holidays and local events could change it. Managers decide whether staffing uses those signals, fill the gap on terms set in advance, and confirmed earnings reach workers through PayPal.</p>
        <div className="cta-row">
          <Link className="primary-button button-link" href="/register">Start your business</Link>
          <Link className="secondary-button button-link" href="/demo">Try the demo</Link>
          <Link className="text-link" href="/sign-in">Sign in</Link>
        </div>
      </div>
      <WorkedExample />
    </div></section>

    <section className="site-section" aria-labelledby="loop-title"><div className="site-width">
      <h2 id="loop-title">Commerce demand becomes paid work</h2>
      <ol className="story-loop">{LOOP.map(([title, text], index) => <li key={title}><span aria-hidden="true">{index + 1}</span><strong>{title}</strong><small>{text}</small></li>)}</ol>
    </div></section>

    <section className="site-section site-section-alt" aria-labelledby="jobs-title"><div className="site-width">
      <h2 id="jobs-title">What FairShift does</h2>
      <p className="section-lede">Four jobs most businesses split across spreadsheets, rota apps and payment runs, connected in one place.</p>
      <div className="job-grid">{JOBS.map(([title, text, points]) => <article key={title}><h3>{title}</h3><p>{text}</p><ul>{points.map(point => <li key={point}>{point}</li>)}</ul></article>)}</div>
      <p><Link className="text-link" href="/product">See how each part works <span aria-hidden="true">→</span></Link></p>
    </div></section>

    <section className="site-section" aria-labelledby="roles-title"><div className="site-width">
      <h2 id="roles-title">One product, three views</h2>
      <div className="role-grid">{ROLES.map(([role, title, text]) => <article key={role}><p className="eyebrow">{role}</p><h3>{title}</h3><p>{text}</p></article>)}</div>
    </div></section>

    <section className="site-section site-section-alt" aria-labelledby="rules-title"><div className="site-width">
      <h2 id="rules-title">Rules FairShift won’t break</h2>
      <div className="role-grid rule-grid">{RULES.map(([title, text]) => <article key={title}><h3>{title}</h3><p>{text}</p></article>)}</div>
    </div></section>

    <section className="site-section closing-cta"><div className="site-width closing-cta-row">
      <div><h2>Plans from {rand(commercialPlan({ tier: "SINGLE_OUTLET", billingPeriod: "MONTHLY" }).homeAmount)} a month incl. VAT, after a 30-day free trial</h2><p>Plans differ by how many locations you run. There is no setup fee or per-worker fee. PayPal bills in US dollars.</p></div>
      <div className="cta-row"><Link className="primary-button button-link" href="/register">Start your business</Link><Link className="secondary-button button-link" href="/pricing">See pricing</Link></div>
    </div></section>
  </PublicShell>;
}
