import { randomUUID } from "node:crypto";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { assertRole, type Scope } from "@/server/auth/access";
import { auditActor } from "@/server/auth/audit-actor";
import type { Database, DatabaseSession } from "@/server/db/client";
import { auditEvents, memberships, outlets, workerLocations, workers } from "@/server/db/schema";
import { UserFacingError } from "@/server/domain/errors";

// A casual worker may belong to several locations of one business (Owner decision 10 Nov 2026). Their
// own location (workers.location_id) is always one of them; worker_locations holds the others. Every
// rule that asks "may this worker be offered work here?" uses worksAt.

export const worksAt = (outletId: string) => or(eq(workers.locationId, outletId),
  sql`exists (select 1 from worker_locations wl where wl.worker_id = "workers"."id" and wl.outlet_id = ${outletId} and wl.removed_at is null)`)!;

export async function workerLocationIds(db: DatabaseSession, workerId: string) {
  const [worker] = await db.select({ locationId: workers.locationId }).from(workers).where(eq(workers.id, workerId));
  if (!worker) return [];
  const extra = await db.select({ outletId: workerLocations.outletId }).from(workerLocations).where(and(eq(workerLocations.workerId, workerId), isNull(workerLocations.removedAt)));
  return [...new Set([worker.locationId, ...extra.map(row => row.outletId)].filter((id): id is string => !!id))];
}

const audit = (db: DatabaseSession, scope: Scope, outletId: string, action: string, workerId: string, detail: Record<string, unknown> = {}) =>
  db.insert(auditEvents).values({ id: randomUUID(), organisationId: scope.organisationId, outletId, action, entityType: "worker", entityId: workerId, correlationId: `${action.toLowerCase()}:${workerId}:${outletId}:${Date.now()}`, metadata: { ...auditActor(scope), ...detail } });

// Adds a location to a casual worker. The Owner may add any of the business's active locations; a
// Manager only their own.
export async function addWorkerLocation(db: Database, scope: Scope, workerId: string, outletId: string) {
  assertRole(scope, ["OWNER", "MANAGER"]);
  if (scope.role === "MANAGER" && outletId !== scope.locationId) throw new Error("Access denied.");
  return db.transaction(async tx => {
    const [worker] = await tx.select().from(workers).where(and(eq(workers.id, workerId), eq(workers.organisationId, scope.organisationId), eq(workers.workerType, "CASUAL"))).for("update");
    const [place] = await tx.select({ id: outlets.id }).from(outlets).where(and(eq(outlets.id, outletId), eq(outlets.organisationId, scope.organisationId), eq(outlets.active, true)));
    if (!worker || !place) throw new Error("Person or location unavailable.");
    if ((await workerLocationIds(tx, workerId)).includes(outletId)) return false;
    await tx.insert(workerLocations).values({ id: randomUUID(), organisationId: scope.organisationId, workerId, outletId, addedBy: scope.userId });
    await audit(tx, scope, outletId, "WORKER_LOCATION_ADDED", workerId);
    return true;
  });
}

// Removes a person from one location and keeps all their history. A casual worker keeps at least one
// location (deactivate them to stop all work); if it was their own location, another becomes it. A
// Manager loses access to that location only.
export async function removeFromLocation(db: Database, scope: Scope, key: string, outletId: string) {
  assertRole(scope, ["OWNER", "MANAGER"]);
  if (scope.role === "MANAGER" && outletId !== scope.locationId) throw new Error("Access denied.");
  const [kind, id] = key.split(":");
  return db.transaction(async tx => {
    if (kind === "worker") {
      const [worker] = await tx.select().from(workers).where(and(eq(workers.id, id), eq(workers.organisationId, scope.organisationId))).for("update");
      if (!worker) throw new Error("Person unavailable.");
      const places = await workerLocationIds(tx, worker.id);
      if (!places.includes(outletId)) throw new Error("Person unavailable.");
      if (places.length === 1) throw new UserFacingError("person-last-location", "This is their only location. Deactivate them instead to stop all their work.");
      const now = new Date();
      if (worker.locationId === outletId) {
        // A signed-up worker's membership is tied to the location they joined (database rule), so their
        // own location can't move: remove the others, or deactivate them, instead.
        if (worker.userId) throw new UserFacingError("person-home-location", "This is the location they joined FairShift through. Remove them from their other locations, or deactivate them.");
        const next = places.find(place => place !== outletId)!;
        await tx.update(workers).set({ locationId: next, updatedAt: now }).where(eq(workers.id, worker.id));
        await tx.update(workerLocations).set({ removedAt: now, removedBy: scope.userId }).where(and(eq(workerLocations.workerId, worker.id), eq(workerLocations.outletId, next), isNull(workerLocations.removedAt)));
      } else {
        await tx.update(workerLocations).set({ removedAt: now, removedBy: scope.userId }).where(and(eq(workerLocations.workerId, worker.id), eq(workerLocations.outletId, outletId), isNull(workerLocations.removedAt)));
      }
      await audit(tx, scope, outletId, "PERSON_REMOVED_FROM_LOCATION", worker.id, { role: "TEAM_MEMBER" });
      return;
    }
    assertRole(scope, ["OWNER"]);
    if (kind === "manager") {
      const revoked = await tx.update(memberships).set({ state: "REVOKED" }).where(and(eq(memberships.userId, id), eq(memberships.organisationId, scope.organisationId), eq(memberships.role, "MANAGER"), eq(memberships.outletId, outletId), eq(memberships.state, "ACTIVE"))).returning();
      if (!revoked.length) throw new Error("Person unavailable.");
      await tx.insert(auditEvents).values({ id: randomUUID(), organisationId: scope.organisationId, outletId, action: "PERSON_REMOVED_FROM_LOCATION", entityType: "manager", entityId: id, correlationId: `removed:${id}:${outletId}:${Date.now()}`, metadata: { ...auditActor(scope), role: "MANAGER" } });
      return;
    }
    throw new Error("Person unavailable.");
  });
}
