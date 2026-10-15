"use server";

import { requireScope } from "@/server/auth/request";
import { DEMO_ORGANISATION_ID, DEMO_OUTLET_ID, DEMO_CASUAL_WORKER_ID } from "@/server/constants";
import { savePayoutDestination } from "@/server/auth/operations";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { getPayPalPayoutClient } from "@/server/integrations/paypal/factory";
import {
  approveDemoIncentive,
  markDemoShiftCompleted,
  recordDemoPerformance,
  refreshDemoIncentivePayout,
  submitDemoIncentivePayout,
} from "@/server/incentives/demo";
import {
  acceptDemoShift,
  publishDemoShift,
} from "@/server/scheduling/demo";

function requiredDemoId(formData: FormData, name: string) {
  const value = String(formData.get(name) ?? "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("This page is out of date. Reload and try again.");
  }
  return value;
}

async function performAction(path: string, action: () => Promise<unknown>) {
  if (!getConfigurationStatus().databaseConfigured) redirect(`${path}?status=error`);
  try { await action(); } catch { redirect(`${path}?status=error`); }
  for (const workspace of ["/manager", "/worker", "/owner", "/operator"]) {
    revalidatePath(workspace, "layout");
  }
  redirect(`${path}?status=saved`);
}

export async function publishDemoShiftAction(formData: FormData) {
  await demoAuthority();
  return performAction("/manager/plan", async () => {
    if (formData.get("workerSelected") !== "yes") throw new Error("Select the invitation recipient.");
    await publishDemoShift(getDatabase());
  });
}

export async function acceptDemoShiftAction(formData: FormData) {
  await demoAuthority(true);
  return performAction("/worker/shifts", async () => acceptDemoShift(getDatabase(), requiredDemoId(formData, "shiftId"), formData.get("acknowledged") === "yes", Number(formData.get("termsVersion"))));
}

export async function recordDemoPerformanceAction(formData: FormData) {
  await demoAuthority();
  return performAction("/manager/review", async () => {
    if (formData.get("completed") !== "yes") throw new Error("Confirm completed work.");
    const value = String(formData.get("performanceSales") ?? "").trim();
    if (!/^\d{1,8}(\.\d{1,2})?$/.test(value)) throw new Error("Enter a valid USD sales amount.");
    const [whole, fraction = ""] = value.split(".");
    const amountMinor = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
    if (!Number.isSafeInteger(amountMinor)) throw new Error("Sales amount is too large.");
    const db = getDatabase();
    const shiftId = requiredDemoId(formData, "shiftId");
    await markDemoShiftCompleted(db, shiftId);
    await recordDemoPerformance(db, amountMinor, shiftId);
  });
}

export async function approveDemoIncentiveAction(formData: FormData) {
  await demoAuthority();
  return performAction("/manager/review", async () => approveDemoIncentive(getDatabase(), requiredDemoId(formData, "incentiveId")));
}

export async function submitDemoIncentivePayoutAction(formData: FormData) {
  await demoAuthority();
  return performAction("/manager/review", async () => submitDemoIncentivePayout(getDatabase(), getPayPalPayoutClient(), requiredDemoId(formData, "incentiveId")));
}

export async function refreshDemoIncentivePayoutAction(formData: FormData) {
  await demoAuthority();
  return performAction("/manager/review", async () => refreshDemoIncentivePayout(getDatabase(), getPayPalPayoutClient(), requiredDemoId(formData, "incentiveId")));
}

export async function saveDemoPayoutDestinationAction(formData: FormData) {
  const scope=await requireScope(["TEAM_MEMBER"]);
  return performAction("/worker/profile", () => savePayoutDestination(getDatabase(),scope,String(formData.get("payoutEmail") ?? "")));
}
async function demoAuthority(worker=false) {
  const scope=await requireScope(worker ? ["TEAM_MEMBER"] : ["OWNER","MANAGER"]);
  if (scope.organisationId !== DEMO_ORGANISATION_ID || scope.locationId !== DEMO_OUTLET_ID || (worker && scope.workerId !== DEMO_CASUAL_WORKER_ID)) throw new Error("Access denied.");
  return scope;
}
