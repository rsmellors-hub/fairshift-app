import Link from "next/link";
import { redirect } from "next/navigation";
import { and,eq } from "drizzle-orm";
import { requireIdentity, requireOwnerCustomer } from "@/server/auth/request";
import { getDatabase } from "@/server/db/client";
import { memberships } from "@/server/db/schema";
import { subscriptionFor } from "@/server/billing/service";
import { isEntitled, ownerDestination } from "@/server/billing/entitlement";
import { commercialPlan, configuredPlan, enterpriseContact } from "@/server/billing/plans";
import { getSubscriptionAdapter } from "@/server/billing/paypal";
import { startSubscriptionAction, refreshSubscriptionAction, signOutAction } from "@/app/auth-actions";
export const dynamic="force-dynamic";
export default async function Subscribe({searchParams}:{searchParams:Promise<{period?:string;status?:string;billing?:string}>}) {
 const {user}=await requireIdentity(),db=getDatabase();
 if (!user.emailVerifiedAt) redirect("/account?status=verify-email");
 const owned=await db.select().from(memberships).where(and(eq(memberships.userId,user.id),eq(memberships.role,"OWNER"),eq(memberships.state,"ACTIVE")));
 const scope=owned.length ? await requireOwnerCustomer() : null;
 const sub=scope ? await subscriptionFor(db,scope) : null;
 if (scope && isEntitled(sub)) redirect(await ownerDestination(db,scope.organisationId));
 const {period,status,billing}=await searchParams;
 const billingPeriod=period === "ANNUAL" ? "ANNUAL" : "MONTHLY";
 const configured=!!getSubscriptionAdapter(),contact=enterpriseContact();
 return <main className="product-page onboarding-page"><header><Link href="/account">Account & notifications</Link><h1>Choose your subscription</h1><ol className="onboarding-progress" aria-label="Setup progress"><li>Account ✓</li><li>Plan</li><li>Workplace</li><li>Team</li></ol></header>
 {status ? <p role="alert">{status === "unavailable" ? "This checkout is unavailable or a different subscription is already in progress. Your account is saved. Review its status below." : "Subscription verification could not be completed. Please try again later."}</p> : null}
 {billing === "cancelled" ? <p>PayPal approval was cancelled. This browser return has not activated access.</p> : null}
 {sub ? <section className="panel"><h2>Subscription status</h2><p>{sub.status} {sub.tier ? `· ${sub.tier.replaceAll("_"," ")} · ${sub.billingPeriod ?? "Custom"}` : ""}</p><p>{sub.verifiedAt ? `Last checked with PayPal: ${sub.verifiedAt.toISOString()}` : "Not yet verified with PayPal."}</p>{sub.approvalUrl && ["APPROVAL_PENDING","APPROVED"].includes(sub.status) && safeApproval(sub.approvalUrl) ? <a className="primary-button" href={sub.approvalUrl}>Continue PayPal approval</a> : null}<form action={refreshSubscriptionAction}><button className="secondary-button">Check subscription with PayPal</button></form>{!["UNCONFIGURED","PENDING","APPROVAL_PENDING","APPROVED"].includes(sub.status) ? <p>Contact FairShift to review your subscription before starting another checkout.</p> : null}</section> : null}
 <nav className="inline-form" aria-label="Billing period"><Link aria-current={billingPeriod === "MONTHLY" ? "page" : undefined} href="/subscribe?period=MONTHLY">Monthly</Link><Link aria-current={billingPeriod === "ANNUAL" ? "page" : undefined} href="/subscribe?period=ANNUAL">Annual</Link></nav>
 <div className="plan-options">{(["SINGLE_OUTLET","MULTI_OUTLET"] as const).map(tier=>{
  const terms=commercialPlan({tier,billingPeriod});
  const available=configured && !!configuredPlan({tier,billingPeriod});
  const locked=!!sub && sub.status !== "UNCONFIGURED" && (sub.tier !== tier || sub.billingPeriod !== billingPeriod || !["PENDING","APPROVAL_PENDING","APPROVED"].includes(sub.status));
  return <section className="panel" key={tier}><h2>{tier === "SINGLE_OUTLET" ? "Single Outlet" : "Multi Outlet"}</h2><p>{tier === "SINGLE_OUTLET" ? "1 active location" : "2–5 locations · Up to 5 active locations"}</p><p><strong>GBP £{terms.amount.replace(".00","")}/{billingPeriod === "MONTHLY" ? "month" : "year"}</strong></p><p>{billingPeriod === "MONTHLY" ? "Monthly" : "Annual"} billing</p>{billingPeriod === "ANNUAL" ? <p>12 months for the price of 10 monthly payments.</p> : null}<p>{available ? "Review the configured subscription price and terms in PayPal before approving." : "Checkout is currently unavailable for this option."}</p><form action={startSubscriptionAction}><input type="hidden" name="tier" value={tier}/><input type="hidden" name="billingPeriod" value={billingPeriod}/><button className="primary-button" disabled={!available || locked}>Continue to PayPal Sandbox</button></form>{locked ? <p>An existing subscription needs review before you can select another plan.</p> : null}</section>;
 })}<section className="panel" id="enterprise"><h2>Enterprise</h2><p>6+ active locations · Custom commercial terms.</p>{contact ? <a href={`mailto:${contact}?subject=FairShift%20Enterprise%20enquiry`}>Contact FairShift</a> : <p>Contact FairShift directly to discuss your locations. Online enquiries are not configured for this environment.</p>}<p>Custom terms must be agreed with FairShift. Enterprise checkout is not available online.</p></section></div>
 <p>After PayPal confirms activation, you’ll enter your personal, business and workplace details. Subscription billing is separate from team member payments.</p><form action={signOutAction}><button className="secondary-button">Sign out</button></form></main>;
}

function safeApproval(value:string) {
 try {const url=new URL(value);return url.protocol === "https:" && url.hostname === "www.sandbox.paypal.com";} catch {return false;}
}
