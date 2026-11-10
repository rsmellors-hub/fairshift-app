import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { assertRole, type Scope } from "@/server/auth/access";
import type { Database, DatabaseSession } from "@/server/db/client";
import { auditEvents, payAgentEvents, payQueries, workPayables, workPayouts, workers } from "@/server/db/schema";
import { UserFacingError } from "@/server/domain/errors";
import { finalPayableMinor } from "@/server/domain/work-payable";
import { payAgentChecklist } from "@/server/pay-agent/presentation";
import { noticeToWorker } from "@/server/worker/inbox";

// "Query this shift's pay" (design, 10 Nov 2026, section 6). A worker asks about one shift's pay; the
// Pay Agent's triage sets out what was already recorded for it (its own checks, the payout's state at
// PayPal Sandbox, the accepted terms) and routes it to the Owner, who answers in the worker's Inbox.
// Triage reads recorded facts only: no model is called, and nothing here can change an amount, a
// recipient or a payout. A query only ever carries text.
export const PAY_QUERY_TOPICS = ["HOURS", "AMOUNT", "TIPS", "NOT_RECEIVED", "OTHER"] as const;
export type PayQueryTopic = typeof PAY_QUERY_TOPICS[number];
export const PAY_QUERY_TOPIC_LABEL: Record<PayQueryTopic, string> = {
  HOURS: "The hours are wrong", AMOUNT: "The amount looks wrong", TIPS: "A question about tips", NOT_RECEIVED: "I haven't received it", OTHER: "Something else",
};

export type PayQueryTriage = { route: "OWNER"; facts: { ok: boolean | null; text: string }[]; payAgent: { status: string; decision: string | null; model: boolean } | null };

const text = (value: string, code: string, what: string) => {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 1000) throw new UserFacingError(code, `Write ${what} of up to 1,000 characters.`);
  return trimmed;
};

// The facts that bear on the worker's topic, from the records as they are now.
export async function triagePayQuery(db: DatabaseSession, payable: typeof workPayables.$inferSelect, topic: PayQueryTopic): Promise<PayQueryTriage> {
  const [[event], [payout]] = await Promise.all([
    db.select().from(payAgentEvents).where(eq(payAgentEvents.payableId, payable.id)).orderBy(desc(payAgentEvents.createdAt)).limit(1),
    db.select({ status: workPayouts.status, paypalStatus: workPayouts.paypalStatus }).from(workPayouts).where(eq(workPayouts.payableId, payable.id)).orderBy(desc(workPayouts.createdAt)).limit(1),
  ]);
  const checks = event ? payAgentChecklist(event) : [];
  const facts: PayQueryTriage["facts"] = [];
  const check = (prefix: string) => checks.find(item => item.text.startsWith(prefix));
  if (topic === "HOURS") {
    const hours = check("Hours");
    facts.push(hours ? { ok: hours.ok, text: `Pay Agent: ${hours.text}` } : { ok: null, text: "The Pay Agent hasn't checked the hours for this shift yet." });
  }
  if (topic === "AMOUNT" || topic === "HOURS") facts.push({ ok: null, text: `Pay comes from the terms the worker accepted (version ${payable.termsVersion}); nobody can edit it.` });
  if (topic === "TIPS") facts.push({ ok: null, text: "Tips follow the location's tip policy and aren't part of the shift's terms." });
  if (topic === "NOT_RECEIVED" || topic === "AMOUNT") facts.push(
    payout?.status === "PAID" ? { ok: true, text: "PayPal Sandbox reported this payout SUCCESS." }
      : payout?.status === "PROCESSING" ? { ok: null, text: payout.paypalStatus === "UNCLAIMED" ? "With PayPal Sandbox, unclaimed: the worker needs to claim it with the saved PayPal email." : "With PayPal Sandbox; not confirmed paid yet." }
      : payout?.status === "FAILED" ? { ok: false, text: "PayPal Sandbox didn't complete this payout." }
      : payout ? { ok: null, text: "The payout is being checked with PayPal Sandbox." }
      : { ok: null, text: payable.status === "APPROVED" ? "Approved but not sent to PayPal yet." : "Not approved yet, so nothing has been sent." });
  for (const item of checks) if (!item.ok && !facts.some(fact => fact.text.endsWith(item.text))) facts.push({ ok: false, text: `Pay Agent: ${item.text}` });
  return { route: "OWNER", facts, payAgent: event ? { status: event.status, decision: event.decision, model: !!event.responseId } : null };
}

