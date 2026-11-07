import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Scope } from "@/server/auth/access";
import { tipAllocationLines, tipHolds, workPayouts } from "@/server/db/schema";
import type { PayPalPayoutAdapter, PayoutResult } from "@/server/integrations/paypal/payout-client";
import { PAY_AGENT_DRY_RUN_ENV } from "@/server/pay-agent/settlement";
import { settleTipLine } from "@/server/tips/agent";
import { TIP_CSV_HEADER } from "@/server/tips/policy";
import { addPermanentStaff, importTipEvidence, saveTipSettings } from "@/server/tips/service";
import { createStatementLink, updateStatementDestination } from "@/server/tips/statement";
import { seedTestFxRate } from "../helpers/fx";
import { payAgentCompany, testUser } from "../helpers/pay-agent";
import { createPostgresTestDatabase, TEST_POSTGRES_URL } from "../helpers/postgres";
import { sandboxFixture } from "../helpers/sandbox";

// Concurrent tip releases on a real PostgreSQL server (separate connections), which PGlite's
// single connection cannot exercise. Runs only with FAIRSHIFT_TEST_POSTGRES_URL set.
afterEach(() => { vi.unstubAllEnvs(); });
const DEV = { NODE_ENV: "development", FAIRSHIFT_DEV_STATEMENT_LINKS: "enabled" };
const row = (ref: string, staff: string, tip: string) => ["Demo POS export", "Store 1", ref, "2026-11-06T09:00:00+02:00", staff, "500.00", tip, "ZAR"].join(",");

async function setup(db: Awaited<ReturnType<typeof createPostgresTestDatabase>>["db"], cap: number) {
  const company = await payAgentCompany(db, { country: "South Africa" });
  sandboxFixture(company.organisationId);
  const owner: Scope = { ...company.scopes[0], userId: await testUser(db), role: "OWNER" };
  await seedTestFxRate(db);
  await saveTipSettings(db, owner, { policy: "DIRECT", autoReleaseCapMinor: cap });
  const staff = await addPermanentStaff(db, owner, { firstName: "Conc", surname: "Urrent", email: `c${randomUUID().slice(0, 6)}@example.test`, paypalEmail: "c.sandbox@example.test" });
  const link = await createStatementLink(db, owner, staff.id, new Date(), DEV);
  await updateStatementDestination(db, link.path.split("#")[1], { action: "CONFIRM" });
  // Two imports on the same day: two allocations, each with one R100 share for the same person.
  for (const ref of ["C-1", "C-2"]) await importTipEvidence(db, owner, [TIP_CSV_HEADER.join(","), row(ref, staff.attributionCode, "100.00")].join("\n"));
  const lines = await db.select().from(tipAllocationLines);
  const approver = { userId: owner.userId, basis: "test" };
  return { owner, staff, lines, approver, authority: (eventId: string) => ({ kind: "STANDING_POLICY" as const, eventId }) };
}
const paypal = () => ({ createPayout: vi.fn(async (input: { senderBatchId: string }): Promise<PayoutResult> => ({ batchId: `PPB${input.senderBatchId.slice(-8)}`, itemId: null, status: "PENDING", batchStatus: "PENDING", itemStatus: null, transactionId: null })), getPayout: vi.fn() }) as unknown as PayPalPayoutAdapter & { createPayout: ReturnType<typeof vi.fn> };

describe.skipIf(!TEST_POSTGRES_URL)("concurrent tip releases (real PostgreSQL)", () => {
  it("lets concurrent releases of one person's shares fit under the daily cap only once", async () => {
    const t = await createPostgresTestDatabase();
    try {
      const s = await setup(t.db, 15_000);
      const client = paypal();
      const outcomes = await Promise.all(s.lines.map(line => settleTipLine(t.db, client, s.owner, line.id, s.authority(randomUUID()), s.approver)));
      expect(outcomes.sort()).toEqual(["DRY_RUN_ELIGIBLE", "HELD"]);
      expect(await t.db.select().from(tipHolds)).toEqual([expect.objectContaining({ reasonCode: "AUTO_RELEASE_CAP_EXCEEDED" })]);
    } finally { await t.close(); }
  });

  it("reserves one payout when the same line is released concurrently with dry run off", async () => {
    vi.stubEnv(PAY_AGENT_DRY_RUN_ENV, "false");
    const t = await createPostgresTestDatabase();
    try {
      const s = await setup(t.db, 100_000);
      const client = paypal();
      const line = s.lines[0];
      const outcomes = await Promise.all(Array.from({ length: 6 }, () => settleTipLine(t.db, client, s.owner, line.id, s.authority(randomUUID()), s.approver)));
      expect(outcomes.filter(outcome => outcome === "PAYOUT_RESERVED")).toHaveLength(1);
      expect(outcomes.filter(outcome => outcome === "PAYOUT_EXISTS")).toHaveLength(5);
      expect(await t.db.select().from(workPayouts).where(eq(workPayouts.tipLineId, line.id))).toHaveLength(1);
      expect(client.createPayout).toHaveBeenCalledTimes(1);
    } finally { await t.close(); }
  });
});
