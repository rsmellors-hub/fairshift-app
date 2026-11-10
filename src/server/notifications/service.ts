import { brandedHtml, invitationHtml } from "@/server/notifications/templates";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, notInArray } from "drizzle-orm";
import type { Database, DatabaseSession } from "@/server/db/client";
import { notifications, notificationDeliveries, teamInvitations } from "@/server/db/schema";
import { demoConfig } from "@/server/demo/config";
import { applicationOrigin, type EmailAdapter } from "./email";
export async function notify(db:DatabaseSession,input: typeof notifications.$inferInsert) {
  const [notification] = await db.insert(notifications).values(input).onConflictDoNothing({target:notifications.eventKey}).returning();
  if (notification) await db.insert(notificationDeliveries).values({id:randomUUID(),notificationId:notification.id,destination:notification.recipientEmail}).onConflictDoNothing();
  return notification;
}
export async function listNotifications(db:DatabaseSession,userId:string) {
  return db.select().from(notifications).where(eq(notifications.userId,userId)).orderBy(desc(notifications.createdAt)).limit(50);
}
export async function markNotificationRead(db:DatabaseSession,userId:string,id:string,read=true) {
  const [row] = await db.update(notifications).set({readAt:read ? new Date() : null}).where(and(eq(notifications.id,id),eq(notifications.userId,userId))).returning();
  if (!row) throw new Error("Notification unavailable.");
  return row;
}
// Persist before dispatch. Only provider acknowledgement means accepted; never claims delivery.
// The design's invitation layout for invitations; FairShift's standard layout for everything else.
async function htmlFor(db:Database,n:typeof notifications.$inferSelect,link:string) {
  if (["MANAGER_INVITATION","TEAM_INVITATION"].includes(n.kind) && n.entityId) {
    const { invitationEmailFor } = await import("@/server/auth/tenancy");
    const email = await invitationEmailFor(db,n.entityId);
    if (email) return invitationHtml(email,link);
  }
  return brandedHtml({heading:n.title,text:n.body,link,action:"Open FairShift"});
}
export async function dispatchNotification(db:Database,adapter:EmailAdapter,id:string,secureHref?:string) {
  const [row] = await db.select({notification:notifications,delivery:notificationDeliveries}).from(notifications).innerJoin(notificationDeliveries,eq(notificationDeliveries.notificationId,notifications.id)).where(eq(notifications.id,id));
  if (!row) return;
  const {notification:n,delivery:d} = row;
  // The public demo's activity never becomes email.
  if (n.organisationId && n.organisationId === demoConfig()?.organisationId) return;
  if (!secureHref && ["MANAGER_INVITATION","TEAM_INVITATION","VERIFY_EMAIL","RESET_PASSWORD"].includes(n.kind)) return;
  const [claimed] = await db.update(notificationDeliveries).set({status:"SENDING",attemptedAt:new Date(),failureCode:null})
    .where(and(eq(notificationDeliveries.id,d.id),inArray(notificationDeliveries.status,["PENDING","UNCONFIGURED","FAILED"]))).returning();
  if (!claimed) return;
  let result:Awaited<ReturnType<EmailAdapter["send"]>>;
  // Invitations use their own subject ("<Business> invited you to FairShift"); every email has a
  // plain-text and a branded HTML version of the same words.
  const invitation=["MANAGER_INVITATION","TEAM_INVITATION"].includes(n.kind), link=`${applicationOrigin()}${secureHref ?? n.href}`;
  try {result = await adapter.send({to:d.destination,subject:invitation ? n.title : `FairShift · ${n.title}`,text:`${n.body}\n\n${link}\n\nFairShift`,
    html:await htmlFor(db,n,link),idempotencyKey:`notification/${n.id}`});}
  catch {
    await db.update(notificationDeliveries).set({status:"UNKNOWN",failureCode:"EMAIL_UNCONFIRMED"}).where(eq(notificationDeliveries.id,d.id));
    if (["MANAGER_INVITATION","TEAM_INVITATION"].includes(n.kind)) await db.update(teamInvitations).set({state:"DELIVERY_FAILED"}).where(and(eq(teamInvitations.id,n.entityId),eq(teamInvitations.state,"CREATED_NOT_SENT"),eq(teamInvitations.token,n.eventKey.split(":").at(-1)!)));
    return;
  }
  await db.transaction(async tx => {
    await tx.update(notificationDeliveries).set({status:result.status,providerMessageId:result.status === "ACCEPTED" ? result.messageId : null,acceptedAt:result.status === "ACCEPTED" ? new Date() : null}).where(eq(notificationDeliveries.id,d.id));
    if (result.status === "ACCEPTED" && ["MANAGER_INVITATION","TEAM_INVITATION"].includes(n.kind)) await tx.update(teamInvitations).set({state:"SENT"}).where(and(eq(teamInvitations.id,n.entityId),eq(teamInvitations.state,"CREATED_NOT_SENT"),eq(teamInvitations.token,n.eventKey.split(":").at(-1)!)));
  });
}
export async function dispatchOperationalEmails(db:Database,adapter:EmailAdapter,userId:string) {
  const rows = await db.select({id:notifications.id}).from(notifications).innerJoin(notificationDeliveries,eq(notificationDeliveries.notificationId,notifications.id))
    .where(and(eq(notifications.userId,userId),inArray(notificationDeliveries.status,["PENDING","UNCONFIGURED"])));
  for (const row of rows) await dispatchNotification(db,adapter,row.id);
}

export async function dispatchWorkerEmails(db:Database,adapter:EmailAdapter,workerId:string) {
 const rows=await db.select({id:notifications.id}).from(notifications).innerJoin(notificationDeliveries,eq(notificationDeliveries.notificationId,notifications.id)).where(and(eq(notifications.workerId,workerId),inArray(notificationDeliveries.status,["PENDING","UNCONFIGURED"])));
 for (const row of rows) await dispatchNotification(db,adapter,row.id);
}
export async function dispatchPendingEmails(db:Database,adapter:EmailAdapter) {
 const rows=await db.select({id:notifications.id}).from(notifications).innerJoin(notificationDeliveries,eq(notificationDeliveries.notificationId,notifications.id)).where(and(inArray(notificationDeliveries.status,["PENDING","UNCONFIGURED"]),notInArray(notifications.kind,["MANAGER_INVITATION","TEAM_INVITATION","VERIFY_EMAIL","RESET_PASSWORD"]))).limit(100);
 for (const row of rows) await dispatchNotification(db,adapter,row.id);
}
