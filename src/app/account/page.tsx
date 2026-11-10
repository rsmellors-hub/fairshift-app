import { updateOwnAccountAction } from "@/app/settings-actions";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { and,eq } from "drizzle-orm";
import { FairShiftBrand } from "@/app/components/product-shell";
import { requireIdentity } from "@/server/auth/request";
import { getDatabase } from "@/server/db/client";
import { memberships,organisations,subscriptions } from "@/server/db/schema";
import { selectMembershipAction,signOutAction,markReadAction } from "@/app/auth-actions";
import { listNotifications } from "@/server/notifications/service";
import { isEntitled } from "@/server/billing/entitlement";
export const metadata: Metadata = { title: "Your account" };
export const dynamic="force-dynamic";
const ROLE: Record<string,string> = { OWNER:"Owner", MANAGER:"Manager", TEAM_MEMBER:"Worker" };
export default async function Account({searchParams}:{searchParams:Promise<{status?:string}>}) {
 const {user}=await requireIdentity(),db=getDatabase();
 const {status}=await searchParams;
 if (!user.emailVerifiedAt) redirect("/check-email");
 const rows=await db.select({membership:memberships,name:organisations.name,subscription:subscriptions,setupCompletedAt:organisations.setupCompletedAt}).from(memberships).innerJoin(organisations,eq(organisations.id,memberships.organisationId)).leftJoin(subscriptions,eq(subscriptions.organisationId,memberships.organisationId)).where(and(eq(memberships.userId,user.id),eq(memberships.state,"ACTIVE")));
 const notices=await listNotifications(db,user.id);
 return <main className="account-page"><header className="acquisition-header"><FairShiftBrand /><form action={signOutAction}><button className="secondary-button">Sign out</button></form></header>
 <div className="workplace-heading"><h1>Your account</h1><p>{user.name ? `${user.name} · ` : ""}{user.email}</p></div>
 {status === "subscription-required" || status === "setup-required" ? <p className="form-notice" role="status">Your workplace isn’t ready yet. Your Owner needs an active subscription and a finished workplace setup. Contact your Owner.</p>:null}
 {status === "error" ? <p className="form-alert" role="alert">That couldn’t be completed. Try again shortly.</p>:null}
 {status === "details-saved" ? <p className="form-notice" role="status">Your details are saved.</p> : status === "details-invalid" ? <p className="form-alert" role="alert">Enter your first name, surname and a valid phone number (or leave the phone blank).</p> : null}
 <section className="panel" id="your-details"><h2>Your details</h2><form action={updateOwnAccountAction} className="workspace-form form-grid">
  <label>First name<input name="firstName" defaultValue={user.firstName ?? ""} maxLength={100} required /></label>
  <label>Surname<input name="surname" defaultValue={user.surname ?? ""} maxLength={100} required /></label>
  <label>Phone (optional)<input name="telephone" type="tel" defaultValue={user.telephone ?? ""} maxLength={30} /></label>
  <button className="secondary-button">Save details</button><p className="form-span note">Your email ({user.email}) is how you sign in.</p></form></section>
 <section className="panel"><h2>Your workplaces</h2>{rows.map(r=>{const ready=isEntitled(r.subscription) && !!r.setupCompletedAt,owner=r.membership.role === "OWNER";return <form action={selectMembershipAction} className="record-row" key={r.membership.id}><span><strong>{r.name || "Workplace setup pending"}</strong><small>{ROLE[r.membership.role] ?? "Team member"}</small></span><input type="hidden" name="membershipId" value={r.membership.id}/><button className="primary-button" disabled={!ready && !owner}>{ready ? "Open workspace":owner ? isEntitled(r.subscription) ? "Continue setup" : "Choose your plan":"Waiting for your Owner"}</button></form>;})}{!rows.length ? <><p>You’re not part of a workplace yet.</p><p><Link className="primary-button button-link" href="/subscribe">Choose your plan</Link></p></>:null}<p><Link className="text-link" href="/invite">Accept an invitation</Link></p></section>
 <section className="panel"><h2>Notifications</h2>{notices.map(n=><article className="record-row" key={n.id}><div><strong>{n.readAt ? "":"New · "}{n.title}</strong><p>{n.body}</p><Link href={n.href}>Open</Link></div><form action={markReadAction}><input type="hidden" name="notificationId" value={n.id}/><input type="hidden" name="read" value={n.readAt ? "no":"yes"}/><button className="secondary-button">Mark {n.readAt ? "unread":"read"}</button></form></article>)}{!notices.length ? <p>No notifications yet.</p>:null}</section></main>;
}
