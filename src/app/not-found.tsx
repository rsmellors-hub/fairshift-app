import type { Metadata } from "next";
import Link from "next/link";

import { AuthShell } from "@/app/components/auth-shell";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return <AuthShell title="Page not found">
    <p>We couldn’t find that page. The link may be out of date, or the page may have moved.</p>
    <p className="auth-switch"><Link href="/">Go to the home page</Link> or <Link href="/sign-in">sign in</Link>.</p>
  </AuthShell>;
}
