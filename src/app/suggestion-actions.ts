"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireScope } from "@/server/auth/request";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { UserFacingError } from "@/server/domain/errors";
import { getWeeklyStaffing } from "@/server/intelligence/staffing";
import { approveSuggestedShift } from "@/server/scheduling/shift-suggestions";

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
    } catch (error) { outcome = error instanceof UserFacingError ? error.feedback : "error"; }
  }
  for (const role of ["manager", "owner", "worker"]) revalidatePath(`/${role}`, "layout");
  redirect(`/manager/plan?status=${outcome}#suggested-shifts`);
}
