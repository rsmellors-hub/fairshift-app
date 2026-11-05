import { assertSandboxOrganisation } from "@/server/config/deployment";
import { DEMO_ORGANISATION_ID } from "@/server/constants";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import { DEMO_CASUAL_WORKER_ID } from "@/server/constants";
import type { DatabaseSession } from "@/server/db/client";
import { calculateIncentive } from "@/server/domain/incentive";
import { shiftIncentives, shifts, workers } from "@/server/db/schema";
import { PayPalPayoutError, type PayPalPayoutAdapter } from "@/server/integrations/paypal/payout-client";
import { getDemoWorkerShift } from "@/server/scheduling/demo";

const minor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const email = z.string().trim().email().max(254);

export { calculateIncentive };

export async function setDemoPayoutDestination(db: DatabaseSession, value: string) {
  const recipient = email.parse(value);
  const [worker] = await db.update(workers)
    .set({ paypalPayoutEmail: recipient, updatedAt: new Date() })
    .where(eq(workers.id, DEMO_CASUAL_WORKER_ID)).returning();
  if (!worker) throw new Error("Demo worker is unavailable.");
  return worker;
}

export async function recordDemoPerformance(db: DatabaseSession, performanceSalesMinor: number, expectedShiftId?: string) {
  minor.parse(performanceSalesMinor);
  const current = await getDemoWorkerShift(db);
  const shift = current?.shift;
  const offer = current?.offer;
  if (expectedShiftId && shift?.id !== expectedShiftId) throw new Error("Demo shift changed. Reload the page.");
  if (!shift || shift.status !== "COMPLETED" || !offer || offer.status !== "ACCEPTED") {
    throw new Error("Only an accepted, completed shift can have performance recorded.");
  }

  const [existing] = await db.select().from(shiftIncentives).where(and(
    eq(shiftIncentives.shiftId, shift.id), eq(shiftIncentives.workerId, DEMO_CASUAL_WORKER_ID),
  )).limit(1);
  if (existing && !["NOT_EARNED", "EARNED"].includes(existing.status)) {
    throw new Error("Performance cannot change after manager approval or payout processing.");
  }
  const earned = calculateIncentive(performanceSalesMinor, shift.incentiveTargetMinor, shift.incentiveAmountMinor);
  const incentiveId = existing?.id ?? randomUUID();
  const values = {
    id: incentiveId,
    shiftId: shift.id,
    workerId: DEMO_CASUAL_WORKER_ID,
    performanceSalesMinor,
    targetSalesMinor: shift.incentiveTargetMinor,
    earnedAmountMinor: earned.earnedAmountMinor,
    status: earned.status,
    paypalSenderBatchId: `FS-BATCH-${incentiveId.replaceAll("-", "")}`,
    paypalSenderItemId: `FS-ITEM-${incentiveId.replaceAll("-", "")}`,
    updatedAt: new Date(),
  };
  const [result] = await db.insert(shiftIncentives).values(values).onConflictDoUpdate({
    target: [shiftIncentives.shiftId, shiftIncentives.workerId],
    set: {
      performanceSalesMinor: values.performanceSalesMinor,
      targetSalesMinor: values.targetSalesMinor,
      earnedAmountMinor: values.earnedAmountMinor,
      status: values.status,
      updatedAt: values.updatedAt,
    },
    setWhere: inArray(shiftIncentives.status, ["NOT_EARNED", "EARNED"]),
  }).returning();
  if (!result) throw new Error("Performance cannot change after manager approval or payout processing.");
  return result;
}

export async function approveDemoIncentive(db: DatabaseSession, expectedIncentiveId?: string) {
  const existing = (await getDemoIncentive(db))?.incentive;
  if (expectedIncentiveId && existing?.id !== expectedIncentiveId) throw new Error("Demo incentive changed. Reload the page.");
  if (existing?.status === "APPROVED") return existing;
  if (!existing || existing.status !== "EARNED" || existing.earnedAmountMinor <= 0) {
    throw new Error("Only a positive earned incentive can be approved.");
  }
  const [approved] = await db.update(shiftIncentives).set({
    status: "APPROVED", approvedAt: new Date(), approvedBy: "DEMO_MANAGER", updatedAt: new Date(),
  }).where(and(eq(shiftIncentives.id, existing.id), eq(shiftIncentives.status, "EARNED"))).returning();
  if (!approved) throw new Error("Incentive approval changed concurrently.");
  return approved;
}

export async function getDemoIncentive(db: DatabaseSession, expectedShiftId?: string) {
  const current = await getDemoWorkerShift(db);
  if (!current || (expectedShiftId && current.shift.id !== expectedShiftId)) return null;
  const [row] = await db.select({ incentive: shiftIncentives, worker: workers, shift: shifts })
    .from(shiftIncentives)
    .innerJoin(workers, eq(shiftIncentives.workerId, workers.id))
    .innerJoin(shifts, eq(shiftIncentives.shiftId, shifts.id))
    .where(and(eq(shiftIncentives.shiftId, current.shift.id), eq(workers.id, DEMO_CASUAL_WORKER_ID)))
    .limit(1);
  return row ?? null;
}

