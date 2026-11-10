import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { assertRole, type Scope } from "@/server/auth/access";
import type { Database, DatabaseSession } from "@/server/db/client";
import { notifications, users, workerMessages, workers } from "@/server/db/schema";
import { UserFacingError } from "@/server/domain/errors";
import { dispatchWorkerEmails, notify } from "@/server/notifications/service";
import type { EmailAdapter } from "@/server/notifications/email";
import { worksAt } from "@/server/people/worker-locations";

// The worker's Inbox (design, 10 Nov 2026): one record of offers, bookings, cancellations and payments,
// each also emailed, plus a plain-text conversation with the managers of the worker's location.

// One notice to a worker, in the Inbox and by email. A notice is a courtesy: if it can't be written the
// operation it describes still stands, so failures are logged and never thrown.
// Some events already get a short notice from a database trigger (offers, cancellations); with replace,
// that notice, while still unread and unsent, takes the fuller wording instead of a second notice.
export async function noticeToWorker(db: DatabaseSession, input: { workerId: string; kind: string; eventKey: string; entityId: string; title: string; body: string; href: string; replace?: boolean }) {
  try {
    const [person] = await db.select({ id: workers.id, organisationId: workers.organisationId, userId: workers.userId, email: users.email }).from(workers).innerJoin(users, eq(users.id, workers.userId)).where(eq(workers.id, input.workerId));
    if (!person) return null;
    if (input.replace) {
      const [updated] = await db.update(notifications).set({ title: input.title, body: input.body, href: input.href }).where(and(eq(notifications.eventKey, input.eventKey), eq(notifications.workerId, person.id), isNull(notifications.readAt),
        sql`not exists (select 1 from notification_deliveries d where d.notification_id = ${notifications.id} and d.status not in ('PENDING', 'UNCONFIGURED'))`)).returning();
      if (updated) return updated;
    }
    return await notify(db, { id: randomUUID(), organisationId: person.organisationId, userId: person.userId, workerId: person.id, recipientEmail: person.email, eventKey: input.eventKey, kind: input.kind, entityId: input.entityId, title: input.title, body: input.body, href: input.href });
  } catch (error) {
    console.error("A worker notice could not be recorded.", { kind: input.kind, cause: error instanceof Error ? error.name : "unknown" });
    return null;
  }
}

export const QUICK_MESSAGES = ["Running 10 minutes late", "Can I swap this shift?", "Thanks!", "Please call me"] as const;

const thread = (scope: Pick<Scope, "organisationId" | "locationId">, workerId: string) => and(eq(workerMessages.organisationId, scope.organisationId), eq(workerMessages.outletId, scope.locationId), eq(workerMessages.workerId, workerId));

export async function workerInbox(db: DatabaseSession, scope: Scope) {
  assertRole(scope, ["TEAM_MEMBER"]);
  if (!scope.workerId) throw new Error("Access denied.");
  const [notices, messages] = await Promise.all([
    db.select().from(notifications).where(and(eq(notifications.userId, scope.userId), eq(notifications.organisationId, scope.organisationId))).orderBy(desc(notifications.createdAt)).limit(50),
    db.select({ id: workerMessages.id, body: workerMessages.body, fromWorker: workerMessages.fromWorker, readAt: workerMessages.readAt, createdAt: workerMessages.createdAt, author: users.firstName })
      .from(workerMessages).innerJoin(users, eq(users.id, workerMessages.authorUserId)).where(thread(scope, scope.workerId)).orderBy(asc(workerMessages.createdAt)).limit(100),
  ]);
  return { notices, messages };
}

// Unread for the worker: notices not yet read and messages from a manager not yet read.
export async function workerUnread(db: DatabaseSession, scope: Scope) {
  if (scope.role !== "TEAM_MEMBER" || !scope.workerId) return 0;
  const [[a], [b]] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(notifications).where(and(eq(notifications.userId, scope.userId), eq(notifications.organisationId, scope.organisationId), isNull(notifications.readAt))),
    db.select({ n: sql<number>`count(*)::int` }).from(workerMessages).where(and(thread(scope, scope.workerId), eq(workerMessages.fromWorker, false), isNull(workerMessages.readAt))),
  ]);
  return (a?.n ?? 0) + (b?.n ?? 0);
}

