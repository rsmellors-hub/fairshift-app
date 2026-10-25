import Link from "next/link";
import { ProductNavigation } from "@/app/components/product-navigation";

export type ProductNavItem = {
  label: string;
  href?: string;
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
  children,
}: {
  role: "Manager" | "Worker" | "Owner" | "Operator";
  context: string;
  navigation: ProductNavItem[];
  mobile?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`product-shell${mobile ? " product-shell-worker" : ""}${role === "Owner" ? " product-shell-owner" : ""}`}>
      {role === "Owner" ? <a className="owner-skip" href="#owner-main">Skip to content</a> : null}
      <aside className="product-sidebar">
        <FairShiftBrand href={`/${role.toLowerCase()}`} />
        <div className="role-context">
          <span>{role} workspace</span>
          <strong>{context}</strong>
        </div>
        <ProductNavigation navigation={navigation} label={`${role} navigation`} />
        <p className="demo-context"><Link href="/account">Account & notifications</Link></p>
      </aside>
      <div className="product-workspace">
        <header className="workspace-bar">
          <FairShiftBrand compact href={`/${role.toLowerCase()}`} />
          {role === "Owner" ? <details className="owner-mobile-menu"><summary>Menu</summary><ProductNavigation navigation={navigation} label="Owner mobile navigation" /></details> : null}
          <div>
            <span>{role}</span>
            <strong>{context}</strong>
          </div>
          {role === "Owner" ? <Link className="owner-account" href="/account">Account</Link> : null}
        </header>
        <main className="product-main" id={role === "Owner" ? "owner-main" : undefined} tabIndex={role === "Owner" ? -1 : undefined}>{children}</main>
      </div>
      {mobile ? (
        <ProductNavigation navigation={navigation} label="Worker mobile navigation" mobile />
      ) : null}
    </div>
  );
}
