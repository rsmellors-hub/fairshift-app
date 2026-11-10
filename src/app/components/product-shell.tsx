import Link from "next/link";
import { ProductNavigation } from "@/app/components/product-navigation";

export type ProductNavItem = {
  label: string;
  href?: string;
  // Starts a labelled group in the side navigation.
  group?: string;
  // A count shown beside the label, read from the same records the page shows (design, 10 Nov 2026).
  count?: number;
};

export function FairShiftBrand({ compact = false, href = "/" }: { compact?: boolean; href?: string }) {
  return (
    <Link className={`product-brand${compact ? " product-brand-compact" : ""}`} href={href} aria-label="FairShift home">
      <span aria-hidden="true">F</span>
      <strong>FairShift</strong>
    </Link>
  );
}
export function ProductShell({
  role,
  context,
  navigation,
  mobile = false,
  banner,
  notice,
  contextControl,
  children,
}: {
  role: "Manager" | "Worker" | "Owner" | "Operator";
  context: string;
  navigation: ProductNavItem[];
  mobile?: boolean;
  banner?: React.ReactNode;
  // A bar for signed-in accounts of the demo business: shown like the banner, but nothing is hidden.
  notice?: React.ReactNode;
  // A control beside the context, such as the Owner's operating-location switch.
  contextControl?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={`product-shell${mobile ? " product-shell-worker" : ""}${banner ? " demo-session" : ""}`}>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <aside className="product-sidebar">
        <FairShiftBrand href={`/${role.toLowerCase()}`} />
        <div className="role-context">
          <span>{role}</span>
          <strong>{context}</strong>
          {contextControl}
        </div>
        <ProductNavigation navigation={navigation} label={`${role} navigation`} />
        {banner ? null : <p className="sidebar-account"><Link href="/account">Account</Link></p>}
      </aside>
      <div className="product-workspace">
        <header className="workspace-bar">
          <FairShiftBrand compact href={`/${role.toLowerCase()}`} />
          {!mobile ? <details className="mobile-menu"><summary>Menu</summary>{contextControl}<ProductNavigation navigation={navigation} label={`${role} mobile navigation`} /></details> : null}
          <div className="workspace-context">
            <span>{role}</span>
            <strong>{context}</strong>
          </div>
          {banner ? null : <Link className="workspace-account" href="/account">Account</Link>}
        </header>
        {banner}{notice}
        <main className="product-main" id="main-content" tabIndex={-1}>{children}</main>
      </div>
      {mobile ? (
        <ProductNavigation navigation={navigation} label="Worker mobile navigation" mobile />
      ) : null}
    </div>
  );
}
