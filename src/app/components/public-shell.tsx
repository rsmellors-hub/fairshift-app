import Link from "next/link";
import type { ReactNode } from "react";
import { FsBrand } from "@/app/components/fs-shell";
import "./public-site.css";

// The public site: one header and footer for everything a visitor sees before signing in (design
// Main.dc.html, 10 Nov 2026). With a hero, the header sits on the dark hero as on the landing page.
// Product and FAQ are not in the design's header; they stay reachable from the footer. The public demo
// is off for judging (Owner, 12 Nov 2026), so nothing here links to it.
export function PublicShell({ hero, children }: { hero?: ReactNode; children: ReactNode }) {
  const header = <header className="fs pub-header"><div className="pub-width pub-header-row">
    <FsBrand inverse={Boolean(hero)} />
    <nav aria-label="Main" className="pub-nav">
      <Link href="/#how">How it works</Link>
      <Link href="/#who">Who it’s for</Link>
      <Link href="/#fair">Fair by design</Link>
      <Link href="/#pricing">Pricing</Link>
    </nav>
    <div className="pub-actions">
      <Link className={hero ? "btn sm inv-out" : "btn sm out"} href="/sign-in">Sign in</Link>
      <Link className={hero ? "btn sm inv" : "btn sm"} href="/register">Start free trial</Link>
    </div>
  </div></header>;
  return <div className="public-site">
    <a className="skip-link" href="#main-content">Skip to content</a>
    {hero ? <div className="pub-dark">{header}{hero}</div> : header}
    <main id="main-content" tabIndex={-1}>{children}</main>
    <footer className="fs pub-footer"><div className="pub-width pub-footer-row">
      <div className="pub-footer-brand">
        <FsBrand inverse />
        <p className="tiny">FairShift is not a payroll service. Shift earnings are paid to the worker’s PayPal wallet once the shift is confirmed. A casual worker’s share of card tips follows as its own PayPal payment.</p>
        <p className="tiny">This environment uses PayPal Sandbox, so no real money moves. FairShift does not run payroll or handle tax.</p>
      </div>
      <nav aria-label="Footer" className="pub-footer-nav">
        <Link href="/#how">How it works</Link>
        <Link href="/pricing">Pricing</Link>
        <Link href="/product">Product</Link>
        <Link href="/faq">FAQ</Link>
        <Link href="/sign-in">Sign in</Link>
        <details className="pub-note"><summary>Privacy</summary><p>FairShift keeps name, email, mobile, PayPal email and shift and pay records. Never a home address, ID number or bank details.</p></details>
        <details className="pub-note"><summary>Terms</summary><p>Owners and managers confirm all work and pay. The AI suggests and checks; it never sets amounts, picks workers or books shifts. Sandbox: no real money moves.</p></details>
      </nav>
    </div></footer>
  </div>;
}
