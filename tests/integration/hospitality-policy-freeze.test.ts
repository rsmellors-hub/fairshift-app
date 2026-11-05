import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { hours } from "../helpers/workload";
import type { Scope } from "@/server/auth/access";
import { commerceConnections, organisations, outlets, regularCoverageWindows, workloadPolicies } from "@/server/db/schema";
import { writeWorkloadPolicyVersion } from "@/server/intelligence/business-policy";
import { getWeeklyStaffing } from "@/server/intelligence/staffing";
import { getWeeklyForecast } from "@/server/intelligence/weekly";
import { calculateDayWorkload, resolveWorkloadPolicy } from "@/server/intelligence/workload";
import { provisionReferenceHistory } from "@/server/reference/provision";
import { REFERENCE_DATASET, REFERENCE_STORE_CODES, REFERENCE_WORKLOAD_POLICY, referenceCoverage, referenceTradingHours } from "@/server/reference/uk-hospitality";
import { REFERENCE_DATASET as RETAIL_DATASET, referenceTransactions as retailTransactions } from "@/server/reference/uk-retail";
vi.mock("@/server/demo/config", () => ({ demoConfig: () => ({ organisationId: process.env.FAIRSHIFT_TEST_DEMO_ORG }) }));

type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];
const NOW = new Date("2026-10-25T10:00:00Z");
const WEEK = [0, 1, 2, 3, 4, 5, 6];
async function company(db: Db) {
  const organisationId = randomUUID();
  process.env.FAIRSHIFT_TEST_DEMO_ORG = organisationId;
  await db.insert(organisations).values({ id: organisationId, name: "Reference", country: "United Kingdom" });
  const rows = REFERENCE_STORE_CODES.map((code, i) => ({ id: randomUUID(), organisationId, name: `${i + 1} ${code}`, timezone: "Europe/London" }));
  await db.insert(outlets).values(rows);
  const mapping = Object.fromEntries(REFERENCE_STORE_CODES.map((code, i) => [code, rows[i].id])) as Record<typeof REFERENCE_STORE_CODES[number], string>;
  const owner: Scope = { userId: randomUUID(), organisationId, locationId: rows[0].id, role: "OWNER", organisationName: "Reference", locationName: rows[0].name, demo: { persona: "OWNER", group: "isolated-test" } };
  return { organisationId, rows, mapping, owner };
}
const WINDOW = { from: "2026-10-12", through: "2026-10-18" };

