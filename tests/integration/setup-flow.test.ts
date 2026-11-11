import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { entitled } from "../helpers/onboarding";
import { resolveScope } from "@/server/auth/access";
import { createIdentityToken, redeemIdentityToken, registerIdentity } from "@/server/auth/identity";
import { createBusinessShell } from "@/server/auth/tenancy";
import { memberships, organisations, outletTradingHours, outlets, saleTransactions, subscriptions, workloadPolicies } from "@/server/db/schema";
import { loadDailySales } from "@/server/intelligence/sales-history";
import { selectForecastSource } from "@/server/intelligence/weekly";
import { saveSetupVenue, setupProgress } from "@/server/onboarding/setup";
import { DEFAULT_HOURS_RULE, DEFAULT_SHIFT_RULES } from "@/server/scheduling/default-rules";
import { loadHoursRule, loadShiftRules } from "@/server/scheduling/shift-rules";
import { generateSampleHistory, importedHistoryLabels, importSalesCsv, SAMPLE_SOURCE_SYSTEM } from "@/server/sales/history-sources";

// Design package §2 (10 Nov 2026): a brand-new business set up from scratch, with no seed data.
type DB = Awaited<ReturnType<typeof createTestDatabase>>["db"];
const NOW = new Date("2026-11-10T08:00:00Z");
const venue = { locationId: null, name: "Gardens", address: "1 Kloof Street", city: "Cape Town", postalCode: "8001", venueType: "CAFE_RESTAURANT", seats: 40,
  customerTypes: ["OFFICE", "TOURISTS"], customerNote: "", trading: Array(7).fill("07:00-17:00"), coverage: Array(7).fill("none"), transactionsPerStaffHour: 7, minimumStaffWhileOpen: 2 };

async function newBusiness(db: DB) {
  const user = await registerIdentity(db, { email: "lindiwe@example.test", password: "a-long-test-password-42" });
  await redeemIdentityToken(db, await createIdentityToken(db, user.id, "VERIFY_EMAIL"), "VERIFY_EMAIL");
  const membership = await createBusinessShell(db, user.id, { name: "Fresh Table", country: "South Africa" });
  return { user, membership, scope: { userId: user.id, organisationId: membership.organisationId, role: "OWNER" } };
}

describe("from-scratch setup", () => {
  it("creates the business with its name and country at sign-up, and sets up the venue only once the trial is active", async () => {
    const t = await createTestDatabase();
    try {
      const b = await newBusiness(t.db);
      expect((await t.db.select().from(organisations).where(eq(organisations.id, b.membership.organisationId)))[0]).toMatchObject({ name: "Fresh Table", country: "South Africa", setupCompletedAt: null });
      expect(await t.db.select().from(subscriptions).where(eq(subscriptions.organisationId, b.membership.organisationId))).toHaveLength(1);
      // Calling again reuses the same business.
      expect((await createBusinessShell(t.db, b.user.id, { name: "Other", country: "South Africa" })).id).toBe(b.membership.id);
      await expect(saveSetupVenue(t.db, b.scope, venue)).rejects.toMatchObject({ feedback: "subscription-required" });
      await entitled(t.db, b.membership.organisationId);
      await t.db.update(organisations).set({ setupCompletedAt: null }).where(eq(organisations.id, b.membership.organisationId));
      await expect(saveSetupVenue(t.db, b.scope, { ...venue, trading: ["07:00-17:00", ...Array(6).fill("")] })).rejects.toMatchObject({ feedback: "trading-hours-invalid" });
      const location = await saveSetupVenue(t.db, b.scope, venue);
      // A new location starts with the default offer settings, and the business with the hours alert (Owner, 11 Nov 2026).
      expect((await loadShiftRules(t.db, b.scope.organisationId, [location.id])).get(location.id)).toMatchObject({ ...DEFAULT_SHIFT_RULES, source: "DEFAULT" });
      expect(await loadHoursRule(t.db, b.scope.organisationId)).toMatchObject({ ...DEFAULT_HOURS_RULE, source: "DEFAULT" });
      expect(location).toMatchObject({ name: "Gardens", country: "South Africa", timezone: "Africa/Johannesburg" });
      expect((await t.db.select().from(outlets).where(eq(outlets.id, location.id)))[0]).toMatchObject({ customerTypes: ["OFFICE", "TOURISTS"], venueType: "CAFE_RESTAURANT", seats: 40 });
      expect((await t.db.select().from(organisations).where(eq(organisations.id, b.membership.organisationId)))[0].setupCompletedAt).toBeInstanceOf(Date);
      expect(await t.db.select().from(outletTradingHours).where(eq(outletTradingHours.outletId, location.id))).toHaveLength(7);
      expect(await t.db.select().from(workloadPolicies).where(and(eq(workloadPolicies.outletId, location.id), eq(workloadPolicies.status, "ACTIVE")))).toHaveLength(1);
      expect(await setupProgress(t.db, b.membership.organisationId, location.id)).toMatchObject({ venue: true, pin: false, sales: false, pay: false });
    } finally { await t.close(); }
  });

  it("builds sample history that a forecast can use, labelled synthetic, and sets it aside once real sales are imported", async () => {
    const t = await createTestDatabase();
    try {
      const b = await newBusiness(t.db);
      await entitled(t.db, b.membership.organisationId);
      const location = await saveSetupVenue(t.db, b.scope, venue);
      const [owner] = await t.db.select().from(memberships).where(eq(memberships.userId, b.user.id));
      const scope = await resolveScope(t.db, b.user.id, owner.id, location.id);
      const sample = await generateSampleHistory(t.db, scope, NOW);
      expect(sample.inserted).toBe(sample.transactions);
      expect(sample.transactions).toBeGreaterThan(56 * 40);
      // Deterministic: running it again adds nothing.
      expect((await generateSampleHistory(t.db, scope, NOW)).inserted).toBe(0);
      expect(await importedHistoryLabels(t.db, location.id)).toEqual([expect.objectContaining({ label: "Sample (synthetic)", sample: true })]);
      const rows = await loadDailySales(t.db, b.membership.organisationId, [location.id]);
      const selection = selectForecastSource(rows, "2026-11-10");
      expect(selection).toMatchObject({ status: "SELECTED", source: "IMPORTED", currency: "ZAR" });
      // Real sales replace the sample.
      const csv = ["date,transactions,sales", "2026-11-02,120,9600.00", "2026-11-03,118,9440.00"].join("\n");
      await expect(importSalesCsv(t.db, scope, "date,transactions\n2026-13-01,5", NOW)).rejects.toMatchObject({ feedback: "csv-invalid" });
      expect(await importSalesCsv(t.db, scope, csv, NOW)).toMatchObject({ rows: 2, transactions: 238 });
      expect((await importedHistoryLabels(t.db, location.id)).map(row => row.label).sort()).toEqual(["Imported by Owner (CSV, 2026-11-10)", "Sample (synthetic)"]);
      const after = await loadDailySales(t.db, b.membership.organisationId, [location.id]);
      expect(after.reduce((sum, row) => sum + row.transactions, 0)).toBe(238);
      await expect(generateSampleHistory(t.db, scope, NOW)).rejects.toMatchObject({ feedback: "sample-after-csv" });
      expect((await t.db.select().from(saleTransactions).where(eq(saleTransactions.sourceSystem, SAMPLE_SOURCE_SYSTEM))).length).toBe(sample.transactions);
    } finally { await t.close(); }
  });
});
