"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireScope } from "@/server/auth/request";
import { disconnectCommerceConnection } from "@/server/commerce/connections";
import { connectSquare, getSquareFreshness, refreshSquareSales, squareSandboxCredentials, syncSquare } from "@/server/commerce/square-connection";
import { prepareDemoShift, recordSquareSandboxSale } from "@/server/commerce/square-demo";
import { mapSquareTeamMember, removeSquareMapping } from "@/server/commerce/square-mapping";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { UserFacingError } from "@/server/domain/errors";
import { decimalToMinorUnits } from "@/server/domain/money";
import { createSquareClient } from "@/server/integrations/square/client";

// Organisation and location come from the session. A form names only a worker, a team member
// that Square must list, or a location checked against the session's organisation.
const field = (form: FormData, name: string) => String(form.get(name) ?? "");
async function perform(destination: string, fn: () => Promise<string>) {
  let status = "error";
  if (getConfigurationStatus().databaseConfigured) {
    try { status = await fn(); }
    catch (error) { status = error instanceof UserFacingError ? error.feedback : "error"; }
  }
  for (const role of ["owner", "manager", "worker"]) revalidatePath(`/${role}`, "layout");
  redirect(`${destination}?status=${status}`);
}

const OWNER_SALES = "/owner/reporting", TEAM = "/manager/team";
export async function connectSquareAction(form: FormData) {
  const scope = await requireScope(["OWNER"]);
  return perform(OWNER_SALES, async () => { await connectSquare(getDatabase(), scope, { outletId: field(form, "outletId") }, createSquareClient(), squareSandboxCredentials()); return "saved"; });
}
export async function syncSquareAction(form: FormData) {
  const scope = await requireScope(["OWNER"]);
  return perform(OWNER_SALES, async () => (await syncSquare(getDatabase(), scope, field(form, "outletId"), createSquareClient())).status === "SUCCEEDED" ? "saved" : "square-sync-failed");
}
export async function disconnectSquareAction(form: FormData) {
  const scope = await requireScope(["OWNER"]);
  return perform(OWNER_SALES, async () => { await disconnectCommerceConnection(getDatabase(), scope, field(form, "outletId")); return "saved"; });
}
export async function mapSquareTeamMemberAction(form: FormData) {
  const scope = await requireScope(["OWNER", "MANAGER"]);
  return perform(TEAM, async () => { await mapSquareTeamMember(getDatabase(), scope, { workerId: field(form, "workerId"), teamMemberId: field(form, "teamMemberId") }, createSquareClient()); return "saved"; });
}
export async function removeSquareMappingAction(form: FormData) {
  const scope = await requireScope(["OWNER", "MANAGER"]);
  return perform(TEAM, async () => { await removeSquareMapping(getDatabase(), scope, field(form, "mappingId")); return "saved"; });
}
export async function recordSquareSandboxSaleAction(form: FormData) {
  const scope = await requireScope(["OWNER", "MANAGER"]);
  return perform(TEAM, async () => {
    let amountMinor: number;
    try { amountMinor = decimalToMinorUnits(field(form, "amount")); } catch { throw new UserFacingError("square-demo-amount", "Enter an amount such as 12.50."); }
    await recordSquareSandboxSale(getDatabase(), scope, { workerId: field(form, "workerId"), amountMinor, requestId: field(form, "requestId") }, createSquareClient());
    return "square-sale-recorded";
  });
}
export async function prepareDemoShiftAction(form: FormData) {
  const scope = await requireScope(["OWNER", "MANAGER"]);
  return perform(TEAM, async () => { await prepareDemoShift(getDatabase(), scope, { workerId: field(form, "workerId"), minutesUntilEnd: Number(field(form, "minutesUntilEnd")) }); return "square-demo-shift-created"; });
}

// Asked for by a page showing Square-attributed figures. Its only input is the session. It
// reports an opaque revision and whether Square could be read, never any sales.
export type SquareRefreshState = { revision: string | null; failed: boolean; lastCheckedAt: string | null };
export async function refreshSquareSalesAction(): Promise<SquareRefreshState> {
  const scope = await requireScope(["OWNER", "MANAGER", "TEAM_MEMBER"]);
  const unknown = { revision: null, failed: true, lastCheckedAt: null };
  if (!getConfigurationStatus().databaseConfigured) return unknown;
  try {
    const result = await refreshSquareSales(getDatabase(), scope, createSquareClient());
    const freshness = await getSquareFreshness(getDatabase(), scope);
    return { revision: freshness?.revision ?? null, failed: result.status === "FAILED" || !!freshness?.attention || !!freshness?.lastFailed, lastCheckedAt: freshness?.lastSuccessAt?.toISOString() ?? null };
  } catch { return unknown; }
}
