import { sandboxOrganisationId } from "@/server/config/deployment";
import type { Metadata } from "next";
import { AcquisitionProgress } from "@/app/components/acquisition-progress";
import { BillingToggle, PLAN_COPY, PlanPrice } from "@/app/components/plan-cards";
import { FairShiftBrand } from "@/app/components/product-shell";
import { redirect } from "next/navigation";
import { and,eq } from "drizzle-orm";
import { requireIdentity, requireOwnerCustomer } from "@/server/auth/request";
import { getDatabase } from "@/server/db/client";
import { memberships } from "@/server/db/schema";
import { subscriptionFor } from "@/server/billing/service";
import { isEntitled, ownerDestination } from "@/server/billing/entitlement";
import { configuredPlan, enterpriseContact } from "@/server/billing/plans";
import { getSubscriptionAdapter } from "@/server/billing/paypal";
import { startSubscriptionAction, refreshSubscriptionAction, signOutAction } from "@/app/auth-actions";
import Link from "next/link";
export const metadata: Metadata = { title: "Choose your plan" };
export const dynamic="force-dynamic";
export default async function Subscribe({searchParams}:{searchParams:Promise<{period?:string;status?:string;billing?:string;verified?:string}>}) {
 const {user}=await requireIdentity(),db=getDatabase();
 if (!user.emailVerifiedAt) redirect("/account?status=verify-email");
 const owned=await db.select().from(memberships).where(and(eq(memberships.userId,user.id),eq(memberships.role,"OWNER"),eq(memberships.state,"ACTIVE")));
 const scope=owned.length ? await requireOwnerCustomer() : null;
 const sub=scope ? await subscriptionFor(db,scope) : null;
 if (scope && isEntitled(sub)) redirect(await ownerDestination(db,scope.organisationId));
 const {period,status,billing,verified}=await searchParams;
 const billingPeriod=period === "ANNUAL" ? "ANNUAL" : "MONTHLY";
 const configured=!!scope && sandboxOrganisationId() === scope.organisationId && !!getSubscriptionAdapter(),contact=enterpriseContact();
 const awaiting=!!sub && ["APPROVAL_PENDING","APPROVED"].includes(sub.status);
 const needsHelp=!!sub && !["UNCONFIGURED","PENDING","APPROVAL_PENDING","APPROVED"].includes(sub.status);
 return <main className="acquisition-shell plan-shell"><header className="acquisition-header"><FairShiftBrand /><form action={signOutAction}><button className="link-button">Sign out</button></form></header>
 <AcquisitionProgress current="Plan"/>
 {verified ? <p className="form-notice" role="status"><strong>Email verified.</strong> Now choose your plan.</p> : null}
 <div className="workplace-heading"><h1>Choose your plan</h1><p>Every plan includes the full product. Choose by how many locations you run.</p></div>
 {status ? <p className="form-alert" role="alert">{status === "unavailable" ? "That checkout isn’t available right now, or another subscription is already in progress. Your account is saved." : "We couldn’t confirm your subscription just now. Please try again shortly."}</p> : null}
 {billing === "cancelled" ? <p className="form-notice" role="status">You cancelled the PayPal approval. Nothing was charged. Continue when you’re ready.</p> : null}
 {awaiting || needsHelp ? <section className="panel"><h2>{needsHelp ? "Your subscription needs attention" : "Your subscription is awaiting confirmation"}</h2><p>{needsHelp ? "Contact FairShift to review it before starting another checkout." : "Finish approving it in PayPal, or check whether PayPal has already confirmed it."}</p><div className="button-row">{configured && awaiting && sub?.approvalUrl && safeApproval(sub.approvalUrl) ? <a className="primary-button button-link" href={sub.approvalUrl}>Continue in PayPal</a> : null}<form action={refreshSubscriptionAction}><button className="secondary-button">Check payment status</button></form>{needsHelp ? <Link className="secondary-button button-link" href="/settlements">Settle existing worker payments</Link> : null}</div></section> : null}
 <BillingToggle current={billingPeriod} basePath="/subscribe"/>
 <div className="plan-grid">{(["SINGLE_OUTLET","MULTI_OUTLET"] as const).map(tier=>{
  const available=configured && !!configuredPlan({tier,billingPeriod});
  const locked=!!sub && sub.status !== "UNCONFIGURED" && (sub.tier !== tier || sub.billingPeriod !== billingPeriod || !["PENDING","APPROVAL_PENDING","APPROVED"].includes(sub.status));
  return <section className="plan-card" key={tier}><h2>{PLAN_COPY[tier].name}</h2><p className="plan-limit">{PLAN_COPY[tier].limit}</p><PlanPrice tier={tier} billingPeriod={billingPeriod}/><ul>{PLAN_COPY[tier].includes.map(line=><li key={line}>{line}</li>)}</ul><form action={startSubscriptionAction}><input type="hidden" name="tier" value={tier}/><input type="hidden" name="billingPeriod" value={billingPeriod}/><button className="primary-button" disabled={!available || locked}>Approve in PayPal</button></form>{!available ? <p className="note">Checkout isn’t available for this plan right now.</p> : locked ? <p className="note">Your existing subscription needs review before you can choose another plan.</p> : null}</section>;
 })}<section className="plan-card" id="enterprise"><h2>Enterprise</h2><p className="plan-limit">6+ locations</p><p className="plan-price"><strong>Custom</strong></p><ul><li>Everything in Multi Outlet</li><li>Commercial terms agreed with you</li></ul>{contact ? <a className="secondary-button button-link" href={`mailto:${contact}?subject=FairShift%20Enterprise%20enquiry`}>Contact FairShift</a> : <p className="note">Contact FairShift to discuss your locations. Enterprise isn’t available through online checkout.</p>}</section></div>
 <p className="note plan-footnote">You’ll leave FairShift to review and approve this subscription in PayPal (PayPal Sandbox in this environment), then come straight back to finish setting up. Your plan pays for FairShift; worker pay is separate.</p></main>;
}

function safeApproval(value:string) {
 try {const url=new URL(value);return url.protocol === "https:" && url.hostname === "www.sandbox.paypal.com";} catch {return false;}
}
