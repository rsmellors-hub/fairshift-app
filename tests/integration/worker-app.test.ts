import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestDatabase } from "../helpers/database";
import { seedTestFxRate } from "../helpers/fx";
import { allocatedWork, payAgentCompany, testUser } from "../helpers/pay-agent";
import { sandboxFixture } from "../helpers/sandbox";
import { createActivatedTeamMember } from "../helpers/workers";
import type { Scope } from "@/server/auth/access";
import { workerRespond } from "@/server/auth/operations";
import { auditEvents, notifications, offerRounds, payQueries, shiftOffers, shifts, workers, workPayables } from "@/server/db/schema";
import type { PayPalPayoutAdapter, PayoutResult } from "@/server/integrations/paypal/payout-client";
import { approveWorkPayable, refreshWorkPayout, submitWorkPayout } from "@/server/payments/work-payouts";
import { changeAssignment, confirmWork, createDepartment, createRequirement, createWorkPolicy, offerAssignment } from "@/server/scheduling/operations";
import { passOnAfterDecline } from "@/server/scheduling/shift-suggestions";
import { cancellationDue } from "@/server/scheduling/shift-labels";
import { managerThread, markInboxRead, sendManagerMessage, sendWorkerMessage, workerInbox, workerUnread } from "@/server/worker/inbox";
import { answerPayQuery, raisePayQuery } from "@/server/worker/pay-queries";
import { workerShiftPay } from "@/server/worker/shift-pay";
import { fixtureHourlyRate } from "../helpers/pay-agent";

// The worker app (design, 10 Nov 2026, section 6): one Inbox record of offers, bookings, cancellations and
// payments; messages with the location's managers; questions about a shift's pay answered by the Owner;
// and the Paid notice, sent only on PayPal SUCCESS. Synthetic tenants and a PayPal double; no network.
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const paypal = (amount: { value: string; currency: string }) => ({
  createPayout: vi.fn(async (input: { senderBatchId: string }): Promise<PayoutResult> => ({ batchId: `PPB${input.senderBatchId.slice(-8)}`, itemId: null, status: "PENDING", batchStatus: "PENDING", itemStatus: null, transactionId: null })),
  getPayout: vi.fn(async (batchId: string): Promise<PayoutResult> => ({ batchId, itemId: "PPI-1", status: "SUCCESS", batchStatus: "SUCCESS", itemStatus: "SUCCESS", transactionId: "PPT-1", itemAmount: amount })),
}) as unknown as PayPalPayoutAdapter;

