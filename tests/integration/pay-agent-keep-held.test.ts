import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestDatabase } from "../helpers/database";
import { confirmedWork, fakePayAgentModel, fakePayoutClient, payAgentCompany, testUser } from "../helpers/pay-agent";
import { sandboxFixture } from "../helpers/sandbox";
import type { Scope } from "@/server/auth/access";
import { auditEvents, notifications, payAgentEvents, workPayables, workPayouts } from "@/server/db/schema";
import { mintPayAgentCredentialForManager, payAgentServiceVerifier } from "@/server/pay-agent/identity";
import { createPayAgent } from "@/server/pay-agent/orchestrator";
import { confirmedWorkSettlement } from "@/server/pay-agent/settlement";
import { keepPayAgentHold, releasePayAgentHold } from "@/server/pay-agent/service";
import { getTodayNeeds } from "@/server/product/owner-today";

// "Keep held" (design, OwnerPay): the Owner's reason is kept on record, the hold and the amount are
// unchanged, nothing is sent to PayPal, and the worker is told once that the payment is being checked.
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const holdReply = (payableId: string) => ({ action: "hold_for_manager_review", payableId, reasonCode: "CONFIRMATION_DELAY", summary: "Confirmation was recorded long after the shift ended.", checks: { hours: "OK", overlap: "OK", timing: "CONCERN", records: "OK" } });

describe("keeping a Pay Agent hold", () => {
  it("records the Owner's reason, keeps the hold open and unpaid, and tells the worker once", async () => {
    const t = await createTestDatabase();
    try {
      const manager = (await payAgentCompany(t.db)).scopes[0];
      sandboxFixture(manager.organisationId);
      const work = await confirmedWork(t.db, manager);
      const eventId = work.payAgentEvent!.id, payableId = work.payable!.id;
      const paypal = fakePayoutClient();
      const agent = createPayAgent({ db: t.db, identityVerifier: payAgentServiceVerifier, model: () => fakePayAgentModel(holdReply), settlement: confirmedWorkSettlement(t.db, paypal) });
      await agent.process({ eventId }, mintPayAgentCredentialForManager(manager));
      const [before] = await t.db.select().from(workPayables).where(eq(workPayables.id, payableId));

      // Owner Today counts the hold and opens Pay at its location.
      const today = await getTodayNeeds(t.db, { ...manager, role: "OWNER" } as Scope, null);
      expect(today).toMatchObject({ held: 1, heldAt: manager.locationId });
      await expect(getTodayNeeds(t.db, manager, null)).rejects.toThrow();

      // Only the Owner decides, and only with a reason.
      await expect(keepPayAgentHold(t.db, manager, eventId, "Checking the hours.")).rejects.toMatchObject({ feedback: "pay-agent-owner-decides" });
      const owner: Scope = { ...manager, role: "OWNER", userId: await testUser(t.db) };
      await expect(keepPayAgentHold(t.db, owner, eventId, "   ")).rejects.toMatchObject({ feedback: "pay-agent-keep-reason" });

      await expect(keepPayAgentHold(t.db, owner, eventId, "Checking the hours with the manager.")).resolves.toMatchObject({ eventId, notified: true });
      // Keeping it again records the new reason without messaging the worker twice.
      await expect(keepPayAgentHold(t.db, owner, eventId, "Still checking.")).resolves.toMatchObject({ eventId, notified: false });

      const [event] = await t.db.select().from(payAgentEvents).where(eq(payAgentEvents.id, eventId));
      expect(event).toMatchObject({ status: "DECIDED_HOLD", resolution: null });
      const [after] = await t.db.select().from(workPayables).where(eq(workPayables.id, payableId));
      expect(after.status).toBe(before.status);
      expect(after.baseAmountMinor).toBe(before.baseAmountMinor);
      expect(await t.db.select().from(workPayouts).where(eq(workPayouts.payableId, payableId))).toHaveLength(0);

      const kept = await t.db.select().from(auditEvents).where(and(eq(auditEvents.action, "PAY_AGENT_HOLD_KEPT"), eq(auditEvents.entityId, eventId)));
      expect(kept.map(row => row.metadata)).toEqual(expect.arrayContaining([
        expect.objectContaining({ outcome: "KEPT", note: "Checking the hours with the manager.", payableId, actorRole: "OWNER" }),
        expect.objectContaining({ outcome: "KEPT", note: "Still checking." }),
      ]));
      const notices = await t.db.select().from(notifications).where(eq(notifications.kind, "PAYMENT_BEING_CHECKED"));
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ workerId: work.payable!.workerId, title: "Your payment is being checked" });
      expect(notices[0].body).not.toMatch(/\d/);

      // The hold can still be released afterwards.
      await releasePayAgentHold(t.db, owner, eventId, "Hours confirmed with the manager.");
      const [released] = await t.db.select().from(payAgentEvents).where(eq(payAgentEvents.id, eventId));
      expect(released.resolution).toBe("RELEASED");
    } finally { await t.close(); }
  });
});
