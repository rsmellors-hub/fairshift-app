"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "@/app/revalidate";
import { requireScope } from "@/server/auth/request";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { getStaffingAssessmentProvider } from "@/server/integrations/openai/staffing-assessment";
import { generateStaffingAssessment, type AssessmentKind } from "@/server/intelligence/ai-staffing";
import type { Scope } from "@/server/auth/access";
import { and, eq } from "drizzle-orm";
import { outlets } from "@/server/db/schema";
import { localDate } from "@/server/intelligence/forecast";
import { locationWageJurisdiction } from "@/server/scheduling/operations";
import { explainWageCheck, type WageExplanationResult } from "@/server/intelligence/wage-explanation";

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

// An on-demand AI explanation of the wage check for a rate the Owner is considering. The location,
// date and check come from the session and FairShift's own rule; the form supplies only the rate.
// The public demo never reaches a provider.
export async function explainWageAction(_previous: WageExplanationResult | null, form: FormData): Promise<WageExplanationResult> {
  const scope = await requireScope(["OWNER"]);
  if (scope.demo) return { state: "UNAVAILABLE", reason: "DEMO" };
  const rate = String(form.get("rate") ?? "");
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(rate)) return { state: "UNAVAILABLE", reason: "INVALID_RATE" };
  const [whole, fraction = ""] = rate.split(".");
  try {
    const db = getDatabase();
    const [outlet] = await db.select().from(outlets).where(and(eq(outlets.id, scope.locationId), eq(outlets.organisationId, scope.organisationId)));
    if (!outlet) return { state: "UNAVAILABLE", reason: "PROVIDER_FAILED" };
    return await explainWageCheck(db, scope, { rateMinor: Number(whole) * 100 + Number(fraction.padEnd(2, "0")), date: localDate(new Date(), outlet.timezone), jurisdiction: await locationWageJurisdiction(db, outlet) }, getStaffingAssessmentProvider());
  } catch { return { state: "UNAVAILABLE", reason: "PROVIDER_FAILED" }; }
}
