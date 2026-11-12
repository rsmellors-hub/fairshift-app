import Link from "next/link";
import { PLAN_COPY, rand } from "@/app/components/plan-cards";
import { PublicShell } from "@/app/components/public-shell";
import { AiChip, Chip, DemoChip } from "@/app/components/fs-ui";
import { commercialPlan, TRIAL_DAYS } from "@/server/billing/plans";

// The public demo is off for judging (Owner, 12 Nov 2026). "Watch the demo" opens the demo video from
// FAIRSHIFT_DEMO_VIDEO_URL; with no valid http(s) address set, no button is shown.
function demoVideoUrl() {
  const value = process.env.FAIRSHIFT_DEMO_VIDEO_URL?.trim();
  if (!value) return null;
  try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null; } catch { return null; }
}

// Landing page (design Main.dc.html, 10 Nov 2026). Public copy follows the decision record:
// DEC-SA-011 and FS-APPROVER-DEC-001 (casual pay on preauthorised terms, confirmed by a person),
// DEC-SA-012 (rand earnings paid in US dollars at the ECB reference rate, locked at reservation),
// FS-TIP-DEC-002 and FS-TIP-AGENT-DEC-001 (tip rule, AI release or hold), FS-OFFER-ORDER-DEC-001
// (people who want more hours are offered first) and FS-PATHWAY-DEC-001 (hours alert).
// Spec over canvas: Square is not in the Works-with strip.

const PROBLEMS = [
  ["Scheduling", "Called in late, sent home early", "Shifts filled by last-minute messages; quiet nights end early with lost hours."],
  ["Pay", "Paid days or weeks later", "Cash in hand or a delayed transfer, with no record of how the amount was worked out."],
  ["Tips", "Tips held until month-end", "Card tips sit with the venue until payroll, even for the lowest-paid staff."],
] as const;

const IMPACT = [
  ["For venues", "Staff to the night you’ll actually have", ["See a busy shift days ahead, with the reason and its source", "Fill gaps in minutes: approve the suggestion and the offers go out", "Every hour, payout and tip on one record you can check", "Pay checked against the minimum wage before anyone is offered a shift"]],
  ["For casual workers", "Know the deal, get paid for it", ["Rate, hours and tip rule shown on every offer, fixed once accepted", "Fair offer order: people who want more hours are offered first", "Paid to PayPal after each confirmed shift, tips included, every rand explained", "Regular hours become visible, so a permanent role can be offered"]],
] as const;

const STEPS = [
  ["01 · Forecast", "The AI sees the busy shift coming", "Your sales history, plus weather, holidays and what’s happening near each venue. Every heads-up links its source."],
  ["02 · Fair offers", "You approve, then offers go out", "Suggested shifts arrive ready to send. Workers who want more hours are offered first, with rate and deadline on every offer."],
  ["03 · Shift worked", "Hours confirmed by a person", "A manager or the owner confirms the shift. Pay comes from the terms the worker accepted, never from the AI."],
  ["04 · Checked", "The Pay Agent looks for problems", "Overlapping shifts, hours beyond the booking, unusual tips. Anything odd is held for the owner with a plain reason."],
  ["05 · Paid", "Straight to the PayPal wallet", "Shown in rand, paid in US dollars at the locked ECB rate. Marked paid only when PayPal confirms it."],
  ["06 · Pathway", "Regular hours become visible", "When a casual worker passes your hours threshold (for example 20 h a week over 12 weeks), you’re alerted to consider a permanent role. FairShift never makes the offer for you."],
] as const;

const PEOPLE = [
  ["Owners", "Run the business", "See every venue’s week ahead, approve suggested shifts, release anything the Pay Agent holds, and manage billing. Owners can do everything a manager can, so a single-venue owner needs no one else."],
  ["Managers", "Run a venue", "Plan their location, send offers, and confirm the hours actually worked. Confirmation is what starts the pay."],
  ["Casual workers", "Pick up shifts", "Get offers on their phone with the pay up front, accept or decline, see every shift on a calendar, and get paid to PayPal after each one."],
] as const;

const PROMISES = [
  ["The AI suggests, people decide", "Every suggestion shows its reason and source. The AI never sets pay, picks a worker or books a shift, and nothing is offered or paid without a person’s approval."],
  ["Terms come before the shift", "Rate, offer order and tip rule are shown before anyone accepts, and never change after."],
  ["Pay is never below the floor", "Every offer is checked against the minimum wage for your country and the shift’s date."],
  ["Tips belong to the people who earned them", "Allocated under your written venue rule, never reduced to cover costs."],
  ["Workers see only their own numbers", "Their earnings, offers and progress. Nobody else’s."],
] as const;

