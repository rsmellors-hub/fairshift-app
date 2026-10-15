import Link from "next/link";
import { FairShiftBrand } from "@/app/components/product-shell";

export default function Home() {
  return <main className="entry-shell">
    <header className="entry-topbar"><FairShiftBrand /><span className="entry-status">Sandbox environment</span></header>
    <section className="entry-hero"><div><span className="eyebrow">Workforce operating intelligence</span><h1>Turn demand into the right shift — and approved work into payment.</h1><p>FairShift connects commercial history, demand forecasting, staffing decisions and transparent worker payments.</p><div className="entry-actions"><Link className="primary-button button-link" href="/operator">Open environment access</Link></div><p className="entry-note">This controlled environment uses fictional business data and PayPal Sandbox. Workspace access is managed from the operator surface; sign-in is not implemented.</p></div><div className="operating-loop" aria-label="FairShift operating loop"><span>Understand demand</span><strong>Sales → forecast → staffing</strong><span>Put the plan to work</span><strong>Shifts → work → performance</strong><span>Pay transparently</span><strong>Approval → payment → confirmation</strong></div></section>
  </main>;
}
