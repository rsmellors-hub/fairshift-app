import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";

import {
  DEMO_CASUAL_WORKER_ID,
  DEMO_ORGANISATION_ID,
  DEMO_OUTLET_ID,
  DEMO_SHIFT_ID,
  DEMO_SHIFT_OFFER_ID,
} from "@/server/constants";
import type { Database, DatabaseSession } from "@/server/db/client";
import {
  auditEvents,
  outlets,
  shiftOffers,
  shiftIncentives,
  shifts,
  workers,
} from "@/server/db/schema";

export const DEMO_SHIFT_TERMS = {
  shiftDate: "2026-10-16",
  startsAt: new Date("2026-10-16T06:00:00.000Z"),
  endsAt: new Date("2026-10-16T14:00:00.000Z"),
  roleName: "Casual service team",
  currencyCode: "USD",
  guaranteedBasePayMinor: 12_000,
  incentiveTargetMinor: 65_000,
  incentiveAmountMinor: 2_500,
  gratuityPolicy:
    "Gratuity is separate from guaranteed base pay and is calculated from verified shift gratuities.",
  incentivePolicy:
    "Optional team incentive is earned only if the published team target is achieved and later verified.",
} as const;

async function writeSchedulingAudit(
  db: DatabaseSession,
  input: {
    action: string;
    entityType: string;
    entityId: string;
    correlationId: string;
    metadata?: Record<string, string | number | boolean | null>;
  },
) {
  await db
    .insert(auditEvents)
    .values({
      id: randomUUID(),
      organisationId: DEMO_ORGANISATION_ID,
      outletId: DEMO_OUTLET_ID,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      correlationId: input.correlationId,
      metadata: input.metadata ?? {},
    });
}

