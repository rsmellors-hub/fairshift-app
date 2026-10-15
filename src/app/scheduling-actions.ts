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
} from "@/server/scheduling/demo";

export async function publishDemoShiftAction() {
  if (!getConfigurationStatus().databaseConfigured) {
    throw new Error("PostgreSQL is not configured.");
  }

  await publishDemoShift(getDatabase());
  redirect("/worker");
}

export async function acceptDemoShiftAction() {
  if (!getConfigurationStatus().databaseConfigured) {
    throw new Error("PostgreSQL is not configured.");
  }

  await acceptDemoShift(getDatabase());
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
  await markDemoShiftCompleted(db);
  await recordDemoPerformance(db, amountMinor);
  redirect("/manager");
}

export async function approveDemoIncentiveAction() {
  if (!getConfigurationStatus().databaseConfigured) throw new Error("PostgreSQL is not configured.");
  await approveDemoIncentive(getDatabase());
  redirect("/manager");
}

export async function submitDemoIncentivePayoutAction() {
  if (!getConfigurationStatus().databaseConfigured) throw new Error("PostgreSQL is not configured.");
  await submitDemoIncentivePayout(getDatabase(), getPayPalPayoutClient());
  redirect("/manager");
}

export async function refreshDemoIncentivePayoutAction() {
  if (!getConfigurationStatus().databaseConfigured) throw new Error("PostgreSQL is not configured.");
  await refreshDemoIncentivePayout(getDatabase(), getPayPalPayoutClient());
  redirect("/manager");
}

export async function saveDemoPayoutDestinationAction(formData: FormData) {
  if (!getConfigurationStatus().databaseConfigured) throw new Error("PostgreSQL is not configured.");
  await setDemoPayoutDestination(getDatabase(), String(formData.get("payoutEmail") ?? ""));
  redirect("/worker");
}
