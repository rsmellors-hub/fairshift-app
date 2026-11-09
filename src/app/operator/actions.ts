"use server";

import { requireOperator } from "@/server/auth/request";
import { redirect } from "next/navigation";
import { revalidatePath } from "@/app/revalidate";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { startNewDemoCycle } from "@/server/scheduling/demo";
import { demoConfig } from "@/server/demo/config";
import { DEMO_ORGANISATION_ID } from "@/server/constants";

export async function startNewDemoCycleAction() {
  await requireOperator();
  if (demoConfig()?.organisationId !== DEMO_ORGANISATION_ID) redirect("/operator/environment?status=error");
  if (!getConfigurationStatus().databaseConfigured) redirect("/operator/environment?status=error");
  try { await startNewDemoCycle(getDatabase()); } catch { redirect("/operator/environment?status=error"); }
  for (const workspace of ["/manager", "/worker", "/owner", "/operator"]) revalidatePath(workspace, "layout");
  redirect("/operator/environment?status=saved");
}
