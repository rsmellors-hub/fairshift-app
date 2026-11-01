"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireScope } from "@/server/auth/request";
import { workers } from "@/server/db/schema";
import { getEmailAdapter } from "@/server/notifications/email";
import { dispatchWorkerEmails } from "@/server/notifications/service";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { UserFacingError } from "@/server/domain/errors";
import { LocalTimeError, localDateTimeToInstant } from "@/server/domain/timezone";
import { locationTimezone, rescheduleShift } from "@/server/scheduling/operations";

export type ScheduleChange = { shiftId: string; expectedTermsVersion: number; startsAt: string; endsAt: string; source: "DRAG" | "CHANGE"; acknowledgeReacceptance: boolean };
export type ScheduleResult = { ok: true; changed: boolean } | { ok: false; code: string; message: string };

const TIME_PROBLEM: Record<string, string> = {
  NONEXISTENT: "That time doesn’t exist at this location because the clocks change. Choose another time.",
  AMBIGUOUS: "That time happens twice at this location because the clocks change. Choose another time.",
};

// Times arrive as wall-clock values at the work location, and this reads them in the
// session's location. The result is an answer rather than a redirect, so the timeline can
// put a refused event back where it was and then show the server's current state.
export async function rescheduleShiftAction(change: ScheduleChange): Promise<ScheduleResult> {
  const scope = await requireScope(["OWNER", "MANAGER"]);
  if (!getConfigurationStatus().databaseConfigured) return { ok: false, code: "error", message: "The schedule is unavailable, so nothing was changed." };
  try {
    const timeZone = await locationTimezone(getDatabase(), scope);
    const { startsAt, endsAt, ...rest } = change;
    const result = await rescheduleShift(getDatabase(), scope, { ...rest, startsAt: localDateTimeToInstant(startsAt, timeZone), endsAt: localDateTimeToInstant(endsAt, timeZone) });
    for (const role of ["manager", "worker", "owner"]) revalidatePath(`/${role}`, "layout");
    // Workers who must answer again are told, as with any other change. The shift has moved
    // by now, so a delivery problem is not reported as a failed move; the offer is on their page.
    if (result.changed) {
      try {
        const members = await getDatabase().select({ id: workers.id }).from(workers).where(eq(workers.locationId, scope.locationId));
        for (const member of members) await dispatchWorkerEmails(getDatabase(), getEmailAdapter(), member.id);
      } catch { /* Delivery state stays with the notification record. */ }
    }
    return { ok: true, changed: result.changed };
  } catch (error) {
    if (error instanceof UserFacingError) return { ok: false, code: error.feedback, message: error.message };
    if (error instanceof LocalTimeError) return { ok: false, code: `time-${error.problem.toLowerCase()}`, message: TIME_PROBLEM[error.problem] ?? "That time could not be read, so nothing was changed." };
    return { ok: false, code: "error", message: "The change could not be saved, so nothing was changed." };
  }
}
