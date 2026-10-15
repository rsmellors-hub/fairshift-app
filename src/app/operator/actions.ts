"use server";

import { requireOperator } from "@/server/auth/request";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { startNewDemoCycle } from "@/server/scheduling/demo";

export async function startNewDemoCycleAction() {
  await requireOperator();
  if (!getConfigurationStatus().databaseConfigured) redirect("/operator/environment?status=error");
  try { await startNewDemoCycle(getDatabase()); } catch { redirect("/operator/environment?status=error"); }
  for (const workspace of ["/manager", "/worker", "/owner", "/operator"]) revalidatePath(workspace, "layout");
  redirect("/operator/environment?status=saved");
}
