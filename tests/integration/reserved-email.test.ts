import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { notificationDeliveries, notifications, organisations } from "@/server/db/schema";
import { RESERVED_TEST_ADDRESS, isReservedTestAddress } from "@/server/domain/reserved-email";
import { dispatchNotification, dispatchPendingEmails, notify } from "@/server/notifications/service";

// 12 Nov 2026: reserved test addresses (demo, judge and test accounts) are never sent to. Only the email is
// skipped: the in-app notice stays as it was, and the delivery is recorded once as not sent, never retried.
describe("email to reserved test addresses", () => {
  it("recognises the reserved names and nothing else", () => {
    for (const a of ["x@example.test", "a@judges.jacaranda-demo.example.test", "b@example.com", "c@shop.example.org", "d@host.invalid", "e@localhost", "f@people.example"]) expect(isReservedTestAddress(a), a).toBe(true);
    for (const a of ["owner@gmail.com", "pay@business.co.za", "x@example-shop.com", "y@notexample.com", "z@examples.com"]) expect(isReservedTestAddress(a), a).toBe(false);
  });

  it("never calls the email service for one, records it once as not sent, keeps the in-app notice, and still sends to a real address", async () => {
    const t = await createTestDatabase();
    try {
      const organisationId = randomUUID();
      await t.db.insert(organisations).values({ id: organisationId, name: "Test business", country: "South Africa" });
      const send = vi.fn(async () => ({ status: "ACCEPTED" as const, messageId: "m-1" }));
      const note = async (recipientEmail: string) => { const id = randomUUID(); await notify(t.db, { id, organisationId, recipientEmail, eventKey: `test:${id}`, kind: "SHIFT_OFFER", entityId: id, title: "New shift", body: "B", href: "/worker" }); return id; };
      const reserved = await note("casual@people.jacaranda-demo.example.test"), real = await note("casual@fairshift-mail.dev");

      await dispatchNotification(t.db, { send }, reserved);
      expect(send).not.toHaveBeenCalled();
      const [skipped] = await t.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.notificationId, reserved));
      expect(skipped).toMatchObject({ status: "FAILED", failureCode: RESERVED_TEST_ADDRESS, attemptedAt: null, providerMessageId: null });
      // The in-app notice is exactly as it was.
      expect((await t.db.select().from(notifications).where(eq(notifications.id, reserved)))[0]).toMatchObject({ title: "New shift", readAt: null });

      // The retry pass never picks it up; a direct dispatch again still doesn't call the service.
      await dispatchPendingEmails(t.db, { send });
      await dispatchNotification(t.db, { send }, reserved);
      expect(send.mock.calls.map(call => (call as unknown as [{ to: string }])[0].to)).toEqual(["casual@fairshift-mail.dev"]);
      expect((await t.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.notificationId, real)))[0]).toMatchObject({ status: "ACCEPTED", providerMessageId: "m-1" });
      expect((await t.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.notificationId, reserved)))[0]).toMatchObject({ status: "FAILED", failureCode: RESERVED_TEST_ADDRESS });
    } finally { await t.close(); }
  });
});
