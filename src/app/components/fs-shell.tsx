import Link from "next/link";
import type { ReactNode } from "react";

// Shell pieces from the design (10 Nov 2026): the sandbox strip, the owner frame (side navigation,
// top bar with the location switcher, content column) and the worker phone frame (top, body, tabs).
// Navigation items, counts and labels always come from the caller; nothing here is demo data.

export type ShellNavItem = { label: string; href: string; count?: number; current?: boolean };

export function FsBrand({ href = "/", inverse = false }: { href?: string; inverse?: boolean }) {
  return <Link className="brand" href={href} aria-label="FairShift home" style={inverse ? { color: "#fff" } : undefined}>
    <span className="mark" aria-hidden="true" style={inverse ? { borderColor: "#fff" } : undefined}>F</span>FairShift
  </Link>;
}

/** The dark strip above every signed-in page: payments here are PayPal Sandbox only. */
export function SandboxStrip({ detail, children }: { detail?: ReactNode; children?: ReactNode }) {
  return <div className="fs sandbox" role="note" aria-label="PayPal Sandbox">
    <span>PayPal Sandbox. No real money moves.</span>
    {detail ? <span className="mono">{detail}</span> : null}
    {children}
  </div>;
}

function NavItem({ item }: { item: ShellNavItem }) {
  return <Link href={item.href} className={item.current ? "item on" : "item"} aria-current={item.current ? "page" : undefined}>
    {item.label}{item.count ? <span className="count">{item.count}</span> : null}
  </Link>;
}

/** The owner frame: side navigation (main group, then a ruled secondary group), top bar, content. */
export function OwnerShell({ label, home, primary, secondary = [], account, strip, topStart, topEnd, children }: {
  label: string;
  home: string;
  primary: ShellNavItem[];
  secondary?: ShellNavItem[];
  account?: ReactNode;
  strip?: ReactNode;
  topStart?: ReactNode;
  topEnd?: ReactNode;
  children: ReactNode;
}) {
  return <div className="fs">
    {strip}
    <div className="shell">
      <nav className="nav" aria-label={label}>
        <FsBrand href={home} />
        <div className="nav-group">{primary.map(item => <NavItem key={item.href} item={item} />)}</div>
        {secondary.length ? <div className="nav-group rule" style={{ paddingTop: 16 }}>{secondary.map(item => <NavItem key={item.href} item={item} />)}</div> : null}
        {account ? <div style={{ marginTop: "auto", padding: "0 12px" }}>{account}</div> : null}
      </nav>
      <div className="main">
        {topStart || topEnd ? <div className="top"><div>{topStart}</div><div style={{ display: "flex", gap: 10, alignItems: "center" }}>{topEnd}</div></div> : null}
        <main className="content" id="main-content" tabIndex={-1}>{children}</main>
      </div>
    </div>
  </div>;
}

/** The worker phone frame: top row, scrolling body, five bottom tabs. */
export function PhoneShell({ label, top, tabs, children }: { label: string; top?: ReactNode; tabs: ShellNavItem[]; children: ReactNode }) {
  return <div className="fs phone">
    {top ? <div className="ptop">{top}</div> : null}
    <main className="pbody" id="main-content" tabIndex={-1}>{children}</main>
    <nav className="tabs" aria-label={label} style={{ gridTemplateColumns: `repeat(${Math.max(tabs.length, 1)},minmax(0,1fr))` }}>
      {tabs.map(tab => <Link key={tab.href} href={tab.href} className={tab.current ? "on" : undefined} aria-current={tab.current ? "page" : undefined}>
        <span>{tab.label}</span>{tab.count ? <span className="count" aria-label={`${tab.count} new`}>{tab.count}</span> : null}
      </Link>)}
    </nav>
  </div>;
}