function nextDemoDate(previous: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Johannesburg", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((value) => value.type === type)?.value;
  const today = `${part("year")}-${part("month")}-${part("day")}`;
  const tomorrowDate = new Date(`${today}T00:00:00.000Z`);
  tomorrowDate.setUTCDate(tomorrowDate.getUTCDate() + 1);
  const tomorrow = tomorrowDate.toISOString().slice(0, 10);
  const next = new Date(`${previous}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10) > tomorrow ? next.toISOString().slice(0, 10) : tomorrow;
}

async function createDemoShift(db: DatabaseSession, shiftId: string, offerId: string, shiftDate: string) {
  const worker = await ensureDemoCasualWorker(db);
  const now = new Date();
  const [shift] = await db.insert(shifts).values({
    id: shiftId, outletId: DEMO_OUTLET_ID, ...DEMO_SHIFT_TERMS,
    shiftDate,
    startsAt: new Date(`${shiftDate}T06:00:00.000Z`),
    endsAt: new Date(`${shiftDate}T14:00:00.000Z`),
    status: "PUBLISHED", publishedAt: now,
  }).onConflictDoNothing({ target: shifts.id }).returning();
  if (!shift) return getDemoWorkerShift(db);
  const [offer] = await db.insert(shiftOffers).values({
    id: offerId, shiftId: shift.id, workerId: worker.id, status: "OFFERED", offeredAt: now,
  }).returning();
  await writeSchedulingAudit(db, {
    action: "SHIFT_PUBLISHED", entityType: "shift", entityId: shift.id,
    correlationId: `demo-cycle:${shift.id}`,
    metadata: { workerId: worker.id, offerId: offer.id, shiftDate: shift.shiftDate, guaranteedBasePayMinor: shift.guaranteedBasePayMinor },
  });
  return { worker, shift, offer };
}

export async function ensureDemoCasualWorker(db: DatabaseSession) {
  await db
    .insert(workers)
    .values({
      id: DEMO_CASUAL_WORKER_ID,
      organisationId: DEMO_ORGANISATION_ID,
      displayName: "Alex Morgan",
      workerType: "CASUAL",
      status: "ACTIVE",
    })
    .onConflictDoNothing({ target: workers.id });

  const [worker] = await db
    .select()
    .from(workers)
    .where(
      and(
        eq(workers.id, DEMO_CASUAL_WORKER_ID),
        eq(workers.organisationId, DEMO_ORGANISATION_ID),
      ),
    )
    .limit(1);

  if (!worker || worker.workerType !== "CASUAL" || worker.status !== "ACTIVE") {
    throw new Error("Demo casual worker is unavailable.");
  }

  return worker;
}

export async function publishDemoShift(db: Database) {
  return db.transaction(async (tx) => {
    await tx.select({ id: outlets.id }).from(outlets).where(eq(outlets.id, DEMO_OUTLET_ID)).for("update");
    const current = await getDemoWorkerShift(tx);
    if (current) return current;
    const created = await createDemoShift(tx, DEMO_SHIFT_ID, DEMO_SHIFT_OFFER_ID, DEMO_SHIFT_TERMS.shiftDate);
    if (!created) throw new Error("Demo shift could not be published.");
    return created;
  });
}

export async function startNewDemoCycle(db: Database) {
  return db.transaction(async (tx) => {
    // The outlet row serialises repeated clicks across hosted instances.
    await tx.select({ id: outlets.id }).from(outlets).where(eq(outlets.id, DEMO_OUTLET_ID)).for("update");
    const current = await getDemoWorkerShift(tx);
    if (!current) throw new Error("Publish the first demo shift before starting another cycle.");
    const [incentive] = await tx.select().from(shiftIncentives).where(and(
      eq(shiftIncentives.shiftId, current.shift.id), eq(shiftIncentives.workerId, DEMO_CASUAL_WORKER_ID),
    )).limit(1);
    if (!incentive || !["PAID", "FAILED", "NOT_EARNED"].includes(incentive.status)) {
      throw new Error("Finish the current demo cycle before starting another.");
    }
    const created = await createDemoShift(tx, randomUUID(), randomUUID(), nextDemoDate(current.shift.shiftDate));
    if (!created) throw new Error("New demo cycle could not be started.");
    return created;
  });
}

export async function getDemoWorkerShift(db: DatabaseSession) {
  const [row] = await db
    .select({
      worker: workers,
      shift: shifts,
      offer: shiftOffers,
    })
    .from(shiftOffers)
    .innerJoin(workers, eq(shiftOffers.workerId, workers.id))
    .innerJoin(shifts, eq(shiftOffers.shiftId, shifts.id))
    .where(
      and(
        eq(workers.id, DEMO_CASUAL_WORKER_ID),
        eq(workers.organisationId, DEMO_ORGANISATION_ID),
        eq(shifts.outletId, DEMO_OUTLET_ID),
        eq(shifts.roleName, DEMO_SHIFT_TERMS.roleName),
      ),
    )
    .orderBy(desc(shifts.shiftDate), desc(shifts.createdAt), desc(shifts.id))
    .limit(1);

  return row ?? null;
}

export async function acceptDemoShift(db: DatabaseSession, expectedShiftId?: string) {
  const current = await getDemoWorkerShift(db);

  if (!current || (expectedShiftId && current.shift.id !== expectedShiftId)) {
    throw new Error("Shift offer is unavailable.");
  }

  if (current.shift.status !== "PUBLISHED") {
    throw new Error("Only published shifts can be accepted.");
  }

  if (current.worker.status !== "ACTIVE") {
    throw new Error("Inactive workers cannot accept shifts.");
  }

  if (current.offer.status === "ACCEPTED") {
    return current;
  }

  if (current.offer.status !== "OFFERED") {
    throw new Error("Shift offer is no longer available for acceptance.");
  }

  const now = new Date();

  const [accepted] = await db
    .update(shiftOffers)
    .set({
      status: "ACCEPTED",
      respondedAt: now,
      acceptedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(shiftOffers.id, current.offer.id),
        eq(shiftOffers.shiftId, current.shift.id),
        eq(shiftOffers.workerId, DEMO_CASUAL_WORKER_ID),
        eq(shiftOffers.status, "OFFERED"),
      ),
    )
    .returning();

  if (!accepted) {
    const recovered = await getDemoWorkerShift(db);

    if (recovered?.offer.status === "ACCEPTED") {
      return recovered;
    }

    throw new Error("Shift acceptance could not be persisted.");
  }

  await writeSchedulingAudit(db, {
    action: "SHIFT_ACCEPTED",
    entityType: "shift_offer",
    entityId: accepted.id,
    correlationId: `demo-cycle:${current.shift.id}`,
    metadata: {
      workerId: DEMO_CASUAL_WORKER_ID,
      shiftId: current.shift.id,
    },
  });

  const result = await getDemoWorkerShift(db);

  if (!result || result.offer.status !== "ACCEPTED") {
    throw new Error("Persisted shift acceptance could not be confirmed.");
  }

  return result;
}