describe("frozen reference operating assumptions", () => {
  it("is 7 transactions per operational staff-hour and a minimum of 2", () => {
    expect(REFERENCE_WORKLOAD_POLICY).toEqual({ transactionsPerStaffHour: 7, minimumStaffWhileOpen: 2 });
  });

  it("has at least the minimum regular staff at every open minute of every venue-day", () => {
    for (const code of REFERENCE_STORE_CODES) for (const day of WEEK) {
      const trading = referenceTradingHours(code)[day], coverage = referenceCoverage(code)[day];
      for (const window of trading) for (let minute = window.start; minute < window.end; minute += 15) {
        const staff = coverage.filter(row => row.start <= minute && minute < row.end).reduce((sum, row) => sum + row.headcount, 0);
        expect({ code, day, minute, ok: staff >= REFERENCE_WORKLOAD_POLICY.minimumStaffWhileOpen }).toEqual({ code, day, minute, ok: true });
      }
    }
  });

  it("corrected Leeds weekdays 15:00–17:00 and Sunday to two people, and nothing else at Leeds", () => {
    const leeds = referenceCoverage("UK01");
    for (const day of [0, 1, 2, 3, 4]) expect(leeds[day]).toEqual([hours(7, 11, 2), hours(11, 15, 3), hours(15, 17, 2)]);
    expect(leeds[5]).toEqual([hours(9, 16, 2)]);
    expect(leeds[6]).toEqual([hours(10, 15, 2)]);
  });

  it("keeps Birmingham's and Stratford's authorised patterns as they were", () => {
    const birmingham = referenceCoverage("UK03");
    expect(birmingham[5]).toEqual([hours(9, 12, 3), hours(12, 17, 5), hours(17, 20, 3)]);
    expect(birmingham[6]).toEqual([hours(11, 17, 3)]);
    expect(referenceTradingHours("UK03")[6]).toEqual([{ start: 660, end: 1020 }]);
    const stratford = referenceCoverage("UK05");
    for (const day of [0, 1, 2, 3, 4]) expect(stratford[day]).toEqual([hours(6, 10, 4), hours(10, 16, 2), hours(16, 20, 3)]);
    expect(stratford[5]).toEqual([hours(7, 20, 3)]);
    expect(stratford[6]).toEqual([hours(8, 19, 2)]);
  });

  it("derives the requirement deterministically from transactions by time: sales value changes nothing", () => {
    const slots = ["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"].map(date => ({ date, minute: 720, transactions: 21, salesMinor: 10_000 }));
    const run = (salesFactor: number) => calculateDayWorkload({ date: "2026-11-09", timezone: "Europe/London", trading: [{ start: 660, end: 840 }], coverage: [hours(11, 14, 2)], policy: REFERENCE_WORKLOAD_POLICY,
      slots: slots.map(row => ({ ...row, salesMinor: row.salesMinor * salesFactor })), dataThrough: "2026-11-01", allocated: [] });
    expect(run(1)).toEqual(run(1));
    expect(run(1).requiredMinutes).toBe(run(50).requiredMinutes);
    expect(run(1).remainingMinutes).toBe(run(50).remainingMinutes);
    // 21 bills in the noon hour at 7 an hour: 3 staff-hours against 2 regular. The floor holds the other hours.
    expect(run(1).blocks.map(block => [block.start, block.requiredMinutes, block.remainingMinutes])).toEqual([[660, 120, 0], [720, 180, 60], [780, 120, 0]]);
    expect(run(1).periods.map(period => [period.state, period.start, period.end])).toEqual([["COVERED", 660, 720], ["OPEN", 720, 780], ["COVERED", 780, 840]]);
  });
});

describe("provisioning the reference policy", () => {
  it("writes one organisation-level REFERENCE policy, with no location overrides, and a rerun adds nothing", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      await provisionReferenceHistory(t.db, { organisationId: c.organisationId, outlets: c.mapping, ...WINDOW }, NOW);
      const load = () => t.db.select().from(workloadPolicies).where(eq(workloadPolicies.organisationId, c.organisationId));
      const [policy, ...rest] = await load();
      expect(rest).toEqual([]);
      expect(policy).toMatchObject({ outletId: null, version: 1, status: "ACTIVE", source: "REFERENCE", transactionsPerStaffHour: 7, minimumStaffWhileOpen: 2 });
      expect(await provisionReferenceHistory(t.db, { organisationId: c.organisationId, outlets: c.mapping, ...WINDOW }, NOW)).toMatchObject({ inserted: 0 });
      expect(await load()).toHaveLength(1);
      const staffing = await getWeeklyStaffing(t.db, c.owner, NOW);
      for (const outlet of staffing.outlets) expect(outlet.policy).toMatchObject({ version: "organisation-v1", level: "ORGANISATION", source: "REFERENCE" });
      // The active source stays reference history: no connected commerce, and no Zettle path, became active.
      expect(await t.db.select().from(commerceConnections)).toEqual([]);
      for (const outlet of (await getWeeklyForecast(t.db, c.owner, NOW)).outlets) expect(outlet.selection).toMatchObject({ status: "SELECTED", source: "REFERENCE" });
    } finally { await t.close(); }
  }, 120_000);

  it("keeps a business's own policy and configured cover, and corrects an already-loaded reference rota", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      await t.db.transaction(tx => writeWorkloadPolicyVersion(tx, { organisationId: c.organisationId, outletId: null, transactionsPerStaffHour: 11, minimumStaffWhileOpen: 3, source: "CONFIGURED", createdBy: null }));
      await provisionReferenceHistory(t.db, { organisationId: c.organisationId, outlets: c.mapping, ...WINDOW }, NOW);
      expect(resolveWorkloadPolicy(await t.db.select().from(workloadPolicies).where(eq(workloadPolicies.status, "ACTIVE")), c.mapping.UK01)).toMatchObject({ transactionsPerStaffHour: 11, source: "CONFIGURED" });

      // A rota loaded before the correction still holds one person; a rerun fixes reference rows only.
      const rows = await t.db.select().from(regularCoverageWindows).where(eq(regularCoverageWindows.outletId, c.mapping.UK01));
      const sunday = rows.find(row => row.isoWeekday === 7)!, monday = rows.find(row => row.isoWeekday === 1)!;
      await t.db.update(regularCoverageWindows).set({ windows: [hours(10, 15, 1)] }).where(eq(regularCoverageWindows.id, sunday.id));
      await t.db.update(regularCoverageWindows).set({ windows: [hours(7, 17, 9)], source: "CONFIGURED" }).where(eq(regularCoverageWindows.id, monday.id));
      await provisionReferenceHistory(t.db, { organisationId: c.organisationId, outlets: c.mapping, ...WINDOW }, NOW);
      const after = await t.db.select().from(regularCoverageWindows).where(eq(regularCoverageWindows.outletId, c.mapping.UK01));
      expect(after.find(row => row.isoWeekday === 7)!.windows).toEqual([hours(10, 15, 2)]);
      expect(after.find(row => row.isoWeekday === 1)).toMatchObject({ windows: [hours(7, 17, 9)], source: "CONFIGURED" });
    } finally { await t.close(); }
  }, 120_000);
});

