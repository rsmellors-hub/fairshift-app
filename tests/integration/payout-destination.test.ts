import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { allocatedWork, payAgentCompany } from "../helpers/pay-agent";
import { WORKER_TEST_PASSWORD, workerChangesPayoutEmail } from "../helpers/payout-destination";
import { hashPassword } from "@/server/auth/identity";
import { changePayoutDestination, savePayoutDestination } from "@/server/auth/operations";
import { auditEvents, users, workers } from "@/server/db/schema";

// Day 6, Step 3b: a worker's PayPal email. The first is typed twice; a change also needs the worker's
// password. Every save is audited with masked addresses only.
describe("PayPal payout destination", () => {
  it("adds the first address only when typed twice, and audits it masked", async () => {
    const t = await createTestDatabase();
    try {
      const manager = (await payAgentCompany(t.db)).scopes[0];
      const { workerScope } = await allocatedWork(t.db, manager, { paymentEmail: null });
      await expect(changePayoutDestination(t.db, workerScope, { email: "casey@example.test", confirmEmail: "casy@example.test" })).rejects.toMatchObject({ feedback: "payout-email-mismatch" });
      await expect(changePayoutDestination(t.db, workerScope, { email: "not-an-email", confirmEmail: "not-an-email" })).rejects.toMatchObject({ feedback: "payout-email-invalid" });
      await changePayoutDestination(t.db, workerScope, { email: "casey@example.test", confirmEmail: "Casey@Example.test " });
      const [added] = await t.db.select().from(auditEvents).where(eq(auditEvents.action, "PAYOUT_DESTINATION_ADDED"));
      expect(added.metadata).toMatchObject({ previous: null, next: "c•••@example.test", reconfirmed: "REPEATED_ADDRESS", reservedPayoutsUnchanged: 0 });
    } finally { await t.close(); }
  });

  it("changes an existing address only with the worker's password, and never through the first-add path", async () => {
    const t = await createTestDatabase();
    try {
      const manager = (await payAgentCompany(t.db)).scopes[0];
      const { workerScope, worker } = await allocatedWork(t.db, manager);
      await t.db.update(users).set({ passwordHash: await hashPassword(WORKER_TEST_PASSWORD) }).where(eq(users.id, workerScope.userId));
      const email = async () => (await t.db.select().from(workers).where(eq(workers.id, worker.id)))[0].paypalPayoutEmail;
      await expect(savePayoutDestination(t.db, workerScope, "attacker@example.test")).rejects.toMatchObject({ feedback: "payout-change-needs-confirmation" });
      await expect(changePayoutDestination(t.db, workerScope, { email: "new@example.test", confirmEmail: "new@example.test" })).rejects.toMatchObject({ feedback: "payout-password" });
      await expect(changePayoutDestination(t.db, workerScope, { email: "new@example.test", confirmEmail: "new@example.test", password: "wrong-password-123" })).rejects.toMatchObject({ feedback: "payout-password" });
      await expect(changePayoutDestination(t.db, workerScope, { email: "casual.sandbox@example.test", confirmEmail: "casual.sandbox@example.test", password: WORKER_TEST_PASSWORD })).rejects.toMatchObject({ feedback: "payout-email-unchanged" });
      expect(await email()).toBe("casual.sandbox@example.test");
      expect(await t.db.select().from(auditEvents).where(eq(auditEvents.action, "PAYOUT_DESTINATION_CHANGED"))).toHaveLength(0);
      await workerChangesPayoutEmail(t.db, workerScope, "new@example.test");
      expect(await email()).toBe("new@example.test");
      // Another worker's scope can't change this worker's address.
      await expect(changePayoutDestination(t.db, { ...workerScope, userId: manager.userId }, { email: "x@example.test", confirmEmail: "x@example.test", password: WORKER_TEST_PASSWORD })).rejects.toThrow();
      // Attempts are limited.
      for (let i = 0; i < 4; i++) await changePayoutDestination(t.db, workerScope, { email: "z@example.test", confirmEmail: "z@example.test", password: "wrong-password-123" }).catch(() => null);
      await expect(changePayoutDestination(t.db, workerScope, { email: "z@example.test", confirmEmail: "z@example.test", password: WORKER_TEST_PASSWORD })).rejects.toThrow(/Too many attempts/);
    } finally { await t.close(); }
  });
});
