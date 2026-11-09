"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireScope } from "@/server/auth/request";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { UserFacingError } from "@/server/domain/errors";
import { decideLocalAdjustments, decideSignal, type LocalDecisionAction, type SignalDecisionAction } from "@/server/intelligence/local-intelligence-service";
import { sendEarlyNotice } from "@/server/intelligence/early-notice";
import { getEmailAdapter } from "@/server/notifications/email";
import { dispatchWorkerEmails } from "@/server/notifications/service";
import { getWeeklyStaffing } from "@/server/intelligence/staffing";

// A manager's choice whether staffing uses the AI-found adjustments for one day at their own location.
// The form names only the day, the choice and what the manager saw; everything else is read again on
// the server. Closed to the public demo, like other writes (the DEMO early notice below is the exception).
const field = (form: FormData, name: string) => String(form.get(name) ?? "");

export async function decideLocalAdjustmentsAction(form: FormData) {
  const scope = await requireScope(["OWNER", "MANAGER"]);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(field(form, "date")) ? field(form, "date") : null;
  const action = field(form, "decision") as LocalDecisionAction;
  let outcome = "error";
  if (getConfigurationStatus().databaseConfigured && date) {
    try {
      const db = getDatabase();
      await decideLocalAdjustments(db, scope, { date, action, fingerprint: field(form, "fingerprint") || undefined }, async target => {
        const outlet = (await getWeeklyStaffing(db, scope, new Date())).outlets.find(row => row.outletId === scope.locationId);
        return { day: outlet?.localIntelligence?.days.find(row => row.date === target) ?? null, scenarioAccepted: !!outlet?.demandContext?.accepted.has(target) };
      });
      outcome = action === "ACCEPTED" ? "local-accepted" : "local-withdrawn";
    } catch (error) { outcome = error instanceof UserFacingError ? error.feedback : "error"; }
  }
  for (const role of ["manager", "owner"]) revalidatePath(`/${role}`, "layout");
  redirect(`/manager/plan?${date ? `date=${date}&` : ""}local=${outcome}#local-intelligence`);
}

// Accepting one AI-found demand signal: staffing uses the current adjustments on every day it changes,
// each checked against what the person saw (date:fingerprint pairs from the card). The adjustments on a
// day can include another applied signal; the card names them. Dismissing sets one signal aside.
const back = (form: FormData) => field(form, "next") === "/owner/forecast" ? "/owner/forecast" : "/manager/plan";
export async function acceptSignalAction(form: FormData) {
  const scope = await requireScope(["OWNER", "MANAGER"]);
  const seen = field(form, "seen").split(",").map(pair => pair.split(":")).filter(([date, fp]) => /^\d{4}-\d{2}-\d{2}$/.test(date ?? "") && /^[0-9a-f]{64}$/.test(fp ?? ""));
  let outcome = "error";
  if (getConfigurationStatus().databaseConfigured && seen.length) {
    try {
      const db = getDatabase();
      const outlet = (await getWeeklyStaffing(db, scope, new Date())).outlets.find(row => row.outletId === scope.locationId);
      for (const [date, fingerprint] of seen) await decideLocalAdjustments(db, scope, { date, action: "ACCEPTED", fingerprint }, async target => ({ day: outlet?.localIntelligence?.days.find(row => row.date === target) ?? null, scenarioAccepted: !!outlet?.demandContext?.accepted.has(target) }));
      outcome = "local-accepted";
    } catch (error) { outcome = error instanceof UserFacingError ? error.feedback : "error"; }
  }
  for (const role of ["manager", "owner"]) revalidatePath(`/${role}`, "layout");
  redirect(`${back(form)}?local=${outcome}#ai-signals`);
}

export async function decideSignalAction(form: FormData) {
  const scope = await requireScope(["OWNER", "MANAGER"]);
  const action = field(form, "decision") as SignalDecisionAction;
  let outcome = "error";
  if (getConfigurationStatus().databaseConfigured) {
    try {
      const db = getDatabase();
      await decideSignal(db, scope, { signalKey: field(form, "signalKey"), action }, async key => (await getWeeklyStaffing(db, scope, new Date())).outlets.find(row => row.outletId === scope.locationId)?.localIntelligence?.signals.find(row => row.key === key) ?? null);
      outcome = action === "DISMISSED" ? "local-dismissed" : "local-restored";
    } catch (error) { outcome = error instanceof UserFacingError ? error.feedback : "error"; }
  }
  for (const role of ["manager", "owner"]) revalidatePath(`/${role}`, "layout");
  redirect(`${back(form)}?local=${outcome}#ai-signals`);
}

// The Owner's confirmation of an early shift notice for a likely closure. Nothing is sent without it,
// and the server works out again whether the alert is current and who it affects. The public demo's
// Owner persona may send only the DEMO scenario's notice, to synthetic workers, never by email
// (sendEarlyNotice enforces this).
export async function sendEarlyNoticeAction(form: FormData) {
  const scope = await requireScope(["OWNER"], { demoWrite: true });
  let status = "error";
  if (getConfigurationStatus().databaseConfigured && field(form, "confirmed") === "yes") {
    try {
      const db = getDatabase();
      const result = await sendEarlyNotice(db, scope, { outletId: field(form, "outletId"), signalKey: field(form, "signalKey") }, async (outletId, signalKey) => {
        const outlet = (await getWeeklyStaffing(db, scope, new Date())).outlets.find(row => row.outletId === outletId);
        const signal = outlet?.localIntelligence?.alerts.find(row => row.key === signalKey);
        return outlet && signal ? { signal, outletId, outletName: outlet.outletName, timezone: outlet.timezone } : null;
      });
      // Email follows the in-app notice where email is set up; the notice stands either way. A public
      // demo notice stays in the app.
      if (!scope.demo) for (const workerId of result.workerIds) await dispatchWorkerEmails(db, getEmailAdapter(), workerId).catch(() => undefined);
      status = "early-notice-sent";
    } catch (error) { status = error instanceof UserFacingError ? error.feedback : "error"; }
  }
  for (const role of ["owner", "worker"]) revalidatePath(`/${role}`, "layout");
  redirect(`/owner?status=${status}#disruption-alerts`);
}
