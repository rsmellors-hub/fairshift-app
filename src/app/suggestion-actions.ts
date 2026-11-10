"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "@/app/revalidate";
import { requireScope } from "@/server/auth/request";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { UserFacingError } from "@/server/domain/errors";
import { getWeeklyStaffing } from "@/server/intelligence/staffing";
import { approveSuggestedShift } from "@/server/scheduling/shift-suggestions";
import { suggestShifts } from "@/server/scheduling/shift-rules";
import { getEmailAdapter } from "@/server/notifications/email";
import { dispatchLocationWorkerEmails } from "@/server/worker/inbox";

const field = (form: FormData, name: string) => String(form.get(name) ?? "");

// One click: the suggested shift is created on the chosen pay terms and the first offer round goes out
// (FS-OFFER-ORDER-DEC-001). The form names only the suggestion; its times and headcount are worked out
// again on the server. Closed to the public demo, like other writes.
export async function approveSuggestedShiftAction(form: FormData) {
  const scope = await requireScope(["OWNER", "MANAGER"]);
  let outcome = "error";
  if (getConfigurationStatus().databaseConfigured) {
    try {
      const db = getDatabase();
      const result = await approveSuggestedShift(db, scope, { key: field(form, "key"), departmentId: field(form, "departmentId"), policyId: field(form, "policyId") },
        async () => (await getWeeklyStaffing(db, scope, new Date())).outlets.find(row => row.outletId === scope.locationId) ?? null);
      outcome = result.round === 1 ? "suggestion-round-1" : "suggestion-round-2";
      // Each offer is in the worker's Inbox; send the emails now (a failure leaves them pending).
      await dispatchLocationWorkerEmails(db, getEmailAdapter(), scope).catch(() => undefined);
    } catch (error) { outcome = error instanceof UserFacingError ? error.feedback : "error"; }
  }
  for (const role of ["manager", "owner", "worker"]) revalidatePath(`/${role}`, "layout");
  redirect(`/manager/fill?status=${outcome}#suggested-shifts`);
}

// Design (OwnerFill, 10 Nov 2026): "Approve all N and send offers". Each suggestion still goes through the
// same server checks and fair offer order as a single approval; any that changed are skipped and counted.
export async function approveAllSuggestedShiftsAction(form: FormData) {
  const scope = await requireScope(["OWNER", "MANAGER"]);
  let outcome = "error", sent = 0;
  if (getConfigurationStatus().databaseConfigured) {
    try {
      const db = getDatabase();
      const read = async () => (await getWeeklyStaffing(db, scope, new Date())).outlets.find(row => row.outletId === scope.locationId) ?? null;
      const outlet = await read();
      const keys = form.getAll("key").map(String).filter(Boolean);
      const wanted = new Set(keys);
      for (const suggestion of outlet ? suggestShifts(outlet).filter(row => wanted.has(row.key)) : []) {
        try { await approveSuggestedShift(db, scope, { key: suggestion.key, departmentId: field(form, "departmentId"), policyId: field(form, "policyId") }, read); sent += 1; }
        catch (error) { if (!(error instanceof UserFacingError)) throw error; }
      }
      outcome = sent ? "suggestions-sent" : "suggestion-approved";
      if (sent) await dispatchLocationWorkerEmails(db, getEmailAdapter(), scope).catch(() => undefined);
    } catch (error) { outcome = error instanceof UserFacingError ? error.feedback : "error"; }
  }
  for (const role of ["manager", "owner", "worker"]) revalidatePath(`/${role}`, "layout");
  redirect(`/manager/fill?status=${outcome}&sent=${sent}#suggested-shifts`);
}
