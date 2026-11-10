import { requireEntitlement } from "@/server/billing/entitlement";
import { randomUUID } from "node:crypto";
import { and, eq, lt, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Database, DatabaseSession } from "@/server/db/client";
import { auditEvents, memberships, organisations, outlets, subscriptions, users, workerLocations, workers, teamInvitations, notifications } from "@/server/db/schema";
import { UserFacingError } from "@/server/domain/errors";
import { invitationSubject, invitationText, type InvitationEmail } from "@/server/notifications/templates";
import { auditActor } from "./audit-actor";
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
// Adds a person by invitation (Day 6, Owner decision 10 Nov 2026): name, email, optional phone, role and
// work location(s); never a home address. A casual worker belongs to one location; a Manager may be
// invited to several at once (one invitation per location, sharing a batch, redeemed together). The
// person is "Invited — not yet signed up" until they open the link and complete sign-up themselves.
// The Owner invites anyone to any location; a Manager invites casual workers to their own location only.
const inviteInput = z.object({role:z.enum(["MANAGER","TEAM_MEMBER"]),email:z.string().trim().toLowerCase().email().max(254),firstName:z.string().trim().min(1).max(100),surname:z.string().trim().min(1).max(100),
  telephone:z.union([z.literal(""),z.string().trim().regex(/^\+?[0-9 ()-]{6,30}$/)]).optional(),locationIds:z.array(z.uuid()).min(1).max(20).optional()}).strict();

export const inviterName = (user: { firstName?: string | null; surname?: string | null; name?: string | null; email: string }) =>
  [user.firstName, user.surname].filter(Boolean).join(" ") || user.name || user.email;

export async function invitationEmailData(tx: DatabaseSession, input: { organisationId: string; inviterId: string | null; role: "MANAGER" | "TEAM_MEMBER"; outletIds: string[]; expiresAt?: Date; invitee?: string | null }): Promise<InvitationEmail> {
  const [organisation] = await tx.select({ name: organisations.name }).from(organisations).where(eq(organisations.id, input.organisationId));
  const [inviter] = input.inviterId ? await tx.select().from(users).where(eq(users.id, input.inviterId)) : [];
  const roles = input.inviterId ? await tx.select({ role: memberships.role }).from(memberships).where(and(eq(memberships.userId, input.inviterId), eq(memberships.organisationId, input.organisationId), eq(memberships.state, "ACTIVE"))) : [];
  const places = input.outletIds.length ? await tx.select({ id: outlets.id, name: outlets.name, city: outlets.city, timezone: outlets.timezone }).from(outlets).where(and(eq(outlets.organisationId, input.organisationId), inArray(outlets.id, input.outletIds))) : [];
  const ordered = input.outletIds.map(id => places.find(row => row.id === id)!).filter(Boolean);
  return { business: organisation?.name ?? "", inviter: inviter ? inviterName(inviter) : "Your employer", inviterRole: roles.some(row => row.role === "OWNER") ? "OWNER" : roles.length ? "MANAGER" : undefined,
    invitee: input.invitee ?? undefined, role: input.role, locations: ordered.map(row => row.city ? `${row.name}, ${row.city}` : row.name), expiresAt: input.expiresAt ?? new Date(Date.now() + 7 * 86_400_000), timezone: ordered[0]?.timezone };
}
async function invitationContent(tx: DatabaseSession, organisationId: string, inviterId: string, role: "MANAGER" | "TEAM_MEMBER", outletIds: string[], expiresAt: Date, invitee?: string) {
  const email = await invitationEmailData(tx, { organisationId, inviterId, role, outletIds, expiresAt, invitee });
  return { title: invitationSubject(email), body: invitationText(email) };
}
// The email for a stored invitation: its location(s), its inviter and its expiry.
export async function invitationEmailFor(tx: DatabaseSession, invitationId: string) {
  const [invitation] = await tx.select().from(teamInvitations).where(eq(teamInvitations.id, invitationId));
  if (!invitation?.organisationId || !invitation.outletId) return null;
  let outletIds = [invitation.outletId];
  if (invitation.batchId) outletIds = (await tx.select({ id: teamInvitations.outletId }).from(teamInvitations).where(eq(teamInvitations.batchId, invitation.batchId))).map(row => row.id!).filter(Boolean);
  if (invitation.workerId) outletIds = [...new Set([invitation.outletId, ...(await tx.select({ id: workerLocations.outletId }).from(workerLocations).where(and(eq(workerLocations.workerId, invitation.workerId), isNull(workerLocations.removedAt)))).map(row => row.id)])];
  return invitationEmailData(tx, { organisationId: invitation.organisationId, inviterId: invitation.createdBy, role: invitation.role as "MANAGER" | "TEAM_MEMBER", outletIds: [...new Set(outletIds)], expiresAt: invitation.expiresAt, invitee: invitation.firstName });
}

