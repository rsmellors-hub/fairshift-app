"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { requireScope } from "@/server/auth/request";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { UserFacingError } from "@/server/domain/errors";
import { recordManualFxRate } from "@/server/fx/reference-rates";

// The Owner-only manual fallback for DEC-SA-012: when the ECB file can't be fetched, the Owner of
// the isolated Sandbox demo organisation records the ECB's published quotes for one date.
export async function recordManualFxRateAction(form: FormData) {
  const scope = await requireScope(["OWNER"]);
  const path = "/owner/payments";
  if (!getConfigurationStatus().databaseConfigured) redirect(`${path}?status=error`);
  const value = (name: string) => String(form.get(name) ?? "").trim();
  try {
    await recordManualFxRate(getDatabase(), scope, { rateDate: value("rateDate"), eurZar: value("eurZar"), eurUsd: value("eurUsd") });
  } catch (error) {
    redirect(`${path}?status=${error instanceof UserFacingError ? error.feedback : "error"}`);
  }
  revalidatePath("/owner", "layout");
  redirect(`${path}?status=saved`);
}
