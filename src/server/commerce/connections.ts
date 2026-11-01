import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, lt, ne } from "drizzle-orm";
import { z } from "zod";

import { assertRole, type Scope } from "@/server/auth/access";
import { consumeLimit } from "@/server/auth/identity";
import { requireEntitlement } from "@/server/billing/entitlement";
import { credentialKey, openCredentials, sealCredentials } from "@/server/commerce/credentials";
import { CommerceIngestionError, ingestConnectedObservations, MAX_BATCH_OBSERVATIONS } from "@/server/commerce/ingestion";
import { normaliseZettlePurchases } from "@/server/commerce/zettle-adapter";
import type { Database, DatabaseSession } from "@/server/db/client";
import { auditEvents, commerceConnections, commerceSyncRuns, outlets } from "@/server/db/schema";
import { UserFacingError } from "@/server/domain/errors";
import { ZETTLE_PAGE_SIZE, ZettleError, type ZettleClient } from "@/server/integrations/zettle/client";

// A location's connection to its merchant account, and the retrieval of its sales.
// Everything reaching canonical history goes through the commerce boundary. A failure
// stores no sales, leaves earlier history in place, and is reported as a failure: it
// is never read as zero sales, and only a sync that finished advances the window.
const FIRST_SYNC_DAYS = 120;
const OVERLAP_DAYS = 1;
const MAX_PAGES = 200;
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

// Connects only after Zettle has accepted the credentials, named the merchant and
// allowed a purchase read. If any of that fails, nothing is stored.
export async function connectZettle(db: Database, scope: ConnectionScope, input: { outletId: string; clientId: string; apiKey: string }, client: ZettleClient, now = new Date()) {
  await authorised(db, scope);
  const key = requiredKey();
  const outletId = await ownedLocation(db, scope, input.outletId);
  const credentials = z.object({ clientId: z.string().trim().min(1).max(200), apiKey: z.string().trim().min(1).max(8000) }).safeParse(input);
  if (!credentials.success) throw new UserFacingError("zettle-credentials-rejected", "Credentials are required.");
  await consumeLimit(db, `zettle-connect:${scope.organisationId}`, 10);
  let merchantId: string;
  try {
    const token = await client.accessToken(credentials.data);
    merchantId = await client.merchantId(token);
    await client.purchases(token, { startDate: isoDay(now), limit: 1 });
  } catch (error) { throw connectionRefusal(error); }
  const id = randomUUID();
  const created = await db.insert(commerceConnections).values({ id, organisationId: scope.organisationId, outletId, provider: "ZETTLE", status: "CONNECTED", providerMerchantId: merchantId,
    sealedCredentials: sealCredentials(credentials.data, key, scope.organisationId, outletId), connectedBy: scope.userId, connectedAt: now }).onConflictDoNothing().returning({ id: commerceConnections.id });
  if (!created.length) throw new UserFacingError("zettle-already-connected", "This location or merchant account already has a connection.");
  await audit(db, scope, outletId, "COMMERCE_CONNECTED", id, { provider: "ZETTLE" });
  return { id, outletId };
}

function connectionRefusal(error: unknown) {
  if (!(error instanceof ZettleError)) throw error;
  if (error.code === "AUTH_REJECTED") return new UserFacingError("zettle-credentials-rejected", "Zettle did not accept these credentials.");
  if (error.code === "SCOPE_MISSING") return new UserFacingError("zettle-scope-missing", "The key does not have the access FairShift needs.");
  return new UserFacingError("zettle-unavailable", "Zettle could not be reached.");
}

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

const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const days = (date: Date, count: number) => new Date(date.getTime() - count * 86_400_000);

