import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { DEMO_ORGANISATION_ID, DEMO_OUTLET_ID } from "@/server/constants";
import type { Scope } from "@/server/auth/access";
import { organisations, outlets, saleTransactions, shiftIncentives, workers } from "@/server/db/schema";
import { getOwnerOverview } from "@/server/product/owner-overview";
import { seedDemoHistory } from "@/server/intelligence/demo";
import { OwnerOverview } from "@/app/owner/overview";
import { acceptDemoShift, publishDemoShift } from "@/server/scheduling/demo";
import { approveDemoIncentive, markDemoShiftCompleted, recordDemoPerformance } from "@/server/incentives/demo";

const scope: Scope = { userId: randomUUID(), organisationId: DEMO_ORGANISATION_ID, locationId: DEMO_OUTLET_ID, role: "OWNER", organisationName: "Demo", locationName: "Rosebank Kitchen" };
type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];
async function receipt(db: Db, outletId: string, amount: number, date: string, currency = "USD", verified = false) {
  await db.insert(saleTransactions).values({ id: randomUUID(), internalReference: randomUUID(), outletId,
    grossAmountMinor: amount, currencyCode: currency, createdAt: new Date(date),
    source: verified ? "PAYPAL_SANDBOX" : "DEMO_SEEDED", providerStatus: verified ? "COMPLETED" : "DEMO_SEEDED",
    verificationState: verified ? "VERIFIED" : "PENDING", reconciliationState: verified ? "RECONCILED" : "NOT_RECONCILED",
    paypalCustomId: verified ? randomUUID() : null, paypalCaptureId: verified ? randomUUID() : null,
    providerCreatedAt: verified ? new Date(date) : null,
  });
}

