import type { Metadata } from "next";
import Link from "next/link";
import { PublicShell } from "@/app/components/public-shell";

export const metadata: Metadata = { title: "FAQ" };

// Only questions current behaviour can answer. Unsettled policy is left out, not guessed at.
const TOPICS = [
  ["Plans and billing", [
    ["How am I billed?", "Your plan is a subscription you approve in PayPal, charged monthly or annually. Your workspace opens once PayPal confirms it is active. This environment uses PayPal Sandbox."],
    ["What counts as a location?", "Any active location you plan staff for. Single Outlet covers one, Multi Outlet up to five, and Enterprise is agreed with you for six or more."],
    ["Do you charge per worker?", "No. Plans are based on locations, and there are no per-worker fees or setup fees."],
    ["Is my plan separate from paying workers?", "Yes. Your plan pays for FairShift. Worker pay is sent per approved shift."],
  ]],
  ["Paying workers", [
    ["How is a worker’s pay worked out?", "Base pay comes from the terms the worker accepted for the shift. If their attributed sales reach the target in those terms, the agreed bonus is added. AI plays no part in the amount."],
    ["Can a payment go out without approval?", "No. A manager confirms the work and its sales, then approves the total. Nothing is sent to PayPal before that."],
    ["Could a worker be paid twice?", "Each approved total can be sent once. A second attempt is refused and the manager sees the existing payment’s status instead."],
    ["When does a payment show as Paid?", "Only after PayPal confirms it. A processing, held or failed payment never shows as Paid."],
    ["Does FairShift run payroll?", "No. FairShift doesn’t run payroll or handle tax."],
  ]],
  ["Sales data", [
    ["Where do sales come from?", "This environment connects to Square Sandbox for attributed sales. A location’s forecast can also come from imported history or labelled reference data. Sources are always shown separately."],
    ["How are sales attributed to a worker?", "A worker is matched to a Square team-member identity. Square Sandbox payments carrying that identity during their accepted shift count towards their target."],
    ["What happens with refunds?", "Refunds are kept and linked for audit. They don’t identify who is responsible and don’t automatically change a worker’s result or earnings."],
  ]],
  ["Forecasts and AI", [
    ["How does the forecast work?", "From each location’s history, using matching weekdays, it forecasts sales for each of the next seven days and expected transactions by time of day, with a planning range. Staffing comes from the transactions and the service capacity and minimum cover you set, not from sales value. Transactions are an approximate measure of workload: not every bill takes the same work."],
    ["What does the AI do?", "It reads the calculated week and suggests what to staff first, with a reason for each suggestion. It doesn’t calculate the figures, book shifts, choose workers, set pay or approve anything."],
  ]],
  ["For workers", [
    ["What do I see before accepting a shift?", "The location, date, times, base pay, sales target and bonus. Once you accept, those terms are fixed for that shift. If they need to change, you are asked again."],
    ["Can other workers see my sales?", "No. You see your own progress. There are no leaderboards or comparisons."],
    ["How do I get paid?", "To your PayPal account, after your manager approves the shift. Your earnings page shows what’s earned, pending and paid."],
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
  </PublicShell>;
}
