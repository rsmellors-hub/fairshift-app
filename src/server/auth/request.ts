import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { getDatabase } from "@/server/db/client";
import { memberships, sessions } from "@/server/db/schema";
import { resolveSession } from "./identity";
import { resolveScope, type Role } from "./access";
export const SESSION_COOKIE = "fairshift_session";
export async function currentIdentity() {
  return resolveSession(getDatabase(),(await cookies()).get(SESSION_COOKIE)?.value);
}
export async function requireIdentity() {
  const identity=await currentIdentity();
  if (!identity) redirect("/sign-in");
  return identity;
}
export async function requireScope(roles:Role[]) {
  const {user,session}=await requireIdentity();
  const rows = await getDatabase().select().from(memberships).where(and(eq(memberships.userId,user.id),eq(memberships.state,"ACTIVE")));
  const selected=rows.find(m => m.id === session.membershipId);
  const membership=selected && roles.includes(selected.role as Role) ? selected : rows.find(m => roles.includes(m.role as Role));
  if (!membership) redirect("/account");
  const locationId=(await cookies()).get("fairshift_location")?.value;
  return resolveScope(getDatabase(),user.id,membership.id,membership.role === "OWNER" ? locationId : undefined,roles);
}
export async function setSessionCookie(token:string) {
  (await cookies()).set(SESSION_COOKIE,token,{httpOnly:true,secure:process.env.NODE_ENV === "production",sameSite:"lax",path:"/",maxAge:7*86400});
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
