import { sandboxFixture } from "../helpers/sandbox";
import { beforeEach as beforeSandbox, afterEach as afterSandbox, vi as sandboxVi } from "vitest";
beforeSandbox(() => sandboxFixture());
afterSandbox(() => sandboxVi.unstubAllEnvs());
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { DEMO_OUTLET_ID } from "@/server/constants";
import {
  attachPayPalCapture,
  attachPayPalOrder,
  createPendingSale,
  getSaleByCaptureId,
} from "@/server/db/repository";
import { reconcileCapture } from "@/server/domain/transactions";
import { createTestDatabase } from "../helpers/database";
import { createFakePayPalAdapter } from "../helpers/paypal";

async function seedSale(db: Parameters<typeof createPendingSale>[0], suffix = "1") {
  const id = randomUUID();
  const sale = await createPendingSale(db, {
    id,
    internalReference: `FS-test-${suffix}-${id}`,
    currencyCode: "USD",
    grossAmountMinor: 500,
  });
  const orderId = suffix === "1" ? "ORDER123456" : `ORDER${suffix}123456`;
  await attachPayPalOrder(db, sale.id, orderId, "CREATED");
  return sale;
}

describe("PayPal persistence and reconciliation", () => {
  it("preserves the server-selected outlet association", async () => {
    const testDb = await createTestDatabase();
    try {
      const sale = await seedSale(testDb.db);
      expect(sale.outletId).toBe(DEMO_OUTLET_ID);
    } finally {
      await testDb.close();
    }
  });

  it("uniquely constrains PayPal capture IDs", async () => {
    const testDb = await createTestDatabase();
    try {
      const first = await seedSale(testDb.db, "A");
      const second = await seedSale(testDb.db, "B");
      await attachPayPalCapture(testDb.db, first.id, {
        captureId: "CAPTURE-DUPLICATE",
        status: "PENDING",
      });
      await expect(
        attachPayPalCapture(testDb.db, second.id, {
          captureId: "CAPTURE-DUPLICATE",
          status: "PENDING",
        }),
      ).rejects.toThrow();
    } finally {
      await testDb.close();
    }
  });

  it("marks a completed capture verified only after provider reconciliation", async () => {
    const testDb = await createTestDatabase();
    try {
      const sale = await seedSale(testDb.db);
      await attachPayPalCapture(testDb.db, sale.id, {
        captureId: "CAPTURE123456",
        status: "COMPLETED",
      });
      expect((await getSaleByCaptureId(testDb.db, "CAPTURE123456"))?.verificationState).toBe("PENDING");

      const reconciled = await reconcileCapture(testDb.db, createFakePayPalAdapter(), "CAPTURE123456");
      expect(reconciled).toMatchObject({
        verificationState: "VERIFIED",
        reconciliationState: "RECONCILED",
        outletId: DEMO_OUTLET_ID,
      });
    } finally {
      await testDb.close();
    }
  });

  it.each(["PENDING", "FAILED", "DECLINED", "REFUNDED", "PARTIALLY_REFUNDED"] as const)(
    "does not verify a reconciled %s capture",
    async (status) => {
      const testDb = await createTestDatabase();
      try {
        const sale = await seedSale(testDb.db);
        await attachPayPalCapture(testDb.db, sale.id, {
          captureId: "CAPTURE123456",
          status,
        });
        const paypal = createFakePayPalAdapter({
          async getCapture() {
            return {
              id: "CAPTURE123456",
              status,
              amount: { currency_code: "USD", value: "5.00" },
              supplementary_data: { related_ids: { order_id: "ORDER1123456" } },
            };
          },
        });
        const reconciled = await reconcileCapture(testDb.db, paypal, "CAPTURE123456");
        expect(reconciled?.verificationState).not.toBe("VERIFIED");
      } finally {
        await testDb.close();
      }
    },
  );
});
