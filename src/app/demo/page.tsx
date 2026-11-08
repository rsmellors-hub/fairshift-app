import type { Metadata } from "next";
import Link from "next/link";
import { PublicShell } from "@/app/components/public-shell";
import { enterDemoAction } from "@/app/demo/actions";
import { getDatabase } from "@/server/db/client";
import { demoConfig, type DemoPersona } from "@/server/demo/config";
import { hasEarlierEvidence } from "@/server/demo/fixtures";
import { demoIdentities } from "@/server/demo/session";
import { SA_REFERENCE_ORGANISATION } from "@/server/reference/sa-reference";
import "./demo.css";

export const metadata: Metadata = { title: "Explore FairShift" };
export const dynamic = "force-dynamic";

const ENTRIES: [DemoPersona, string, string][] = [
  ["OWNER", "Start as the Owner", "See next week’s demand, local signals and the staffing gap across five South African locations."],
  ["MANAGER", "Start as the Manager", "Fill a gap with a shift on preauthorised rand terms, offer it and finalise the allocation."],
  ["WORKER", "Start as the Worker", "Accept shifts on your phone and see your pay in rand."],
];

// The route through the demo of the fictional South African business. The current flow and any earlier
// completed work are kept apart, because a shift accepted during a visit can't also be one already done.
type Act = { act: string; who: string; text: string; stops: string[] };
const DEMAND: Act = { act: "Demand", who: "Owner", text: "Synthetic sales history becomes next week’s expected transactions by time of day and a casual staffing gap at each location, in rand. Weather, public holidays and local events can adjust the forecast: twice a day AI searches the web near each location, a finding counts only with a source page FairShift could reach, and staffing uses an adjustment only when an Owner or a manager accepts it.", stops: ["Overview", "Forecast", "Locations"] };
const OPPORTUNITY: Act = { act: "Opportunity", who: "Manager, then Worker", text: "Fill a gap with a shift on the Owner’s preauthorised rand terms and offer it. As the Worker, accept with the full terms in view. As the Manager, finalise it on the schedule.", stops: ["Forecast & staffing", "Fill shifts", "Shifts", "Allocations"] };
const DISRUPTION: Act = { act: "Disruption", who: "Owner, then Manager", text: "A DEMO capacity scenario, made for the demonstration, shows a water interruption that would stop Rosebank trading tomorrow. The Owner sees the alert and, for casual shifts booked at Rosebank that day, who to tell early. The Manager sees the risk on tomorrow’s plan. It is synthetic, not a real event, and sending notices is turned off in the public demo.", stops: ["Overview", "Forecast & staffing"] };
const MONEY: Act = { act: "Money", who: "Manager, then Worker", text: "When a manager confirms completed work, the FairShift Pay Agent checks it, and FairShift’s server settles eligible pay through PayPal Sandbox in US dollars at the latest European Central Bank reference rate, locked when the payout is reserved, showing the worker the rand amount and the rate. Paid appears only once PayPal confirms it. Demo sessions can’t start a payment.", stops: ["Review & pay", "Earnings"] };

async function demoState() {
  const config = demoConfig();
  if (!config) return { open: false, saBusiness: false, earlier: false };
  try {
    const db = getDatabase();
    const open = !!await demoIdentities(db, config);
    return { open, saBusiness: config.organisationId === SA_REFERENCE_ORGANISATION.id, earlier: open && await hasEarlierEvidence(db, config.organisationId) };
  } catch { return { open: false, saBusiness: false, earlier: false }; }
}

export default async function DemoPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  const { open, saBusiness, earlier } = await demoState();
  const acts = saBusiness ? [DEMAND, OPPORTUNITY, DISRUPTION, MONEY] : [DEMAND, OPPORTUNITY, MONEY];
  return <PublicShell>
    <section className="page-intro"><div className="site-width">
      <h1>Explore FairShift</h1>
      <p className="lede">{saBusiness ? "Explore FairShift with Jacaranda Table Demo, a fictional South African cafe group trading in rand at five locations: Rosebank and Sandton in Johannesburg, Pretoria Central, Durban North and Cape Town Gardens." : "Explore FairShift using a prepared demonstration business."} No sign-up needed, and no real money moves.</p>
      {status === "expired" ? <p className="form-notice" role="status">Your demo session ended. Start again whenever you like.</p> : null}
      {status === "unavailable" && open ? <p className="form-alert" role="alert">The demo couldn’t start just now. Try again in a moment.</p> : null}
      {open ? <div className="demo-entry">{ENTRIES.map(([persona, title, text]) => <form action={enterDemoAction} key={persona}><input type="hidden" name="persona" value={persona} /><button><strong>{title}</strong><small>{text}</small></button></form>)}</div>
        : <><p className="form-notice" role="status">The demo isn’t open right now.</p><div className="cta-row"><Link className="primary-button button-link" href="/register">Start your business</Link><Link className="secondary-button button-link" href="/sign-in">Sign in</Link></div></>}
    </div></section>
    <section className="site-section"><div className="site-width">
      <h2>Follow the story</h2>
      <p className="section-lede">You can switch between Owner, Manager and Worker at any time. The business is shared with other visitors{saBusiness ? ": its venues, staff and sales are fictional or synthetic, and every screen says so" : ""}.{earlier ? " Its earlier completed work was prepared in advance, not created during your visit." : ""}</p>
      <ol className="demo-acts">{acts.map(({ act, who, text, stops }, index) => <li key={act}>
        <p className="eyebrow">Act {index + 1} · {act}</p>
        <h3>{who}</h3>
        <p>{text}</p>
        <p className="demo-stops">{stops.join(" → ")}</p>
      </li>)}</ol>
    </div></section>
  </PublicShell>;
}
