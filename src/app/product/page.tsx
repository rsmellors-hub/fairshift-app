import type { Metadata } from "next";
import Link from "next/link";
import { PublicShell } from "@/app/components/public-shell";

export const metadata: Metadata = { title: "How it works" };

// Each step follows the decision record: DEC-SA-011 and FS-APPROVER-DEC-001 (casual pay), DEC-SA-012
// (currency), FS-TIP-DEC-002 and FS-TIP-AGENT-DEC-001 (tips), FS-DEMAND-CONTEXT-001 and the 8 November
// 2026 demand-signal decisions (local signals).
const STEPS = [
  ["Commerce intelligence", "FairShift keeps each location’s sales in one standard record, with its source attached. Square Sandbox sales, imported history and clearly labelled reference data are shown separately and never blended."],
  ["Sales and workload forecast", "For each location, FairShift forecasts sales for each of the next seven days and expected transactions by time of day, comparing like with like: Saturdays with Saturdays. Every forecast has a planning range, and older evidence is called out."],
  ["Local signals", "Weather, public holidays and local events can change demand. Each signal is shown with its source, and one FairShift can’t confirm is shown but never applied. An accepted signal adjusts the forecast by a fixed 5% or 10%, at most two in any hour, and staffing changes only when a manager accepts the adjusted forecast."],
  ["Staffing requirement", "Expected transactions become staff hours, hour by hour, using the service capacity and minimum cover you set. Sales value isn’t part of this. FairShift subtracts your regular cover and any allocated casual shifts. What remains is the gap to fill."],
  ["AI-assisted prioritisation", "AI reads the calculated week and suggests what to staff first, and why. Any figure it cites must match FairShift’s own numbers, or the answer is discarded. It never books a shift, chooses a worker or changes pay."],
  ["Shift opportunities", "A manager creates the shift for a gap, within the pay terms the Owner has set in advance. Managers can’t change those rates."],
  ["Worker acceptance", "Available workers at that location receive an offer showing the date, times and pay terms. Those terms are fixed for that shift once they accept."],
  ["Allocation", "Accepting isn’t the same as being booked. The manager finalises who works on one timeline, and FairShift prevents overlapping shifts. If a shift changes after acceptance, the worker must accept the new terms."],
  ["Confirmed work", "After the shift, the manager confirms the work was done. That manager is recorded as the approver, on the terms agreed before the shift, and no second approval follows."],
  ["Pay Agent", "The FairShift Pay Agent, an AI, checks the confirmed work and either settles it or holds it for a person to look at. It can’t set or change an amount, a recipient or who may be paid: FairShift’s server works those out from the accepted terms and its records."],
  ["Tips", "Each location has one tip policy, set by the Owner: DIRECT, where each tip goes to the person on its POS row, or SHIFT_POOL, where each shift block’s tips are shared equally. AI checks the tip evidence and releases or holds each allocation. Holds go to the Owner, who releases them as calculated or keeps them held, and nobody edits an amount or a recipient."],
  ["PayPal payout", "Earnings are in rand. FairShift converts them to US dollars at the latest European Central Bank reference rate and locks that rate when the payout is reserved, so a retry never converts again. Each payout can be sent once, and it shows as Paid only after PayPal confirms it, so a held or failed payment never looks finished."],
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
      <p className="section-lede">FairShift doesn’t run payroll or handle tax, isn’t an HR system, and doesn’t schedule workers across locations. Workers belong to one location, managers stay in control of staffing and confirm completed work, and the Owner decides any tip the AI holds.</p>
    </div></section>
    <section className="site-section closing-cta"><div className="site-width closing-cta-row">
      <div><h2>See it with a real week</h2><p>Follow one shift from forecast to PayPal confirmation.</p></div>
      <div className="cta-row"><Link className="primary-button button-link" href="/demo">Try the demo</Link><Link className="secondary-button button-link" href="/pricing">See pricing</Link></div>
    </div></section>
  </PublicShell>;
}
