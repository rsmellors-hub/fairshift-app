import { requireEntitlement } from "@/server/billing/entitlement";
import { randomUUID } from "node:crypto";
import { and, eq, lt, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@/server/db/client";
import { memberships, organisations, outlets, subscriptions, users, workers, teamInvitations, notifications } from "@/server/db/schema";
import { assertRole, resolveScope, type Scope } from "./access";
import { newToken, tokenHash, consumeLimit } from "./identity";
import { notify } from "@/server/notifications/service";

// Serialize acquisition per identity and reuse existing Owner membership (including legacy orgs).
export async function ensureCustomerOrganisation(db:Database,userId:string,preferredMembershipId?:string|null) {
  return db.transaction(async tx => {
    const [user] = await tx.select().from(users).where(eq(users.id,userId)).for("update");
    if (!user?.emailVerifiedAt) throw new Error("Verify your email before choosing a subscription.");
    const owned = await tx.select().from(memberships).where(and(eq(memberships.userId,userId),eq(memberships.role,"OWNER"),eq(memberships.state,"ACTIVE")));
    const existing=owned.find(m=>m.id === preferredMembershipId) ?? owned[0];
    if (existing) return existing;
    const organisationId=randomUUID();
    // Empty name denotes an internal customer shell, never fabricated trading details.
    await tx.insert(organisations).values({id:organisationId,name:""});
    const [membership]=await tx.insert(memberships).values({id:randomUUID(),userId,organisationId,role:"OWNER"}).returning();
    await tx.insert(subscriptions).values({id:randomUUID(),organisationId,requestId:randomUUID()});
    return membership;
  });
}
export async function inviteMember(db:Database,scope:Scope,input:unknown) {
  assertRole(scope,["OWNER","MANAGER"]);
 await requireEntitlement(db,scope.organisationId);
  const value = z.object({role:z.enum(["MANAGER","TEAM_MEMBER"]),email:z.string().trim().toLowerCase().email().max(254),firstName:z.string().trim().min(1).max(100),surname:z.string().trim().min(1).max(100),telephone:z.string().trim().regex(/^\+?[0-9 ()-]{6,30}$/)}).strict().parse(input);
  if (value.role === "MANAGER") assertRole(scope,["OWNER"]);
  await consumeLimit(db,`invite:${scope.userId}:${scope.organisationId}`,50);
  const token=newToken();
  return db.transaction(async tx => {
    // Revalidate membership rather than accepting a caller's stale authority.
    const current = await tx.select().from(memberships).where(and(eq(memberships.userId,scope.userId),eq(memberships.organisationId,scope.organisationId),eq(memberships.state,"ACTIVE")));
    const authority = current.find(m => m.role === "OWNER" || (value.role === "TEAM_MEMBER" && m.role === "MANAGER" && m.outletId === scope.locationId));
    if (!authority) throw new Error("Access denied.");
    await resolveScope(tx,scope.userId,authority.id,scope.locationId,["OWNER","MANAGER"]);
    const [user] = await tx.select().from(users).where(eq(users.id,scope.userId));
    if (!user?.emailVerifiedAt) throw new Error("Verify your email first.");
    let workerId:string|null=null;
    if (value.role === "TEAM_MEMBER") {
      const existing = await tx.select().from(workers).where(and(eq(workers.organisationId,scope.organisationId),eq(workers.email,value.email))).for("update");
      if (existing.length) throw new Error("A team record already exists for this email. Review its invitation.");
      const [worker] = await tx.insert(workers).values({id:randomUUID(),organisationId:scope.organisationId,locationId:scope.locationId,firstName:value.firstName,surname:value.surname,telephone:value.telephone,email:value.email,displayName:`${value.firstName} ${value.surname}`,workerType:"CASUAL"}).returning();
      workerId=worker.id;
    }
    const [invitation] = await tx.insert(teamInvitations).values({id:randomUUID(),workerId,organisationId:scope.organisationId,outletId:scope.locationId,email:value.email,role:value.role,token:tokenHash(token),createdBy:scope.userId}).returning();
    const notification=await notify(tx,{id:randomUUID(),organisationId:scope.organisationId,recipientEmail:value.email,eventKey:`invitation:${invitation.id}:${tokenHash(token)}`,kind:value.role === "MANAGER" ? "MANAGER_INVITATION":"TEAM_INVITATION",entityId:invitation.id,title:"You’re invited to FairShift",body:`You have been invited to ${scope.organisationName} at ${scope.locationName} as ${value.role === "MANAGER" ? "a Manager":"a Team Member"}. Sign in with this email to review and redeem your invitation. This invitation expires in seven days.`,href:"/account"});
    return {invitation,notificationId:notification!.id,token};
  });
}
export async function redeemInvitation(db:Database,userId:string,input:unknown) {
  const {token} = z.object({token:z.string().min(20).max(200)}).strict().parse(input);
  await db.update(teamInvitations).set({state:"EXPIRED"}).where(and(eq(teamInvitations.token,tokenHash(token)),lt(teamInvitations.expiresAt,new Date()),inArray(teamInvitations.state,["CREATED_NOT_SENT","SENT","DELIVERY_FAILED"])));
  return db.transaction(async tx => {
    const [invitation] = await tx.select().from(teamInvitations).where(eq(teamInvitations.token,tokenHash(token))).for("update");
    if (!invitation || !["CREATED_NOT_SENT","SENT","DELIVERY_FAILED"].includes(invitation.state) || invitation.expiresAt <= new Date() || !invitation.organisationId || !invitation.outletId) throw new Error("Invitation expired or unavailable.");
    const [user] = await tx.select().from(users).where(eq(users.id,userId)).for("update");
    if (!user || user.email !== invitation.email) throw new Error("Sign in with the invited email address.");
    const [location] = await tx.select().from(outlets).where(and(eq(outlets.id,invitation.outletId),eq(outlets.organisationId,invitation.organisationId)));
    if (!location) throw new Error("Invitation scope is unavailable.");
    if (invitation.workerId) {
      const [worker] = await tx.select().from(workers).where(and(eq(workers.id,invitation.workerId),eq(workers.organisationId,invitation.organisationId),eq(workers.locationId,invitation.outletId),eq(workers.status,"ACTIVE"))).for("update");
      if (!worker || (worker.userId && worker.userId !== userId)) throw new Error("Team identity is unavailable.");
      await tx.update(workers).set({userId}).where(eq(workers.id,worker.id));
    }
    const [membership] = await tx.insert(memberships).values({id:randomUUID(),userId,organisationId:invitation.organisationId,outletId:invitation.outletId,workerId:invitation.workerId,role:invitation.role,invitationId:invitation.id}).returning();
    await tx.update(teamInvitations).set({state:"REDEEMED",redeemedBy:userId,redeemedAt:new Date()}).where(eq(teamInvitations.id,invitation.id));
    // Possession of the invitation proves control of the invited mailbox.
    await tx.update(users).set({emailVerifiedAt:user.emailVerifiedAt ?? new Date()}).where(eq(users.id,userId));
    await tx.update(notifications).set({userId}).where(and(eq(notifications.organisationId,invitation.organisationId),eq(notifications.recipientEmail,user.email)));
    return membership;
  });
}
export async function revokeInvitation(db:Database,scope:Scope,id:string) {
  assertRole(scope,["OWNER","MANAGER"]);
 await requireEntitlement(db,scope.organisationId);
  const [row]=await db.select().from(teamInvitations).where(and(eq(teamInvitations.id,id),eq(teamInvitations.organisationId,scope.organisationId),eq(teamInvitations.outletId,scope.locationId)));
  if (!row || row.state === "REDEEMED" || (scope.role === "MANAGER" && row.role !== "TEAM_MEMBER")) throw new Error("Invitation unavailable.");
  await db.update(teamInvitations).set({state:"REVOKED"}).where(and(eq(teamInvitations.id,id),eq(teamInvitations.state,row.state)));
}
export async function resendInvitation(db:Database,scope:Scope,id:string) {
 assertRole(scope,["OWNER","MANAGER"]);
 await requireEntitlement(db,scope.organisationId);
 await consumeLimit(db,`invite-resend:${scope.userId}:${scope.organisationId}`,10);
 const token=newToken();
 return db.transaction(async tx=>{
  const [i]=await tx.select().from(teamInvitations).where(and(eq(teamInvitations.id,id),eq(teamInvitations.organisationId,scope.organisationId),eq(teamInvitations.outletId,scope.locationId))).for("update");
  if (!i || !i.email || ["REDEEMED","REVOKED"].includes(i.state) || (scope.role === "MANAGER" && i.role !== "TEAM_MEMBER")) throw new Error("Invitation unavailable.");
  await tx.update(teamInvitations).set({token:tokenHash(token),state:"CREATED_NOT_SENT",expiresAt:new Date(Date.now()+7*86400_000)}).where(eq(teamInvitations.id,id));
  const n=await notify(tx,{id:randomUUID(),organisationId:scope.organisationId,recipientEmail:i.email,eventKey:`invitation:${id}:${tokenHash(token)}`,kind:i.role === "MANAGER" ? "MANAGER_INVITATION":"TEAM_INVITATION",entityId:id,title:"Your FairShift invitation",body:`Join ${scope.organisationName} at ${scope.locationName}. This replaces your earlier invitation link and expires in seven days.`,href:"/account"});
  return {token,notificationId:n!.id};
 });
}