describe("Owner Overview scoped evidence", () => {
  it("uses the authorised demo history and its actual single location, with an independently checked dated total", async () => {
    const t = await createTestDatabase();
    try {
      await seedDemoHistory(t.db);
      const data = await getOwnerOverview(t.db, scope);
      expect(data.locations).toHaveLength(1);
      expect(data.series).toHaveLength(1);
      expect(data.series[0]).toMatchObject({ source: "DEMO_SEEDED", currency: "USD", start: "2026-10-08", end: "2026-10-14" });
      const expected = await t.db.execute(sql`select sum(gross_amount_minor)::int as total from sale_transactions where outlet_id = ${DEMO_OUTLET_ID} and created_at >= '2026-10-07T22:00:00Z' and created_at < '2026-10-14T22:00:00Z'`);
      expect(data.series[0].totalMinor).toBe(expected.rows[0].total);
      const html = renderToStaticMarkup(createElement(OwnerOverview, { data }));
      expect(html).toContain("Synthetic demo sales, not provider-verified commerce");
      expect(html).not.toContain("All Locations");
      expect(html).toContain("Not calculated");
      expect(html).not.toContain("Covered");
    } finally { await t.close(); }
  });

  it("keeps missing dates unknown, genuine zero receipts visible, and sources/currencies separate", async () => {
    const t = await createTestDatabase();
    try {
      await receipt(t.db, DEMO_OUTLET_ID, 0, "2026-10-10T22:30:00Z"); // 11 Oct locally
      await receipt(t.db, DEMO_OUTLET_ID, 1500, "2026-10-14T12:00:00Z");
      await receipt(t.db, DEMO_OUTLET_ID, 2500, "2026-10-14T12:00:00Z", "GBP");
      await receipt(t.db, DEMO_OUTLET_ID, 4000, "2026-10-14T12:00:00Z", "USD", true);
      // An unverified provider row must never count as factual revenue.
      await t.db.insert(saleTransactions).values({ id: randomUUID(), internalReference: randomUUID(), outletId: DEMO_OUTLET_ID, grossAmountMinor: 999999, currencyCode: "USD", paypalCustomId: randomUUID() });
      const data = await getOwnerOverview(t.db, scope);
      expect(data.series).toHaveLength(3);
      expect(data.series.find(row => row.key === "PAYPAL_SANDBOX:USD")?.totalMinor).toBe(4000);
      const demo = data.series.find(row => row.key === "DEMO_SEEDED:USD")!;
      expect(demo.totalMinor).toBe(1500);
      expect(demo.days.find(row => row.date === "2026-10-11")?.amountMinor).toBe(0);
      expect(demo.days.find(row => row.date === "2026-10-12")?.amountMinor).toBeNull();
      expect(demo.locations[0].observedDays).toBe(2);
      const html = renderToStaticMarkup(createElement(OwnerOverview, { data }));
      expect(html).toContain("Actual · PayPal Sandbox");
      expect(html).toContain("Forecast sales");
      expect(html).toContain("Company weekly forecast is not available yet");
    } finally { await t.close(); }
  });

  it("renders exactly five locations when persisted for the authorised test organisation, without leaking another tenant", async () => {
    const t = await createTestDatabase();
    try {
      const organisationId = randomUUID();
      await t.db.insert(organisations).values({ id: organisationId, name: "Five-location test fixture" });
      const locations = Array.from({ length: 5 }, (_, i) => ({ id: randomUUID(), organisationId, name: `Test location ${i + 1}`, timezone: "UTC" }));
      await t.db.insert(outlets).values(locations);
      await receipt(t.db, locations[0].id, 12300, "2026-10-14T12:00:00Z");
      await receipt(t.db, DEMO_OUTLET_ID, 888888, "2026-10-14T12:00:00Z");
      const data = await getOwnerOverview(t.db, { ...scope, organisationId, locationId: locations[0].id, locationName: locations[0].name });
      expect(data.locations).toHaveLength(5);
      expect(data.series[0].totalMinor).toBe(12300);
      expect(data.series[0].locations[1].amountMinor).toBeNull();
      const html = renderToStaticMarkup(createElement(OwnerOverview, { data }));
      expect(html).toContain("All Locations");
      for (const location of locations) expect(html).toContain(`<strong>${location.name}</strong>`);
      expect(html).not.toContain("Rosebank Kitchen");
      expect(html).not.toContain('href="/owner/locations/');
    } finally { await t.close(); }
  });

  it("derives attention from persisted earned/failed incentives and removes an item after approval", async () => {
    const t = await createTestDatabase();
    try {
      const current = await publishDemoShift(t.db);
      await acceptDemoShift(t.db, current.shift.id, true, current.shift.termsVersion);
      await markDemoShiftCompleted(t.db, current.shift.id);
      const result = await recordDemoPerformance(t.db, 72000, current.shift.id);
      let data = await getOwnerOverview(t.db, scope);
      expect(data.attention).toHaveLength(1);
      expect(data.attention![0]).toMatchObject({ id: result.id, status: "EARNED", locationName: "Rosebank Kitchen", date: current.shift.shiftDate });
      expect(renderToStaticMarkup(createElement(OwnerOverview, { data }))).toContain("Incentive awaiting manager approval");
      const organisationId = randomUUID();
      await t.db.insert(organisations).values({ id: organisationId, name: "Other company" });
      expect((await getOwnerOverview(t.db, { ...scope, organisationId })).attention).toEqual([]);
      await approveDemoIncentive(t.db, result.id);
      expect((await getOwnerOverview(t.db, scope)).attention).toEqual([]);
      await t.db.update(shiftIncentives).set({ status: "FAILED" }).where(eq(shiftIncentives.id, result.id));
      data = await getOwnerOverview(t.db, scope);
      expect(renderToStaticMarkup(createElement(OwnerOverview, { data }))).toContain("Incentive payment failed");
      // Inconsistent worker/location data is excluded, even inside one organisation.
      await t.db.update(workers).set({ locationId: null }).where(eq(workers.id, current.worker.id));
      expect((await getOwnerOverview(t.db, scope)).attention).toEqual([]);
    } finally { await t.close(); }
  });

  it("preserves locations and attention if the sales query fails, and sales if attention fails", async () => {
    const t = await createTestDatabase();
    try {
      await receipt(t.db, DEMO_OUTLET_ID, 1000, "2026-10-14T12:00:00Z");
      await t.db.execute(sql`alter table sale_transactions rename to unavailable_sales`);
      let data = await getOwnerOverview(t.db, scope);
      expect(data.salesUnavailable).toBe(true);
      expect(data.locations).toHaveLength(1);
      expect(data.attention).toEqual([]);
      expect(renderToStaticMarkup(createElement(OwnerOverview, { data }))).toContain("Sales could not be loaded");
      await t.db.execute(sql`alter table unavailable_sales rename to sale_transactions`);
      await t.db.execute(sql`alter table shift_incentives rename to unavailable_incentives`);
      data = await getOwnerOverview(t.db, scope);
      expect(data.attention).toBeNull();
      expect(data.series[0].totalMinor).toBe(1000);
      expect(renderToStaticMarkup(createElement(OwnerOverview, { data }))).toContain("Payment attention could not be loaded");
    } finally { await t.close(); }
  });

  it("rejects Manager and Worker authority before reading Owner data", async () => {
    const t = await createTestDatabase();
    try {
      for (const role of ["MANAGER", "TEAM_MEMBER"] as const) await expect(getOwnerOverview(t.db, { ...scope, role })).rejects.toThrow("Access denied");
    } finally { await t.close(); }
  });
});
