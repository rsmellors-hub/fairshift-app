import Link from "next/link";
import { PublicShell, WorkedExample } from "@/app/components/public-shell";

const LOOP = [
  ["Commerce", "Sales history for each location"],
  ["Forecast", "Expected sales for each of the next seven days"],
  ["Staffing gap", "Labour needed, minus the cover you already have"],
  ["Shift offer", "Clear terms, sent to available workers"],
  ["Performance", "Attributed sales against an agreed target"],
  ["PayPal payment", "Base plus bonus, once a manager approves"],
] as const;

const JOBS = [
  ["Plan", "See each location’s next seven days of demand, and where your regular team won’t cover it.", ["Daily forecast with a planning range", "Labour needed, minus regular cover, equals the gap", "AI-assisted priorities with the reason for each"]],
  ["Staff", "Managers turn a gap into a shift and offer it to available workers at their location.", ["Every offer shows times, base pay, target and bonus", "Terms are fixed once a worker accepts", "One timeline shows who is working when"]],
  ["Track", "Workers follow their own progress towards an agreed sales target during the shift.", ["Sales attributed to the worker, within the shift", "Refunds are kept for audit and don’t change the result", "Workers see only their own figures"]],
  ["Pay", "After the shift, a manager checks the work and sales, approves the total, and it goes to the worker’s PayPal account.", ["Base pay plus any bonus earned, calculated by rule", "Nothing is sent without a manager’s approval", "Marked Paid only when PayPal confirms it"]],
] as const;

const ROLES = [
  ["Owner", "Every location on one screen", "Next week’s demand and staffing gap by location. Sets pay terms, targets and bonuses once for the business."],
  ["Manager", "Plan, fill, approve", "Works their location. Sees the gap, sends offers, finalises who works, and approves what was earned."],
  ["Worker", "A phone app, not a portal", "Shift offers with clear terms, a live target during the shift, and earnings split into earned, pending and paid."],
] as const;

const RULES = [
  ["AI suggests, people decide", "AI explains the forecast and suggests what to staff first. It never books a shift, chooses a worker or sets pay."],
  ["Pay follows the agreed terms", "The amount comes from what the worker accepted and the sales recorded, by a fixed rule."],
  ["No payment without approval", "A manager approves every total before anything goes to PayPal."],
  ["Your figures are yours", "Workers see their own progress, never a ranking of colleagues."],
] as const;

export default function Home() {
  return <PublicShell>
    <section className="home-hero"><div className="site-width home-hero-grid">
      <div>
        <h1>The right people. The right place. The right time. The right pay.</h1>
        <p className="lede">FairShift turns your sales history into a daily forecast and a clear staffing gap. Managers fill it with transparent shift terms, and approved earnings reach workers through PayPal.</p>
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
      <div><h2>Plans from £29 a month</h2><p>Plans differ by how many locations you run. There is no setup fee or per-worker fee.</p></div>
      <div className="cta-row"><Link className="primary-button button-link" href="/register">Start your business</Link><Link className="secondary-button button-link" href="/pricing">See pricing</Link></div>
    </div></section>
  </PublicShell>;
}
