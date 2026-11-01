import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../helpers/database";
import type { Scope } from "@/server/auth/access";
import { DEMO_ORGANISATION_ID, DEMO_OUTLET_ID } from "@/server/constants";
import { organisations, outlets, saleTransactions } from "@/server/db/schema";
import { seedDemoHistory } from "@/server/intelligence/demo";
import { forecastFromHistory } from "@/server/intelligence/forecast";
import { getWeeklyForecast } from "@/server/intelligence/weekly";
import { getManagerForecast } from "@/server/intelligence/manager";
import { ManagerForecast } from "@/app/components/manager-forecast";
import { provisionReferenceHistory } from "@/server/reference/provision";
import { REFERENCE_STORE_CODES, referenceDates, referenceTradingDay } from "@/server/reference/uk-retail";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OwnerWeeklyForecast } from "@/app/owner/weekly-forecast";
import { OwnerOverview } from "@/app/owner/overview";
import { getOwnerOverview, ownerForecastSummary } from "@/server/product/owner-overview";

type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];
const NOW = new Date("2026-10-25T10:00:00Z");
// NOW is Sunday 25 Oct 2026 in London (the day BST ends); planning starts tomorrow.
const WEEK = ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"];

async function referenceCompany(db: Db, from = "2025-11-03") {
  const organisationId = randomUUID();
  await db.insert(organisations).values({ id: organisationId, name: "Weekly forecast company" });
  const rows = REFERENCE_STORE_CODES.map((code, i) => ({ id: randomUUID(), organisationId, name: `${i + 1} ${code} store`, timezone: "Europe/London" }));
  await db.insert(outlets).values(rows);
  const mapping = Object.fromEntries(REFERENCE_STORE_CODES.map((code, i) => [code, rows[i].id])) as Record<typeof REFERENCE_STORE_CODES[number], string>;
  await provisionReferenceHistory(db, { organisationId, outlets: mapping, from, through: "2025-12-28" });
  const owner: Scope = { userId: randomUUID(), organisationId, locationId: rows[0].id, role: "OWNER", organisationName: "Weekly", locationName: rows[0].name };
  return { organisationId, rows, mapping, owner };
}

