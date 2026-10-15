import Link from "next/link";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { requireIdentity, requireOwnerCustomer } from "@/server/auth/request";
import { getDatabase } from "@/server/db/client";
import { organisations, outlets } from "@/server/db/schema";
import { organisationEntitled } from "@/server/billing/entitlement";
import { completeWorkplaceAction, signOutAction } from "@/app/auth-actions";
import { BusinessFields, PersonalFields } from "@/app/components/onboarding-fields";
export const dynamic="force-dynamic";
export default async function Onboarding({searchParams}:{searchParams:Promise<{status?:string}>}) {
 const {user}=await requireIdentity(),scope=await requireOwnerCustomer(),db=getDatabase();
 if (!await organisationEntitled(db,scope.organisationId)) redirect("/subscribe");
 const [business]=await db.select().from(organisations).where(eq(organisations.id,scope.organisationId));
 const locations=await db.select().from(outlets).where(eq(outlets.organisationId,scope.organisationId));
 const location=locations.find(row=>row.active);
 return <main className="product-page onboarding-page"><header><Link href="/account">Account & notifications</Link><h1>Set up your workplace</h1><ol className="onboarding-progress" aria-label="Setup progress"><li>Account ✓</li><li>Plan ✓</li><li>Workplace {business?.setupCompletedAt ? "✓" : ""}</li><li>Team</li></ol></header>
 {(await searchParams).status === "error" ? <p role="alert">We couldn’t save your workplace. Complete the required fields and check your subscription before trying again.</p> : null}
 <form action={completeWorkplaceAction} className="workspace-form"><section className="panel"><h2>Your details</h2><PersonalFields value={user}/><label>Email address<input type="email" value={user.email} readOnly/></label></section><section className="panel"><h2>Business details</h2><BusinessFields value={business}/>{location ? <p>Operating location: {location.name}. Your business address is separate from your operating locations.</p> : <label>First operating location<input name="locationName" required maxLength={150} placeholder="e.g. Johannesburg store"/></label>}</section><button className="primary-button">Save & continue to FairShift</button></form>
 {business?.setupCompletedAt ? <Link href="/owner">Open workspace</Link> : null}<Link href="/subscribe">Subscription</Link><form action={signOutAction}><button className="secondary-button">Sign out</button></form></main>;
}
