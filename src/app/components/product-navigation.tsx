"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ProductNavItem } from "@/app/components/product-shell";

export function ProductNavigation({ navigation, label, mobile = false }: { navigation: ProductNavItem[]; label: string; mobile?: boolean }) {
  const pathname = usePathname();
  return <nav className={mobile ? "worker-bottom-nav" : "product-nav"} aria-label={label}>
    {navigation.map((item) => item.href ? <Link key={item.href} href={item.href} aria-current={pathname === item.href ? "page" : undefined}>{item.label}</Link> : <span key={item.label} className="product-nav-planned">{item.label}<small>Not available</small></span>)}
  </nav>;
}