describe("weekly demand forecast", () => {
  it("forecasts seven days for each of five outlets from reference history, deterministically and in GBP", async () => {
    const t = await createTestDatabase();
    try {
      const c = await referenceCompany(t.db);
      const weekly = await getWeeklyForecast(t.db, c.owner, NOW);
      expect(weekly.outlets).toHaveLength(5);
      for (const [i, outlet] of weekly.outlets.entries()) {
        expect(outlet.selection).toMatchObject({ status: "SELECTED", source: "REFERENCE", currency: "GBP", kind: "HISTORICAL", dataThrough: "2025-12-28", firstTarget: "2026-10-26" });
        expect(outlet.days.map(day => day.targetDate)).toEqual(WEEK);
        expect(outlet.days.every(day => day.forecast && day.forecast.lowerSalesMinor <= day.forecast.forecastSalesMinor && day.forecast.forecastSalesMinor <= day.forecast.upperSalesMinor)).toBe(true);
        expect(outlet.weeklyTotalMinor).toBe(outlet.days.reduce((sum, day) => sum + day.forecast!.forecastSalesMinor, 0));
        // Independent check: the generator's own daily totals give the same forecast as the database path.
        const code = REFERENCE_STORE_CODES[i];
        const days = referenceDates("2025-11-03", "2025-12-28").map(date => referenceTradingDay(code, date)).filter(day => day.open)
          .map(day => ({ date: day.date, salesMinor: day.open ? day.salesMinor : 0, transactions: day.open ? day.transactions : 0 }));
        expect(outlet.days[0].forecast).toEqual(forecastFromHistory({ days, dataThrough: "2025-12-28", targetDate: WEEK[0] }));
      }
      expect(new Set(weekly.outlets.map(outlet => outlet.weeklyTotalMinor)).size).toBe(5);
      expect(weekly.consolidated).toMatchObject({ source: "REFERENCE", currency: "GBP", dataThrough: "2025-12-28", firstTarget: "2026-10-26", dataThroughConsistent: true });
      expect(weekly.consolidated!.totalMinor).toBe(weekly.outlets.reduce((sum, outlet) => sum + outlet.weeklyTotalMinor!, 0));
      expect(await getWeeklyForecast(t.db, c.owner, NOW)).toEqual(weekly);
      // The planning week follows the injected clock; the evidence keeps its own date.
      expect((await getWeeklyForecast(t.db, c.owner, new Date("2027-03-01T10:00:00Z"))).consolidated).toMatchObject({ firstTarget: "2027-03-02", dataThrough: "2025-12-28" });
    } finally { await t.close(); }
  }, 180_000);

  it("keeps a handful of provider sales from replacing reference history", async () => {
    const t = await createTestDatabase();
    try {
      const c = await referenceCompany(t.db, "2025-12-01");
      const id = randomUUID();
      await t.db.insert(saleTransactions).values({ id, internalReference: id, paypalCustomId: id, outletId: c.mapping.UK01, currencyCode: "GBP",
        source: "PAYPAL_SANDBOX", grossAmountMinor: 99_999_999, paypalCaptureId: `TEST-${id}`, paypalOrderId: `ORDER-${id}`,
        providerCreatedAt: new Date("2026-10-24T12:00:00Z"), providerStatus: "COMPLETED", verificationState: "VERIFIED", reconciliationState: "RECONCILED" });
      const uk01 = (await getWeeklyForecast(t.db, c.owner, NOW)).outlets.find(outlet => outlet.outletId === c.mapping.UK01)!;
      expect(uk01.selection).toMatchObject({ source: "REFERENCE", rejected: [{ source: "PAYPAL_SANDBOX", reason: "INSUFFICIENT_DAYS" }] });
      expect(uk01.days.every(day => day.forecast!.forecastSalesMinor < 99_999_999)).toBe(true);
    } finally { await t.close(); }
  }, 180_000);

  it("shows missing history as unavailable, not zero, and withholds a mixed company total", async () => {
    const t = await createTestDatabase();
    try {
      const c = await referenceCompany(t.db, "2025-12-15");
      const empty = randomUUID();
      await t.db.insert(outlets).values({ id: empty, organisationId: c.organisationId, name: "0 New store", timezone: "Europe/London" });
      const weekly = await getWeeklyForecast(t.db, c.owner, NOW);
      const missing = weekly.outlets.find(outlet => outlet.outletId === empty)!;
      expect(missing).toMatchObject({ selection: { status: "NONE" }, days: [], weeklyTotalMinor: null });
      expect(weekly.consolidated).toBeNull();
      const none = await getWeeklyForecast(t.db, { ...c.owner, role: "MANAGER", locationId: empty }, NOW);
      const html = renderToStaticMarkup(createElement(OwnerWeeklyForecast, { weekly: none }));
      expect(html).toContain("No location has eligible sales history yet.");
      expect(html).not.toContain("Varies by location");
      expect(html).not.toContain("Not combined");
    } finally { await t.close(); }
  }, 180_000);

  it("scopes outlets to the authorised organisation and manager location, and rejects workers", async () => {
    const t = await createTestDatabase();
    try {
      const c = await referenceCompany(t.db, "2025-12-22");
      const otherId = randomUUID();
      await t.db.insert(organisations).values({ id: otherId, name: "Other company" });
      const other = await getWeeklyForecast(t.db, { ...c.owner, organisationId: otherId }, NOW);
      expect(other.outlets).toEqual([]);
      expect(other.consolidated).toBeNull();
      const manager = await getWeeklyForecast(t.db, { ...c.owner, role: "MANAGER", locationId: c.mapping.UK03 }, NOW);
      expect(manager.outlets.map(outlet => outlet.outletId)).toEqual([c.mapping.UK03]);
      // A location ID from another organisation yields nothing.
      expect((await getWeeklyForecast(t.db, { ...c.owner, organisationId: otherId, role: "MANAGER", locationId: c.mapping.UK03 }, NOW)).outlets).toEqual([]);
      await expect(getWeeklyForecast(t.db, { ...c.owner, role: "TEAM_MEMBER" }, NOW)).rejects.toThrow("Access denied");
    } finally { await t.close(); }
  }, 180_000);

  it("plans the legacy demo history for the real next seven days, keeping its data-through date", async () => {
    const t = await createTestDatabase();
    try {
      await seedDemoHistory(t.db);
      const weekly = await getWeeklyForecast(t.db, { userId: randomUUID(), organisationId: DEMO_ORGANISATION_ID, locationId: DEMO_OUTLET_ID, role: "OWNER", organisationName: "Demo", locationName: "Rosebank Kitchen" }, NOW);
      expect(weekly.outlets[0].selection).toMatchObject({ source: "DEMO_SEEDED", currency: "USD", dataThrough: "2026-10-14", firstTarget: "2026-10-26" });
      expect(weekly.outlets[0].days).toHaveLength(7);
    } finally { await t.close(); }
  }, 180_000);

  it("renders the weekly forecast and overview summary with provenance, GBP and no AI claims", async () => {
    const t = await createTestDatabase();
    try {
      const c = await referenceCompany(t.db, "2025-12-01");
      const empty = randomUUID();
      const weekly = await getWeeklyForecast(t.db, c.owner, NOW);
      let html = renderToStaticMarkup(createElement(OwnerWeeklyForecast, { weekly }));
      for (const header of ["Mon 26 Oct", "Tue 27 Oct", "Wed 28 Oct", "Thu 29 Oct", "Fri 30 Oct", "Sat 31 Oct", "Sun 1 Nov"]) expect(html).toContain(`>${header}</th>`);
      for (const row of c.rows) expect(html).toContain(`<strong>${row.name}</strong>`);
      expect(html).toContain("Reference sales history · GBP · data through Sun, 28 Dec 2025");
      expect(html).toContain("Forecast from historical evidence");
      expect(html).toContain("Reference sales history is labelled synthetic input, through Sun, 28 Dec 2025.");
      expect(html).toContain("Historical evidence through Sun, 28 Dec 2025");
      expect(html).toContain("Mon, 26 Oct 2026 – Sun, 1 Nov 2026");
      expect(html).toContain("does not describe current trading");
      expect(html).toContain("All locations");
      // Staffing not supplied to the component: no staffing section and no zero gap.
      expect(html).not.toContain("Staffing by location");
      expect(html).toContain("No AI is used in this forecast");
      expect(html).toContain("£");
      expect(html).not.toContain("$");
      expect(html).not.toMatch(/recommended workers|staffing gap of|AI forecast|Zettle sales|live sales/i);

      const data = await getOwnerOverview(t.db, c.owner);
      html = renderToStaticMarkup(createElement(OwnerOverview, { data, forecast: ownerForecastSummary(weekly) }));
      expect(html).toContain("Next 7 days · from reference history through 28 Dec 2025");
      expect(html).toContain("Weekly forecast");
      html = renderToStaticMarkup(createElement(OwnerOverview, { data, forecast: null }));
      expect(html).toContain("The weekly forecast could not be loaded. No demand has been assumed.");
      expect(html).not.toContain("Forecast · week from");

      await t.db.insert(outlets).values({ id: empty, organisationId: c.organisationId, name: "0 New store", timezone: "Europe/London" });
      const partial = await getWeeklyForecast(t.db, c.owner, NOW);
      html = renderToStaticMarkup(createElement(OwnerWeeklyForecast, { weekly: partial }));
      expect(html).toContain("No forecast: no eligible sales history. No demand has been assumed.");
      expect(html).toContain("Not combined");
      expect(html).not.toContain("All locations</th>");
      html = renderToStaticMarkup(createElement(OwnerOverview, { data: await getOwnerOverview(t.db, c.owner), forecast: ownerForecastSummary(partial) }));
      expect(html).toContain("5 of 6 locations forecast separately");
      html = renderToStaticMarkup(createElement(OwnerWeeklyForecast, { weekly: null }));
      expect(html).toContain('role="alert"');
      expect(html).toContain("No demand has been assumed");
    } finally { await t.close(); }
  }, 180_000);

  it("gives a manager of a reference location no single-day worker figure from the USD-only demonstration policy", async () => {
    const t = await createTestDatabase();
    try {
      const c = await referenceCompany(t.db, "2025-12-15");
      const result = await getManagerForecast(t.db, NOW, { organisationId: c.organisationId, locationId: c.mapping.UK02 });
      expect(result).toMatchObject({ status: "UNAVAILABLE", reason: "NO_STAFFING_POLICY_FOR_CURRENCY", source: "REFERENCE", currency: "GBP", targetDate: "2026-10-26" });
      const html = renderToStaticMarkup(createElement(ManagerForecast, { result }));
      expect(html).toContain("demonstration worker estimate is defined in USD");
      expect(html).not.toContain("Recommended workers");
    } finally { await t.close(); }
  }, 180_000);
});
