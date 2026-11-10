import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { allocatedWork, payAgentCompany } from "../helpers/pay-agent";
import { WORKER_TEST_PASSWORD, workerChangesPayoutEmail } from "../helpers/payout-destination";
import { hashPassword } from "@/server/auth/identity";
import { changePayoutDestination, savePayoutDestination } from "@/server/auth/operations";
import { auditEvents, notifications, users, workers } from "@/server/db/schema";
import { cancelPayoutChange, confirmPayoutChange, payoutsPaused } from "@/server/worker/payout-destination";

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

  it("waits for the link sent to the new address, pausing new payouts until it's used", async () => {
    const t = await createTestDatabase();
    try {
      const manager = (await payAgentCompany(t.db)).scopes[0];
      const { workerScope, worker } = await allocatedWork(t.db, manager);
      const email = async () => (await t.db.select().from(workers).where(eq(workers.id, worker.id)))[0].paypalPayoutEmail;
      const result = await workerChangesPayoutEmail(t.db, workerScope, "new@example.test", false);
      if (!("pending" in result) || !result.pending) throw new Error("expected a pending change");
      // Nothing changes yet; payouts are paused; the link goes to the new address, and its code isn't stored.
      expect(await email()).toBe("casual.sandbox@example.test");
      expect(await payoutsPaused(t.db, worker.id)).toBe(true);
      const [notice] = await t.db.select().from(notifications).where(eq(notifications.kind, "PAYOUT_EMAIL_CONFIRM"));
      expect(notice).toMatchObject({ recipientEmail: "new@example.test", href: "/payout-email/confirm" });
      const token = result.pending.secureLink.split("#")[1];
      expect(JSON.stringify(notice)).not.toContain(token);
      const [requested] = await t.db.select().from(auditEvents).where(eq(auditEvents.action, "PAYOUT_DESTINATION_CHANGE_REQUESTED"));
      expect(requested.metadata).toMatchObject({ previous: "c•••@example.test", next: "n•••@example.test", payoutsPaused: true });
      // A wrong code changes nothing; the right one applies the change once and resumes payouts.
      await expect(confirmPayoutChange(t.db, "not-the-code")).rejects.toMatchObject({ feedback: "payout-link-invalid" });
      await confirmPayoutChange(t.db, token);
      expect(await email()).toBe("new@example.test");
      expect(await payoutsPaused(t.db, worker.id)).toBe(false);
      await expect(confirmPayoutChange(t.db, token)).rejects.toMatchObject({ feedback: "payout-link-invalid" });
      // An expired link is refused; a cancelled change resumes payouts to the confirmed address.
      const again = await workerChangesPayoutEmail(t.db, workerScope, "later@example.test", false);
      if (!("pending" in again) || !again.pending) throw new Error("expected a pending change");
      await expect(confirmPayoutChange(t.db, again.pending.secureLink.split("#")[1], new Date(Date.now() + 25 * 3_600_000))).rejects.toMatchObject({ feedback: "payout-link-invalid" });
      expect(await cancelPayoutChange(t.db, workerScope)).toBe(true);
      expect(await payoutsPaused(t.db, worker.id)).toBe(false);
      await expect(confirmPayoutChange(t.db, again.pending.secureLink.split("#")[1])).rejects.toMatchObject({ feedback: "payout-link-invalid" });
      expect(await email()).toBe("new@example.test");
    } finally { await t.close(); }
  });
});
