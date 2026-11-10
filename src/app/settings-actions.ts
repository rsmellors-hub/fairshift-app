"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "@/app/revalidate";
import { requireIdentity, requireScope } from "@/server/auth/request";
import { getDatabase } from "@/server/db/client";
import { UserFacingError } from "@/server/domain/errors";
import { setHoursRule, setShiftRules, updateBusinessDetails, updateOwnAccountDetails, updateOwnDetails } from "@/server/settings/settings";

// Editable settings (Day 6, item 3). Server-checked: rules and business details are the Owner's; a
// person's own details are their own. Closed to the public demo.
const field = (form: FormData, name: string) => String(form.get(name) ?? "");
const hours = (text: string) => { const value = Number(text.trim()); return Number.isFinite(value) ? Math.round(value * 60) : NaN; };
async function run(path: string, success: string, fn: () => Promise<unknown>) {
  let outcome = success;
  try { await fn(); } catch (error) { outcome = error instanceof UserFacingError ? error.feedback : "error"; }
  for (const role of ["owner", "manager", "worker"]) revalidatePath(`/${role}`, "layout");
  const [base, hash] = path.split("#");
  redirect(`${base}${base.includes("?") ? "&" : "?"}status=${outcome}${hash ? `#${hash}` : ""}`);
}

export async function setShiftRulesAction(form: FormData) {
  const scope = await requireScope(["OWNER"]);
  return run("/owner/policies#shift-rules", "shift-rules-saved", () => setShiftRules(getDatabase(), scope, {
    minMinutes: hours(field(form, "minHours")), maxMinutes: hours(field(form, "maxHours")), preferredMinutes: hours(field(form, "preferredHours")),
    firstRoundMinutes: hours(field(form, "firstRoundHours")), firstRoundCutoffMinutes: hours(field(form, "cutoffHours")) }));
}
export async function setHoursRuleAction(form: FormData) {
  const scope = await requireScope(["OWNER"]);
  return run("/owner/policies#hours-rule", "hours-rule-saved", () => setHoursRule(getDatabase(), scope, { weeklyThresholdMinutes: hours(field(form, "weeklyHours")), referenceWeeks: Number(field(form, "referenceWeeks")) }));
}
export async function updateBusinessAction(form: FormData) {
  const scope = await requireScope(["OWNER"]);
  return run("/owner/settings#business", "business-saved", () => updateBusinessDetails(getDatabase(), scope, { name: field(form, "name"), businessAddress: field(form, "businessAddress"), city: field(form, "city"), province: field(form, "province"), postalCode: field(form, "postalCode") }));
}
export async function updateOwnDetailsAction(form: FormData) {
  const scope = await requireScope(["TEAM_MEMBER"]);
  return run("/worker/profile#your-details", "details-saved", () => updateOwnDetails(getDatabase(), scope, { firstName: field(form, "firstName"), surname: field(form, "surname"), telephone: field(form, "telephone") }));
}
export async function updateOwnAccountAction(form: FormData) {
  const { user, session } = await requireIdentity();
  if (session.demoPersona) redirect("/account?status=error");
  return run("/account#your-details", "details-saved", () => updateOwnAccountDetails(getDatabase(), user.id, { firstName: field(form, "firstName"), surname: field(form, "surname"), telephone: field(form, "telephone") }));
}
