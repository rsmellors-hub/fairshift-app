import { personal, business, entitled } from "../helpers/onboarding";
import { randomUUID } from "node:crypto";
import { and,eq } from "drizzle-orm";
import { describe,expect,it } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { registerIdentity, createIdentityToken, redeemIdentityToken, signIn, resolveSession, revokeSession, tokenHash } from "@/server/auth/identity";
import { createOrganisation, inviteMember, redeemInvitation, revokeInvitation, resendInvitation } from "@/server/auth/tenancy";
import { resolveScope } from "@/server/auth/access";
import { workerWorkspace,workerRespond,savePayoutDestination } from "@/server/auth/operations";
import { users,memberships,workers,teamInvitations,notifications,notificationDeliveries,identityTokens,shifts,outlets } from "@/server/db/schema";
import { createDepartment,createWorkPolicy,createRequirement,offerAssignment,allocateAssignment,changeAssignment,confirmWork,getOperations } from "@/server/scheduling/operations";
import { dispatchNotification,listNotifications,markNotificationRead } from "@/server/notifications/service";
import { ResendEmail } from "@/server/notifications/email";

type DB=Awaited<ReturnType<typeof createTestDatabase>>["db"];
const password="a-long-test-password-42";
async function identity(db:DB,email:string,verify=true) {
 const user=await registerIdentity(db,{email,...personal,password});
 if (verify) await redeemIdentityToken(db,await createIdentityToken(db,user.id,"VERIFY_EMAIL"),"VERIFY_EMAIL");
 return user;
}
async function owner(db:DB,email="owner@example.test") {
 const user=await identity(db,email);
 const org=await createOrganisation(db,user.id,{...business,name:`Company ${email}`,locationName:"Main location"});
 await entitled(db,org.organisationId);
 return {user,...org,scope:await resolveScope(db,user.id,org.membershipId)};
}
const invitation=(email:string,role:"MANAGER"|"TEAM_MEMBER"="TEAM_MEMBER")=>({email,role,firstName:"Sam",surname:"Taylor",telephone:"+27111234567"});
async function join(db:DB,scope:Awaited<ReturnType<typeof owner>>["scope"],email:string,role:"MANAGER"|"TEAM_MEMBER"="TEAM_MEMBER") {
 const invite=await inviteMember(db,scope,invitation(email,role)),user=await identity(db,email,false);
 const m=await redeemInvitation(db,user.id,{token:invite.token});
 return {user,invite,m,scope:await resolveScope(db,user.id,m.id)};
}
async function requirement(db:DB,scope:Awaited<ReturnType<typeof owner>>["scope"]) {
 const [d]=await createDepartment(db,"Sales",scope),[p]=await createWorkPolicy(db,{earningsModel:"DAILY",rateMinor:15000},"Daily",scope);
 return createRequirement(db,{departmentId:d.id,policyId:p.id,startsAt:new Date("2026-01-10T08:00:00Z"),endsAt:new Date("2026-01-10T14:00:00Z"),requiredHeadcount:2},scope);
}
describe("authenticated Owner-originated tenancy",()=>{
 it("registers identity without authority, verifies mailbox, bootstraps organisation and manages hashed sessions",async()=>{
  const t=await createTestDatabase();try {
   await expect(registerIdentity(t.db,{email:"bad@example.test",...personal,password,role:"OWNER"})).rejects.toThrow();
   const u=await identity(t.db,"new@example.test",false);
   expect(await t.db.select().from(memberships)).toHaveLength(0);
   await expect(createOrganisation(t.db,u.id,{...business,name:"Co",locationName:"HQ"})).rejects.toThrow(/Verify/);
   const token=await createIdentityToken(t.db,u.id,"VERIFY_EMAIL");
   expect((await t.db.select().from(identityTokens))[0].tokenHash).not.toBe(token);
   await redeemIdentityToken(t.db,token,"VERIFY_EMAIL");
   await expect(redeemIdentityToken(t.db,token,"VERIFY_EMAIL")).rejects.toThrow();
   const org=await createOrganisation(t.db,u.id,{...business,name:"Co",locationName:"HQ"});
   expect(await resolveScope(t.db,u.id,org.membershipId)).toMatchObject({role:"OWNER",organisationId:org.organisationId});
   const session=await signIn(t.db,u.email,password);
   expect((await resolveSession(t.db,session))?.user.id).toBe(u.id);
   await revokeSession(t.db,session);expect(await resolveSession(t.db,session)).toBeNull();
   await expect(signIn(t.db,u.email,"incorrect")).rejects.toThrow();
   const before=await signIn(t.db,u.email,password),reset=await createIdentityToken(t.db,u.id,"RESET_PASSWORD");
   await redeemIdentityToken(t.db,reset,"RESET_PASSWORD","another-long-password-42");
   expect(await resolveSession(t.db,before)).toBeNull();
   await expect(signIn(t.db,u.email,password)).rejects.toThrow();
   expect(await signIn(t.db,u.email,"another-long-password-42")).toHaveLength(43);
  }finally{await t.close();}
 });
 it("derives Manager and Team authority from fixed invitations, with mailbox and replay protection",async()=>{
  const t=await createTestDatabase();try {
   const o=await owner(t.db),manager=await join(t.db,o.scope,"manager@example.test","MANAGER"),team=await join(t.db,o.scope,"worker@example.test");
   expect(manager.scope.role).toBe("MANAGER");expect(team.scope.role).toBe("TEAM_MEMBER");
   expect(team.scope.workerId).toBeTruthy();
   const [w]=await t.db.select().from(workers).where(eq(workers.id,team.scope.workerId!));
   expect(w.userId).toBe(team.user.id);expect(w.attributionCode).toMatch(/^FS-/);
   expect((await t.db.select().from(teamInvitations).where(eq(teamInvitations.id,manager.invite.invitation.id)))[0].state).toBe("REDEEMED");
   expect(manager.invite.invitation.token).toBe(tokenHash(manager.invite.token));
   await expect(redeemInvitation(t.db,manager.user.id,{token:manager.invite.token})).rejects.toThrow();
   const fresh=await inviteMember(t.db,o.scope,invitation("different@example.test","MANAGER"));
   await expect(redeemInvitation(t.db,team.user.id,{token:fresh.token})).rejects.toThrow(/email/);
   await expect(redeemInvitation(t.db,team.user.id,{token:fresh.token,role:"OWNER"})).rejects.toThrow();
   await expect(resolveScope(t.db,team.user.id,manager.m.id)).rejects.toThrow(/denied/);
   await expect(resolveScope(t.db,team.user.id,team.m.id,undefined,["OWNER","MANAGER"])).rejects.toThrow(/denied/);
   await expect(inviteMember(t.db,team.scope,invitation("evil@example.test","MANAGER"))).rejects.toThrow(/denied/);
   await expect(inviteMember(t.db,manager.scope,invitation("evil@example.test","MANAGER"))).rejects.toThrow(/denied/);
   // Even raw relational writes cannot relabel an invitation-derived membership.
   await expect(t.db.update(memberships).set({role:"MANAGER",workerId:null}).where(eq(memberships.id,team.m.id))).rejects.toThrow();
  }finally{await t.close();}
 });
 it("permits scoped Manager invitations and rejects another location/organisation",async()=>{
  const t=await createTestDatabase();try {
   const a=await owner(t.db),b=await owner(t.db,"other@example.test"),m=await join(t.db,a.scope,"manager@example.test","MANAGER");
   const team=await join(t.db,m.scope,"team@example.test");expect(team.scope.organisationId).toBe(a.organisationId);
   const another=randomUUID();await t.db.insert(outlets).values({id:another,organisationId:a.organisationId,name:"Other location",timezone:"Africa/Johannesburg"});
   await expect(resolveScope(t.db,m.user.id,m.m.id,another)).rejects.toThrow(/denied/);
   await expect(inviteMember(t.db,{...m.scope,locationId:another},invitation("blocked@example.test"))).rejects.toThrow(/denied/);
   await expect(inviteMember(t.db,{...m.scope,organisationId:b.organisationId,locationId:b.locationId},invitation("blocked@example.test"))).rejects.toThrow(/denied/);
   await expect(resolveScope(t.db,m.user.id,b.membershipId)).rejects.toThrow(/denied/);
   expect((await getOperations(t.db,m.scope)).team).toHaveLength(1);
  }finally{await t.close();}
 });
 it("marks invitations sent only after provider acknowledgement and does not dispatch duplicates",async()=>{
  const t=await createTestDatabase();try {
   const o=await owner(t.db),i=await inviteMember(t.db,o.scope,invitation("mail@example.test","MANAGER"));
   let calls=0;
   const adapter={send:async()=>{calls++;return {status:"ACCEPTED" as const,messageId:"provider-message"};}};
   await dispatchNotification(t.db,adapter,i.notificationId,`/invite#${i.token}`);
   await dispatchNotification(t.db,adapter,i.notificationId,`/invite#${i.token}`);
   expect(calls).toBe(1);
   expect((await t.db.select().from(teamInvitations).where(eq(teamInvitations.id,i.invitation.id)))[0].state).toBe("SENT");
   expect((await t.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.notificationId,i.notificationId)))[0]).toMatchObject({status:"ACCEPTED",providerMessageId:"provider-message",deliveredAt:null});
  }finally{await t.close();}
 });
 it("rejects expired/revoked tokens and invalidates earlier tokens when resent",async()=>{
  const t=await createTestDatabase();try {
   const o=await owner(t.db),u=await identity(t.db,"invite@example.test",false),i=await inviteMember(t.db,o.scope,invitation(u.email));
   await t.db.update(teamInvitations).set({expiresAt:new Date(0)}).where(eq(teamInvitations.id,i.invitation.id));
   await expect(redeemInvitation(t.db,u.id,{token:i.token})).rejects.toThrow();
   const resent=await resendInvitation(t.db,o.scope,i.invitation.id);
   await expect(redeemInvitation(t.db,u.id,{token:i.token})).rejects.toThrow();
   await revokeInvitation(t.db,o.scope,i.invitation.id);
   await expect(redeemInvitation(t.db,u.id,{token:resent.token})).rejects.toThrow();
   expect(await t.db.select().from(memberships).where(eq(memberships.userId,u.id))).toHaveLength(0);
  }finally{await t.close();}
 });
 it("isolates worker reads/mutations and assignment IDs while preserving exact acceptance/allocation",async()=>{
  const t=await createTestDatabase();try {
   const o=await owner(t.db),a=await join(t.db,o.scope,"a@example.test"),b=await join(t.db,o.scope,"b@example.test"),foreign=await owner(t.db,"foreign@example.test");
   const shift=await requirement(t.db,o.scope),oa=await offerAssignment(t.db,shift.id,a.scope.workerId!,o.scope),ob=await offerAssignment(t.db,shift.id,b.scope.workerId!,o.scope);
   expect((await workerWorkspace(t.db,a.scope)).assignments.map(r=>r.offer.id)).toEqual([oa.id]);
   await expect(workerRespond(t.db,a.scope,ob.id,1,"ACCEPTED",true)).rejects.toThrow(/unavailable/);
   await expect(workerRespond(t.db,a.scope,oa.id,1,"ACCEPTED",false)).rejects.toThrow(/acknowledge/);
   await workerRespond(t.db,a.scope,oa.id,1,"ACCEPTED",true);await allocateAssignment(t.db,oa.id,o.scope);
   await expect(offerAssignment(t.db,shift.id,a.scope.workerId!,foreign.scope)).rejects.toThrow();
   await savePayoutDestination(t.db,a.scope,"mine@example.test");
   expect((await workerWorkspace(t.db,b.scope)).profile?.paypalPayoutEmail).toBeNull();
   await changeAssignment(t.db,o.scope,shift.id,{startsAt:new Date("2026-01-11T08:00:00Z"),endsAt:new Date("2026-01-11T14:00:00Z")});
   await expect(workerRespond(t.db,a.scope,oa.id,1,"ACCEPTED",true)).rejects.toThrow(/changed/);
   await workerRespond(t.db,a.scope,oa.id,2,"ACCEPTED",true);await allocateAssignment(t.db,oa.id,o.scope);await confirmWork(t.db,oa.id,o.scope);
   await expect(changeAssignment(t.db,o.scope,shift.id,{cancel:true})).rejects.toThrow(/Reviewed/);
   expect((await workerWorkspace(t.db,a.scope)).profile?.paypalPayoutEmail).toBe("mine@example.test");
  }finally{await t.close();}
 });
 it("persists actionable events independently of failed/unconfigured emails and isolates notification reads",async()=>{
  const t=await createTestDatabase();try {
   const o=await owner(t.db),a=await join(t.db,o.scope,"a@example.test"),b=await join(t.db,o.scope,"b@example.test");
   const invitationNotice=(await t.db.select().from(notifications).where(eq(notifications.id,a.invite.notificationId)))[0];
   expect(invitationNotice.userId).toBe(a.user.id);
   await dispatchNotification(t.db,new ResendEmail(),invitationNotice.id,`/invite#${a.invite.token}`);
   expect((await t.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.notificationId,invitationNotice.id)))[0].status).toBe("UNCONFIGURED");
   await dispatchNotification(t.db,{send:async()=>{throw new Error("offline");}},invitationNotice.id,"/invite#code");
   expect((await t.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.notificationId,invitationNotice.id)))[0].status).toBe("UNKNOWN");
   expect((await listNotifications(t.db,a.user.id)).some(n=>n.id===invitationNotice.id)).toBe(true);
   await expect(markNotificationRead(t.db,b.user.id,invitationNotice.id)).rejects.toThrow();
   expect((await markNotificationRead(t.db,a.user.id,invitationNotice.id)).readAt).toBeInstanceOf(Date);
   expect((await markNotificationRead(t.db,a.user.id,invitationNotice.id,false)).readAt).toBeNull();
   const shift=await requirement(t.db,o.scope);await offerAssignment(t.db,shift.id,a.scope.workerId!,o.scope);
   let notices=await listNotifications(t.db,a.user.id);expect(notices.filter(n=>n.kind === "SHIFT_OFFER")).toHaveLength(1);
   await changeAssignment(t.db,o.scope,shift.id,{startsAt:new Date("2026-01-11T08:00:00Z"),endsAt:new Date("2026-01-11T14:00:00Z")});
   await t.db.update(shifts).set({updatedAt:new Date()}).where(eq(shifts.id,shift.id));
   notices=await listNotifications(t.db,a.user.id);expect(notices.filter(n=>n.kind === "SHIFT_CHANGED")).toHaveLength(1);
   await changeAssignment(t.db,o.scope,shift.id,{cancel:true});
   expect((await listNotifications(t.db,a.user.id)).filter(n=>n.kind === "SHIFT_CANCELLED")).toHaveLength(1);
   expect((await listNotifications(t.db,b.user.id)).some(n=>n.kind === "SHIFT_OFFER")).toBe(false);
   expect(await t.db.select().from(users).where(and(eq(users.id,a.user.id),eq(users.email,a.user.email)))).toHaveLength(1);
  }finally{await t.close();}
 });
});