export async function inviteMember(db:Database,scope:Scope,input:unknown) {
  assertRole(scope,["OWNER","MANAGER"]);
  await requireEntitlement(db,scope.organisationId);
  const value = inviteInput.parse(input);
  if (value.role === "MANAGER") assertRole(scope,["OWNER"]);
  const locationIds = [...new Set(value.locationIds ?? [scope.locationId])];
  if (scope.role === "MANAGER" && locationIds.some(id => id !== scope.locationId)) throw new Error("Access denied.");
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
    const places = await tx.select({ id: outlets.id }).from(outlets).where(and(eq(outlets.organisationId,scope.organisationId),eq(outlets.active,true),inArray(outlets.id,locationIds)));
    if (places.length !== locationIds.length) throw new Error("Location unavailable.");
    const telephone = value.telephone ? value.telephone : null;
    let workerId:string|null=null;
    if (value.role === "TEAM_MEMBER") {
      const existing = await tx.select().from(workers).where(and(eq(workers.organisationId,scope.organisationId),eq(workers.email,value.email))).for("update");
      if (existing.length) throw new UserFacingError("person-exists", "Someone with this email is already in this business. Resend or revoke their invitation instead.");
      const [worker] = await tx.insert(workers).values({id:randomUUID(),organisationId:scope.organisationId,locationId:locationIds[0],firstName:value.firstName,surname:value.surname,telephone,email:value.email,displayName:`${value.firstName} ${value.surname}`,workerType:"CASUAL"}).returning();
      workerId=worker.id;
      // A casual worker may belong to several locations (Owner decision 10 Nov 2026): the first is theirs.
      if (locationIds.length > 1) await tx.insert(workerLocations).values(locationIds.slice(1).map(outletId => ({id:randomUUID(),organisationId:scope.organisationId,workerId:worker.id,outletId,addedBy:scope.userId})));
    } else {
      const pending = await tx.select({ id: teamInvitations.id }).from(teamInvitations).where(and(eq(teamInvitations.organisationId,scope.organisationId),eq(teamInvitations.email,value.email),eq(teamInvitations.role,"MANAGER"),inArray(teamInvitations.state,["CREATED_NOT_SENT","SENT","DELIVERY_FAILED"]),inArray(teamInvitations.outletId,locationIds)));
      if (pending.length) throw new UserFacingError("person-exists", "This person already has an open invitation for that location. Resend or revoke it instead.");
    }
    const batchId = randomUUID(), expiresAt = new Date(Date.now()+7*86400_000);
    const rows = (value.role === "TEAM_MEMBER" ? locationIds.slice(0, 1) : locationIds).map((outletId, i) => ({id:randomUUID(),workerId,organisationId:scope.organisationId,outletId,email:value.email,role:value.role,token:tokenHash(i === 0 ? token : newToken()),createdBy:scope.userId,expiresAt,
      firstName:value.firstName,surname:value.surname,telephone,batchId}));
    const created = await tx.insert(teamInvitations).values(rows).returning();
    const invitation = created.find(row => row.token === tokenHash(token))!;
    const content = await invitationContent(tx, scope.organisationId, scope.userId, value.role, locationIds, expiresAt, value.firstName);
    const notification=await notify(tx,{id:randomUUID(),organisationId:scope.organisationId,recipientEmail:value.email,eventKey:`invitation:${invitation.id}:${tokenHash(token)}`,kind:value.role === "MANAGER" ? "MANAGER_INVITATION":"TEAM_INVITATION",entityId:invitation.id,title:content.title,body:content.body,href:"/invite"});
    await tx.insert(auditEvents).values({id:randomUUID(),organisationId:scope.organisationId,outletId:locationIds[0],action:"PERSON_INVITED",entityType:"team_invitation",entityId:invitation.id,correlationId:`invitation:${batchId}`,
      metadata:{...auditActor(scope),role:value.role,locationIds,workerId,invitationIds:created.map(row=>row.id)}});
    return {invitation,invitations:created,notificationId:notification!.id,token};
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
    // A Manager invited to several locations at once joins all of them with this one link.
    if (invitation.batchId && invitation.role === "MANAGER") {
      const siblings = await tx.select().from(teamInvitations).where(and(eq(teamInvitations.batchId,invitation.batchId),eq(teamInvitations.organisationId,invitation.organisationId),eq(teamInvitations.email,invitation.email!),inArray(teamInvitations.state,["CREATED_NOT_SENT","SENT","DELIVERY_FAILED"]))).for("update");
      for (const sibling of siblings) {
        const [place] = await tx.select({id:outlets.id}).from(outlets).where(and(eq(outlets.id,sibling.outletId!),eq(outlets.active,true)));
        if (!place) continue;
        await tx.insert(memberships).values({id:randomUUID(),userId,organisationId:invitation.organisationId,outletId:sibling.outletId,workerId:null,role:"MANAGER",invitationId:sibling.id});
        await tx.update(teamInvitations).set({state:"REDEEMED",redeemedBy:userId,redeemedAt:new Date()}).where(eq(teamInvitations.id,sibling.id));
      }
    }
    // Possession of the invitation proves control of the invited mailbox.
    await tx.update(users).set({emailVerifiedAt:user.emailVerifiedAt ?? new Date()}).where(eq(users.id,userId));
    await tx.update(notifications).set({userId}).where(and(eq(notifications.organisationId,invitation.organisationId),eq(notifications.recipientEmail,user.email)));
    return membership;
  });
}
export async function revokeInvitation(db:Database,scope:Scope,id:string) {
  assertRole(scope,["OWNER","MANAGER"]);
 await requireEntitlement(db,scope.organisationId);
  const [row]=await db.select().from(teamInvitations).where(and(eq(teamInvitations.id,id),eq(teamInvitations.organisationId,scope.organisationId),scope.role === "OWNER" ? undefined : eq(teamInvitations.outletId,scope.locationId)));
  if (!row || row.state === "REDEEMED" || (scope.role === "MANAGER" && row.role !== "TEAM_MEMBER")) throw new Error("Invitation unavailable.");
  await db.transaction(async tx => {
    await tx.update(teamInvitations).set({state:"REVOKED"}).where(and(eq(teamInvitations.id,id),eq(teamInvitations.state,row.state)));
    if (row.batchId) await tx.update(teamInvitations).set({state:"REVOKED"}).where(and(eq(teamInvitations.batchId,row.batchId),inArray(teamInvitations.state,["CREATED_NOT_SENT","SENT","DELIVERY_FAILED","EXPIRED"])));
    // A casual worker who never signed up is no longer offered work or listed as available.
    if (row.workerId) await tx.update(workers).set({status:"INACTIVE",updatedAt:new Date()}).where(and(eq(workers.id,row.workerId),isNull(workers.userId)));
    await tx.insert(auditEvents).values({id:randomUUID(),organisationId:scope.organisationId,outletId:row.outletId,action:"INVITATION_REVOKED",entityType:"team_invitation",entityId:id,correlationId:`invitation:${id}:revoked`,metadata:{...auditActor(scope),previousState:row.state,workerId:row.workerId}});
  });
}
export async function resendInvitation(db:Database,scope:Scope,id:string) {
 assertRole(scope,["OWNER","MANAGER"]);
 await requireEntitlement(db,scope.organisationId);
 await consumeLimit(db,`invite-resend:${scope.userId}:${scope.organisationId}`,10);
 const token=newToken();
 return db.transaction(async tx=>{
  const [i]=await tx.select().from(teamInvitations).where(and(eq(teamInvitations.id,id),eq(teamInvitations.organisationId,scope.organisationId),scope.role === "OWNER" ? undefined : eq(teamInvitations.outletId,scope.locationId))).for("update");
  if (!i || !i.email || ["REDEEMED","REVOKED"].includes(i.state) || (scope.role === "MANAGER" && i.role !== "TEAM_MEMBER")) throw new Error("Invitation unavailable.");
  const expiresAt=new Date(Date.now()+7*86400_000);
  await tx.update(teamInvitations).set({token:tokenHash(token),state:"CREATED_NOT_SENT",expiresAt}).where(eq(teamInvitations.id,id));
  const batch=i.batchId ? await tx.select({outletId:teamInvitations.outletId}).from(teamInvitations).where(and(eq(teamInvitations.batchId,i.batchId),inArray(teamInvitations.state,["CREATED_NOT_SENT","SENT","DELIVERY_FAILED","EXPIRED"]))) : [];
  if (i.batchId) await tx.update(teamInvitations).set({expiresAt,state:"CREATED_NOT_SENT"}).where(and(eq(teamInvitations.batchId,i.batchId),eq(teamInvitations.state,"EXPIRED")));
  const content=await invitationContent(tx,scope.organisationId,scope.userId,i.role as "MANAGER"|"TEAM_MEMBER",[...new Set([i.outletId!,...batch.map(row=>row.outletId!)])],expiresAt);
  const n=await notify(tx,{id:randomUUID(),organisationId:scope.organisationId,recipientEmail:i.email,eventKey:`invitation:${id}:${tokenHash(token)}`,kind:i.role === "MANAGER" ? "MANAGER_INVITATION":"TEAM_INVITATION",entityId:id,title:content.title,body:`${content.body}\n\nThis replaces any earlier invitation link.`,href:"/invite"});
  await tx.insert(auditEvents).values({id:randomUUID(),organisationId:scope.organisationId,outletId:i.outletId,action:"INVITATION_RESENT",entityType:"team_invitation",entityId:id,correlationId:`invitation:${id}:${Date.now()}`,metadata:{...auditActor(scope),previousState:i.state}});
  return {token,notificationId:n!.id};
 });
}
