import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { requireIdentity, requireMembershipScope } from "@/server/auth/request";
import { getDatabase } from "@/server/db/client";
import { memberships, organisations } from "@/server/db/schema";
import { businessDetails, personalDetails } from "@/server/auth/onboarding";
import { subscriptionFor } from "@/server/billing/service";
import { isEntitled } from "@/server/billing/entitlement";
import { getSubscriptionAdapter } from "@/server/billing/paypal";
import { createOrganisationAction, saveBusinessAction, savePersonalAction, startSubscriptionAction, refreshSubscriptionAction, requestVerificationAction, signOutAction } from "@/app/auth-actions";
import { BusinessFields, PersonalFields } from "@/app/components/onboarding-fields";
export const dynamic = "force-dynamic";
export default async function Onboarding({searchParams}: {searchParams: Promise<{status?: string; billing?: string}>}) {
  const {user} = await requireIdentity(), db = getDatabase();
  const owners = await db.select().from(memberships).where(and(eq(memberships.userId, user.id), eq(memberships.role, "OWNER"), eq(memberships.state, "ACTIVE")));
  const scope = owners.length ? await requireMembershipScope(["OWNER"]) : null;
  const [business] = scope ? await db.select().from(organisations).where(eq(organisations.id, scope.organisationId)) : [];
  const subscription = scope ? await subscriptionFor(db, scope) : null;
  const entitled = isEntitled(subscription), configured = !!getSubscriptionAdapter();
  const complete = personalDetails.safeParse(user).success && businessDetails.safeParse(business).success;
  const {status, billing} = await searchParams;
  return <main className="product-page onboarding-page">
    <header><Link href="/account">Account & notifications</Link><h1>Welcome to FairShift</h1><p>Set up your workplace</p>
      <ol className="onboarding-progress" aria-label="Setup progress"><li>Account {user.emailVerifiedAt ? "✓" : "· verify email"}</li><li>Business {complete ? "✓" : ""}</li><li>Plan {entitled ? "✓" : ""}</li><li>Team</li></ol>
    </header>
    {status === "error" ? <p role="alert">We couldn’t save these details. Complete all required fields and try again.</p> : null}
    {!user.emailVerifiedAt ? <section className="panel"><h2>Verify your email</h2><p>Confirm {user.email} before setting up your business.</p><form action={requestVerificationAction}><button className="primary-button">Request verification email</button></form></section> : null}
    <section className="panel"><h2>Your details</h2><form action={savePersonalAction} className="workspace-form"><PersonalFields value={user}/><label>Email address<input type="email" value={user.email} readOnly autoComplete="email" /></label><button className="secondary-button">Save your details</button></form></section>
    {user.emailVerifiedAt ? <section className="panel"><h2>Business details</h2><form action={scope ? saveBusinessAction : createOrganisationAction} className="workspace-form"><BusinessFields value={business}/>{!scope ? <label>First operating location<input name="locationName" maxLength={150} required placeholder="e.g. Johannesburg store" /></label> : <p>Operating location: {scope.locationName}. Your business address is separate from your operating locations.</p>}<button className="primary-button">{scope ? "Save business details" : "Save business & continue"}</button></form></section> : null}
    {scope ? <section className="panel"><h2>Choose your plan</h2><p className="status-pill">{subscription?.status ?? "UNCONFIGURED"}</p>
      {entitled ? <><p>Your subscription is active.</p><Link className="primary-button" href="/owner">Continue to FairShift</Link></> : <><p>Your workplace is saved. Operational access will be available after PayPal confirms an active subscription.</p>{!complete ? <p>Complete your personal and business details before continuing to PayPal.</p> : null}
        {!configured ? <p>PayPal subscription setup is currently unavailable. Your details are saved; please return when setup is available.</p> : ["UNCONFIGURED", "PENDING", "APPROVAL_PENDING", "APPROVED"].includes(subscription?.status ?? "") ? <form action={startSubscriptionAction}><button className="primary-button" disabled={!complete}>{subscription?.approvalUrl ? "Continue PayPal approval" : "Continue to PayPal Sandbox"}</button></form> : <p>Review your subscription with PayPal. If it cannot be restored, contact support before starting another subscription.</p>}
        {billing === "cancelled" ? <p>PayPal approval was cancelled. No access has been activated by this return.</p> : null}
        <form action={refreshSubscriptionAction}><button className="secondary-button">Check subscription with PayPal</button></form></>}
      <p>{subscription?.verifiedAt ? `Last checked with PayPal: ${subscription.verifiedAt.toISOString()}` : "Not yet verified with PayPal."}</p><p className="method-note">Sandbox subscription billing is separate from team member payments.</p>
    </section> : null}
    <form action={signOutAction}><button className="secondary-button">Sign out</button></form>
  </main>;
}
