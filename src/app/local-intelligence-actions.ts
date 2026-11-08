"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireScope } from "@/server/auth/request";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { UserFacingError } from "@/server/domain/errors";
import { decideLocalAdjustments, type LocalDecisionAction } from "@/server/intelligence/local-intelligence-service";
import { getWeeklyStaffing } from "@/server/intelligence/staffing";

// A manager's choice whether staffing uses the AI-found adjustments for one day at their own location.
// The form names only the day, the choice and what the manager saw; everything else is read again on
// the server. Closed to the public demo, like every other write.
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
