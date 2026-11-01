import type { Metadata } from "next";
import Link from "next/link";
import { PublicShell } from "@/app/components/public-shell";
import { enterDemoAction } from "@/app/demo/actions";
import { getDatabase } from "@/server/db/client";
import { demoConfig, type DemoPersona } from "@/server/demo/config";
import { demoIdentities } from "@/server/demo/session";
import "./demo.css";

export const metadata: Metadata = { title: "Explore FairShift" };
export const dynamic = "force-dynamic";

const ENTRIES: [DemoPersona, string, string][] = [
  ["OWNER", "Start as the Owner", "See demand and the staffing gap across five locations."],
  ["MANAGER", "Start as the Manager", "Fill a gap, send an offer and finalise the allocation."],
  ["WORKER", "Start as the Worker", "Accept shifts on your phone and see your pay."],
];

// The route through the demo. The current flow and the earlier completed shift are kept apart,
// because a shift accepted during a visit can't also be the one already finished and paid.
const ACTS = [
  ["Demand", "Owner", "Sales history becomes a daily forecast for next week and a staffing gap at each location. The history is labelled reference data.", ["Overview", "Sales", "Forecast", "Location drill-down"]],
  ["Opportunity", "Manager, then Worker", "Fill a gap with a shift inside the Owner’s pay terms and offer it. As the Worker, accept with the full terms in view. As the Manager, finalise it on the schedule.", ["Forecast & staffing", "Fill shifts", "Offer", "Accept", "Allocations"]],
  ["Performance", "Worker", "An earlier completed shift shows how attributed sales reached a £200 target.", ["Earlier completed shift", "£200 target"]],
  ["Money", "Manager, then Worker", "The same earlier shift shows £96 base + £25 bonus = £121, the manager’s approval, and the PayPal Sandbox result the Worker sees.", ["Review & pay", "Worker earnings"]],
] as const;

async function demoOpen() {
  const config = demoConfig();
  if (!config) return false;
  try { return !!await demoIdentities(getDatabase(), config); } catch { return false; }
}

export default async function DemoPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  const open = await demoOpen();
  return <PublicShell>
    <section className="page-intro"><div className="site-width">
      <h1>Explore FairShift</h1>
      <p className="lede">Explore the complete FairShift commerce-to-income workflow using a prepared demonstration business. No sign-up needed, and no real money moves.</p>
      {status === "expired" ? <p className="form-notice" role="status">Your demo session ended. Start again whenever you like.</p> : null}
      {status === "unavailable" && open ? <p className="form-alert" role="alert">The demo couldn’t start just now. Try again in a moment.</p> : null}
      {open ? <div className="demo-entry">{ENTRIES.map(([persona, title, text]) => <form action={enterDemoAction} key={persona}><input type="hidden" name="persona" value={persona} /><button><strong>{title}</strong><small>{text}</small></button></form>)}</div>
        : <><p className="form-notice" role="status">The demo isn’t open right now.</p><div className="cta-row"><Link className="primary-button button-link" href="/register">Start your business</Link><Link className="secondary-button button-link" href="/sign-in">Sign in</Link></div></>}
    </div></section>
    <section className="site-section"><div className="site-width">
      <h2>Follow the story</h2>
      <p className="section-lede">You can switch between Owner, Manager and Worker at any time. The business is shared with other visitors, and its earlier completed shift was prepared in advance, not created during your visit.</p>
      <ol className="demo-acts">{ACTS.map(([act, who, text, stops], index) => <li key={act}>
        <p className="eyebrow">Act {index + 1} · {act}</p>
        <h3>{who}</h3>
        <p>{text}</p>
        <p className="demo-stops">{stops.join(" → ")}</p>
      </li>)}</ol>
    </div></section>
  </PublicShell>;
}
