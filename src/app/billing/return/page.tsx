import Link from "next/link";
import { refreshSubscription } from "@/server/billing/service";
import { getSubscriptionAdapter } from "@/server/billing/paypal";
import { requireMembershipScope } from "@/server/auth/request";
import { getDatabase } from "@/server/db/client";
export const dynamic="force-dynamic";
export default async function BillingReturn() {
 const scope=await requireMembershipScope(["OWNER"]);
 let status="Verification unavailable";
 try {status=(await refreshSubscription(getDatabase(),scope,getSubscriptionAdapter()))?.status ?? "Pending";} catch {}
 return <main className="centered-shell"><h1>Organisation subscription</h1><p>{status}</p><p>Your browser return does not activate your subscription. FairShift checks PayPal directly.</p><Link href="/onboarding">Continue setup</Link></main>;
}
