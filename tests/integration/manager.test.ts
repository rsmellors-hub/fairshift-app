import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import ManagerPage from "@/app/manager/page";
import { ManagerWorkspace } from "@/app/manager/workspace";
import { getConfigurationStatus } from "@/server/config/env";
import { DEMO_ORGANISATION_ID, DEMO_OUTLET_ID } from "@/server/constants";
import { getDatabase } from "@/server/db/client";
import { listDemoOutletTransactions } from "@/server/db/repository";
import { outlets, saleTransactions } from "@/server/db/schema";
import { DEMO_AS_OF, seedDemoHistory } from "@/server/intelligence/demo";
import { getManagerForecast as scopedGetManagerForecast } from "@/server/intelligence/manager";
import { ManagerForecast } from "@/app/components/manager-forecast";
import { createTestDatabase } from "../helpers/database";

vi.mock("@/server/auth/request",()=>({requireScope:async()=>({userId:"90000000-0000-4000-8000-000000000001",organisationId:"10000000-0000-4000-8000-000000000001",locationId:"20000000-0000-4000-8000-000000000001",role:"MANAGER",organisationName:"Demo",locationName:"Rosebank Kitchen"})}));
vi.mock("@/server/db/client", () => ({ getDatabase: vi.fn() }));
vi.mock("@/server/config/env", () => ({ getConfigurationStatus: vi.fn() }));
vi.mock("@/server/demo/config", () => ({ demoConfig: () => ({ organisationId: "10000000-0000-4000-8000-000000000001" }) }));

const demoScope = { organisationId: DEMO_ORGANISATION_ID, locationId: DEMO_OUTLET_ID, demo: { persona: "MANAGER" as const, group: "isolated-test" } };
const getManagerForecast = (db: Awaited<ReturnType<typeof createTestDatabase>>["db"], now: Date) => scopedGetManagerForecast(db, now, demoScope);

describe("persisted commercial history to manager output", () => {
  it("seeds idempotently in the normalized table and renders an explainable demo recommendation", async () => {
    const testDb = await createTestDatabase();
    try {
      expect(await seedDemoHistory(testDb.db)).toMatchObject({ inserted: 3704, expected: 3704 });
      expect(await seedDemoHistory(testDb.db)).toMatchObject({ inserted: 0 });
      const result = await getManagerForecast(testDb.db, DEMO_AS_OF);
      // Historical evidence plans the next local day (tomorrow), keeping its own data-through date.
      expect(result).toMatchObject({
        status: "AVAILABLE", source: "DEMO_SEEDED", eligibleDays: 56, eligibleTransactions: 3704,
        targetDate: "2026-10-16", dataAsOf: "2026-10-14T22:00:00.000Z",
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
      // The page plans from the current date; pin only Date so the rendered week is deterministic.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(DEMO_AS_OF);
      let html: string;
      try { html = renderToStaticMarkup(await ManagerWorkspace({ area: "plan" })); } finally { vi.useRealTimers(); }
      // The legacy single-day worker estimate is no longer on the page; weekly staffing is authoritative.
      expect(html).not.toContain("Recommended worker delta");
      expect(html).not.toContain("Single-day demand forecast");
      const singleDay = renderToStaticMarkup(createElement(ManagerForecast, { result }));
      expect(singleDay).toContain("Demo / seeded · not PayPal verified");
      expect(singleDay).toContain("Recommended worker delta");
      expect(singleDay).toContain("+3");
      expect(singleDay).toContain("forecast for 2026-10-16");
      // Planning-week staffing for the demo location: nothing is configured, so no requirement is invented.
      expect(html).toContain("Planning week Fri, 16 Oct 2026 – Thu, 22 Oct 2026");
      expect(html).toContain("Configuration required");
      expect(html).toContain("service capacity and minimum cover");
      expect(html).not.toMatch(/Casual labour gap<\/span><strong>/);
      expect(html).toContain("No eligible sales history");
      expect(singleDay).toContain("comparison assumption, not a saved plan");
      expect(singleDay).toContain("comparable-days-recency-v1");
      expect(singleDay).toContain("not a calibrated confidence interval");
      expect(html).toContain("/manager/fill");
      expect(html).not.toContain("Approve incentive");
    } finally {
      vi.resetAllMocks();
      await testDb.close();
    }
  });

  it("prefers verified PayPal sales only once eligible, without mixing demo, other currencies or other outlets", async () => {
    const testDb = await createTestDatabase();
    try {
      await seedDemoHistory(testDb.db);
      const otherOutlet = randomUUID();
      const [outlet] = await testDb.db.select().from(outlets).where(eq(outlets.id, DEMO_OUTLET_ID));
      await testDb.db.insert(outlets).values({
        id: otherOutlet, organisationId: outlet.organisationId, name: "Other outlet", timezone: outlet.timezone,
      });
      const verified = async (outletId: string, currencyCode: string, amount: number, date: string) => {
        const id = randomUUID();
        await testDb.db.insert(saleTransactions).values({
          id, internalReference: id, paypalCustomId: id, outletId, currencyCode,
          source: "PAYPAL_SANDBOX", grossAmountMinor: amount, paypalCaptureId: `TEST-${id}`,
          paypalOrderId: `ORDER-${id}`, providerCreatedAt: new Date(`${date}T10:00:00Z`),
          providerStatus: "COMPLETED", verificationState: "VERIFIED", reconciliationState: "RECONCILED",
        });
      };
      // One verified capture must never replace a complete history.
      await verified(DEMO_OUTLET_ID, "USD", 160001, "2026-10-13");
      expect(await getManagerForecast(testDb.db, DEMO_AS_OF)).toMatchObject({ source: "DEMO_SEEDED", eligibleTransactions: 3704 });
      // 44 consecutive fresh days (every weekday at least six times) make the provider eligible.
      for (let day = 0; day < 44; day++) {
        const date = new Date(Date.UTC(2026, 8, 1 + day)).toISOString().slice(0, 10);
        if (date !== "2026-10-13") await verified(DEMO_OUTLET_ID, "USD", 160001, date);
        await verified(DEMO_OUTLET_ID, "EUR", 900000, date);
        await verified(otherOutlet, "USD", 900000, date);
      }
      const result = await getManagerForecast(testDb.db, DEMO_AS_OF);
      expect(result).toMatchObject({ source: "PAYPAL_SANDBOX", currency: "USD", targetDate: "2026-10-16", forecastSalesMinor: 160001, eligibleDays: 44, eligibleTransactions: 44, staffing: { workers: 3, workerDelta: -2 } });
      const html = renderToStaticMarkup(createElement(ManagerForecast, { result }));
      expect(html).toContain("Historical fact · verified PayPal Sandbox sales");
      expect(html).not.toContain("Synthetic history");
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
      expect(renderToStaticMarkup(await ManagerPage({}))).toContain("Workspace information is unavailable");
      expect(getDatabase).not.toHaveBeenCalled();
    } finally {
      vi.resetAllMocks();
      await testDb.close();
    }
  });
});
