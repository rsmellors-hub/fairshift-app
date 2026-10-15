import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import ManagerPage from "@/app/manager/page";
import { ManagerWorkspace } from "@/app/manager/workspace";
import { getConfigurationStatus } from "@/server/config/env";
import { DEMO_OUTLET_ID } from "@/server/constants";
import { getDatabase } from "@/server/db/client";
import { listDemoOutletTransactions } from "@/server/db/repository";
import { outlets, saleTransactions } from "@/server/db/schema";
import { DEMO_AS_OF, seedDemoHistory } from "@/server/intelligence/demo";
import { getManagerForecast } from "@/server/intelligence/manager";
import { ManagerForecast } from "@/app/components/manager-forecast";
import { createTestDatabase } from "../helpers/database";

vi.mock("@/server/db/client", () => ({ getDatabase: vi.fn() }));
vi.mock("@/server/config/env", () => ({ getConfigurationStatus: vi.fn() }));

describe("persisted commercial history to manager output", () => {
  it("seeds idempotently in the normalized table and renders an explainable demo recommendation", async () => {
    const testDb = await createTestDatabase();
    try {
      expect(await seedDemoHistory(testDb.db)).toMatchObject({ inserted: 3704, expected: 3704 });
      expect(await seedDemoHistory(testDb.db)).toMatchObject({ inserted: 0 });
      const result = await getManagerForecast(testDb.db, DEMO_AS_OF);
      expect(result).toMatchObject({
        status: "AVAILABLE", source: "DEMO_SEEDED", eligibleDays: 56, eligibleTransactions: 3704,
        staffing: { workers: 8, workerDelta: 3 },
      });
      const rows = await testDb.db.select().from(saleTransactions);
      expect(rows.every((row) => row.source === "DEMO_SEEDED" && row.verificationState === "PENDING" &&
        row.paypalCaptureId === null && row.paypalOrderId === null && row.paypalCustomId === null)).toBe(true);
      expect(await listDemoOutletTransactions(testDb.db)).toHaveLength(0);

      vi.mocked(getDatabase).mockReturnValue(testDb.db);
      vi.mocked(getConfigurationStatus).mockReturnValue({
        databaseConfigured: true, paypalConfigured: false, paypalPayoutConfigured: false, aiConfigured: false, environment: "NOT CONFIGURED", currency: "USD", amount: "5.00",
      });
      const html = renderToStaticMarkup(await ManagerWorkspace({ area: "plan" }));
      expect(html).toContain("Demo / seeded · not PayPal verified");
      expect(html).toContain("Recommended worker delta");
      expect(html).toContain("+3");
      expect(html).toContain("Historical evidence");
      expect(html).toContain("comparison assumption, not a saved plan");
      expect(html).toContain("comparable-days-recency-v1");
      expect(html).toContain("not a calibrated confidence interval");
      expect(html).toContain("Coverage requirements");
      expect(html).not.toContain("Approve incentive");
    } finally {
      vi.resetAllMocks();
      await testDb.close();
    }
  });

  it("prefers eligible verified PayPal sales without mixing demo, other currencies or other outlets", async () => {
    const testDb = await createTestDatabase();
    try {
      await seedDemoHistory(testDb.db);
      const otherOutlet = randomUUID();
      const [outlet] = await testDb.db.select().from(outlets).where(eq(outlets.id, DEMO_OUTLET_ID));
      await testDb.db.insert(outlets).values({
        id: otherOutlet, organisationId: outlet.organisationId, name: "Other outlet", timezone: outlet.timezone,
      });
      for (const [outletId, currencyCode, amount] of [
        [DEMO_OUTLET_ID, "USD", 160001], [DEMO_OUTLET_ID, "EUR", 900000], [otherOutlet, "USD", 900000],
      ] as const) {
        const id = randomUUID();
        await testDb.db.insert(saleTransactions).values({
          id, internalReference: id, paypalCustomId: id, outletId, currencyCode,
          source: "PAYPAL_SANDBOX", grossAmountMinor: amount, paypalCaptureId: `TEST-${id}`,
          paypalOrderId: `ORDER-${id}`, providerCreatedAt: new Date("2026-10-13T10:00:00Z"),
          providerStatus: "COMPLETED", verificationState: "VERIFIED", reconciliationState: "RECONCILED",
        });
      }
      const result = await getManagerForecast(testDb.db, DEMO_AS_OF);
      expect(result).toMatchObject({ source: "PAYPAL_SANDBOX", forecastSalesMinor: 160001, eligibleTransactions: 1, staffing: { workers: 3, workerDelta: -2 } });
      const html = renderToStaticMarkup(createElement(ManagerForecast, { result }));
      expect(html).toContain("Historical fact · verified PayPal Sandbox sales");
      expect(html).not.toContain("Fixed synthetic scenario");
      // These are test fixtures, not live PayPal evidence.
    } finally {
      await testDb.close();
    }
  });

  it("enforces seed provenance and preserves PayPal reference and outlet foreign-key constraints", async () => {
    const testDb = await createTestDatabase();
    try {
      const base = {
        id: randomUUID(), internalReference: "DEMO-CONSTRAINT", outletId: DEMO_OUTLET_ID,
        source: "DEMO_SEEDED", currencyCode: "USD", grossAmountMinor: 100,
        providerStatus: "DEMO_SEEDED", verificationState: "PENDING", reconciliationState: "NOT_RECONCILED",
      };
      for (const invalid of [
        { verificationState: "VERIFIED" }, { paypalCaptureId: "FAKE" }, { paypalOrderId: "FAKE" },
        { paypalCustomId: "FAKE" }, { source: "UNKNOWN" }, { outletId: randomUUID() },
        { source: "PAYPAL_SANDBOX" },
      ]) await expect(testDb.db.insert(saleTransactions).values({ ...base, ...invalid })).rejects.toThrow();
      await testDb.db.insert(saleTransactions).values(base);
      await expect(testDb.db.insert(saleTransactions).values({ ...base, id: randomUUID() })).rejects.toThrow();
    } finally {
      await testDb.close();
    }
  });

  it("renders missing history and unavailable database clearly without fabricated numbers", async () => {
    const testDb = await createTestDatabase();
    try {
      const result = await getManagerForecast(testDb.db, DEMO_AS_OF);
      expect(result.status).toBe("UNAVAILABLE");
      expect(renderToStaticMarkup(createElement(ManagerForecast, { result }))).toContain("No eligible completed sales");
      vi.mocked(getConfigurationStatus).mockReturnValue({
        databaseConfigured: false, paypalConfigured: false, paypalPayoutConfigured: false, aiConfigured: false, environment: "NOT CONFIGURED", currency: "USD", amount: "5.00",
      });
      expect(renderToStaticMarkup(await ManagerPage())).toContain("Workspace information is unavailable");
      expect(getDatabase).not.toHaveBeenCalled();
    } finally {
      vi.resetAllMocks();
      await testDb.close();
    }
  });
});
