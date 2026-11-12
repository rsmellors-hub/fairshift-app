import type { Metadata } from "next";
import Link from "next/link";
import { rand } from "@/app/components/plan-cards";
import { PublicShell } from "@/app/components/public-shell";
import { catalogue, PRICE_LIST } from "@/server/billing/plans";

export const metadata: Metadata = { title: "FAQ" };

// Only questions current behaviour can answer. Unsettled policy is left out, not guessed at. Pay, tip,
// currency and signal answers follow DEC-SA-011, FS-APPROVER-DEC-001, DEC-SA-012, FS-TIP-DEC-002,
// FS-TIP-AGENT-DEC-001 and the 8 November 2026 Owner decisions (demand signals, the Owner-or-Manager
// staffing gate, home currency, pricing, no VAT on earnings or tips). Prices come from the catalogue.
const { SINGLE_OUTLET: venue, MULTI_OUTLET: group } = catalogue;
const PRICES = `Venue (1 location): ${rand(venue.MONTHLY.homeAmount)} a month or ${rand(venue.ANNUAL.homeAmount)} a year. Group (up to 5 locations): ${rand(group.MONTHLY.homeAmount)} a month or ${rand(group.ANNUAL.homeAmount)} a year. Prices include ${PRICE_LIST.vatPercent}% VAT. PayPal bills them in US dollars: US$${venue.MONTHLY.amount}, US$${venue.ANNUAL.amount}, US$${group.MONTHLY.amount} and US$${group.ANNUAL.amount}. Your bank or PayPal converts at its own rate.`;
const TOPICS = [
  ["Plans and billing", [
    ["What does a plan cost?", PRICES],
    ["How am I billed?", "Your plan is a subscription you approve in PayPal, charged monthly or annually. Prices are set in rand, and PayPal bills the US dollar amount shown on each plan. Your workspace opens once PayPal confirms the subscription is active. This environment uses PayPal Sandbox."],
    ["What counts as a location?", "Any active location you plan staff for. Venue covers one, Group up to five, and Enterprise is agreed with you for six or more."],
    ["Do you charge per worker?", "No. Each plan is a flat price set by locations, with no per-worker fees or setup fees. Workers are never charged."],
    ["Is there a free trial?", "Yes. Every self-service plan starts with 30 days free. You approve the subscription in PayPal, and nothing is charged until the trial ends. You can cancel in your PayPal account before then."],
    ["Is my plan separate from paying workers?", "Yes. Your plan pays for FairShift. Worker pay is sent per confirmed shift, and VAT is never applied to worker earnings or tips."],
  ]],
  ["Paying workers", [
    ["How is a worker’s pay worked out?", "From the pay terms the worker accepted before the shift, which the Owner set in advance. Tips follow the location’s tip policy. AI plays no part in any amount."],
    ["Can a payment go out before the work is confirmed?", "No. The completed shift is confirmed first, by a manager or the Owner, and the person who confirms it is recorded as the approver. FairShift’s server then checks the payment is due before anything goes to PayPal."],
    ["Could a worker be paid twice?", "No. Each confirmed shift can be paid once. A second attempt is refused and the existing payment’s status is shown instead."],
    ["What currency are workers paid in?", "Earnings are in rand, and workers always see rand first. PayPal pays in US dollars, so FairShift converts at the latest European Central Bank reference rate and locks it when the payout is reserved. The dollar amount and the rate are shown as a separate, labelled line."],
    ["How are tips shared?", "Each location has one tip policy, set by the Owner: DIRECT, where each tip goes to the person on its POS row, or SHIFT_POOL, shared equally among the people in each shift block. AI checks the tip evidence and releases or holds each allocation, and holds go to the Owner. AI never sets an amount or a recipient."],
    ["When does a payment show as Paid?", "Only after PayPal confirms it. A processing, held or failed payment never shows as Paid."],
    ["Does FairShift run payroll?", "No. FairShift doesn’t run payroll or handle tax."],
  ]],
  ["Sales data", [
    ["Where do sales come from?", "From each location’s sales history, kept with its source. Sample history is labelled synthetic reference history, made for a fictional business. Sources are always shown separately and never blended."],
    ["What happens with refunds?", "Refunds are kept and linked for audit. They don’t identify who is responsible and don’t automatically change a worker’s earnings."],
  ]],
  ["Forecasts and AI", [
    ["How does the forecast work?", "From each location’s history, using matching weekdays, it forecasts sales for each of the next seven days and expected transactions by time of day, with a planning range. Staffing comes from the transactions and the service capacity and minimum cover you set, not from sales value. Transactions are an approximate measure of workload: not every bill takes the same work. Weather, public holidays and local events can adjust the forecast by a fixed 5% or 10%, and staffing uses an adjustment only when an Owner or a manager accepts it."],
    ["What does the AI do?", "It reads the calculated week and suggests what to staff first, with a reason. Twice a day it searches the web for local events and disruptions, and a finding counts only with a source FairShift can check. It also checks confirmed work and tip evidence, and can hold a payment for a person to review. It doesn’t calculate the figures, book shifts, choose workers or set any amount or recipient."],
  ]],
  ["For workers", [
    ["What do I see before accepting a shift?", "The location, date, times and pay terms. Once you accept, those terms are fixed for that shift. If they need to change, you are asked again."],
    ["Can other workers see my pay?", "No. You see your own earnings and tips. There are no leaderboards or comparisons."],
    ["How do I get paid?", "To your PayPal account, after your manager confirms the shift, in US dollars converted from rand at the European Central Bank reference rate. Your earnings page shows what’s earned, pending and paid, in rand first. FairShift never charges workers."],
  ]],
] as const;

export default function FaqPage() {
  return <PublicShell>
    <section className="page-intro"><div className="site-width">
      <h1>Frequently asked questions</h1>
      <p className="lede">How FairShift works, what it costs, and how pay reaches your workers.</p>
    </div></section>
    <section className="site-section"><div className="site-width faq-list">
      {TOPICS.map(([topic, questions]) => <section key={topic} aria-label={topic}>
        <h2>{topic}</h2>
        {questions.map(([question, answer]) => <details key={question}><summary>{question}</summary><p>{answer}</p></details>)}
      </section>)}
      <p><Link className="text-link" href="/product">Read how FairShift works <span aria-hidden="true">→</span></Link></p>
    </div></section>
    <section className="site-section" id="terms" aria-labelledby="terms-title"><div className="site-width">
      <h2 id="terms-title">Terms</h2>
      <p>Owners and managers confirm all work and pay. The AI suggests and checks; it never sets amounts, picks workers or books shifts. This deployment uses PayPal Sandbox: no real money moves.</p>
    </div></section>
    <section className="site-section" id="privacy" aria-labelledby="privacy-title"><div className="site-width">
      <h2 id="privacy-title">Privacy</h2>
      <p>FairShift keeps name, email, mobile, PayPal email and shift and pay records. Never a home address, ID number or bank details.</p>
    </div></section>
  </PublicShell>;
}
