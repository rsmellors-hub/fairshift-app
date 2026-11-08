import { sandboxFixture } from "../helpers/sandbox";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/server/db/client";
import type { Scope } from "@/server/auth/access";
import { refreshWorkPayout, type WorkPayout } from "@/server/payments/work-payouts";

const NOW = new Date("2026-11-05T12:00:00Z");
const DAY = 24 * 60 * 60_000;
const scope = { userId: randomUUID(), organisationId: randomUUID(), locationId: randomUUID(), role: "MANAGER" } as Scope;

// Invalid/missing timestamps cannot be inserted through the real NOT NULL schema.
// Inject malformed read results at the DB boundary to verify the runtime fails closed.
function fixture(reservedAt: unknown, status: string, afterAudit?: () => void) {
  const payableId = randomUUID();
  const payout = {
    id: randomUUID(), payableId, status, reservedAt, updatedAt: new Date(NOW.getTime() - 600_000),
    currencyCode: "GBP", providerCurrency: "GBP", providerAmountMinor: 7_800, fxRateMicros: null, fxRateSource: null,
    paypalBatchId: null, submittedAt: new Date(NOW.getTime() - 1_000), createdAt: NOW,
    lastError: { code: "TIMEOUT", outcome: "UNKNOWN" }, attempts: 1,
  } as WorkPayout;
  const claimed = { ...payout, status: "SUBMITTING", attempts: 2, updatedAt: NOW };
  const select = vi.fn()
    .mockReturnValueOnce({ from: () => ({ where: async () => [{ id: payableId }] }) })
    .mockReturnValueOnce({ from: () => ({ where: async () => [payout] }) })
    // Otherwise eligible historical GB/GBP route; the cutoff, not an SA route
    // refusal, must prevent the resend after claim/audit advances the clock.
    .mockReturnValueOnce({ from: () => ({ innerJoin: () => ({ where: async () => [{ locationCountry: "GB", organisationCountry: "GB" }] }) }) });
  const set = vi.fn((values: Partial<WorkPayout>) => ({ where: () => ({ returning: async () => [{ ...claimed, ...values }] }) }));
  const update = vi.fn(() => ({ set }));
  const values = vi.fn(async (row: unknown) => { void row; afterAudit?.(); });
  const insert = vi.fn(() => ({ values }));
  const db = { select, update, insert } as unknown as Database;
  const paypal = { createPayout: vi.fn(), getPayout: vi.fn() };
  return { db, paypal, payableId, payout, update, insert, values, set };
}

beforeEach(() => { sandboxFixture(scope.organisationId); vi.useFakeTimers({ now: NOW, toFake: ["Date"] }); });
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("no-batch recovery rejects an unreliable original attempt time", () => {
  for (const status of ["RECONCILIATION_REQUIRED", "SUBMITTING"]) {
    it.each([
      ["missing", undefined], ["null", null], ["invalid Date", new Date(NaN)],
      ["future Date", new Date(NOW.getTime() + 1)],
      ["ambiguous string", "11/04/2026"], ["ISO string instead of a DB Date", NOW.toISOString()],
      ["numeric time instead of a DB Date", NOW.getTime()],
    ])(`${status}: refuses %s without provider create or evidence changes`, async (_label, value) => {
      const f = fixture(value, status);
      await expect(refreshWorkPayout(f.db, f.paypal, scope, f.payableId)).rejects.toMatchObject({
        feedback: "payout-investigation-required", message: expect.stringContaining("Investigate the original payout"),
      });
      expect(f.paypal.createPayout).not.toHaveBeenCalled();
      expect(f.paypal.getPayout).not.toHaveBeenCalled();
      expect(f.update).not.toHaveBeenCalled();
      // The only write is the Manager's refused request, recorded in the audit.
      expect(f.insert).toHaveBeenCalledTimes(1);
      expect(f.values).toHaveBeenCalledWith(expect.objectContaining({ action: "PAYOUT_STATUS_CHECK_REQUESTED", entityId: f.payableId,
        metadata: expect.objectContaining({ actorUserId: scope.userId, actorRole: "MANAGER", sessionType: "SIGNED_IN", outcome: "REFUSED:payout-investigation-required" }) }));
    });
  }

  it("rechecks time after claim/audit, retaining uncertainty and provider evidence when the cutoff is crossed", async () => {
    const reservedAt = new Date(NOW.getTime() - 28 * DAY + 1);
    const f = fixture(reservedAt, "RECONCILIATION_REQUIRED", () => { vi.setSystemTime(new Date(NOW.getTime() + 1)); });
    await expect(refreshWorkPayout(f.db, f.paypal, scope, f.payableId)).rejects.toMatchObject({ feedback: "payout-investigation-required" });
    expect(f.paypal.createPayout).not.toHaveBeenCalled();
    expect(f.set).toHaveBeenCalledTimes(2);
    expect(f.set.mock.calls[1][0]).toEqual({ status: "RECONCILIATION_REQUIRED", updatedAt: new Date(NOW.getTime() + 1) });
    expect(f.payout).toMatchObject({ reservedAt, lastError: { code: "TIMEOUT", outcome: "UNKNOWN" }, paypalBatchId: null });
  });
});