// Prices come from the server-owned catalogue, rand first; the US dollar amount PayPal bills is a labelled secondary line.
function PlanCard({ tier, dark }: { tier: "SINGLE_OUTLET" | "MULTI_OUTLET"; dark?: boolean }) {
  const monthly = commercialPlan({ tier, billingPeriod: "MONTHLY" }), annual = commercialPlan({ tier, billingPeriod: "ANNUAL" });
  const blurb = tier === "SINGLE_OUTLET" ? "One venue, unlimited workers. Ideal for an owner-run venue." : "Several venues, managers per venue, one owner view.";
  return <div className={dark ? "land-plan land-plan-dark" : "land-plan"}>
    <div className="land-plan-head"><span className="eyebrow">{PLAN_COPY[tier].name}</span>{dark ? <Chip tone="dark" className="land-plan-chip">{PLAN_COPY[tier].limit}</Chip> : null}</div>
    <p className="small">{blurb}</p>
    <p><span className="serif land-price">{rand(monthly.homeAmount)}</span> <span className="small">/ month incl. VAT</span></p>
    <p className="tiny">or {rand(annual.homeAmount)} a year · billed by PayPal as US${monthly.amount} a month</p>
    <Link className={dark ? "btn inv lg wide" : "btn out lg wide"} href="/register">Start free trial</Link>
  </div>;
}

function Hero() {
  return <section className="fs land-hero" aria-labelledby="hero-title">
    <div className="pub-width land-hero-grid">
      <div className="land-hero-copy">
        <h1 id="hero-title" className="d1 land-hero-title"><span>The right people.</span> <span>The right place.</span> <span className="land-dim">The right time.</span> <span className="land-dim">The right pay.</span></h1>
        <p className="land-intro">FairShift is shift planning and same-day pay for restaurants, cafés and bars that rely on casual staff. It spots busy shifts early from what’s happening around each venue, offers the work fairly, and pays people through PayPal as soon as a manager confirms the shift, with tips included.</p>
        <p className="land-intro-sub">For owners and managers who want fewer short-staffed nights, and for casual workers who deserve clear terms and to be paid on time.</p>
        <div className="cta-row land-ctas">
          <Link className="btn lg inv" href="/register">Start your {TRIAL_DAYS}-day free trial</Link>
          {(() => { const video = demoVideoUrl(); return video ? <a className="btn lg inv-out" href={video} target="_blank" rel="noreferrer">Watch the demo</a> : null; })()}
        </div>
        <p className="tiny land-hero-note">{TRIAL_DAYS} days free. Billed through PayPal. Workers never pay.</p>
      </div>
      <div className="land-hero-example">
        {/* An illustration, not a working screen: its buttons are drawn, not rendered as controls. */}
        <figure className="land-phone" aria-label="Example screen">
          <div className="land-phone-screen">
            <p className="serif land-phone-greeting">Good afternoon</p>
            <div className="card land-phone-card">
              <div className="land-row"><AiChip>AI heads-up</AiChip><DemoChip>Sample</DemoChip></div>
              <p className="h4">Friday evening looks busier than usual</p>
              <ul className="land-phone-list"><li>A show nearby at 19:30</li><li>Dry and warm after 15:00</li><li>Source linked on every heads-up</li></ul>
              <div className="sunk land-phone-suggest"><strong>Suggested:</strong> 2 casual staff, 16:00–22:00</div>
              <div className="land-row land-row-start" aria-hidden="true"><span className="btn sm">Approve and send offers</span><span className="btn sm out">Adjust</span></div>
            </div>
            <div className="card land-phone-card land-phone-paid">
              <div className="land-row"><span className="eyebrow">Paid to PayPal</span><Chip tone="paid">Paid</Chip></div>
              <div className="land-row land-phone-line"><span>6 h × R45.00</span><span className="num">R270.00</span></div>
              <div className="land-row land-phone-line"><span>Card tips, shift pool</span><span className="num">Per venue rule</span></div>
              <p className="tiny">Paid shows only when PayPal confirms the payout.</p>
            </div>
            <figcaption className="tiny land-phone-caption">Example screen</figcaption>
          </div>
        </figure>
      </div>
    </div>
    <div className="land-works">
      <div className="pub-width land-works-row">
        <span className="eyebrow">Works with</span><span>PayPal payouts &amp; subscriptions</span><span>OpenAI</span><span>Public weather, holiday &amp; events data</span>
      </div>
    </div>
  </section>;
}