function mapPayPalStatus(status: string) {
  switch (status.toUpperCase()) {
    case "SUCCESS": return { status: "PAID" as const, paid: true };
    case "FAILED": case "DENIED": case "CANCELED": case "RETURNED": case "BLOCKED": case "REVERSED":
      return { status: "FAILED" as const, paid: false };
    case "PENDING": return { status: "SUBMITTED" as const, paid: false };
    default: return { status: "PROCESSING" as const, paid: false };
  }
}

export async function submitDemoIncentivePayout(db: DatabaseSession, paypal: PayPalPayoutAdapter, expectedIncentiveId?: string) {
  assertSandboxOrganisation(DEMO_ORGANISATION_ID);
  const current = await getDemoIncentive(db);
  if (!current || (expectedIncentiveId && current.incentive.id !== expectedIncentiveId) || current.incentive.status !== "APPROVED" || current.incentive.earnedAmountMinor <= 0 ||
      !current.incentive.approvedAt || !current.worker.paypalPayoutEmail || current.incentive.submittedAt || current.shift.currencyCode !== "USD") {
    throw new Error("Incentive is not eligible for a first payout submission.");
  }
  const amountMinor = minor.parse(current.incentive.earnedAmountMinor);
  const [reserved] = await db.update(shiftIncentives).set({
    status: "SUBMITTING", payoutRecipient: current.worker.paypalPayoutEmail,
    submittedAt: new Date(), updatedAt: new Date(),
  }).where(and(eq(shiftIncentives.id, current.incentive.id), eq(shiftIncentives.status, "APPROVED"), isNull(shiftIncentives.submittedAt))).returning();
  if (!reserved) throw new Error("Payout was already submitted or reserved by another request.");

  try {
    const response = await paypal.createPayout({
      senderBatchId: reserved.paypalSenderBatchId,
      senderItemId: reserved.paypalSenderItemId,
      recipient: current.worker.paypalPayoutEmail,
      amount: `${Math.floor(amountMinor / 100)}.${String(amountMinor % 100).padStart(2, "0")}`,
    });
    const mapped = mapPayPalStatus(response.status);
    const [updated] = await db.update(shiftIncentives).set({
      status: mapped.status === "PAID" ? "PAID" : mapped.status,
      paypalBatchId: response.batchId,
      paypalItemId: response.itemId,
      paypalStatus: response.status,
      paidAt: mapped.paid ? new Date() : null,
      failureCode: mapped.status === "FAILED" ? "PAYPAL_PAYOUT_FAILED" : null,
      updatedAt: new Date(),
    }).where(eq(shiftIncentives.id, reserved.id)).returning();
    return updated;
  } catch (error) {
    const code = error instanceof PayPalPayoutError ? error.code : "PAYOUT_REQUEST_FAILED";
    await db.update(shiftIncentives).set({
      status: "FAILED", failureCode: code, updatedAt: new Date(),
    }).where(eq(shiftIncentives.id, reserved.id)).returning();
    throw new Error(`PayPal payout could not be confirmed (${code}); duplicate submission is locked.`, { cause: error });
  }
}

export async function refreshDemoIncentivePayout(db: DatabaseSession, paypal: PayPalPayoutAdapter, expectedIncentiveId?: string) {
  assertSandboxOrganisation(DEMO_ORGANISATION_ID);
  const current = await getDemoIncentive(db);
  if (expectedIncentiveId && current?.incentive.id !== expectedIncentiveId) throw new Error("Demo incentive changed. Reload the page.");
  if (!current?.incentive.paypalBatchId) throw new Error("No PayPal payout batch is available to refresh.");
  const response = await paypal.getPayout(current.incentive.paypalBatchId, current.incentive.paypalSenderItemId);
  const mapped = mapPayPalStatus(response.status);
  const [updated] = await db.update(shiftIncentives).set({
    status: mapped.status,
    paypalItemId: response.itemId ?? current.incentive.paypalItemId,
    paypalStatus: response.status,
    paidAt: mapped.paid ? current.incentive.paidAt ?? new Date() : null,
    failureCode: mapped.status === "FAILED" ? "PAYPAL_PAYOUT_FAILED" : null,
    updatedAt: new Date(),
  }).where(eq(shiftIncentives.id, current.incentive.id)).returning();
  return updated;
}

export async function markDemoShiftCompleted(db: DatabaseSession, expectedShiftId?: string) {
  const current = await getDemoWorkerShift(db);
  if (!current || (expectedShiftId && current.shift.id !== expectedShiftId) || current.offer.status !== "ACCEPTED") throw new Error("The demo shift is not ready to complete.");
  const [shift] = await db.update(shifts).set({ status: "COMPLETED", updatedAt: new Date() })
    .where(and(eq(shifts.id, current.shift.id), eq(shifts.status, "PUBLISHED"))).returning();
  if (shift) return shift;
  const [existing] = await db.select().from(shifts).where(eq(shifts.id, current.shift.id)).limit(1);
  if (!existing || existing.status !== "COMPLETED") throw new Error("The demo shift is not ready to complete.");
  return existing;
}
