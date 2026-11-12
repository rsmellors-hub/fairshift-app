import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { sandboxFixture } from "../helpers/sandbox";
import { confirmedWork, payAgentCompany } from "../helpers/pay-agent";
import { auditEvents, notifications, workPayouts } from "@/server/db/schema";
import type { PayPalPayoutAdapter, PayoutResult } from "@/server/integrations/paypal/payout-client";
import type { PayoutCredentials } from "@/server/payments/business-paypal";
import { approveWorkPayable, PAYOUT_REFRESH_SERVICE, submitWorkPayout } from "@/server/payments/work-payouts";
import { JOBS, runDueJobs } from "@/server/scheduler/feeds";

// F5 (12 Nov 2026): payouts PayPal accepted and hasn't settled are read again on a schedule, with no
// user action, through the same reconciliation. Synthetic fixtures and an in-process PayPal double.
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];
const T0 = new Date("2026-11-12T10:00:00Z");

function paypalDouble(item: () => string) {
  const built: PayoutCredentials[] = [];
  const client = {
    createPayout: vi.fn(async (input: { senderBatchId: string }): Promise<PayoutResult> => ({ batchId: `PPB${input.senderBatchId.slice(-8)}`, itemId: null, status: "PENDING", batchStatus: "PENDING", itemStatus: null, transactionId: null })),
    getPayout: vi.fn(async (batchId: string): Promise<PayoutResult> => ({ batchId, itemId: "PPI-1", status: item(), batchStatus: "SUCCESS", itemStatus: item(), transactionId: "PPT-1", itemAmount: { value: "78.00", currency: "GBP" } })),
  } as unknown as PayPalPayoutAdapter & { createPayout: ReturnType<typeof vi.fn>; getPayout: ReturnType<typeof vi.fn> };
  return { client, built, factory: (credentials: PayoutCredentials) => { built.push(credentials); return client; } };
}
const refreshJob = JOBS.filter(job => job.key === "payouts:refresh");

async function processingPayout(db: Db) {
  const c = await payAgentCompany(db);
  sandboxFixture(c.organisationId);
  const manager = c.scopes[0];
  const { payable } = await confirmedWork(db, manager);
  await approveWorkPayable(db, manager, payable!.id);
  const sent = paypalDouble(() => "PENDING");
  await submitWorkPayout(db, sent.client, manager, payable!.id);
  const [payout] = await db.select().from(workPayouts).where(eq(workPayouts.payableId, payable!.id));
  expect(payout).toMatchObject({ status: "PROCESSING" });
  expect(payout.paypalBatchId).toBeTruthy();
  return payout;
}

describe("scheduled payout status refresh", () => {
  it("turns PROCESSING into PAID on PayPal's item SUCCESS with no user action, with exactly one Paid notice", async () => {
    const t = await createTestDatabase();
    try {
      const payout = await processingPayout(t.db);
      let status = "PENDING";
      const paypal = paypalDouble(() => status);
      const tick = (minutes: number) => runDueJobs(t.db, { now: () => new Date(T0.getTime() + minutes * 60_000), demoOrganisationIds: [], aiSchedule: false, payoutClient: paypal.factory }, refreshJob);

      // Still pending at PayPal: nothing changes.
      expect(await tick(0)).toEqual([{ key: "payouts:refresh", outcome: "RAN", ok: true, code: null }]);
      expect((await t.db.select().from(workPayouts).where(eq(workPayouts.id, payout.id)))[0].status).toBe("PROCESSING");
      expect(await tick(5)).toEqual([{ key: "payouts:refresh", outcome: "NOT_DUE" }]);

      status = "SUCCESS";
      await tick(10);
      const [paid] = await t.db.select().from(workPayouts).where(eq(workPayouts.id, payout.id));
      expect(paid).toMatchObject({ status: "PAID", paypalStatus: "SUCCESS" });
      expect(paypal.built.map(c => c.kind)).toEqual(["PLATFORM", "PLATFORM"]);
      expect(paypal.client.getPayout).toHaveBeenCalledWith(payout.paypalBatchId, payout.senderItemId);
      // Read only: the job never creates a payout.
      expect(paypal.client.createPayout).not.toHaveBeenCalled();
      const [update] = await t.db.select().from(auditEvents).where(eq(auditEvents.action, "PAYOUT_STATUS_UPDATED"));
      expect(update.metadata).toMatchObject({ actorUserId: null, actorService: PAYOUT_REFRESH_SERVICE, from: "PROCESSING", to: "PAID" });

      // Later passes find nothing to read, and the worker was told once.
      await tick(20);
      await tick(30);
      expect(paypal.client.getPayout).toHaveBeenCalledTimes(2);
      expect(await t.db.select().from(notifications).where(eq(notifications.kind, "PAYOUT_PAID"))).toHaveLength(1);
    } finally { await t.close(); }
  });

  it("never resends a payout without a PayPal batch ID", async () => {
    const t = await createTestDatabase();
    try {
      const c = await payAgentCompany(t.db);
      sandboxFixture(c.organisationId);
      const manager = c.scopes[0];
      const { payable } = await confirmedWork(t.db, manager);
      await approveWorkPayable(t.db, manager, payable!.id);
      // PayPal's create call fails with no answer: the outcome is unknown and there is no batch ID,
      // so the payout waits for a person to reconcile it. Made stale, so a resend would be tempting.
      const lost = paypalDouble(() => "PENDING");
      lost.client.createPayout.mockRejectedValueOnce(new Error("socket hang up"));
      await submitWorkPayout(t.db, lost.client, manager, payable!.id);
      const [payout] = await t.db.select().from(workPayouts).where(eq(workPayouts.payableId, payable!.id));
      expect(payout).toMatchObject({ status: "RECONCILIATION_REQUIRED", paypalBatchId: null });
      await t.db.update(workPayouts).set({ updatedAt: new Date(Date.now() - 3_600_000) }).where(eq(workPayouts.id, payout.id));
      const paypal = paypalDouble(() => "SUCCESS");
      const [result] = await runDueJobs(t.db, { now: () => T0, demoOrganisationIds: [], aiSchedule: false, payoutClient: paypal.factory }, refreshJob);
      expect(result).toMatchObject({ outcome: "RAN", ok: true });
      expect(paypal.client.createPayout).not.toHaveBeenCalled();
      expect(paypal.client.getPayout).not.toHaveBeenCalled();
      expect((await t.db.select().from(workPayouts).where(eq(workPayouts.id, payout.id)))[0].status).toBe("RECONCILIATION_REQUIRED");
    } finally { await t.close(); }
  });

  it("is off without PayPal payout configuration", async () => {
    const t = await createTestDatabase();
    try {
      expect(await runDueJobs(t.db, { now: () => T0, demoOrganisationIds: [], aiSchedule: false }, refreshJob)).toEqual([{ key: "payouts:refresh", outcome: "DISABLED" }]);
    } finally { await t.close(); }
  });
});