// A worker's question about their own shift's pay. One open question per shift.
export async function raisePayQuery(db: Database, scope: Scope, input: { payableId: string; topic: string; message: string }) {
  assertRole(scope, ["TEAM_MEMBER"]);
  if (!scope.workerId) throw new Error("Access denied.");
  const topic = PAY_QUERY_TOPICS.find(value => value === input.topic);
  if (!topic) throw new UserFacingError("pay-query-topic", "Choose what your question is about.");
  const message = text(input.message, "pay-query-message", "your question");
  const [payable] = await db.select().from(workPayables).where(and(eq(workPayables.id, input.payableId), eq(workPayables.workerId, scope.workerId), eq(workPayables.organisationId, scope.organisationId)));
  if (!payable) throw new UserFacingError("pay-query-unavailable", "That shift's pay isn't available.");
  const triage = await triagePayQuery(db, payable, topic);
  return db.transaction(async tx => {
    const [row] = await tx.insert(payQueries).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: payable.outletId, workerId: scope.workerId!, payableId: payable.id, topic, message, triage }).onConflictDoNothing().returning();
    if (!row) throw new UserFacingError("pay-query-open", "You've already asked about this shift. You'll get the answer in your Inbox.");
    await tx.insert(auditEvents).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: payable.outletId, action: "PAY_QUERY_RAISED", entityType: "pay_query", entityId: row.id, correlationId: `payable:${payable.id}`, metadata: { topic, workerId: scope.workerId, actorUserId: scope.userId } });
    return row;
  });
}

export async function payQueriesForPayable(db: DatabaseSession, scope: Scope, payableId: string) {
  assertRole(scope, ["TEAM_MEMBER"]);
  return db.select().from(payQueries).where(and(eq(payQueries.payableId, payableId), eq(payQueries.workerId, scope.workerId!), eq(payQueries.organisationId, scope.organisationId))).orderBy(desc(payQueries.createdAt));
}

// Open questions at the Owner's selected location, for Pay · Needs you.
export async function openPayQueries(db: DatabaseSession, scope: Scope) {
  assertRole(scope, ["OWNER", "MANAGER"]);
  return db.select({ query: payQueries, workerName: workers.displayName, amountMinor: workPayables.baseAmountMinor, payable: workPayables }).from(payQueries)
    .innerJoin(workers, eq(workers.id, payQueries.workerId)).innerJoin(workPayables, eq(workPayables.id, payQueries.payableId))
    .where(and(eq(payQueries.organisationId, scope.organisationId), eq(payQueries.outletId, scope.locationId), eq(payQueries.status, "OPEN"))).orderBy(payQueries.createdAt)
    .then(rows => rows.map(row => ({ ...row, totalMinor: finalPayableMinor(row.payable) })));
}

// The Owner answers. The answer goes to the worker's Inbox and by email; nothing else changes.
export async function answerPayQuery(db: Database, scope: Scope, queryId: string, answer: string) {
  assertRole(scope, ["OWNER"]);
  const value = text(answer, "pay-query-answer", "an answer");
  const now = new Date();
  const row = await db.transaction(async tx => {
    const [updated] = await tx.update(payQueries).set({ status: "ANSWERED", answer: value, answeredBy: scope.userId, answeredAt: now })
      .where(and(eq(payQueries.id, queryId), eq(payQueries.organisationId, scope.organisationId), eq(payQueries.status, "OPEN"))).returning();
    if (!updated) throw new UserFacingError("pay-query-unavailable", "This question has already been answered or isn't available.");
    await tx.insert(auditEvents).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: updated.outletId, action: "PAY_QUERY_ANSWERED", entityType: "pay_query", entityId: updated.id, correlationId: `payable:${updated.payableId}`, metadata: { actorUserId: scope.userId, actorRole: scope.role } });
    return updated;
  });
  await noticeToWorker(db, { workerId: row.workerId, kind: "PAY_QUERY_ANSWERED", eventKey: `pay-query-answered:${row.id}`, entityId: row.payableId, title: "Your pay question was answered", body: value, href: `/worker/pay/${row.payableId}` });
  return row;
}
