"use server";
import { UserFacingError } from "@/server/domain/errors";
import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { getDatabase } from "@/server/db/client";
import { users, outlets, memberships } from "@/server/db/schema";
import { registerIdentity, signIn, issueSession, createIdentityToken, redeemIdentityToken, revokeSession, consumeLimit } from "@/server/auth/identity";
import { currentIdentity, requireIdentity, requireOwnerCustomer, requireScope, selectMembership, setSessionCookie, SESSION_COOKIE } from "@/server/auth/request";
import { ensureCustomerOrganisation, inviteMember, redeemInvitation, revokeInvitation } from "@/server/auth/tenancy";
import { notify, dispatchNotification, markNotificationRead, dispatchOperationalEmails } from "@/server/notifications/service";
import { getEmailAdapter } from "@/server/notifications/email";
import { startSubscription, refreshSubscription } from "@/server/billing/service";
import { planSelection } from "@/server/billing/plans";
import { createLocation } from "@/server/billing/locations";
import { getSubscriptionAdapter } from "@/server/billing/paypal";
import { completeWorkplace, savePersonalDetails, saveBusinessDetails } from "@/server/auth/onboarding";
import { organisationEntitled, ownerDestination, workplaceComplete } from "@/server/billing/entitlement";
import { workplaceDetails, workplaceErrors, type WorkplaceFormState } from "@/lib/workplace";
const personalKeys=["title","firstName","surname","position","telephone"];
const businessKeys=["name","businessAddress","city","province","postalCode","country"];
const field=(form:FormData,name:string) => String(form.get(name) ?? "");
async function identityEmail(user:{id:string;email:string},purpose:"VERIFY_EMAIL"|"RESET_PASSWORD") {
 const db=getDatabase(),token=await createIdentityToken(db,user.id,purpose),id=randomUUID();
 await notify(db,{id,userId:user.id,recipientEmail:user.email,eventKey:`identity:${id}`,kind:purpose,entityId:user.id,title:purpose === "VERIFY_EMAIL" ? "Verify your email":"Reset your password",body:purpose === "VERIFY_EMAIL" ? "Confirm your email to continue to FairShift. This link expires in one hour.":"Use this link to choose a new password. This link expires in one hour.",href:"/account"});
 await dispatchNotification(db,getEmailAdapter(),id,`/${purpose === "VERIFY_EMAIL" ? "verify-email":"reset-password"}#${token}`);
}
export async function registerAction(form:FormData) {
 let token:string;
 try {
  await consumeLimit(getDatabase(),"registration-global",100);
  const user=await registerIdentity(getDatabase(),{email:field(form,"email"),password:field(form,"password")});
  token=await issueSession(getDatabase(),user.id);
  await identityEmail(user,"VERIFY_EMAIL");
 } catch {redirect("/register?status=error");}
 await setSessionCookie(token);
 redirect("/account?status=verification-requested");
}
export async function signInAction(form:FormData) {
 let token:string;
 try {token=await signIn(getDatabase(),field(form,"email"),field(form,"password"));} catch {redirect("/sign-in?status=error");}
 await setSessionCookie(token);
 const identity=await currentIdentity();
 if (identity?.user.emailVerifiedAt) {
  const rows=await getDatabase().select().from(memberships).where(and(eq(memberships.userId,identity.user.id),eq(memberships.state,"ACTIVE")));
  const selected=rows.find(m=>m.id === identity.session.membershipId) ?? rows[0];
  if (!selected) redirect("/subscribe");
  redirect(await membershipDestination(selected));
 }
 redirect("/account");
}
export async function signOutAction() {
 const jar=await cookies(),token=jar.get(SESSION_COOKIE)?.value;
 if (token) await revokeSession(getDatabase(),token);
 jar.delete(SESSION_COOKIE);jar.delete("fairshift_location");redirect("/sign-in");
}
export async function requestVerificationAction() {
 const {user}=await requireIdentity();
 try {await consumeLimit(getDatabase(),`verify:${user.id}`,3);await identityEmail(user,"VERIFY_EMAIL");} catch {redirect("/account?status=error");}
 redirect("/account?status=verification-requested");
}
export async function verifyEmailAction(form:FormData) {
 let userId:string;
 try {userId=await redeemIdentityToken(getDatabase(),field(form,"token"),"VERIFY_EMAIL");} catch {redirect("/verify-email?status=error");}
 // Keep the registration session. A forwarded verification link must not log a
 // different browser/account into the verified identity without its password.
 const current=await currentIdentity();
 if (current?.user.id === userId) redirect("/subscribe");
 redirect("/sign-in?status=verified");
}
export async function requestResetAction(form:FormData) {
 try {
  const email=field(form,"email").trim().toLowerCase();
  await consumeLimit(getDatabase(),`reset:${email}`,3);
  const [user]=await getDatabase().select().from(users).where(eq(users.email,email));
  if (user) await identityEmail(user,"RESET_PASSWORD");
 } catch {}
 redirect("/sign-in?status=reset-requested");
}
export async function resetPasswordAction(form:FormData) {
 try {await redeemIdentityToken(getDatabase(),field(form,"token"),"RESET_PASSWORD",field(form,"password"));} catch {redirect("/reset-password?status=error");}
 redirect("/sign-in?status=password-reset");
}
export async function completeWorkplaceAction(_previous:WorkplaceFormState,form:FormData):Promise<WorkplaceFormState> {
 const scope=await requireOwnerCustomer();
 const keys=["firstName","surname","position","telephone","name","locationName","locationAddress","locationCity","locationPostalCode","locationCountry",...businessKeys.filter(key=>key !== "name")];
 const input={...Object.fromEntries(keys.filter(key=>form.has(key)).map(key=>[key,field(form,key)])),sameAddress:form.get("sameAddress") === "on"};
 const parsed=workplaceDetails.safeParse(input);
 if (!parsed.success) return {errors:workplaceErrors(input),message:"Check the highlighted details and try again."};
 try {await completeWorkplace(getDatabase(),scope,parsed.data);} catch (error) {return {message:error instanceof UserFacingError ? `${error.message} Your details are still here. Check the country, or contact FairShift.` : "We couldn’t save your workplace. Your details are still here. Please try again shortly."};}
 (await cookies()).delete("fairshift_location");redirect("/owner");
}
// A status check only reads/reconciles the existing subscription; it never starts checkout.
export async function checkSubscriptionStatusAction():Promise<{destination:string|null;message?:string}> {
 const scope=await requireOwnerCustomer(),db=getDatabase();
 let destination=await ownerDestination(db,scope.organisationId);
 if (destination !== "/subscribe") return {destination};
 try {await refreshSubscription(db,scope,getSubscriptionAdapter());} catch {
  destination=await ownerDestination(db,scope.organisationId);
  return destination !== "/subscribe" ? {destination} : {destination:null,message:"We couldn’t confirm your subscription yet. Check the payment status or try again shortly."};
 }
 destination=await ownerDestination(db,scope.organisationId);
 return {destination:destination === "/subscribe" ? null : destination};
}
export async function createLocationAction(form:FormData) {
 const scope=await requireScope(["OWNER"]);
 try {await createLocation(getDatabase(),scope,{name:field(form,"name")});} catch (error) {
   const message=error instanceof UserFacingError || error instanceof Error && /plan allows|entitlement needs configuration/.test(error.message) ? (error as Error).message : "The location could not be added.";
   redirect(`/owner/locations?status=${encodeURIComponent(message)}`);
 }
 redirect("/owner/locations?status=saved");
}
export async function selectMembershipAction(form:FormData) {
 const member=await selectMembership(field(form,"membershipId"));
 (await cookies()).delete("fairshift_location");
 redirect(await membershipDestination(member));
}
export async function selectLocationAction(form:FormData) {
 const scope=await requireScope(["OWNER"]);
 const rows=await getDatabase().select().from(outlets).where(eq(outlets.organisationId,scope.organisationId));
 if (!rows.some(r => r.active && r.id === field(form,"locationId"))) throw new Error("Access denied.");
 (await cookies()).set("fairshift_location",field(form,"locationId"),{httpOnly:true,secure:process.env.NODE_ENV === "production",sameSite:"lax",path:"/"});
 redirect("/owner/policies");
}
export async function inviteAction(form:FormData) {
 const scope=await requireScope(["OWNER","MANAGER"]);
 const path=scope.role === "OWNER" ? "/owner/workforce":"/manager/team";
 try {
  const result=await inviteMember(getDatabase(),scope,{role:field(form,"role"),email:field(form,"email"),firstName:field(form,"firstName"),surname:field(form,"surname"),telephone:field(form,"telephone")});
  await dispatchNotification(getDatabase(),getEmailAdapter(),result.notificationId,`/invite#${result.token}`);
 } catch {redirect(`${path}?status=error`);}
 redirect(`${path}?status=saved`);
}
export async function redeemInvitationAction(form:FormData) {
 const {user}=await requireIdentity();
 let id:string;
 try {await consumeLimit(getDatabase(),`redeem:${user.id}`);id=(await redeemInvitation(getDatabase(),user.id,{token:field(form,"token")})).id;} catch {redirect("/invite?status=error");}
 const member=await selectMembership(id);
 redirect(await membershipDestination(member));
}
export async function revokeInvitationAction(form:FormData) {
 const scope=await requireScope(["OWNER","MANAGER"]);
 await revokeInvitation(getDatabase(),scope,field(form,"invitationId"));redirect(scope.role === "OWNER" ? "/owner/workforce":"/manager/team");
}
export async function markReadAction(form:FormData) {
 const {user}=await requireIdentity();
 await markNotificationRead(getDatabase(),user.id,field(form,"notificationId"),field(form,"read") !== "no");redirect("/account");
}
export async function deliverNotificationsAction() {
 const {user}=await requireIdentity();
 await dispatchOperationalEmails(getDatabase(),getEmailAdapter(),user.id);redirect("/account");
}
export async function startSubscriptionAction(form:FormData) {
 const {user,session}=await requireIdentity();
 let approval:string|null|undefined;
 try {
  const selection=planSelection.parse({tier:field(form,"tier"),billingPeriod:field(form,"billingPeriod")});
  const member=await ensureCustomerOrganisation(getDatabase(),user.id,session.membershipId);
  await selectMembership(member.id);
  approval=(await startSubscription(getDatabase(),{userId:user.id,organisationId:member.organisationId,role:member.role},getSubscriptionAdapter(),selection))?.approvalUrl;
 } catch {redirect("/subscribe?status=unavailable");}
 if (approval) redirect(approval);
 redirect("/subscribe");
}
export async function refreshSubscriptionAction() {
 const scope=await requireOwnerCustomer();
 try {await refreshSubscription(getDatabase(),scope,getSubscriptionAdapter());} catch {redirect("/subscribe?status=error");}
 redirect(await ownerDestination(getDatabase(),scope.organisationId));
}
export async function resendInvitationAction(form:FormData) {
 const scope=await requireScope(["OWNER","MANAGER"]),path=scope.role === "OWNER" ? "/owner/workforce":"/manager/team";
 try {
  const {resendInvitation}=await import("@/server/auth/tenancy");
  const result=await resendInvitation(getDatabase(),scope,field(form,"invitationId"));
  await dispatchNotification(getDatabase(),getEmailAdapter(),result.notificationId,`/invite#${result.token}`);
 } catch {redirect(`${path}?status=error`);}
 redirect(`${path}?status=saved`);
}

