import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { assertRole, type Scope } from "@/server/auth/access";
import { requireEntitlement } from "@/server/billing/entitlement";
import { audit } from "@/server/commerce/connections";
import { liveSquareConnection, squareToken } from "@/server/commerce/square-connection";
import type { Database, DatabaseSession } from "@/server/db/client";
import { attributedSales, commerceWorkerIdentities, workPerformanceResults, workers } from "@/server/db/schema";
import { UserFacingError } from "@/server/domain/errors";
import { SquareError, type SquareClient } from "@/server/integrations/square/client";
import { incentiveWork, SQUARE_ATTRIBUTION_PROVIDER } from "@/server/performance/attribution";
import { deriveSquareAttribution } from "@/server/performance/square-attribution";

// A manager or owner states that a Square team member identity means one FairShift worker. Their
// organisation and location come from the session, the worker must work at that location, and the
// identity must be one Square currently lists for the connected location. It maps an identity. It
// does not establish who was logged in to a till.
type MappingScope = Pick<Scope, "organisationId" | "locationId" | "role"> & { userId?: string };

async function authorise(db: DatabaseSession, scope: MappingScope) {
  assertRole(scope as Scope, ["OWNER", "MANAGER"]);
  await requireEntitlement(db, scope.organisationId);
  const connection = await liveSquareConnection(db, scope);
  if (!connection) throw new UserFacingError("commerce-not-connected", "This location has no connection.");
  return connection;
}

export async function listSquareTeamMembers(db: DatabaseSession, scope: MappingScope, client: SquareClient) {
  const connection = await authorise(db, scope);
  return client.teamMembers(squareToken(connection), connection.providerLocationId!);
}

export async function mapSquareTeamMember(db: Database, scope: MappingScope, input: { workerId: string; teamMemberId: string }, client: SquareClient, now = new Date()) {
  const connection = await authorise(db, scope);
  const workerId = z.uuid().safeParse(input.workerId);
  const [worker] = workerId.success ? await db.select({ id: workers.id }).from(workers).where(and(eq(workers.id, workerId.data), eq(workers.organisationId, scope.organisationId), eq(workers.locationId, scope.locationId), eq(workers.status, "ACTIVE"))) : [];
  if (!worker) throw new UserFacingError("square-mapping-worker", "That worker is not available at this location.");
  let members;
  try { members = await client.teamMembers(squareToken(connection), connection.providerLocationId!); }
  catch (error) { if (error instanceof SquareError) throw new UserFacingError("square-unavailable", "Square could not be reached."); throw error; }
  if (!members.some(member => member.id === input.teamMemberId)) throw new UserFacingError("square-mapping-identity", "Square does not list that team member at this location.");
  return db.transaction(async tx => {
    const id = randomUUID();
    const [created] = await tx.insert(commerceWorkerIdentities).values({ id, organisationId: scope.organisationId, outletId: scope.locationId, workerId: worker.id, provider: SQUARE_ATTRIBUTION_PROVIDER, providerMerchantId: connection.providerMerchantId, providerTeamMemberId: input.teamMemberId, status: "ACTIVE", createdBy: scope.userId ?? null, createdAt: now }).onConflictDoNothing().returning({ id: commerceWorkerIdentities.id });
    if (!created) throw new UserFacingError("square-mapping-duplicate", "That worker or Square team member is already mapped.");
    await audit(tx, scope, scope.locationId, "SQUARE_TEAM_MEMBER_MAPPED", connection.id, { mappingId: id, workerId: worker.id });
    // Payments already held for this identity can now qualify.
    await deriveSquareAttribution(tx, scope);
    return { id };
  });
}

// Stops future attribution through this mapping and withdraws sales it attributed that no manager
// has confirmed, so a mistaken mapping can be corrected. Confirmed results are final and stay.
export async function removeSquareMapping(db: Database, scope: MappingScope, mappingId: string, now = new Date()) {
  assertRole(scope as Scope, ["OWNER", "MANAGER"]);
  await requireEntitlement(db, scope.organisationId);
  const parsed = z.uuid().safeParse(mappingId);
  return db.transaction(async tx => {
    const [mapping] = parsed.success ? await tx.update(commerceWorkerIdentities).set({ status: "REMOVED", removedAt: now, removedBy: scope.userId ?? null })
      .where(and(eq(commerceWorkerIdentities.id, parsed.data), eq(commerceWorkerIdentities.organisationId, scope.organisationId), eq(commerceWorkerIdentities.outletId, scope.locationId), eq(commerceWorkerIdentities.status, "ACTIVE"))).returning() : [];
    if (!mapping) throw new UserFacingError("square-mapping-unavailable", "That mapping is not available.");
    const work = await incentiveWork(tx, { ...scope, role: "MANAGER" }, true, [mapping.workerId]);
    const finals = work.length ? await tx.select({ id: workPerformanceResults.allocationId }).from(workPerformanceResults).where(inArray(workPerformanceResults.allocationId, work.map(item => item.allocation.id))) : [];
    const locked = work.filter(item => finals.some(row => row.id === item.allocation.id));
    const attributed = await tx.select({ id: attributedSales.id, occurredAt: attributedSales.occurredAt }).from(attributedSales).where(and(eq(attributedSales.outletId, scope.locationId), eq(attributedSales.provider, SQUARE_ATTRIBUTION_PROVIDER), eq(attributedSales.workerId, mapping.workerId)));
    const withdrawn = attributed.filter(row => !locked.some(item => item.terms.startsAt <= row.occurredAt && row.occurredAt < item.terms.endsAt)).map(row => row.id);
    if (withdrawn.length) await tx.delete(attributedSales).where(inArray(attributedSales.id, withdrawn));
    await audit(tx, scope, scope.locationId, "SQUARE_TEAM_MEMBER_UNMAPPED", mapping.id, { workerId: mapping.workerId, withdrawnSales: withdrawn.length });
    return { withdrawn: withdrawn.length };
  });
}

export async function getSquareMappings(db: DatabaseSession, scope: MappingScope) {
  assertRole(scope as Scope, ["OWNER", "MANAGER"]);
  return db.select({ id: commerceWorkerIdentities.id, workerId: commerceWorkerIdentities.workerId, workerName: workers.displayName, teamMemberId: commerceWorkerIdentities.providerTeamMemberId, createdAt: commerceWorkerIdentities.createdAt })
    .from(commerceWorkerIdentities).innerJoin(workers, eq(workers.id, commerceWorkerIdentities.workerId))
    .where(and(eq(commerceWorkerIdentities.organisationId, scope.organisationId), eq(commerceWorkerIdentities.outletId, scope.locationId), eq(commerceWorkerIdentities.status, "ACTIVE")));
}