// Retrieves purchases since the last completed sync. Reports the run; never throws a provider failure.
export async function syncZettle(db: Database, scope: ConnectionScope, outletId: string, client: ZettleClient, now = new Date()) {
  await authorised(db, scope);
  const key = requiredKey();
  const location = await ownedLocation(db, scope, outletId);
  // Another provider's credentials must never reach this client.
  const [connection] = await db.select().from(commerceConnections).where(and(eq(commerceConnections.outletId, location), eq(commerceConnections.organisationId, scope.organisationId), eq(commerceConnections.provider, "ZETTLE"), ne(commerceConnections.status, "DISCONNECTED")));
  if (!connection?.sealedCredentials) throw new UserFacingError("commerce-not-connected", "This location has no connection.");
  await consumeLimit(db, `zettle-sync:${connection.id}`, 20);

  const opened = await openSyncRun(db, connection.id, now);
  if (!opened) throw new UserFacingError("commerce-sync-running", "A sync is already running for this location.");
  const { runId, windowStart } = opened;

  const fail = async (failureCode: string) => {
    await db.update(commerceSyncRuns).set({ status: "FAILED", failureCode, finishedAt: new Date() }).where(eq(commerceSyncRuns.id, runId));
    if (failureCode === "AUTH_REJECTED") await db.update(commerceConnections).set({ status: "AUTH_FAILED" }).where(eq(commerceConnections.id, connection.id));
    await audit(db, scope, location, "COMMERCE_SYNC_FAILED", connection.id, { runId, failureCode });
    return { status: "FAILED" as const, failureCode };
  };
  try {
    const token = await client.accessToken(openCredentials(connection.sealedCredentials, key, scope.organisationId, location));
    const purchases: unknown[] = [];
    let hash: string | undefined;
    for (let page = 0; ; page++) {
      if (page === MAX_PAGES) throw new ZettleError("HISTORY_TOO_LARGE");
      const response = await client.purchases(token, { startDate: isoDay(windowStart), limit: ZETTLE_PAGE_SIZE, lastPurchaseHash: hash });
      if (!response.purchases.length) break;
      purchases.push(...response.purchases);
      if (!response.lastPurchaseHash || response.lastPurchaseHash === hash) throw new ZettleError("MALFORMED_RESPONSE");
      hash = response.lastPurchaseHash;
    }
    // Normalised as a whole first, so one unreadable purchase stores nothing.
    const { observations, refundsExcluded } = normaliseZettlePurchases(purchases, location);
    // One transaction across batches, so a rejected batch leaves none of the retrieval behind.
    const { inserted, duplicates } = await db.transaction(async tx => {
      const totals = { inserted: 0, duplicates: 0 };
      for (let i = 0; i < observations.length; i += MAX_BATCH_OBSERVATIONS) {
        const written = await ingestConnectedObservations(tx, { organisationId: scope.organisationId, provider: "ZETTLE", sourceSystem: `ZETTLE:${connection.providerMerchantId}`, observations: observations.slice(i, i + MAX_BATCH_OBSERVATIONS), now: new Date() });
        totals.inserted += written.inserted; totals.duplicates += written.duplicates;
      }
      return totals;
    });
    await db.update(commerceSyncRuns).set({ status: "SUCCEEDED", retrieved: purchases.length, inserted, duplicates, refundsExcluded, finishedAt: new Date() }).where(eq(commerceSyncRuns.id, runId));
    if (connection.status === "AUTH_FAILED") await db.update(commerceConnections).set({ status: "CONNECTED" }).where(eq(commerceConnections.id, connection.id));
    await audit(db, scope, location, "COMMERCE_SYNC_SUCCEEDED", connection.id, { runId, retrieved: purchases.length, inserted, duplicates, refundsExcluded });
    return { status: "SUCCEEDED" as const, retrieved: purchases.length, inserted, duplicates, refundsExcluded };
  } catch (error) {
    if (error instanceof ZettleError) return fail(error.code);
    if (error instanceof CommerceIngestionError) return fail(error.code);
    await fail("UNEXPECTED");
    throw error;
  }
}

// Erases the credentials, for a connection of any provider. Sales already retrieved remain as
// history; they were genuine when retrieved, and their freshness rules stop them being treated
// as current.
export async function disconnectZettle(db: Database, scope: ConnectionScope, outletId: string, now = new Date()) {
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