async function membershipDestination(member:{organisationId:string;role:string}) {
 if (member.role === "OWNER") return ownerDestination(getDatabase(),member.organisationId);
 if (!await organisationEntitled(getDatabase(),member.organisationId)) return "/account?status=subscription-required";
 if (!await workplaceComplete(getDatabase(),member.organisationId)) return "/account?status=setup-required";
 return member.role === "OWNER" ? "/owner":member.role === "MANAGER" ? "/manager":"/worker";
}
export async function savePersonalAction(form:FormData) {
 const {user}=await requireIdentity();
 const scope=await requireOwnerCustomer();
 if (!await organisationEntitled(getDatabase(),scope.organisationId)) redirect("/subscribe");
 try {await savePersonalDetails(getDatabase(),user.id,Object.fromEntries(personalKeys.map(key=>[key,field(form,key)])));} catch {redirect("/onboarding?status=error");}
 redirect("/onboarding?status=saved");
}
export async function saveBusinessAction(form:FormData) {
 const scope=await requireOwnerCustomer();
 try {await saveBusinessDetails(getDatabase(),scope.userId,scope.organisationId,Object.fromEntries(businessKeys.map(key=>[key,field(form,key)])));} catch {redirect("/onboarding?status=error");}
 redirect("/onboarding?status=saved");
}
