import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresTestDatabase, TEST_POSTGRES_URL } from "../helpers/postgres";
import { allocatedWork, confirmedWork, payAgentCompany } from "../helpers/pay-agent";
import { payAgentEvents, workPayables } from "@/server/db/schema";
import { confirmWork } from "@/server/scheduling/operations";
import { claimForModel, claimForSettlement, finishClaim, recordPayAgentEvent, resolveHold } from "@/server/pay-agent/journal";

// Uniqueness and concurrency of the durable Pay Agent journal across separate connections of a
// real PostgreSQL server. Skipped, and reported as skipped, unless FAIRSHIFT_TEST_POSTGRES_URL
// names a disposable server (see tests/helpers/postgres.ts).
describe.skipIf(!TEST_POSTGRES_URL)("Pay Agent journal on a real PostgreSQL server", () => {
  let t: Awaited<ReturnType<typeof createPostgresTestDatabase>>;
  beforeAll(async () => { t = await createPostgresTestDatabase(); }, 120_000);
  afterAll(async () => { await t?.close(); });
  const expireLease = (id: string) => t.db.update(payAgentEvents).set({ leaseExpiresAt: sql`now() - interval '1 second'` }).where(eq(payAgentEvents.id, id));

  it("records one payable and one event for concurrent confirmations on separate connections", async () => {
    const manager = (await payAgentCompany(t.db)).scopes[0];
    const work = await allocatedWork(t.db, manager);
    const results = await Promise.all(Array.from({ length: 6 }, () => confirmWork(t.db, work.offer.id, manager)));
    expect(new Set(results.map(result => result.payable!.id)).size).toBe(1);
    expect(new Set(results.map(result => result.payAgentEvent!.id)).size).toBe(1);
    expect(await t.db.select().from(workPayables).where(eq(workPayables.offerId, work.offer.id))).toHaveLength(1);
    expect(await t.db.select().from(payAgentEvents).where(eq(payAgentEvents.payableId, results[0].payable!.id))).toHaveLength(1);
  });

  it("keeps one event per payable and evidence version under concurrent inserts", async () => {
    const manager = (await payAgentCompany(t.db)).scopes[0];
    const { payable } = await confirmedWork(t.db, manager);
    const events = await Promise.all(Array.from({ length: 8 }, () => t.db.transaction(tx => recordPayAgentEvent(tx, manager, payable!.id, "EVIDENCE_REFRESHED", manager.userId))));
    expect(new Set(events.map(event => event.id)).size).toBe(1);
    expect(await t.db.select().from(payAgentEvents).where(eq(payAgentEvents.payableId, payable!.id))).toHaveLength(1);
  });

  it("lets exactly one of many concurrent claims win", async () => {
    const manager = (await payAgentCompany(t.db)).scopes[0];
    const { payAgentEvent } = await confirmedWork(t.db, manager);
    const claims = await Promise.all(Array.from({ length: 12 }, (_, i) => claimForModel(t.db, manager, payAgentEvent!.id, { manual: i % 2 === 0 })));
    const winners = claims.filter(claim => claim !== null);
    expect(winners).toHaveLength(1);
    const [row] = await t.db.select().from(payAgentEvents).where(eq(payAgentEvents.id, payAgentEvent!.id));
    expect(row).toMatchObject({ status: "CLAIMED", attemptCount: 1, claimToken: winners[0]!.claimToken });
  });

  it("lets exactly one recovery take an expired claim and fences the previous owner", async () => {
    const manager = (await payAgentCompany(t.db)).scopes[0];
    const { payAgentEvent } = await confirmedWork(t.db, manager);
    const stale = (await claimForModel(t.db, manager, payAgentEvent!.id, { manual: false }))!;
    await expireLease(stale.id);
    const takeovers = (await Promise.all(Array.from({ length: 10 }, () => claimForModel(t.db, manager, stale.id, { manual: false })))).filter(claim => claim !== null);
    expect(takeovers).toHaveLength(1);
    expect(takeovers[0]!.attemptCount).toBe(2);
    // The old owner and the new owner finish at the same moment: only the new owner's write lands.
    const [late, current] = await Promise.all([
      finishClaim(t.db, stale, { status: "DECIDED_SETTLE", decision: "SETTLE" }),
      finishClaim(t.db, takeovers[0]!, { status: "DECIDED_HOLD", decision: "HOLD", reasonCode: "INCOMPLETE_EVIDENCE", summary: "Performance evidence is missing for this shift." }),
    ]);
    expect(late).toBeNull();
    expect(current).toMatchObject({ status: "DECIDED_HOLD", decision: "HOLD" });
  });

  it("starts the settlement gates once and resolves a hold once under concurrency", async () => {
    const manager = (await payAgentCompany(t.db)).scopes[0];
    const settle = (await confirmedWork(t.db, manager)).payAgentEvent!;
    await finishClaim(t.db, (await claimForModel(t.db, manager, settle.id, { manual: false }))!, { status: "DECIDED_SETTLE", decision: "SETTLE" });
    const settlementClaims = (await Promise.all(Array.from({ length: 10 }, () => claimForSettlement(t.db, manager, settle.id, { manual: false })))).filter(claim => claim !== null);
    expect(settlementClaims).toHaveLength(1);

    const hold = (await confirmedWork(t.db, manager)).payAgentEvent!;
    await finishClaim(t.db, (await claimForModel(t.db, manager, hold.id, { manual: false }))!, { status: "DECIDED_HOLD", decision: "HOLD", reasonCode: "HOURS_MISMATCH", summary: "Shift record and accepted schedule differ by two hours." });
    const resolutions = await Promise.all(Array.from({ length: 6 }, (_, i) => resolveHold(t.db, manager, hold.id, i % 2
      ? { resolution: "REJECTED", userId: manager.userId, note: "Hours not worked as confirmed." }
      : { resolution: "RELEASED", userId: manager.userId, note: null })));
    expect(resolutions.filter(row => row !== null)).toHaveLength(1);
  });
});
