"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireScope } from "@/server/auth/request";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { getStaffingAssessmentProvider } from "@/server/integrations/openai/staffing-assessment";
import { generateStaffingAssessment, type AssessmentKind } from "@/server/intelligence/ai-staffing";
import type { Scope } from "@/server/auth/access";

// Generating an AI assessment is an explicit request; page rendering never calls the
// model. The scope comes from the session only: no form field selects a location.
async function generate(path: string, kind: AssessmentKind, scope: Scope) {
  let outcome = "error";
  if (getConfigurationStatus().databaseConfigured) {
    try {
      const provider = getStaffingAssessmentProvider();
      if (!provider) outcome = "not-configured";
      else outcome = (await generateStaffingAssessment(getDatabase(), scope, kind, provider)).record.status === "AVAILABLE" ? "saved" : "failed";
    } catch { outcome = "error"; }
  }
  revalidatePath(path);
  redirect(`${path}?ai=${outcome}`);
}

export async function generateOwnerAssessmentAction() {
  return generate("/owner/forecast", "ORGANISATION", await requireScope(["OWNER"]));
}

export async function generateLocationAssessmentAction() {
  return generate("/manager/plan", "LOCATION", await requireScope(["OWNER", "MANAGER"]));
}
