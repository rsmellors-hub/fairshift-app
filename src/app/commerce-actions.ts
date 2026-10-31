"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireScope } from "@/server/auth/request";
import { connectZettle, disconnectZettle, syncZettle } from "@/server/commerce/connections";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { UserFacingError } from "@/server/domain/errors";
import { createZettleClient } from "@/server/integrations/zettle/client";

// Owner-only. Location comes from the form but is checked against the session's
// organisation by the service. The API key is passed through and sealed, never echoed.
const SALES = "/owner/reporting";
const field = (form: FormData, name: string) => String(form.get(name) ?? "");
async function perform(fn: () => Promise<string>) {
  let status = "error";
  if (getConfigurationStatus().databaseConfigured) {
    try { status = await fn(); }
    catch (error) { status = error instanceof UserFacingError ? error.feedback : "error"; }
  }
  revalidatePath("/owner", "layout");
  redirect(`${SALES}?status=${status}`);
}

export async function connectZettleAction(form: FormData) {
  const scope = await requireScope(["OWNER"]);
  return perform(async () => {
    await connectZettle(getDatabase(), scope, { outletId: field(form, "outletId"), clientId: field(form, "clientId"), apiKey: field(form, "apiKey") }, createZettleClient());
    return "saved";
  });
}
export async function syncZettleAction(form: FormData) {
  const scope = await requireScope(["OWNER"]);
  return perform(async () => (await syncZettle(getDatabase(), scope, field(form, "outletId"), createZettleClient())).status === "SUCCEEDED" ? "saved" : "zettle-sync-failed");
}
export async function disconnectZettleAction(form: FormData) {
  const scope = await requireScope(["OWNER"]);
  return perform(async () => { await disconnectZettle(getDatabase(), scope, field(form, "outletId")); return "saved"; });
}
