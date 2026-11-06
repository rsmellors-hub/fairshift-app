import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, lt, ne } from "drizzle-orm";
import { z } from "zod";

import { assertRole, type Scope } from "@/server/auth/access";
import { requireEntitlement } from "@/server/billing/entitlement";
import { credentialKey } from "@/server/commerce/credentials";
import type { Database, DatabaseSession } from "@/server/db/client";
import { auditEvents, commerceConnections, commerceSyncRuns, outlets } from "@/server/db/schema";
import { UserFacingError } from "@/server/domain/errors";

// A location's connection to its merchant account, and the retrieval of its sales.
// Everything reaching canonical history goes through the commerce boundary. A failure
// stores no sales, leaves earlier history in place, and is reported as a failure: it
// is never read as zero sales, and only a sync that finished advances the window.
const FIRST_SYNC_DAYS = 120;
const OVERLAP_DAYS = 1;
const ABANDONED_AFTER_MS = 15 * 60_000;

export type ConnectionScope = Pick<Scope, "userId" | "organisationId" | "locationId" | "role">;
export const authorised = async (db: DatabaseSession, scope: ConnectionScope) => { assertRole(scope as Scope, ["OWNER"]); await requireEntitlement(db, scope.organisationId); };
export const requiredKey = () => {
  const key = credentialKey();
  if (!key) throw new UserFacingError("commerce-not-configured", "Commerce connections are not configured.");
  return key;
};
export async function ownedLocation(db: DatabaseSession, scope: ConnectionScope, outletId: string) {
  const parsed = z.uuid().safeParse(outletId);
  const [outlet] = parsed.success ? await db.select({ id: outlets.id }).from(outlets).where(and(eq(outlets.id, parsed.data), eq(outlets.organisationId, scope.organisationId), eq(outlets.active, true))) : [];
  if (!outlet) throw new UserFacingError("commerce-location", "Location unavailable.");
  return outlet.id;
}
export const audit = (db: DatabaseSession, scope: { organisationId: string; userId?: string | null }, outletId: string, action: string, entityId: string, metadata: Record<string, unknown> = {}) =>
  db.insert(auditEvents).values({ id: randomUUID(), organisationId: scope.organisationId, outletId, action, entityType: "commerce_connection", entityId, correlationId: `commerce:${entityId}`, metadata: { actorUserId: scope.userId ?? null, ...metadata } });

// Opens a run for a connection's retrieval, covering everything since the last completed sync
// less an overlap, because repeats are harmless and late records are not. Null means another
// run holds the connection. A run abandoned by a crash must not block retrying forever.
export async function openSyncRun(db: DatabaseSession, connectionId: string, now: Date) {
  await db.update(commerceSyncRuns).set({ status: "FAILED", failureCode: "ABANDONED", finishedAt: now })
    .where(and(eq(commerceSyncRuns.connectionId, connectionId), eq(commerceSyncRuns.status, "RUNNING"), lt(commerceSyncRuns.startedAt, new Date(now.getTime() - ABANDONED_AFTER_MS))));
  const [last] = await db.select({ startedAt: commerceSyncRuns.startedAt }).from(commerceSyncRuns)
    .where(and(eq(commerceSyncRuns.connectionId, connectionId), eq(commerceSyncRuns.status, "SUCCEEDED"))).orderBy(desc(commerceSyncRuns.startedAt)).limit(1);
  const windowStart = last ? days(last.startedAt, OVERLAP_DAYS) : days(now, FIRST_SYNC_DAYS);
  const runId = randomUUID();
  const [run] = await db.insert(commerceSyncRuns).values({ id: runId, connectionId, status: "RUNNING", windowStart, startedAt: now }).onConflictDoNothing().returning({ id: commerceSyncRuns.id });
  return run ? { runId, windowStart } : null;
}

const days = (date: Date, count: number) => new Date(date.getTime() - count * 86_400_000);

// Erases the credentials, for a connection of any provider. Sales already retrieved remain as
// history; they were genuine when retrieved, and their freshness rules stop them being treated
// as current.
export async function disconnectCommerceConnection(db: Database, scope: ConnectionScope, outletId: string, now = new Date()) {
  await authorised(db, scope);
  const location = await ownedLocation(db, scope, outletId);
  const [row] = await db.update(commerceConnections).set({ status: "DISCONNECTED", sealedCredentials: null, disconnectedAt: now })
    .where(and(eq(commerceConnections.outletId, location), eq(commerceConnections.organisationId, scope.organisationId), ne(commerceConnections.status, "DISCONNECTED"))).returning({ id: commerceConnections.id });
  if (!row) throw new UserFacingError("commerce-not-connected", "This location has no connection.");
  await audit(db, scope, location, "COMMERCE_DISCONNECTED", row.id);
}

// What the Owner may see of each location's connection. Credentials and the merchant
// identifier are not selected.
export async function getCommerceConnections(db: DatabaseSession, scope: Pick<Scope, "organisationId" | "role">) {
  assertRole(scope as Scope, ["OWNER"]);
  const rows = await db.select({ id: commerceConnections.id, outletId: commerceConnections.outletId, provider: commerceConnections.provider, providerEnvironment: commerceConnections.providerEnvironment, status: commerceConnections.status, connectedAt: commerceConnections.connectedAt })
    .from(commerceConnections).where(and(eq(commerceConnections.organisationId, scope.organisationId), ne(commerceConnections.status, "DISCONNECTED")));
  const runs = rows.length ? await db.select({ connectionId: commerceSyncRuns.connectionId, status: commerceSyncRuns.status, failureCode: commerceSyncRuns.failureCode, retrieved: commerceSyncRuns.retrieved, inserted: commerceSyncRuns.inserted, duplicates: commerceSyncRuns.duplicates, refundsExcluded: commerceSyncRuns.refundsExcluded, startedAt: commerceSyncRuns.startedAt, finishedAt: commerceSyncRuns.finishedAt })
    .from(commerceSyncRuns).where(inArray(commerceSyncRuns.connectionId, rows.map(row => row.id))).orderBy(desc(commerceSyncRuns.startedAt)) : [];
  return rows.map(row => {
    const own = runs.filter(run => run.connectionId === row.id);
    return { ...row, latestRun: own[0] ?? null, lastSuccess: own.find(run => run.status === "SUCCEEDED") ?? null };
  });
}
export type CommerceConnectionView = Awaited<ReturnType<typeof getCommerceConnections>>[number];
export const commerceConnectionsConfigured = () => credentialKey() !== null;