// Opening the Inbox marks what the worker can now see as read.
export async function markInboxRead(db: Database, scope: Scope) {
  assertRole(scope, ["TEAM_MEMBER"]);
  if (!scope.workerId) throw new Error("Access denied.");
  const now = new Date();
  await db.update(notifications).set({ readAt: now }).where(and(eq(notifications.userId, scope.userId), eq(notifications.organisationId, scope.organisationId), isNull(notifications.readAt)));
  await db.update(workerMessages).set({ readAt: now }).where(and(thread(scope, scope.workerId), eq(workerMessages.fromWorker, false), isNull(workerMessages.readAt)));
}

const body = (value: string) => {
  const text = value.trim();
  if (!text || text.length > 1000) throw new UserFacingError("message-length", "Write a message of up to 1,000 characters.");
  return text;
};

// A worker writes to their location's managers. Each manager and the Owner gets it in the app and by email.
export async function sendWorkerMessage(db: Database, scope: Scope, text: string) {
  assertRole(scope, ["TEAM_MEMBER"]);
  if (!scope.workerId) throw new Error("Access denied.");
  const value = body(text);
  const [row] = await db.insert(workerMessages).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: scope.locationId, workerId: scope.workerId, authorUserId: scope.userId, fromWorker: true, body: value }).returning();
  return row;
}

// A manager (or the Owner) replies in a worker's thread at the manager's location. The worker is
// notified in the Inbox and by email.
export async function sendManagerMessage(db: Database, scope: Scope, workerId: string, text: string) {
  assertRole(scope, ["OWNER", "MANAGER"]);
  const value = body(text);
  const [worker] = await db.select({ id: workers.id }).from(workers).where(and(eq(workers.id, workerId), eq(workers.organisationId, scope.organisationId)));
  if (!worker) throw new Error("Access denied.");
  const [row] = await db.insert(workerMessages).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: scope.locationId, workerId, authorUserId: scope.userId, fromWorker: false, body: value }).returning();
  return row;
}

// Threads at a location for its managers: the latest message per worker, unread ones first.
export async function locationThreads(db: DatabaseSession, scope: Scope) {
  assertRole(scope, ["OWNER", "MANAGER"]);
  return db.select({ workerId: workerMessages.workerId, name: workers.displayName, last: sql<Date>`max(${workerMessages.createdAt})`, unread: sql<number>`count(*) filter (where ${workerMessages.fromWorker} and ${workerMessages.readAt} is null)::int` })
    .from(workerMessages).innerJoin(workers, eq(workers.id, workerMessages.workerId))
    .where(and(eq(workerMessages.organisationId, scope.organisationId), eq(workerMessages.outletId, scope.locationId))).groupBy(workerMessages.workerId, workers.displayName).orderBy(desc(sql`max(${workerMessages.createdAt})`));
}

// One worker's thread at the manager's location; opening it marks the worker's messages read.
export async function managerThread(db: Database, scope: Scope, workerId: string) {
  assertRole(scope, ["OWNER", "MANAGER"]);
  const [worker] = await db.select({ id: workers.id, name: workers.displayName }).from(workers).where(and(eq(workers.id, workerId), eq(workers.organisationId, scope.organisationId)));
  if (!worker) return null;
  const messages = await db.select({ id: workerMessages.id, body: workerMessages.body, fromWorker: workerMessages.fromWorker, createdAt: workerMessages.createdAt, author: users.firstName })
    .from(workerMessages).innerJoin(users, eq(users.id, workerMessages.authorUserId)).where(thread(scope, workerId)).orderBy(asc(workerMessages.createdAt)).limit(100);
  if (!scope.demo) await db.update(workerMessages).set({ readAt: new Date() }).where(and(thread(scope, workerId), eq(workerMessages.fromWorker, true), isNull(workerMessages.readAt)));
  return { worker, messages };
}

// After an action that wrote notices to several workers at a location (offer rounds), send their emails.
export async function dispatchLocationWorkerEmails(db: Database, adapter: EmailAdapter, scope: Pick<Scope, "organisationId" | "locationId">) {
  const people = await db.select({ id: workers.id }).from(workers).where(and(eq(workers.organisationId, scope.organisationId), worksAt(scope.locationId)));
  for (const person of people) await dispatchWorkerEmails(db, adapter, person.id).catch(() => undefined);
}
