import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { DEMO_INCENTIVE_ID } from "@/server/constants";
import { shiftIncentives } from "@/server/db/schema";
import {
  approveDemoIncentive,
  calculateIncentive,
  getDemoIncentive,
  markDemoShiftCompleted,
  recordDemoPerformance,
  refreshDemoIncentivePayout,
  setDemoPayoutDestination,
  submitDemoIncentivePayout,
} from "@/server/incentives/demo";
import type { PayPalPayoutAdapter } from "@/server/integrations/paypal/payout-client";
import { acceptDemoShift, getDemoWorkerShift, publishDemoShift, startNewDemoCycle } from "@/server/scheduling/demo";
import { createTestDatabase } from "../helpers/database";

const successAdapter = (overrides: Partial<PayPalPayoutAdapter> = {}): PayPalPayoutAdapter => ({
  async createPayout() { return { batchId: "PAYPAL-BATCH-1", itemId: "PAYPAL-ITEM-1", status: "PENDING" }; },
  async getPayout() { return { batchId: "PAYPAL-BATCH-1", itemId: "PAYPAL-ITEM-1", status: "SUCCESS" }; },
  ...overrides,
});

async function completedAcceptedShift(db: Parameters<typeof publishDemoShift>[0]) {
  await publishDemoShift(db);
  await acceptDemoShift(db, undefined, true);
  await markDemoShiftCompleted(db);
}