describe("worker app records", () => {
  it("puts offers, bookings and payments in the Inbox, and the Paid notice only after PayPal SUCCESS", async () => {
    const t = await createTestDatabase();
    try {
      const manager = (await payAgentCompany(t.db)).scopes[0];
      sandboxFixture(manager.organisationId);
      const { workerScope, offer } = await allocatedWork(t.db, manager);
      const kinds = async () => (await t.db.select({ kind: notifications.kind }).from(notifications).where(eq(notifications.userId, workerScope.userId))).map(row => row.kind).sort();
      expect(await kinds()).toEqual(["SHIFT_BOOKED", "SHIFT_OFFER"]);
      const [offerNotice] = await t.db.select().from(notifications).where(and(eq(notifications.userId, workerScope.userId), eq(notifications.kind, "SHIFT_OFFER")));
      expect(offerNotice.body).toMatch(/£\d+\.\d{2}/);
      expect(offerNotice.body).toContain("cancellation pay");
      expect(await workerUnread(t.db, workerScope)).toBe(2);

      const { payable } = await confirmWork(t.db, offer.id, manager);
      await approveWorkPayable(t.db, manager, payable!.id);
      const client = paypal({ value: (payable!.baseAmountMinor / 100).toFixed(2), currency: "GBP" });
      await submitWorkPayout(t.db, client, manager, payable!.id);
      // Sent but not confirmed: no Paid notice yet.
      expect(await kinds()).not.toContain("PAYOUT_PAID");
      await refreshWorkPayout(t.db, client, manager, payable!.id);
      await refreshWorkPayout(t.db, client, manager, payable!.id);
      const paid = await t.db.select().from(notifications).where(and(eq(notifications.userId, workerScope.userId), eq(notifications.kind, "PAYOUT_PAID")));
      expect(paid).toHaveLength(1);
      expect(paid[0].title).toMatch(/^Paid: £\d+\.\d{2} for /);
      expect(paid[0].body).toContain("Paid ✓");
      expect(paid[0].body).toMatch(/PayPal batch: PPB/);
      expect(paid[0].body).toContain("Query this shift's pay");
      expect(paid[0].href).toBe(`/worker/pay/${payable!.id}`);

      const inbox = await workerInbox(t.db, workerScope);
      expect(inbox.notices.map(row => row.kind)).toEqual(expect.arrayContaining(["SHIFT_OFFER", "SHIFT_BOOKED", "PAYOUT_PAID"]));
      await markInboxRead(t.db, workerScope);
      expect(await workerUnread(t.db, workerScope)).toBe(0);

      // The shift's pay page shows the worker's own payout, Paid ✓ only because PayPal reported SUCCESS.
      const page = await workerShiftPay(t.db, workerScope, payable!.id);
      expect(page?.payout).toMatchObject({ status: "PAID", paypalBatchId: expect.stringMatching(/^PPB/) });
      expect(await workerShiftPay(t.db, { ...workerScope, workerId: randomUUID() }, payable!.id)).toBeNull();
    } finally { await t.close(); }
  });

  it("states rand first, then the US$ amount with the ECB rate it locked, in the Paid notice", async () => {
    const t = await createTestDatabase();
    try {
      const manager = (await payAgentCompany(t.db, { country: "South Africa" })).scopes[0];
      sandboxFixture(manager.organisationId);
      await seedTestFxRate(t.db);
      const { workerScope, offer } = await allocatedWork(t.db, manager);
      const { payable } = await confirmWork(t.db, offer.id, manager);
      await approveWorkPayable(t.db, manager, payable!.id);
      const first = await submitWorkPayout(t.db, paypal({ value: "0", currency: "USD" }), manager, payable!.id);
      const usd = (first.payout!.providerAmountMinor / 100).toFixed(2);
      await refreshWorkPayout(t.db, paypal({ value: usd, currency: "USD" }), manager, payable!.id);
      const [paid] = await t.db.select().from(notifications).where(and(eq(notifications.userId, workerScope.userId), eq(notifications.kind, "PAYOUT_PAID")));
      expect(paid.title).toMatch(/^Paid: R\s?\d/);
      expect(paid.body.indexOf("R")).toBeLessThan(paid.body.indexOf("US$"));
      expect(paid.body).toMatch(/US\$\d+\.\d{2} at ECB \d+\.\d{4}/);
      expect(paid.body).toContain("rand can't be sent through PayPal");
    } finally { await t.close(); }
  });

  it("tells booked workers who cancelled, under which rule, and the cancellation pay due", async () => {
    const t = await createTestDatabase();
    try {
      const manager = (await payAgentCompany(t.db)).scopes[0];
      const soon = new Date(Date.now() + 3 * 3_600_000);
      const { workerScope, shift } = await allocatedWork(t.db, manager, { startsAt: soon, endsAt: new Date(soon.getTime() + 4 * 3_600_000) });
      await t.db.update(shifts).set({ cancellationPercent: 50, cancellationWindowMinutes: 1440 }).where(eq(shifts.id, shift.id));
      await changeAssignment(t.db, manager, shift.id, { cancel: true });
      const [notice] = await t.db.select().from(notifications).where(and(eq(notifications.userId, workerScope.userId), eq(notifications.kind, "SHIFT_CANCELLED")));
      const [row] = await t.db.select().from(shifts).where(eq(shifts.id, shift.id));
      const due = cancellationDue(row, new Date())!;
      expect(due).toBe(Math.round((row.expectedEarningsMinor ?? row.guaranteedBasePayMinor) / 2));
      expect(notice.body).toContain("50%");
      expect(notice.body).toContain(`£${(due / 100).toFixed(2)}`);
      const [audit] = await t.db.select().from(auditEvents).where(eq(auditEvents.action, "SHIFT_CANCELLED"));
      expect(audit.metadata).toMatchObject({ actorUserId: manager.userId, cancellationPercent: 50, dueMinor: due, workerIds: [workerScope.workerId] });
      // Outside the window nothing is due.
      expect(cancellationDue({ ...row, startsAt: new Date(Date.now() + 3 * 86_400_000) }, new Date())).toBe(0);
    } finally { await t.close(); }
  });

  it("gives a shift the default cancellation pay when its location has no saved rule", async () => {
    const t = await createTestDatabase();
    try {
      const manager = (await payAgentCompany(t.db)).scopes[0];
      const { shift } = await allocatedWork(t.db, manager);
      const [row] = await t.db.select().from(shifts).where(eq(shifts.id, shift.id));
      expect(row).toMatchObject({ cancellationPercent: 50, cancellationWindowMinutes: 1440 });
    } finally { await t.close(); }
  });

  it("keeps each worker's messages to their own thread, and only the Owner answers pay questions", async () => {
    const t = await createTestDatabase();
    try {
      const manager = (await payAgentCompany(t.db)).scopes[0];
      const a = await allocatedWork(t.db, manager), b = await allocatedWork(t.db, manager);
      await sendWorkerMessage(t.db, a.workerScope, "Running 10 minutes late");
      await expect(sendWorkerMessage(t.db, a.workerScope, "   ")).rejects.toMatchObject({ feedback: "message-length" });
      await sendManagerMessage(t.db, manager, a.worker.id, "Thanks for letting us know.");
      expect((await workerInbox(t.db, a.workerScope)).messages.map(row => row.body)).toEqual(["Running 10 minutes late", "Thanks for letting us know."]);
      expect((await workerInbox(t.db, b.workerScope)).messages).toHaveLength(0);
      expect((await managerThread(t.db, manager, a.worker.id))?.messages).toHaveLength(2);
      await expect(sendManagerMessage(t.db, { ...manager, organisationId: randomUUID() }, a.worker.id, "Hi")).rejects.toThrow();

      const { payable } = await confirmWork(t.db, a.offer.id, manager);
      // A worker can ask only about their own shift's pay, once at a time.
      await expect(raisePayQuery(t.db, b.workerScope, { payableId: payable!.id, topic: "HOURS", message: "Is this mine?" })).rejects.toMatchObject({ feedback: "pay-query-unavailable" });
      await expect(raisePayQuery(t.db, a.workerScope, { payableId: payable!.id, topic: "BONUS", message: "?" })).rejects.toMatchObject({ feedback: "pay-query-topic" });
      const query = await raisePayQuery(t.db, a.workerScope, { payableId: payable!.id, topic: "HOURS", message: "I stayed 30 minutes longer." });
      expect(query.triage).toMatchObject({ route: "OWNER" });
      await expect(raisePayQuery(t.db, a.workerScope, { payableId: payable!.id, topic: "AMOUNT", message: "And the amount?" })).rejects.toMatchObject({ feedback: "pay-query-open" });
      await expect(answerPayQuery(t.db, manager, query.id, "Checked.")).rejects.toThrow();
      const owner: Scope = { ...manager, role: "OWNER", userId: await testUser(t.db) };
      const before = await t.db.select().from(workPayables).where(eq(workPayables.id, payable!.id));
      await answerPayQuery(t.db, owner, query.id, "Your shift was scheduled to 14:00; I've asked your manager to check.");
      await expect(answerPayQuery(t.db, owner, query.id, "Again")).rejects.toMatchObject({ feedback: "pay-query-unavailable" });
      expect(await t.db.select().from(workPayables).where(eq(workPayables.id, payable!.id))).toEqual(before);
      const [answered] = await t.db.select().from(payQueries).where(eq(payQueries.id, query.id));
      expect(answered).toMatchObject({ status: "ANSWERED", answeredBy: owner.userId });
      const [notice] = await t.db.select().from(notifications).where(and(eq(notifications.userId, a.workerScope.userId), eq(notifications.kind, "PAY_QUERY_ANSWERED")));
      expect(notice.href).toBe(`/worker/pay/${payable!.id}`);
    } finally { await t.close(); }
  });

  it("passes a shift to round 2 once everyone in round 1 declines", async () => {
    const t = await createTestDatabase();
    try {
      const manager = (await payAgentCompany(t.db)).scopes[0];
      const [department] = await createDepartment(t.db, "Floor", manager);
      const [policy] = await createWorkPolicy(t.db, { earningsModel: "HOURLY" as const, rateMinor: await fixtureHourlyRate(t.db, manager) }, "Casual terms", manager);
      const startsAt = new Date(Date.now() + 2 * 86_400_000);
      const shift = await createRequirement(t.db, { departmentId: department.id, policyId: policy.id, startsAt, endsAt: new Date(startsAt.getTime() + 4 * 3_600_000), requiredHeadcount: 1 }, manager);
      const people: { worker: { id: string }; scope: Scope }[] = [];
      for (const name of ["One", "Two"]) {
        const { worker } = await createActivatedTeamMember(t.db, { firstName: name, surname: "Worker", telephone: "+441132000000", email: `${name.toLowerCase()}.${randomUUID().slice(0, 6)}@example.test` }, manager);
        const userId = await testUser(t.db);
        await t.db.update(workers).set({ userId }).where(eq(workers.id, worker.id));
        people.push({ worker, scope: { ...manager, userId, workerId: worker.id, role: "TEAM_MEMBER" } as Scope });
      }
      // Round 1 went to the first worker only.
      const offer = await offerAssignment(t.db, shift.id, people[0].worker.id, manager, { round: true });
      await t.db.insert(offerRounds).values({ id: randomUUID(), organisationId: manager.organisationId, outletId: manager.locationId, shiftId: shift.id, round: 1, openedAt: new Date(), closesAt: new Date(Date.now() + 3_600_000), criteria: "Round 1", offers: [{ workerId: people[0].worker.id, offerId: offer.id }] });
      await workerRespond(t.db, people[0].scope, offer.id, 1, "DECLINED", false);
      const rounds = await t.db.select().from(offerRounds).where(eq(offerRounds.shiftId, shift.id));
      expect(rounds.map(row => row.round).sort()).toEqual([1, 2]);
      const offers = await t.db.select().from(shiftOffers).where(eq(shiftOffers.shiftId, shift.id));
      expect(offers.find(row => row.workerId === people[1].worker.id)?.status).toBe("OFFERED");
      // Once round 2 exists, a later decline doesn't open another.
      expect(await passOnAfterDecline(t.db, manager, shift.id)).toEqual({ opened: false });
    } finally { await t.close(); }
  });
});