export default function Home() {
  return <PublicShell hero={<Hero />}>
    <div className="fs land">
      <section className="pub-width land-section land-why" aria-labelledby="why-title">
        <h2 className="d2 land-lead">Fill the gaps before the rush. <span className="land-faint">Pay people properly after it.</span></h2>
        <div className="land-why-copy">
          <span className="eyebrow">Why FairShift exists</span>
          <h3 id="why-title" className="d3">Casual work shouldn’t mean casual pay</h3>
          <p>Hospitality runs on casual staff, but most venues still plan by gut feel and WhatsApp. When demand is guessed, both sides lose. The owner is short-staffed on the busy night and overstaffed on the quiet one, and the worker carries the cost: called in late, sent home early, paid days later, tips held until month-end.</p>
          <p>FairShift gives the owner a forecast they can act on, and gives the worker terms set before they accept and pay that follows the shift. The AI does the noticing and the checking. People make every decision about work and money.</p>
        </div>
        <div className="land-grid land-grid-3">{PROBLEMS.map(([eyebrow, title, text]) => <div className="rule land-ruled" key={eyebrow}><span className="eyebrow">{eyebrow}</span><p className="h4">{title}</p><p className="small">{text}</p></div>)}</div>
      </section>

      <section id="impact" className="pub-width land-section" aria-labelledby="impact-title">
        <div className="land-head"><span className="eyebrow">The impact we’re building for</span><h2 id="impact-title" className="d2">Better nights for the venue. <span className="land-faint">A fairer deal for the people who work them.</span></h2></div>
        <div className="land-grid land-grid-2">{IMPACT.map(([eyebrow, title, points]) => <div className="card land-card" key={eyebrow}><span className="eyebrow">{eyebrow}</span><p className="h4">{title}</p><ul className="small land-list">{points.map(point => <li key={point}>{point}</li>)}</ul></div>)}</div>
        <p className="small land-measure">These are the outcomes FairShift is designed for. We measure them in the product: hours offered, shifts filled, time from confirmation to payout, and tips paid per shift.</p>
      </section>

      <section id="how" className="pub-width land-section" aria-labelledby="how-title">
        <div className="land-head"><span className="eyebrow">How it works</span><h2 id="how-title" className="d2">From tonight’s forecast <br />to money in the wallet</h2></div>
        <ol className="land-grid land-grid-3 land-steps">{STEPS.map(([eyebrow, title, text]) => <li className="rule land-ruled" key={eyebrow}><span className="eyebrow">{eyebrow}</span><p className="h4">{title}</p><p className="small">{text}</p></li>)}</ol>
        <p><Link className="link" href="/product">See how each part works <span aria-hidden="true">→</span></Link></p>
      </section>

      <section id="who" className="pub-width land-section" aria-labelledby="who-title">
        <div className="land-head"><span className="eyebrow">Who it’s for</span><h2 id="who-title" className="d2">One system, three people, each with their own view</h2><p className="small land-sub">Built for independent restaurants, cafés and bars, from a single venue run by its owner to a group of up to five locations.</p></div>
        <div className="land-grid land-grid-3 land-people">{PEOPLE.map(([eyebrow, title, text]) => <div className="card land-card" key={eyebrow}><span className="eyebrow">{eyebrow}</span><p className="h4">{title}</p><p className="small">{text}</p></div>)}</div>
        {/* Permanent staff can't yet see or receive their share on the hosted build (Owner, 12 Nov 2026). */}
        <p className="small land-people-note">Permanent staff are included when card tips are shared. Paying their share through PayPal comes next.</p>
      </section>

      <section id="fair" className="pub-width land-section land-fair" aria-labelledby="fair-title">
        <div className="land-fair-intro"><span className="eyebrow">Fair by design</span><h2 id="fair-title" className="d2">Five promises that hold on every shift</h2><p className="small land-sub">FairShift isn’t payroll, a staffing agency or a job marketplace. It works for venues and the people already on their team, and its job ends when shift earnings and tips reach the worker’s PayPal account.</p></div>
        <ol className="land-promises">{PROMISES.map(([title, text], index) => <li className="rule" key={title}><span className="mono land-num">{String(index + 1).padStart(2, "0")}</span><div><p className="h4">{title}</p><p className="small">{text}</p></div></li>)}</ol>
      </section>

      <section id="pricing" className="land-pricing" aria-labelledby="pricing-title">
        <div className="pub-width land-section">
          <div className="land-head land-pricing-head"><span className="eyebrow">Pricing</span><h2 id="pricing-title" className="d2">Priced by venue, not by person</h2><p className="land-body">Every plan starts with {TRIAL_DAYS} days free. You approve the subscription in PayPal at sign-up, and nothing is charged until the trial ends. No per-worker fees. Workers are never charged.</p></div>
          <div className="land-grid land-grid-plans"><PlanCard tier="SINGLE_OUTLET" /><PlanCard tier="MULTI_OUTLET" dark /></div>
          <p><Link className="link" href="/pricing">See full pricing, annual plans and Enterprise</Link></p>
        </div>
      </section>

      <section className="land-closing" aria-labelledby="closing-title">
        <div className="pub-width land-section">
          <h2 id="closing-title" className="d2 land-closing-title">Your next busy night <span className="land-dim">is already on the calendar</span></h2>
          <p className="land-closing-copy">Choose a plan, add your venue’s address and pay terms, and invite your team. FairShift will tell you when to call in extra hands, and make sure the people who answer are paid properly.</p>
          <div className="cta-row land-ctas"><Link className="btn lg inv" href="/register">Start your {TRIAL_DAYS}-day free trial</Link><Link className="btn lg inv-out" href="/sign-in">Sign in</Link></div>
        </div>
      </section>
    </div>
  </PublicShell>;
}
