"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireScope } from "@/server/auth/request";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { UserFacingError } from "@/server/domain/errors";
import { getStaffingAssessmentProvider } from "@/server/integrations/openai/staffing-assessment";
import { addManagerSignal, addStructuredSignal, decideDemandContext, proposeDemandContext, refreshContextFeeds, withdrawManagerSignal, type ContextAction } from "@/server/intelligence/demand-context-service";
import { STRUCTURED_SIGNAL_KINDS, type StructuredSignalKind } from "@/server/intelligence/manager-signals";

// Every action works on the session's own location: no field selects one. Rendering a page never
// calls the model. These stay closed to the public demo, which never reaches a provider.
const field = (form: FormData, name: string) => String(form.get(name) ?? "");
const dateOf = (form: FormData) => { const value = field(form, "date"); return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null; };

function finish(date: string | null, outcome: string): never {
  for (const role of ["manager", "owner"]) revalidatePath(`/${role}`, "layout");
  redirect(`/manager/plan?${date ? `date=${date}&` : ""}context=${outcome}#demand-context`);
}
async function run(date: string | null, fn: () => Promise<string>): Promise<never> {
  let outcome = "error";
  if (getConfigurationStatus().databaseConfigured) {
    // A failure here leaves the baseline as it was. Only a refusal with its own message is named.
    try { outcome = await fn(); } catch (error) { outcome = error instanceof UserFacingError ? error.feedback : "error"; }
  }
  finish(date, outcome);
}

export async function addManagerSignalAction(form: FormData) {
  const scope = await requireScope(["OWNER", "MANAGER"]);
  const validFrom = field(form, "validFrom");
  return run(dateOf(form) ?? (/^\d{4}-\d{2}-\d{2}$/.test(validFrom) ? validFrom : null), async () => {
    await addManagerSignal(getDatabase(), scope, { validFrom, validTo: field(form, "validTo") || validFrom, summary: field(form, "summary"), direction: field(form, "direction") });
    return "signal-saved";
  });
}
const STRUCTURED_FIELDS: Record<StructuredSignalKind, readonly string[]> = {
  BOOKINGS: ["date", "start", "end", "quantityKind", "quantity", "comparison"],
  LOCAL_EVENT: ["date", "name", "start", "end", "distanceBand", "attendanceBand", "sourceUrl"],
  PROMOTION: ["validFrom", "validTo", "name", "start", "end", "description"],
};
export async function addStructuredSignalAction(form: FormData) {
  const scope = await requireScope(["OWNER", "MANAGER"]);
  const kind = field(form, "kind") as StructuredSignalKind;
  const returnDate = /^\d{4}-\d{2}-\d{2}$/.test(field(form, "planDate")) ? field(form, "planDate") : null;
  return run(returnDate, async () => {
    if (!STRUCTURED_SIGNAL_KINDS.includes(kind)) return "context-signal-fields";
    await addStructuredSignal(getDatabase(), scope, kind, Object.fromEntries(STRUCTURED_FIELDS[kind].map(name => [name, field(form, name)])));
    return "signal-saved";
  });
}
export async function refreshContextFeedsAction(form: FormData) {
  const scope = await requireScope(["OWNER", "MANAGER"]);
  return run(dateOf(form), async () => {
    const { weather, events } = await refreshContextFeeds(getDatabase(), scope);
    if (weather === "NO_COORDINATES") return "feeds-no-coordinates";
    return weather === "FAILED" || events === "FAILED" ? "feeds-failed" : "feeds-refreshed";
  });
}
export async function withdrawManagerSignalAction(form: FormData) {
  const scope = await requireScope(["OWNER", "MANAGER"]);
  return run(dateOf(form), async () => { await withdrawManagerSignal(getDatabase(), scope, field(form, "signalId")); return "signal-withdrawn"; });
}
export async function proposeDemandContextAction(form: FormData) {
  const scope = await requireScope(["OWNER", "MANAGER"]);
  const date = dateOf(form);
  return run(date, async () => {
    const provider = getStaffingAssessmentProvider();
    if (!provider) return "not-configured";
    if (!date) return "error";
    return (await proposeDemandContext(getDatabase(), scope, date, provider)).record.status === "AVAILABLE" ? "proposed" : "failed";
  });
}
export async function decideDemandContextAction(form: FormData) {
  const scope = await requireScope(["OWNER", "MANAGER"]);
  return run(dateOf(form), async () => {
    const action = field(form, "decision") as ContextAction;
    await decideDemandContext(getDatabase(), scope, { proposalId: field(form, "proposalId"), action });
    return action === "ACCEPTED" ? "accepted" : action === "DISMISSED" ? "dismissed" : "withdrawn";
  });
}