describe("preserved history and firewalls", () => {
  it("keeps the retail generator reproducible and unloadable, and its evidence on file", async () => {
    expect(RETAIL_DATASET.version).toBe("uk-specialty-retail-v2");
    expect(retailTransactions("UK01", "2026-10-30").length).toBeGreaterThan(0);
    expect(await readFile("src/server/reference/provision.ts", "utf8")).not.toContain("uk-retail");
    expect(REFERENCE_DATASET.version).toBe("uk-hospitality-v1");
    for (const file of ["docs/REFERENCE_REFRESH_EVIDENCE.md", "docs/PAYPAL_FINAL_EVIDENCE.md", "docs/PERFORMANCE_INCENTIVE_JOURNEY_EVIDENCE.md", "docs/SQUARE_LIVE_EVIDENCE.md", "docs/ZETTLE_LIVE_EVIDENCE.md"]) expect((await readFile(file, "utf8")).length).toBeGreaterThan(100);
    expect(await readFile("docs/PAYPAL_FINAL_EVIDENCE.md", "utf8")).toContain("GBP 121.00");
  });

  it("states the frozen rules in authority, and no public page claims the retired method", async () => {
    const agents = await readFile("AGENTS.md", "utf8"), spec = await readFile("docs/FAIRSHIFT_PRODUCT_UX_SPEC.md", "utf8");
    for (const text of ["fast-casual", "7 transactions per operational staff-hour", "anti-tuning", "No new Zettle implementation"]) expect(agents).toContain(text);
    // Status discipline: AGENTS.md keeps each claim separate, in the governance ladder's order, and the
    // authority register states the same ladder (wording set by governance commit 5b0d902).
    const ladder = ["APPROVED", "IMPLEMENTED", "TESTED", "VERIFIED LOCALLY", "DEPLOYED", "VERIFIED ON HOSTED", "DEMO-READY"];
    expect(agents).toContain(`${ladder.join(" ≠ ")}. Each is a separate claim that needs its own evidence.`);
    const register = await readFile("docs/FS-DOCUMENT-AUTHORITY-REGISTER.md", "utf8");
    expect(register).toContain(`**Status ladder:** ${ladder.map(step => step.toLowerCase()).join(", ")}. Each is a separate claim that needs its own evidence.`);
    for (const text of ["7 completed transactions per operational staff-hour", "Golden Path anti-tuning rule", "Opportunity Demand", "tip allocation method"]) expect(spec).toContain(text);
    for (const file of ["src/app/page.tsx", "src/app/product/page.tsx", "src/app/faq/page.tsx", "src/app/components/plan-cards.tsx", "src/app/demo/page.tsx"]) {
      const copy = await readFile(file, "utf8");
      expect({ file, match: /sales-per-labour-hour|per labour hour|Zettle|retail|not hourly/i.exec(copy)?.[0] ?? null }).toEqual({ file, match: null });
    }
  });
});
