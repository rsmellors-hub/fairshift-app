import { and, eq } from "drizzle-orm";

import {
  DEMO_CASUAL_WORKER_ID,
  DEMO_ORGANISATION_ID,
  DEMO_OUTLET_ID,
  DEMO_SHIFT_ID,
  DEMO_SHIFT_OFFER_ID,
} from "@/server/constants";
import type { DatabaseSession } from "@/server/db/client";
import {
  auditEvents,
  shiftOffers,
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
    id: string;
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
      id: input.id,
      organisationId: DEMO_ORGANISATION_ID,
      outletId: DEMO_OUTLET_ID,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      correlationId: input.correlationId,
      metadata: input.metadata ?? {},
    })
    .onConflictDoNothing();
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

export async function publishDemoShift(db: DatabaseSession) {
  const worker = await ensureDemoCasualWorker(db);
  const now = new Date();

  await db
    .insert(shifts)
    .values({
      id: DEMO_SHIFT_ID,
      outletId: DEMO_OUTLET_ID,
      ...DEMO_SHIFT_TERMS,
      status: "PUBLISHED",
      publishedAt: now,
    })
    .onConflictDoNothing({ target: shifts.id });

  const [shift] = await db
    .select()
    .from(shifts)
    .where(
      and(
        eq(shifts.id, DEMO_SHIFT_ID),
        eq(shifts.outletId, DEMO_OUTLET_ID),
      ),
    )
    .limit(1);

  if (!shift || shift.status !== "PUBLISHED") {
    throw new Error("Demo shift could not be published.");
  }

  await db
    .insert(shiftOffers)
    .values({
      id: DEMO_SHIFT_OFFER_ID,
      shiftId: shift.id,
      workerId: worker.id,
      status: "OFFERED",
      offeredAt: now,
    })
    .onConflictDoNothing({ target: shiftOffers.id });

  const [offer] = await db
    .select()
    .from(shiftOffers)
    .where(
      and(
        eq(shiftOffers.id, DEMO_SHIFT_OFFER_ID),
        eq(shiftOffers.shiftId, shift.id),
        eq(shiftOffers.workerId, worker.id),
      ),
    )
    .limit(1);

  if (!offer) {
    throw new Error("Demo shift offer is unavailable.");
  }

  await writeSchedulingAudit(db, {
    id: "60000000-0000-4000-8000-000000000001",
    action: "SHIFT_PUBLISHED",
    entityType: "shift",
    entityId: shift.id,
    correlationId: "demo-shift-publication",
    metadata: {
      workerId: worker.id,
      offerId: offer.id,
      shiftDate: shift.shiftDate,
      guaranteedBasePayMinor: shift.guaranteedBasePayMinor,
    },
  });

  return { worker, shift, offer };
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
        eq(shiftOffers.id, DEMO_SHIFT_OFFER_ID),
        eq(workers.id, DEMO_CASUAL_WORKER_ID),
        eq(workers.organisationId, DEMO_ORGANISATION_ID),
        eq(shifts.outletId, DEMO_OUTLET_ID),
      ),
    )
    .limit(1);

  return row ?? null;
}

export async function acceptDemoShift(db: DatabaseSession) {
  const current = await getDemoWorkerShift(db);

  if (!current) {
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
        eq(shiftOffers.id, DEMO_SHIFT_OFFER_ID),
        eq(shiftOffers.shiftId, DEMO_SHIFT_ID),
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
    id: "60000000-0000-4000-8000-000000000002",
    action: "SHIFT_ACCEPTED",
    entityType: "shift_offer",
    entityId: accepted.id,
    correlationId: "demo-shift-acceptance",
    metadata: {
      workerId: DEMO_CASUAL_WORKER_ID,
      shiftId: DEMO_SHIFT_ID,
    },
  });

  const result = await getDemoWorkerShift(db);

  if (!result || result.offer.status !== "ACCEPTED") {
    throw new Error("Persisted shift acceptance could not be confirmed.");
  }

  return result;
}