describe("shift incentive and PayPal payout workflow", () => {
  it("earns only when the exact minor-unit sales target is met", () => {
    expect(calculateIncentive(64_999, 65_000, 2_500)).toEqual({ earned: false, earnedAmountMinor: 0, status: "NOT_EARNED" });
    expect(calculateIncentive(65_000, 65_000, 2_500)).toEqual({ earned: true, earnedAmountMinor: 2_500, status: "EARNED" });
  });

  it("requires approval and recipient before payout, prevents duplicates, and refreshes persisted status", async () => {
    const testDb = await createTestDatabase();
    try {
      await completedAcceptedShift(testDb.db);
      const earned = await recordDemoPerformance(testDb.db, 65_000);
      expect(earned.status).toBe("EARNED");
      const createPayout = vi.fn(successAdapter().createPayout);
      const adapter = successAdapter({ createPayout });

      await expect(submitDemoIncentivePayout(testDb.db, adapter)).rejects.toThrow(/not eligible/);
      expect(createPayout).not.toHaveBeenCalled();
      await approveDemoIncentive(testDb.db);
      await expect(submitDemoIncentivePayout(testDb.db, adapter)).rejects.toThrow(/not eligible/);

      await setDemoPayoutDestination(testDb.db, "worker@example.test");
      expect(await getDemoIncentive(testDb.db)).toMatchObject({
        worker: { paypalPayoutEmail: "worker@example.test" },
        incentive: { payoutRecipient: null, submittedAt: null },
      });
      expect(createPayout).not.toHaveBeenCalled();
      const submitted = await submitDemoIncentivePayout(testDb.db, adapter);
      expect(submitted).toMatchObject({ status: "SUBMITTED", paypalBatchId: "PAYPAL-BATCH-1", paypalItemId: "PAYPAL-ITEM-1", paypalStatus: "PENDING" });
      expect(createPayout).toHaveBeenCalledTimes(1);
      expect(createPayout).toHaveBeenCalledWith(expect.objectContaining({ amount: "25.00", recipient: "worker@example.test" }));
      await expect(submitDemoIncentivePayout(testDb.db, adapter)).rejects.toThrow(/not eligible/);
      expect(createPayout).toHaveBeenCalledTimes(1);

      const paid = await refreshDemoIncentivePayout(testDb.db, adapter);
      expect(paid).toMatchObject({ status: "PAID", paypalStatus: "SUCCESS", paypalBatchId: "PAYPAL-BATCH-1", paypalItemId: "PAYPAL-ITEM-1" });
      const persisted = await testDb.db.select().from(shiftIncentives).where(eq(shiftIncentives.id, earned.id));
      expect(persisted[0].status).toBe("PAID");
      expect(persisted[0].paidAt).toBeInstanceOf(Date);
    } finally {
      await testDb.close();
    }
  });

  it("persists and reads back a valid payment destination without initiating a payout", async () => {
    const testDb = await createTestDatabase();
    try {
      await completedAcceptedShift(testDb.db);
      await recordDemoPerformance(testDb.db, 65_000);

      const saved = await setDemoPayoutDestination(testDb.db, "worker@example.test");
      expect(saved.paypalPayoutEmail).toBe("worker@example.test");
      expect(await getDemoIncentive(testDb.db)).toMatchObject({
        worker: { paypalPayoutEmail: "worker@example.test" },
        incentive: {
          status: "EARNED",
          payoutRecipient: null,
          submittedAt: null,
          paypalBatchId: null,
        },
      });

      await expect(setDemoPayoutDestination(testDb.db, "not-an-email")).rejects.toThrow();
      expect(await getDemoIncentive(testDb.db)).toMatchObject({
        worker: { paypalPayoutEmail: "worker@example.test" },
        incentive: { status: "EARNED", payoutRecipient: null, submittedAt: null },
      });
    } finally {
      await testDb.close();
    }
  });

  it("keeps a below-target result unearned and rejects approval", async () => {
    const testDb = await createTestDatabase();
    try {
      await completedAcceptedShift(testDb.db);
      const result = await recordDemoPerformance(testDb.db, 64_999);
      expect(result).toMatchObject({ status: "NOT_EARNED", earnedAmountMinor: 0 });
      await expect(approveDemoIncentive(testDb.db)).rejects.toThrow(/positive earned incentive/);
      expect(await getDemoIncentive(testDb.db)).toMatchObject({ incentive: { status: "NOT_EARNED" } });
    } finally {
      await testDb.close();
    }
  });

  it("persists failure status and locks an uncertain submission against duplicate payout", async () => {
    const testDb = await createTestDatabase();
    try {
      await completedAcceptedShift(testDb.db);
      await recordDemoPerformance(testDb.db, 70_000);
      await setDemoPayoutDestination(testDb.db, "worker@example.test");
      await approveDemoIncentive(testDb.db);
      const createPayout = vi.fn(async () => { throw new Error("network timeout"); });
      const adapter = successAdapter({ createPayout });
      await expect(submitDemoIncentivePayout(testDb.db, adapter)).rejects.toThrow(/duplicate submission is locked/);
      expect(await getDemoIncentive(testDb.db)).toMatchObject({ incentive: { status: "FAILED", failureCode: "PAYOUT_REQUEST_FAILED", submittedAt: expect.any(Date) } });
      await expect(submitDemoIncentivePayout(testDb.db, adapter)).rejects.toThrow(/not eligible/);
      expect(createPayout).toHaveBeenCalledTimes(1);
    } finally {
      await testDb.close();
    }
  });

  it("preserves a failed payout while a new cycle earns and reconciles its own payout", async () => {
    const testDb = await createTestDatabase();
    try {
      await completedAcceptedShift(testDb.db);
      const firstRecorded = await recordDemoPerformance(testDb.db, 70_000);
      const [historical] = await testDb.db.update(shiftIncentives).set({
        id: DEMO_INCENTIVE_ID,
        paypalSenderBatchId: `FS-BATCH-${DEMO_INCENTIVE_ID.replaceAll("-", "")}`,
        paypalSenderItemId: `FS-ITEM-${DEMO_INCENTIVE_ID.replaceAll("-", "")}`,
      }).where(eq(shiftIncentives.id, firstRecorded.id)).returning();
      await setDemoPayoutDestination(testDb.db, "worker@example.test");
      await approveDemoIncentive(testDb.db);
      const failedCreate = vi.fn(async () => { throw new Error("uncertain provider response"); });
      await expect(submitDemoIncentivePayout(testDb.db, successAdapter({ createPayout: failedCreate })))
        .rejects.toThrow(/duplicate submission is locked/);
      const [locked] = await testDb.db.select().from(shiftIncentives).where(eq(shiftIncentives.id, historical.id));
      expect(locked).toMatchObject({ status: "FAILED", submittedAt: expect.any(Date) });

      const fresh = await startNewDemoCycle(testDb.db);
      expect((await getDemoWorkerShift(testDb.db))?.shift.id).toBe(fresh.shift.id);
      expect(await getDemoIncentive(testDb.db)).toBeNull();
      await expect(acceptDemoShift(testDb.db, historical.shiftId)).rejects.toThrow(/unavailable/);
      await acceptDemoShift(testDb.db, undefined, true);
      await markDemoShiftCompleted(testDb.db);
      const current = await recordDemoPerformance(testDb.db, 72_000);
      expect(current.id).not.toBe(historical.id);
      expect(current.shiftId).toBe(fresh.shift.id);
      expect(current.paypalSenderBatchId).not.toBe(historical.paypalSenderBatchId);
      expect(current.paypalSenderItemId).not.toBe(historical.paypalSenderItemId);
      expect(await getDemoIncentive(testDb.db)).toMatchObject({ incentive: { id: current.id, status: "EARNED" } });

      const createPayout = vi.fn(async () => ({ batchId: "PAYPAL-BATCH-NEW", itemId: "PAYPAL-ITEM-NEW", status: "PENDING" }));
      const getPayout = vi.fn(async () => ({ batchId: "PAYPAL-BATCH-NEW", itemId: "PAYPAL-ITEM-NEW", status: "SUCCESS" }));
      const adapter = successAdapter({ createPayout, getPayout });
      await expect(submitDemoIncentivePayout(testDb.db, adapter, historical.id)).rejects.toThrow(/not eligible/);
      await expect(submitDemoIncentivePayout(testDb.db, adapter)).rejects.toThrow(/not eligible/);
      expect(createPayout).not.toHaveBeenCalled();
      await approveDemoIncentive(testDb.db);
      const submitted = await submitDemoIncentivePayout(testDb.db, adapter);
      expect(submitted).toMatchObject({ id: current.id, status: "SUBMITTED", paypalBatchId: "PAYPAL-BATCH-NEW", paypalItemId: "PAYPAL-ITEM-NEW" });
      expect(createPayout).toHaveBeenCalledWith(expect.objectContaining({
        senderBatchId: current.paypalSenderBatchId, senderItemId: current.paypalSenderItemId,
      }));
      await expect(submitDemoIncentivePayout(testDb.db, adapter)).rejects.toThrow(/not eligible/);
      expect(createPayout).toHaveBeenCalledTimes(1);

      const paid = await refreshDemoIncentivePayout(testDb.db, adapter);
      await expect(refreshDemoIncentivePayout(testDb.db, adapter, historical.id)).rejects.toThrow(/changed/);
      expect(paid).toMatchObject({ id: current.id, status: "PAID", paypalStatus: "SUCCESS" });
      expect(getPayout).toHaveBeenCalledWith("PAYPAL-BATCH-NEW", current.paypalSenderItemId);
      const [historicalAfter] = await testDb.db.select().from(shiftIncentives).where(eq(shiftIncentives.id, historical.id));
      expect(historicalAfter).toEqual(locked);
      expect(failedCreate).toHaveBeenCalledTimes(1);
    } finally {
      await testDb.close();
    }
  });
});
