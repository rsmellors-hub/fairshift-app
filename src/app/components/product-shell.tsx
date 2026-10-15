import Link from "next/link";

export type ProductNavItem = {
  label: string;
  href?: string;
};

export function FairShiftBrand({ compact = false }: { compact?: boolean }) {
  return (
    <Link className={`product-brand${compact ? " product-brand-compact" : ""}`} href="/" aria-label="FairShift home">
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
  role: "Manager" | "Worker" | "Owner";
  context: string;
  navigation: ProductNavItem[];
  mobile?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`product-shell${mobile ? " product-shell-worker" : ""}`}>
      <aside className="product-sidebar">
        <FairShiftBrand />
        <div className="role-context">
          <span>{role} workspace</span>
          <strong>{context}</strong>
        </div>
        <nav className="product-nav" aria-label={`${role} navigation`}>
          {navigation.map((item) => item.href ? (
            <Link key={item.label} href={item.href} aria-current={item.href === `/${role.toLowerCase()}` ? "page" : undefined}>
              {item.label}
            </Link>
          ) : (
            <span className="product-nav-planned" key={item.label} aria-disabled="true">
              {item.label}<small>Coming next</small>
            </span>
          ))}
        </nav>
        <p className="demo-context">Demo product context · access controls are not yet implemented.</p>
      </aside>
      <div className="product-workspace">
        <header className="workspace-bar">
          <FairShiftBrand compact />
          <div>
            <span>{role}</span>
            <strong>{context}</strong>
          </div>
        </header>
        <main className="product-main">{children}</main>
      </div>
      {mobile ? (
        <nav className="worker-bottom-nav" aria-label="Worker mobile navigation">
          {navigation.map((item) => item.href ? (
            <Link key={item.label} href={item.href} aria-current={item.href === "/worker" ? "page" : undefined}>{item.label}</Link>
          ) : (
            <span key={item.label} aria-disabled="true">{item.label}</span>
          ))}
        </nav>
      ) : null}
    </div>
  );
}
