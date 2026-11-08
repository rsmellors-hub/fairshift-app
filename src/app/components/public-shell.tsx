import Link from "next/link";
import { FairShiftBrand } from "@/app/components/product-shell";

// The public site: one header and footer for everything a visitor sees before signing in.
export function PublicShell({ children }: { children: React.ReactNode }) {
  return <div className="public-site">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <header className="site-header"><div className="site-width site-header-row">
      <FairShiftBrand />
      <nav aria-label="Main" className="site-nav">
        <Link href="/product">Product</Link>
        <Link href="/pricing">Pricing</Link>
        <Link href="/faq">FAQ</Link>
        <Link href="/sign-in">Sign in</Link>
        <Link className="primary-button button-link" href="/register">Start your business</Link>
      </nav>
    </div></header>
    <main id="main-content" tabIndex={-1}>{children}</main>
    <footer className="site-footer"><div className="site-width site-footer-row">
      <div><FairShiftBrand /><p>AI-assisted demand intelligence, staffing and transparent worker pay.</p></div>
      <nav aria-label="Footer"><Link href="/product">Product</Link><Link href="/pricing">Pricing</Link><Link href="/faq">FAQ</Link><Link href="/demo">Try the demo</Link><Link href="/sign-in">Sign in</Link></nav>
      <p className="site-footer-note">This environment uses PayPal Sandbox and Square Sandbox, so no real money moves. FairShift does not run payroll or handle tax.</p>
    </div></footer>
  </div>;
}

// A worked example, labelled as one wherever it appears: one casual shift on preauthorised terms.
export function WorkedExample() {
  return <aside className="worked-example" aria-label="Worked example of one shift">
    <p className="eyebrow">Worked example · one casual shift, 10:00–16:00</p>
    <dl className="pay-sum">
      <div><dt>Preauthorised terms the worker accepted</dt><dd>R45.00 an hour</dd></div>
      <div><dt>Hours the manager confirmed</dt><dd>6</dd></div>
      <div className="pay-sum-total"><dt>Earnings, in rand</dt><dd>R270.00</dd></div>
    </dl>
    <ol className="pay-steps" aria-label="What happens to that amount"><li>Confirmed</li><li>Checked</li><li>Sent to PayPal</li><li>Paid</li></ol>
    <p className="note">The FairShift Pay Agent checks the work and FairShift’s server sends the amount through PayPal Sandbox, in US dollars at the European Central Bank reference rate. Paid shows only once PayPal confirms it. The worker saw these terms before accepting.</p>
  </aside>;
}
