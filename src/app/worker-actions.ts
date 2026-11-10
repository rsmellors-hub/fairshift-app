"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "@/app/revalidate";
import { requireScope } from "@/server/auth/request";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { UserFacingError } from "@/server/domain/errors";
import { getEmailAdapter } from "@/server/notifications/email";
import { dispatchWorkerEmails } from "@/server/notifications/service";
import { sendManagerMessage, sendWorkerMessage, noticeToWorker } from "@/server/worker/inbox";
import { answerPayQuery, raisePayQuery } from "@/server/worker/pay-queries";
import { cancelPayoutChange, confirmPayoutChange } from "@/server/worker/payout-destination";

// Worker app actions (design, 10 Nov 2026, section 6) and the manager's side of the same records.
const field = (form: FormData, name: string) => String(form.get(name) ?? "");
async function perform(target: string, done: string, fn: () => Promise<unknown>) {
  const [path, hash] = target.split("#");
  const anchor = hash ? `#${hash}` : "", join = path.includes("?") ? "&" : "?";
  if (!getConfigurationStatus().databaseConfigured) redirect(`${path}${join}status=error${anchor}`);
  try { await fn(); } catch (error) {
    redirect(`${path}${join}status=${error instanceof UserFacingError ? error.feedback : "error"}${anchor}`);
  }
  for (const role of ["manager", "worker", "owner"]) revalidatePath(`/${role}`, "layout");
  redirect(`${path}${join}status=${done}${anchor}`);
}
// Email follows the in-app record; a failed send leaves the record and is retried by the dispatcher.
const email = async (fn: () => Promise<unknown>) => { try { await fn(); } catch { /* dispatched later */ } };

export async function confirmPayoutEmailAction(form: FormData) {
  if (!getConfigurationStatus().databaseConfigured) redirect("/payout-email/confirm?status=error");
  try { await confirmPayoutChange(getDatabase(), field(form, "token")); } catch { redirect("/payout-email/confirm?status=error"); }
  revalidatePath("/worker", "layout");
  redirect("/payout-email/confirm?status=done");
}

export async function cancelPayoutChangeAction() {
  const scope = await requireScope(["TEAM_MEMBER"]);
  return perform("/worker/profile#payment-settings", "payout-change-cancelled", () => cancelPayoutChange(getDatabase(), scope));
}

export async function sendWorkerMessageAction(form: FormData) {
  const scope = await requireScope(["TEAM_MEMBER"]);
  return perform("/worker/inbox#chat", "message-sent", () => sendWorkerMessage(getDatabase(), scope, field(form, "quick") || field(form, "body")));
}

export async function raisePayQueryAction(form: FormData) {
  const scope = await requireScope(["TEAM_MEMBER"]);
  const payableId = field(form, "payableId");
  return perform(`/worker/pay/${encodeURIComponent(payableId)}#query`, "pay-query-sent", () => raisePayQuery(getDatabase(), scope, { payableId, topic: field(form, "topic"), message: field(form, "message") }));
}

export async function sendManagerMessageAction(form: FormData) {
  const scope = await requireScope(["OWNER", "MANAGER"]);
  const workerId = field(form, "workerId");
  return perform(`/manager/team?thread=${encodeURIComponent(workerId)}#messages`, "message-sent", async () => {
    const db = getDatabase();
    const row = await sendManagerMessage(db, scope, workerId, field(form, "body"));
    await noticeToWorker(db, { workerId, kind: "MANAGER_MESSAGE", eventKey: `message:${row.id}`, entityId: row.id, title: "New message from your manager", body: row.body, href: "/worker/inbox#chat" });
    await email(() => dispatchWorkerEmails(db, getEmailAdapter(), workerId));
  });
}

export async function answerPayQueryAction(form: FormData) {
  const scope = await requireScope(["OWNER"]);
  return perform("/manager/review#pay-queries", "pay-query-answered", async () => {
    const db = getDatabase();
    const row = await answerPayQuery(db, scope, field(form, "queryId"), field(form, "answer"));
    await email(() => dispatchWorkerEmails(db, getEmailAdapter(), row.workerId));
  });
}
