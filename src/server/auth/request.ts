import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { getDatabase } from "@/server/db/client";
import { memberships, sessions } from "@/server/db/schema";
import { resolveSession } from "./identity";
import { resolveScope, type Role } from "./access";
import { organisationEntitled, workplaceComplete } from "@/server/billing/entitlement";
import { REQUEST_METHOD_HEADER } from "@/lib/request-method";
import { DEMO_HOME, DEMO_MEMBERSHIP_ROLE, demoConfig, demoPersona } from "@/server/demo/config";
export const SESSION_COOKIE = "fairshift_session";
export const DEMO_COOKIE = "fairshift_demo";
export async function currentIdentity() {
  return resolveSession(getDatabase(),(await cookies()).get(SESSION_COOKIE)?.value);
}
async function signedIn() {
  const identity=await currentIdentity();
  if (!identity) redirect((await cookies()).get(DEMO_COOKIE)?.value ? "/demo?status=expired" : "/sign-in");
  return identity;
}
// Account, onboarding and billing. A demo session never reaches any of them.
export async function requireIdentity() {
  const identity=await signedIn();
  if (identity.session.demoPersona) redirect(`${DEMO_HOME[demoPersona.parse(identity.session.demoPersona)]}?status=demo-read-only`);
  return identity;
}
// A demo session is valid only while public demo access is on and still names its configured
// membership. On anything but a plain read it is refused, unless the action opted in: a new
// action is closed to the demo by default. A missing method header counts as a write.
async function demoScope(session:{demoPersona:string|null;demoGroup:string|null;membershipId:string|null},userId:string,roles:Role[],demoWrite:boolean) {
  const config=demoConfig(),persona=demoPersona.safeParse(session.demoPersona);
  if (!config || !persona.success || !session.demoGroup || session.membershipId !== config[persona.data]) redirect("/demo?status=unavailable");
  const home=DEMO_HOME[persona.data];
  if (!roles.includes(DEMO_MEMBERSHIP_ROLE[persona.data] as Role)) redirect(`${home}?status=demo-read-only`);
  if (!demoWrite && !["GET","HEAD"].includes((await headers()).get(REQUEST_METHOD_HEADER) ?? "")) redirect(`${home}?status=demo-read-only`);
  const locationId=persona.data === "OWNER" ? (await cookies()).get("fairshift_location")?.value : undefined;
  const scope=await resolveScope(getDatabase(),userId,session.membershipId!,locationId,roles);
  if (scope.organisationId !== config.organisationId) redirect("/demo?status=unavailable");
  return {...scope,demo:{persona:persona.data,group:session.demoGroup}};
}
// Account/onboarding/billing only. Operational entry points must use requireScope.
export async function requireMembershipScope(roles:Role[]) {
  const {user,session}=await requireIdentity();
  const rows = await getDatabase().select().from(memberships).where(and(eq(memberships.userId,user.id),eq(memberships.state,"ACTIVE")));
  const selected=rows.find(m => m.id === session.membershipId);
  const membership=selected && roles.includes(selected.role as Role) ? selected : rows.find(m => roles.includes(m.role as Role));
  if (!membership) redirect("/account");
  const locationId=(await cookies()).get("fairshift_location")?.value;
  return resolveScope(getDatabase(),user.id,membership.id,membership.role === "OWNER" ? locationId : undefined,roles);
}
export async function requireOwnerCustomer() {
  const {user,session}=await requireIdentity();
  if (!user.emailVerifiedAt) redirect("/account?status=verify-email");
  const rows=await getDatabase().select().from(memberships).where(and(eq(memberships.userId,user.id),eq(memberships.role,"OWNER"),eq(memberships.state,"ACTIVE")));
  const member=rows.find(m=>m.id === session.membershipId) ?? rows[0];
  if (!member) redirect("/subscribe");
  return {userId:user.id,organisationId:member.organisationId,role:member.role};
}
export async function requireScope(roles:Role[],options:{demoWrite?:boolean}={}) {
  const {user,session}=await signedIn();
  if (session.demoPersona) return demoScope(session,user.id,roles,!!options.demoWrite);
  const rows=await getDatabase().select().from(memberships).where(and(eq(memberships.userId,user.id),eq(memberships.state,"ACTIVE")));
  const selected=rows.find(m=>m.id === session.membershipId);
  const member=selected && roles.includes(selected.role as Role) ? selected : rows.find(m=>roles.includes(m.role as Role));
  if (!member) redirect("/account");
  if (!user.emailVerifiedAt) redirect("/account?status=verify-email");
  if (!await organisationEntitled(getDatabase(),member.organisationId)) redirect(member.role === "OWNER" ? "/subscribe" : "/account?status=subscription-required");
  if (!await workplaceComplete(getDatabase(),member.organisationId)) redirect(member.role === "OWNER" ? "/onboarding" : "/account?status=setup-required");
  const locationId=(await cookies()).get("fairshift_location")?.value;
  return resolveScope(getDatabase(),user.id,member.id,member.role === "OWNER" ? locationId : undefined,roles);
}
// Existing worker-payment obligations remain accessible after operational entitlement
// ends. This keeps every identity, role, membership, workplace and location check from
// requireScope, but deliberately does not grant access to any operational action.
export async function requireFinancialScope(roles:Role[]) {
  const {user,session}=await signedIn();
  if (session.demoPersona) return demoScope(session,user.id,roles,false);
  const rows=await getDatabase().select().from(memberships).where(and(eq(memberships.userId,user.id),eq(memberships.state,"ACTIVE")));
  const selected=rows.find(m=>m.id === session.membershipId);
  const member=selected && roles.includes(selected.role as Role) ? selected : rows.find(m=>roles.includes(m.role as Role));
  if (!member) redirect("/account");
  if (!user.emailVerifiedAt) redirect("/account?status=verify-email");
  if (!await workplaceComplete(getDatabase(),member.organisationId)) redirect(member.role === "OWNER" ? "/onboarding" : "/account?status=setup-required");
  const locationId=(await cookies()).get("fairshift_location")?.value;
  return resolveScope(getDatabase(),user.id,member.id,member.role === "OWNER" ? locationId : undefined,roles);
}
export async function setSessionCookie(token:string,expiresAt?:Date) {
  (await cookies()).set(SESSION_COOKIE,token,{httpOnly:true,secure:process.env.NODE_ENV === "production",sameSite:"lax",path:"/",...(expiresAt ? {expires:expiresAt} : {maxAge:7*86400})});
}
export async function selectMembership(id:string) {
  const {user,session}=await requireIdentity();
  const [membership]=await getDatabase().select().from(memberships).where(and(eq(memberships.id,id),eq(memberships.userId,user.id),eq(memberships.state,"ACTIVE")));
  if (!membership) throw new Error("Access denied.");
  await getDatabase().update(sessions).set({membershipId:id}).where(eq(sessions.id,session.id));
  return membership;
}
export function operatorAllowed(user:{id:string;emailVerifiedAt:Date|null}) {
  return !!user.emailVerifiedAt && (process.env.FAIRSHIFT_OPERATOR_USER_IDS ?? "").split(",").map(s=>s.trim()).includes(user.id);
}
export async function requireOperator() {
  const {user}=await requireIdentity();
  if (!operatorAllowed(user)) throw new Error("Access denied.");
  return user;
}
