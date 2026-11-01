import type { Metadata } from "next";
import Link from "next/link";
import { PublicShell } from "@/app/components/public-shell";

export const metadata: Metadata = { title: "How it works" };

const STEPS = [
  ["Commerce intelligence", "FairShift keeps each location’s sales in one standard record, with its source attached. Square Sandbox sales, imported history and clearly labelled reference data are shown separately and never blended."],
  ["Daily forecast", "For each location, FairShift forecasts sales for each of the next seven days, comparing like with like: Saturdays with Saturdays. Every forecast has a planning range, and older evidence is called out."],
  ["Staffing requirement", "The forecast becomes labour hours using a sales-per-labour-hour figure you set. FairShift subtracts your regular cover and any allocated casual shifts. What remains is the gap to fill."],
  ["AI-assisted prioritisation", "AI reads the calculated week and suggests what to staff first, and why. Any figure it cites must match FairShift’s own numbers, or the answer is discarded. It never books a shift, chooses a worker or changes pay."],
  ["Shift opportunities", "A manager creates the shift for a gap, within the pay terms the Owner has set. Managers can’t change those rates."],
  ["Worker acceptance", "Available workers at that location receive an offer showing the date, times, base pay, sales target and bonus. Those terms are fixed for that shift once they accept."],
  ["Allocation", "Accepting isn’t the same as being booked. The manager finalises who works on one timeline, and FairShift prevents overlapping shifts. If a shift changes after acceptance, the worker must accept the new terms."],
  ["Attributed performance", "Sales attributed to a worker during their accepted shift count towards their target. They can follow their own progress during the shift. Refunds are kept for audit and don’t change the result."],
  ["Incentives", "The current rule is simple: reach the agreed sales target, earn the agreed fixed bonus. The calculation is a fixed rule, and AI plays no part in it."],
  ["Manager approval", "After the shift the manager confirms the work happened and checks the sales. FairShift shows base plus bonus, and the manager approves that exact total."],
  ["PayPal payout", "Approved earnings go to the worker’s PayPal account. Each approved total can be sent once. It shows as Paid only after PayPal confirms it, so a held or failed payment never looks finished."],
] as const;

export default function ProductPage() {
  return <PublicShell>
    <section className="page-intro"><div className="site-width">
      <h1>How FairShift works</h1>
      <p className="lede">From a location’s sales history to a worker’s PayPal account: what each part does, and what it deliberately doesn’t.</p>
    </div></section>
    <section className="site-section"><div className="site-width">
      <ol className="how-steps">{STEPS.map(([title, text], index) => <li key={title}><span aria-hidden="true">{index + 1}</span><div><h2>{title}</h2><p>{text}</p></div></li>)}</ol>
    </div></section>
    <section className="site-section site-section-alt"><div className="site-width">
      <h2>What FairShift isn’t</h2>
      <p className="section-lede">FairShift doesn’t run payroll or handle tax, isn’t an HR system, and doesn’t schedule workers across locations. Workers belong to one location, and managers stay in control of every staffing and payment decision.</p>
    </div></section>
    <section className="site-section closing-cta"><div className="site-width closing-cta-row">
      <div><h2>See it with a real week</h2><p>Follow one shift from forecast to PayPal confirmation.</p></div>
      <div className="cta-row"><Link className="primary-button button-link" href="/demo">Try the demo</Link><Link className="secondary-button button-link" href="/pricing">See pricing</Link></div>
    </div></section>
  </PublicShell>;
}
