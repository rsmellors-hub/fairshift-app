"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ProductNavItem } from "@/app/components/product-shell";

export function ProductNavigation({ navigation, label, mobile = false }: { navigation: ProductNavItem[]; label: string; mobile?: boolean }) {
  const pathname = usePathname();
  // A section link (with a hash) is never "the page"; its own page's link carries the state.
  const current = (href: string) => pathname === href || (href.includes("#") ? false : href.split("/").length > 2 && pathname.startsWith(`${href}/`));
  return <nav className={mobile ? "worker-bottom-nav" : "product-nav"} aria-label={label}>
    {navigation.map((item) => item.href ? <span className="product-nav-item" key={item.href}>
      {item.group && !mobile ? <span className="product-nav-group">{item.group}</span> : null}
      <Link href={item.href} aria-current={current(item.href) ? "page" : undefined}>{item.label}{item.count ? <span className="nav-count" aria-label={`${item.count} unread`}>{item.count}</span> : null}</Link>
    </span> : null)}
  </nav>;
}
