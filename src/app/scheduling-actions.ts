"use server";

import { redirect } from "next/navigation";

import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { getPayPalPayoutClient } from "@/server/integrations/paypal/factory";
import {
  approveDemoIncentive,
  markDemoShiftCompleted,
  recordDemoPerformance,
  refreshDemoIncentivePayout,
  setDemoPayoutDestination,
  submitDemoIncentivePayout,
} from "@/server/incentives/demo";
import {
  acceptDemoShift,
  publishDemoShift,
  startNewDemoCycle,
} from "@/server/scheduling/demo";

function requiredDemoId(formData: FormData, name: string) {
  const value = String(formData.get(name) ?? "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("Demo page is out of date. Reload and try again.");
  }
  return value;
}

export async function publishDemoShiftAction() {
  if (!getConfigurationStatus().databaseConfigured) {
    throw new Error("PostgreSQL is not configured.");
  }

  await publishDemoShift(getDatabase());
  redirect("/worker");
}

export async function startNewDemoCycleAction() {
  if (!getConfigurationStatus().databaseConfigured) throw new Error("PostgreSQL is not configured.");
  await startNewDemoCycle(getDatabase());
  redirect("/manager");
}

export async function acceptDemoShiftAction(formData: FormData) {
  if (!getConfigurationStatus().databaseConfigured) {
    throw new Error("PostgreSQL is not configured.");
  }

  await acceptDemoShift(getDatabase(), requiredDemoId(formData, "shiftId"));
  redirect("/worker");
}

export async function recordDemoPerformanceAction(formData: FormData) {
  if (!getConfigurationStatus().databaseConfigured) throw new Error("PostgreSQL is not configured.");
  const value = String(formData.get("performanceSales") ?? "").trim();
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(value)) throw new Error("Enter a valid USD sales amount.");
  const [whole, fraction = ""] = value.split(".");
  const amountMinor = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(amountMinor)) throw new Error("Sales amount is too large.");
  const db = getDatabase();
  const shiftId = requiredDemoId(formData, "shiftId");
  await markDemoShiftCompleted(db, shiftId);
  await recordDemoPerformance(db, amountMinor, shiftId);
  redirect("/manager");
}

export async function approveDemoIncentiveAction(formData: FormData) {
  if (!getConfigurationStatus().databaseConfigured) throw new Error("PostgreSQL is not configured.");
  await approveDemoIncentive(getDatabase(), requiredDemoId(formData, "incentiveId"));
  redirect("/manager");
}

export async function submitDemoIncentivePayoutAction(formData: FormData) {
  if (!getConfigurationStatus().databaseConfigured) throw new Error("PostgreSQL is not configured.");
  await submitDemoIncentivePayout(getDatabase(), getPayPalPayoutClient(), requiredDemoId(formData, "incentiveId"));
  redirect("/manager");
}

export async function refreshDemoIncentivePayoutAction(formData: FormData) {
  if (!getConfigurationStatus().databaseConfigured) throw new Error("PostgreSQL is not configured.");
  await refreshDemoIncentivePayout(getDatabase(), getPayPalPayoutClient(), requiredDemoId(formData, "incentiveId"));
  redirect("/manager");
}

export async function saveDemoPayoutDestinationAction(formData: FormData) {
  if (!getConfigurationStatus().databaseConfigured) {
    redirect("/worker?paymentDetails=error");
  }

  try {
    await setDemoPayoutDestination(getDatabase(), String(formData.get("payoutEmail") ?? ""));
  } catch {
    redirect("/worker?paymentDetails=error");
  }

  redirect("/worker?paymentDetails=saved");
}
