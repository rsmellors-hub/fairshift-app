import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  DEMO_CASUAL_WORKER_ID,
  DEMO_SHIFT_ID,
  DEMO_SHIFT_OFFER_ID,
} from "@/server/constants";
import { auditEvents, shiftOffers, shifts } from "@/server/db/schema";
import { markDemoShiftCompleted, recordDemoPerformance } from "@/server/incentives/demo";
import {
  acceptDemoShift,
  DEMO_SHIFT_TERMS,
  getDemoWorkerShift,
  publishDemoShift,
  startNewDemoCycle,
} from "@/server/scheduling/demo";
import { createTestDatabase } from "../helpers/database";

describe("workforce scheduling persistence", () => {
  it("migrates a blank database through the workforce scheduling schema", async () => {
    const testDb = await createTestDatabase();

    try {
      const result = await testDb.db
        .select()
        .from(shifts)
        .where(eq(shifts.id, DEMO_SHIFT_ID));

      expect(result).toEqual([]);
    } finally {
      await testDb.close();
    }
  });

  it("publishes the demo shift with explicit worker and financial terms", async () => {
    const testDb = await createTestDatabase();

    try {
      const result = await publishDemoShift(testDb.db);

      expect(result.worker).toMatchObject({
        id: DEMO_CASUAL_WORKER_ID,
        workerType: "CASUAL",
        status: "ACTIVE",
      });

      expect(result.shift).toMatchObject({
        id: DEMO_SHIFT_ID,
        status: "PUBLISHED",
        shiftDate: DEMO_SHIFT_TERMS.shiftDate,
        roleName: DEMO_SHIFT_TERMS.roleName,
        currencyCode: DEMO_SHIFT_TERMS.currencyCode,
        guaranteedBasePayMinor: DEMO_SHIFT_TERMS.guaranteedBasePayMinor,
        gratuityPolicy: DEMO_SHIFT_TERMS.gratuityPolicy,
        incentivePolicy: DEMO_SHIFT_TERMS.incentivePolicy,
      });

      expect(result.shift.publishedAt).toBeInstanceOf(Date);

      expect(result.offer).toMatchObject({
        id: DEMO_SHIFT_OFFER_ID,
        workerId: DEMO_CASUAL_WORKER_ID,
        shiftId: DEMO_SHIFT_ID,
        status: "OFFERED",
        respondedAt: null,
        acceptedAt: null,
      });
    } finally {
      await testDb.close();
    }
  });

  it("publishes idempotently without duplicate shift offers", async () => {
    const testDb = await createTestDatabase();

    try {
      await publishDemoShift(testDb.db);
      await publishDemoShift(testDb.db);

      const persistedShifts = await testDb.db
        .select()
        .from(shifts)
        .where(eq(shifts.id, DEMO_SHIFT_ID));

      const persistedOffers = await testDb.db
        .select()
        .from(shiftOffers)
        .where(eq(shiftOffers.id, DEMO_SHIFT_OFFER_ID));

      expect(persistedShifts).toHaveLength(1);
      expect(persistedOffers).toHaveLength(1);
    } finally {
      await testDb.close();
    }
  });

  it("persists worker acceptance and acceptance audit evidence", async () => {
    const testDb = await createTestDatabase();

    try {
      await publishDemoShift(testDb.db);

      const accepted = await acceptDemoShift(testDb.db, undefined, true);

      expect(accepted.offer.status).toBe("ACCEPTED");
      expect(accepted.offer.respondedAt).toBeInstanceOf(Date);
      expect(accepted.offer.acceptedAt).toBeInstanceOf(Date);

      const persisted = await getDemoWorkerShift(testDb.db);

      expect(persisted?.offer.status).toBe("ACCEPTED");
      expect(persisted?.offer.respondedAt).toBeInstanceOf(Date);
      expect(persisted?.offer.acceptedAt).toBeInstanceOf(Date);

      const acceptanceAudit = await testDb.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.action, "SHIFT_ACCEPTED"));

      expect(acceptanceAudit).toHaveLength(1);
      expect(acceptanceAudit[0]).toMatchObject({
        entityType: "shift_offer",
        entityId: DEMO_SHIFT_OFFER_ID,
      });
    } finally {
      await testDb.close();
    }
  });

  it("treats repeated acceptance as idempotent", async () => {
    const testDb = await createTestDatabase();

    try {
      await publishDemoShift(testDb.db);

      const first = await acceptDemoShift(testDb.db, undefined, true);
      const second = await acceptDemoShift(testDb.db, undefined, true);

      expect(first.offer.status).toBe("ACCEPTED");
      expect(second.offer.status).toBe("ACCEPTED");
      expect(second.offer.acceptedAt?.getTime()).toBe(
        first.offer.acceptedAt?.getTime(),
      );

      const acceptanceAudits = await testDb.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.action, "SHIFT_ACCEPTED"));

      expect(acceptanceAudits).toHaveLength(1);
    } finally {
      await testDb.close();
    }
  });

  it("rejects invalid accepted state at the database boundary", async () => {
    const testDb = await createTestDatabase();

    try {
      await publishDemoShift(testDb.db);

      await expect(
        testDb.db
          .update(shiftOffers)
          .set({
            status: "ACCEPTED",
            respondedAt: null,
            acceptedAt: null,
          })
          .where(eq(shiftOffers.id, DEMO_SHIFT_OFFER_ID)),
      ).rejects.toThrow();
    } finally {
      await testDb.close();
    }
  });

  it("starts a distinct current cycle, retains history and audits each publication and acceptance", async () => {
    const testDb = await createTestDatabase();
    try {
      const first = await publishDemoShift(testDb.db);
      await acceptDemoShift(testDb.db, undefined, true);
      await markDemoShiftCompleted(testDb.db);
      await recordDemoPerformance(testDb.db, 0);

      const second = await startNewDemoCycle(testDb.db);
      expect(second.shift.id).not.toBe(first.shift.id);
      expect(second.offer.id).not.toBe(first.offer.id);
      expect(second.shift.shiftDate > first.shift.shiftDate).toBe(true);
      expect((await getDemoWorkerShift(testDb.db))?.shift.id).toBe(second.shift.id);
      await expect(startNewDemoCycle(testDb.db)).rejects.toThrow(/Finish the current/);

      await acceptDemoShift(testDb.db, undefined, true);
      const persistedShifts = await testDb.db.select().from(shifts);
      const persistedOffers = await testDb.db.select().from(shiftOffers);
      expect(persistedShifts.map((row) => row.id)).toContain(first.shift.id);
      expect(persistedOffers.map((row) => row.id)).toContain(first.offer.id);
      expect(persistedShifts).toHaveLength(2);
      expect(persistedOffers).toHaveLength(2);

      const events = await testDb.db.select().from(auditEvents);
      expect(events.filter((event) => event.action === "SHIFT_PUBLISHED")).toHaveLength(2);
      expect(events.filter((event) => event.action === "SHIFT_ACCEPTED")).toHaveLength(2);
      expect(new Set(events.map((event) => event.id)).size).toBe(4);
      expect(new Set(events.map((event) => event.correlationId))).toEqual(new Set([
        `demo-cycle:${first.shift.id}`, `demo-cycle:${second.shift.id}`,
      ]));
    } finally {
      await testDb.close();
    }
  });
});
