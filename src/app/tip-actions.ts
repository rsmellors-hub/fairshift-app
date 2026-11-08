"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { requireScope } from "@/server/auth/request";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { UserFacingError } from "@/server/domain/errors";
import { getPayPalPayoutClient } from "@/server/integrations/paypal/factory";
import { refreshTipLinePayout } from "@/server/payments/work-payouts";
import { decideTipHold } from "@/server/tips/agent";
import { addPermanentStaff, importTipEvidence, saveBlockRoster, saveShiftBlocks, saveTipSettings, setPermanentStaffStatus } from "@/server/tips/service";
import { createStatementLink } from "@/server/tips/statement";
import { retryTipCheck, scheduleReleasedLineHold, scheduleTipEvents, tipAgentFor } from "@/server/tips/wiring";

// Owner-only tip actions (FS-TIP-DEC-002, FS-TIP-AGENT-DEC-001). Managers have no tip actions.
const PATH = "/owner/tips";
const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

async function perform(fn: () => Promise<unknown>, success = "saved") {
  if (!getConfigurationStatus().databaseConfigured) redirect(`${PATH}?status=error`);
  try { await fn(); } catch (error) {
    redirect(`${PATH}?status=${error instanceof UserFacingError ? error.feedback : "error"}`);
  }
  revalidatePath("/owner", "layout");
  revalidatePath("/worker", "layout");
  redirect(`${PATH}?status=${success}`);
}
const rand = (value: string) => /^\d{1,7}(\.\d{1,2})?$/.test(value) ? Math.round(Number(value) * 100) : NaN;

export async function saveTipSettingsAction(form: FormData) {
  const scope = await requireScope(["OWNER"]);
  return perform(() => saveTipSettings(getDatabase(), scope, { policy: field(form, "policy"), autoReleaseCapMinor: rand(field(form, "cap")) }));
}
export async function saveShiftBlocksAction(form: FormData) {
  const scope = await requireScope(["OWNER"]);
  return perform(() => saveShiftBlocks(getDatabase(), scope, field(form, "blocks")));
}
export async function addPermanentStaffAction(form: FormData) {
  const scope = await requireScope(["OWNER"]);
  return perform(() => addPermanentStaff(getDatabase(), scope, { firstName: field(form, "firstName"), surname: field(form, "surname"), email: field(form, "email"), paypalEmail: field(form, "paypalEmail") }));
}
export async function setPermanentStaffStatusAction(form: FormData) {
  const scope = await requireScope(["OWNER"]);
  return perform(() => setPermanentStaffStatus(getDatabase(), scope, field(form, "workerId"), field(form, "status") === "INACTIVE" ? "INACTIVE" : "ACTIVE"));
}
export async function saveBlockRosterAction(form: FormData) {
  const scope = await requireScope(["OWNER"]);
  const entries = form.getAll("slot").map(String).map(value => { const [day, blockId] = value.split(":"); return { isoWeekday: Number(day), blockId }; });
  return perform(() => saveBlockRoster(getDatabase(), scope, field(form, "workerId"), entries));
}
export async function importTipsAction(form: FormData) {
  const scope = await requireScope(["OWNER"]);
  const file = form.get("file");
  const text = file instanceof File && file.size ? await file.text() : field(form, "csv");
  return perform(async () => {
    const db = getDatabase();
    const result = await importTipEvidence(db, scope, text);
    // Committed: the Pay Agent's tip checks run after the response, never inside it.
    scheduleTipEvents(tipAgentFor(db), scope, result.eventIds);
  }, "tips-imported");
}
export async function decideTipHoldAction(form: FormData) {
  const scope = await requireScope(["OWNER"]);
  return perform(async () => {
    const db = getDatabase();
    const { hold, record } = await decideTipHold(db, getPayPalPayoutClient, scope, { holdId: field(form, "holdId"), decision: field(form, "decision"), reason: field(form, "reason") });
    if (record.decision !== "RELEASED") return;
    if (hold.source === "MODEL" && hold.tipAgentEventId) scheduleTipEvents(tipAgentFor(db), scope, [hold.tipAgentEventId]);
    else scheduleReleasedLineHold(db, scope, hold);
  });
}
export async function retryTipCheckAction(form: FormData) {
  const scope = await requireScope(["OWNER"]);
  return perform(async () => { const db = getDatabase(); await retryTipCheck(db, tipAgentFor(db), scope, field(form, "eventId")); });
}
export async function refreshTipPayoutAction(form: FormData) {
  const scope = await requireScope(["OWNER"]);
  return perform(() => refreshTipLinePayout(getDatabase(), getPayPalPayoutClient, scope, field(form, "lineId")));
}
// Development only (see createStatementLink): returns the fragment path once, never a redirect,
// so the token is never in a request URL or a server log.
export async function openStatementLinkAction(workerId: string): Promise<{ path: string } | { error: string }> {
  const scope = await requireScope(["OWNER"]);
  try { return { path: (await createStatementLink(getDatabase(), scope, workerId)).path }; }
  catch (error) { return { error: error instanceof UserFacingError ? error.message : "The link couldn't be created." }; }
}
