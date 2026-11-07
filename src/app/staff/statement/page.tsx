import type { Metadata } from "next";
import { StatementClient } from "./statement-client";

export const dynamic = "force-dynamic";
// No analytics, no indexing: the page only renders the client that reads the fragment.
export const metadata: Metadata = { title: "Your tips · FairShift", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default function StaffStatementPage() {
  return <main className="product-page staff-statement"><StatementClient /></main>;
}
