import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";

import { consumeLimit } from "@/server/auth/identity";
import { assertRole, type Scope } from "@/server/auth/access";
import { requireEntitlement } from "@/server/billing/entitlement";
import { audit, authorised, ownedLocation, openSyncRun, requiredKey, type ConnectionScope } from "@/server/commerce/connections";
import { openCredentials, sealCredentials } from "@/server/commerce/credentials";
import { CommerceIngestionError, ingestConnectedObservations, MAX_BATCH_OBSERVATIONS } from "@/server/commerce/ingestion";
import { normaliseSquarePayments, normaliseSquareRefunds, type SquarePaymentEvidence, type SquareRefundEvidence } from "@/server/commerce/square-adapter";
import type { Database, DatabaseSession } from "@/server/db/client";
import { attributedSales, commerceConnections, commercePaymentEvidence, commerceRefundEvidence, commerceSyncRuns, commerceWorkerIdentities, organisations, outlets, saleTransactions, workers } from "@/server/db/schema";
import { resolveLocationCurrency } from "@/server/domain/currency";
import { UserFacingError } from "@/server/domain/errors";
import { SquareError, type SquareClient, type SquarePage, type SquareWindowQuery } from "@/server/integrations/square/client";
import { deriveSquareAttribution, type AttributionOutcome } from "@/server/performance/square-attribution";

const MAX_PAGES = 200;
// A provider clock a little ahead of ours is not a future-dated sale.
const CLOCK_SKEW_MS = 2 * 60_000;
// A viewer's page asks for fresh sales every 10 seconds. A location runs at most one sync per
// 9 seconds, however many people are looking.
export const SQUARE_REFRESH_THROTTLE_MS = 9_000;
export const SQUARE_REFRESH_POLL_MS = 10_000;
// Gate evidence: a new payment was missing from an immediate list and appeared about 4 seconds
// later. A sync started within that lag misses it, the next one that may run is at most
// 9 + 10 seconds on, and it then takes a request or two. So a sale is visible within this bound.
export const SQUARE_VISIBLE_WITHIN_MS = 30_000;

export type SquareCredentials = { applicationId: string; accessToken: string };
// Sandbox only: the Sandbox application's credentials are held by the server and never typed
// into a page. Any other environment is treated as not configured.
export function squareSandboxCredentials(env: Record<string, string | undefined> = process.env): SquareCredentials | null {
  if (env.SQUARE_ENVIRONMENT !== "sandbox" || !env.SQUARE_ACCESS_TOKEN || !env.SQUARE_APPLICATION_ID) return null;
  return { applicationId: env.SQUARE_APPLICATION_ID, accessToken: env.SQUARE_ACCESS_TOKEN };
}

// A location's live Square connection, read from the session's organisation and location.
export async function liveSquareConnection(db: DatabaseSession, scope: { organisationId: string; locationId: string }) {
  const [connection] = await db.select().from(commerceConnections).where(and(eq(commerceConnections.organisationId, scope.organisationId), eq(commerceConnections.outletId, scope.locationId), eq(commerceConnections.provider, "SQUARE"), ne(commerceConnections.status, "DISCONNECTED")));
  return connection ?? null;
}
export function squareToken(connection: typeof commerceConnections.$inferSelect) {
  return openCredentials(connection.sealedCredentials!, requiredKey(), connection.organisationId, connection.outletId).apiKey;
}

function connectionRefusal(error: unknown) {
  if (!(error instanceof SquareError)) throw error;
  if (error.code === "AUTH_REJECTED" || error.code === "SCOPE_MISSING") return new UserFacingError("square-credentials-rejected", "Square did not accept the configured Sandbox credentials.");
  return new UserFacingError("square-unavailable", "Square could not be reached.");
}

// Binds one Square Sandbox location to one FairShift location, and only after Square has accepted
// the credentials and allowed the reads a sync needs. If any of that fails, nothing is stored.
export async function connectSquare(db: Database, scope: ConnectionScope, input: { outletId: string }, client: SquareClient, credentials: SquareCredentials | null, now = new Date()) {
  await authorised(db, scope);
  const key = requiredKey();
  if (!credentials) throw new UserFacingError("square-not-configured", "Square Sandbox is not configured.");
  const outletId = await ownedLocation(db, scope, input.outletId);
  await consumeLimit(db, `square-connect:${scope.organisationId}`, 10);
  const [place] = await db.select({ locationCountry: outlets.country, organisationCountry: organisations.country }).from(outlets).innerJoin(organisations, eq(organisations.id, outlets.organisationId)).where(eq(outlets.id, outletId));
  let location;
  try {
    const active = (await client.locations(credentials.accessToken)).filter(row => row.status === "ACTIVE");
    if (active.length !== 1) throw new UserFacingError("square-location-choice", "The Square Sandbox seller must have exactly one active location to connect.");
    location = active[0];
    await client.payments(credentials.accessToken, { locationId: location.id, beginTime: now.toISOString() });
  } catch (error) { if (error instanceof UserFacingError) throw error; throw connectionRefusal(error); }
  if (location.currency !== resolveLocationCurrency(place)) throw new UserFacingError("square-location-currency", "This Square location trades in a different currency from this FairShift location.");
  const id = randomUUID();
  const created = await db.insert(commerceConnections).values({ id, organisationId: scope.organisationId, outletId, provider: "SQUARE", status: "CONNECTED", providerMerchantId: location.merchant_id, providerLocationId: location.id, providerEnvironment: "SANDBOX",
    sealedCredentials: sealCredentials({ clientId: credentials.applicationId, apiKey: credentials.accessToken }, key, scope.organisationId, outletId), connectedBy: scope.userId, connectedAt: now }).onConflictDoNothing().returning({ id: commerceConnections.id });
  if (!created.length) throw new UserFacingError("square-already-connected", "This location or Square seller already has a connection.");
  await audit(db, scope, outletId, "COMMERCE_CONNECTED", id, { provider: "SQUARE", environment: "SANDBOX" });
  return { id, outletId };
}

async function allPages(fetchPage: (query: SquareWindowQuery) => Promise<SquarePage>, query: Omit<SquareWindowQuery, "cursor">) {
  const items: unknown[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await fetchPage({ ...query, cursor });
    items.push(...response.items);
    if (!response.cursor) return items;
    if (response.cursor === cursor) throw new SquareError("MALFORMED_RESPONSE");
    cursor = response.cursor;
  }
  throw new SquareError("HISTORY_TOO_LARGE");
}

// Stores what Square said about each sale. Facts already held must not change: an identity that
// moves between reads is a provider contradiction, so the whole retrieval is refused. A tip is
// held the same way, because Square can't change it once the payment is COMPLETED. A row stored
// before tips were read keeps its unknown tip: evidence is written once and not backfilled.
async function recordPaymentEvidence(tx: DatabaseSession, connection: typeof commerceConnections.$inferSelect, evidence: readonly SquarePaymentEvidence[]) {
  for (let i = 0; i < evidence.length; i += 1000) {
    const chunk = evidence.slice(i, i + 1000);
    const sales = new Map((await tx.select({ id: saleTransactions.id, paymentId: saleTransactions.sourceTransactionId }).from(saleTransactions).where(and(eq(saleTransactions.outletId, connection.outletId), eq(saleTransactions.source, "SQUARE"), eq(saleTransactions.sourceSystem, `SQUARE:${connection.providerMerchantId}`), inArray(saleTransactions.sourceTransactionId, chunk.map(row => row.providerPaymentId))))).map(row => [row.paymentId, row.id]));
    await tx.insert(commercePaymentEvidence).values(chunk.map(row => ({ id: randomUUID(), organisationId: connection.organisationId, outletId: connection.outletId, connectionId: connection.id, saleTransactionId: sales.get(row.providerPaymentId)!, provider: "SQUARE", ...row }))).onConflictDoNothing();
    const held = await tx.select({ paymentId: commercePaymentEvidence.providerPaymentId, teamMemberId: commercePaymentEvidence.providerTeamMemberId, locationId: commercePaymentEvidence.providerLocationId, tipAmountMinor: commercePaymentEvidence.tipAmountMinor }).from(commercePaymentEvidence).where(and(eq(commercePaymentEvidence.outletId, connection.outletId), eq(commercePaymentEvidence.provider, "SQUARE"), inArray(commercePaymentEvidence.providerPaymentId, chunk.map(row => row.providerPaymentId))));
    for (const row of chunk) {
      const found = held.find(item => item.paymentId === row.providerPaymentId);
      if (!found || found.teamMemberId !== row.providerTeamMemberId || found.locationId !== row.providerLocationId) throw new CommerceIngestionError("CONFLICTING_DUPLICATE", "A payment's team member or location changed.");
      if (found.tipAmountMinor !== null && row.tipAmountMinor !== null && found.tipAmountMinor !== row.tipAmountMinor) throw new CommerceIngestionError("CONFLICTING_DUPLICATE", "A completed payment's tip changed.");
    }
  }
}
async function recordRefundEvidence(tx: DatabaseSession, connection: typeof commerceConnections.$inferSelect, refunds: readonly SquareRefundEvidence[]) {
  for (const refund of refunds) {
    const [created] = await tx.insert(commerceRefundEvidence).values({ id: randomUUID(), organisationId: connection.organisationId, outletId: connection.outletId, connectionId: connection.id, provider: "SQUARE", ...refund }).onConflictDoNothing().returning({ id: commerceRefundEvidence.id });
    if (created) continue;
    const [held] = await tx.select().from(commerceRefundEvidence).where(and(eq(commerceRefundEvidence.outletId, connection.outletId), eq(commerceRefundEvidence.provider, "SQUARE"), eq(commerceRefundEvidence.providerRefundId, refund.providerRefundId)));
    if (held.providerPaymentId !== refund.providerPaymentId || held.amountMinor !== refund.amountMinor || held.currencyCode !== refund.currencyCode) throw new CommerceIngestionError("CONFLICTING_DUPLICATE", "A refund's payment or amount changed.");
    // A refund's status legitimately moves on, for example from pending to completed.
    if (held.providerStatus !== refund.providerStatus) await tx.update(commerceRefundEvidence).set({ providerStatus: refund.providerStatus }).where(eq(commerceRefundEvidence.id, held.id));
  }
}

export type SquareSyncResult = { status: "SUCCEEDED"; retrieved: number; inserted: number; duplicates: number; notCompleted: number; refundsRecorded: number; attribution: AttributionOutcome } | { status: "FAILED"; failureCode: string } | { status: "SKIPPED" };

// One retrieval, whoever or whatever asked for it. Both lists are read completely before anything
// is stored, then stored in one transaction with the attribution they produce, so a failure on any
// page leaves nothing behind, does not advance the window, and is recorded as a failure. It is never
// read as zero sales. The overlap means a payment Square lists late is found by a later sync, and it
// is then stored once, because a payment ID is one sale.
async function runSquareSync(db: Database, actor: { organisationId: string; userId?: string | null }, connection: typeof commerceConnections.$inferSelect, client: SquareClient, now: Date, options: { background?: boolean; failedBefore?: boolean } = {}): Promise<SquareSyncResult> {
  const opened = await openSyncRun(db, connection.id, now);
  if (!opened) return { status: "SKIPPED" };
  const { runId, windowStart } = opened;
  const fail = async (failureCode: string) => {
    await db.update(commerceSyncRuns).set({ status: "FAILED", failureCode, finishedAt: new Date() }).where(eq(commerceSyncRuns.id, runId));
    if (failureCode === "AUTH_REJECTED") await db.update(commerceConnections).set({ status: "AUTH_FAILED" }).where(eq(commerceConnections.id, connection.id));
    // A background retry records the start of a failure, not every repeat of it.
    if (!options.failedBefore) await audit(db, actor, connection.outletId, "COMMERCE_SYNC_FAILED", connection.id, { runId, failureCode, provider: "SQUARE" });
    return { status: "FAILED" as const, failureCode };
  };
  try {
    const token = squareToken(connection), locationId = connection.providerLocationId!;
    const query = { locationId, beginTime: windowStart.toISOString() };
    const payments = await allPages(page => client.payments(token, page), query);
    const refunds = normaliseSquareRefunds(await allPages(page => client.refunds(token, page), query), locationId);
    const { observations, evidence, notCompleted } = normaliseSquarePayments(payments, connection.outletId, locationId);
    const { inserted, duplicates, attribution } = await db.transaction(async tx => {
      const totals = { inserted: 0, duplicates: 0 };
      for (let i = 0; i < observations.length; i += MAX_BATCH_OBSERVATIONS) {
        const written = await ingestConnectedObservations(tx, { provider: "SQUARE", organisationId: connection.organisationId, sourceSystem: `SQUARE:${connection.providerMerchantId}`, observations: observations.slice(i, i + MAX_BATCH_OBSERVATIONS), now: new Date(now.getTime() + CLOCK_SKEW_MS) });
        totals.inserted += written.inserted; totals.duplicates += written.duplicates;
      }
      await recordPaymentEvidence(tx, connection, evidence);
      await recordRefundEvidence(tx, connection, refunds);
      return { ...totals, attribution: await deriveSquareAttribution(tx, { organisationId: connection.organisationId, locationId: connection.outletId }) };
    });
    await db.update(commerceSyncRuns).set({ status: "SUCCEEDED", retrieved: payments.length, inserted, duplicates, refundsExcluded: refunds.length, finishedAt: new Date() }).where(eq(commerceSyncRuns.id, runId));
    if (connection.status === "AUTH_FAILED") await db.update(commerceConnections).set({ status: "CONNECTED" }).where(eq(commerceConnections.id, connection.id));
    if (!options.background || inserted || attribution.attributed) await audit(db, actor, connection.outletId, "COMMERCE_SYNC_SUCCEEDED", connection.id, { runId, provider: "SQUARE", retrieved: payments.length, inserted, duplicates, notCompleted, refundsRecorded: refunds.length, attribution });
    return { status: "SUCCEEDED", retrieved: payments.length, inserted, duplicates, notCompleted, refundsRecorded: refunds.length, attribution };
  } catch (error) {
    if (error instanceof SquareError || error instanceof CommerceIngestionError) return fail(error.code);
    await fail("UNEXPECTED");
    throw error;
  }
}

// The Owner's explicit sync.
export async function syncSquare(db: Database, scope: ConnectionScope, outletId: string, client: SquareClient, now = new Date()) {
  await authorised(db, scope);
  requiredKey();
  const location = await ownedLocation(db, scope, outletId);
  const connection = await liveSquareConnection(db, { organisationId: scope.organisationId, locationId: location });
  if (!connection) throw new UserFacingError("commerce-not-connected", "This location has no connection.");
  await consumeLimit(db, `square-sync:${connection.id}`, 20);
  const result = await runSquareSync(db, scope, connection, client, now);
  if (result.status === "SKIPPED") throw new UserFacingError("commerce-sync-running", "A sync is already running for this location.");
  return result;
}

// The same sync, asked for by a page that is showing Square-attributed figures, for the viewer's
// own session location. Anyone working at the location may cause it, because it changes nothing a
// sync would not, returns no sales, and takes no input. It runs at most once per throttle window,
// and not at all on a connection Square has refused until the Owner deals with it.
export async function refreshSquareSales(db: Database, scope: Pick<Scope, "organisationId" | "locationId"> & { userId?: string | null }, client: SquareClient, now = new Date()): Promise<SquareSyncResult> {
  await requireEntitlement(db, scope.organisationId);
  const connection = await liveSquareConnection(db, scope);
  if (!connection || connection.status !== "CONNECTED" || !requiredKeyAvailable()) return { status: "SKIPPED" };
  const [latest] = await db.select({ startedAt: commerceSyncRuns.startedAt, status: commerceSyncRuns.status }).from(commerceSyncRuns).where(eq(commerceSyncRuns.connectionId, connection.id)).orderBy(desc(commerceSyncRuns.startedAt)).limit(1);
  if (latest && now.getTime() - latest.startedAt.getTime() < SQUARE_REFRESH_THROTTLE_MS) return { status: "SKIPPED" };
  return runSquareSync(db, scope, connection, client, now, { background: true, failedBefore: latest?.status === "FAILED" });
}
const requiredKeyAvailable = () => { try { requiredKey(); return true; } catch { return false; } };

// Whether figures from Square can be relied on right now, for a location's pages.
export async function getSquareFreshness(db: DatabaseSession, scope: { organisationId: string; locationId: string }) {
  const connection = await liveSquareConnection(db, scope);
  if (!connection) return null;
  const runs = await db.select({ status: commerceSyncRuns.status, startedAt: commerceSyncRuns.startedAt }).from(commerceSyncRuns).where(eq(commerceSyncRuns.connectionId, connection.id)).orderBy(desc(commerceSyncRuns.startedAt)).limit(50);
  const lastSuccess = runs.find(run => run.status === "SUCCEEDED");
  // Whichever viewer's sync found a new sale, every open page must notice. This changes when the
  // location's attributed sales do, and is opaque, so it tells a worker nothing about store sales.
  const [totals] = await db.select({ count: sql<string>`count(*)`, minor: sql<string>`coalesce(sum(${attributedSales.amountMinor}), 0)` }).from(attributedSales).where(and(eq(attributedSales.outletId, scope.locationId), eq(attributedSales.provider, "SQUARE")));
  const revision = createHash("sha256").update(`${connection.id}:${totals.count}:${totals.minor}`).digest("hex").slice(0, 16);
  return { attention: connection.status === "AUTH_FAILED", lastSuccessAt: lastSuccess?.startedAt ?? null, lastFailed: runs[0]?.status === "FAILED", revision };
}

// The Owner's audit view of one location's latest Square payments. Provider IDs are shortened,
// refunds are shown beside the sale and not netted, and the reason a payment wasn't attributed
// says what is missing. Nothing about a customer or card is held to show.
export async function getSquareActivity(db: DatabaseSession, scope: Pick<Scope, "organisationId" | "role">, outletId: string) {
  assertRole(scope as Scope, ["OWNER"]);
  const rows = await db.select({ paymentId: commercePaymentEvidence.providerPaymentId, teamMemberId: commercePaymentEvidence.providerTeamMemberId, status: commercePaymentEvidence.providerStatus, occurredAt: saleTransactions.occurredAt, amountMinor: saleTransactions.grossAmountMinor, currencyCode: saleTransactions.currencyCode, workerName: workers.displayName })
    .from(commercePaymentEvidence).innerJoin(saleTransactions, eq(saleTransactions.id, commercePaymentEvidence.saleTransactionId))
    .leftJoin(attributedSales, and(eq(attributedSales.outletId, commercePaymentEvidence.outletId), eq(attributedSales.provider, "SQUARE"), eq(attributedSales.providerTransactionId, commercePaymentEvidence.providerPaymentId)))
    .leftJoin(workers, eq(workers.id, attributedSales.workerId))
    .where(and(eq(commercePaymentEvidence.organisationId, scope.organisationId), eq(commercePaymentEvidence.outletId, outletId))).orderBy(desc(saleTransactions.occurredAt)).limit(20);
  const refunds = rows.length ? await db.select({ paymentId: commerceRefundEvidence.providerPaymentId, amountMinor: commerceRefundEvidence.amountMinor, status: commerceRefundEvidence.providerStatus }).from(commerceRefundEvidence).where(and(eq(commerceRefundEvidence.outletId, outletId), eq(commerceRefundEvidence.organisationId, scope.organisationId), inArray(commerceRefundEvidence.providerPaymentId, rows.map(row => row.paymentId)))) : [];
  const mapped = new Set((await db.select({ id: commerceWorkerIdentities.providerTeamMemberId }).from(commerceWorkerIdentities).where(and(eq(commerceWorkerIdentities.outletId, outletId), eq(commerceWorkerIdentities.organisationId, scope.organisationId), eq(commerceWorkerIdentities.status, "ACTIVE")))).map(row => row.id));
  return rows.map(row => ({
    reference: row.paymentId.slice(-6), occurredAt: row.occurredAt!, amountMinor: row.amountMinor, currencyCode: row.currencyCode, status: row.status,
    refundedMinor: refunds.filter(refund => refund.paymentId === row.paymentId && refund.status === "COMPLETED").reduce((sum, refund) => sum + refund.amountMinor, 0),
    attribution: row.workerName ? { state: "ATTRIBUTED" as const, workerName: row.workerName } : !row.teamMemberId ? { state: "NO_TEAM_MEMBER" as const } : !mapped.has(row.teamMemberId) ? { state: "NOT_MAPPED" as const } : { state: "NOT_IN_SHIFT" as const },
  }));
}
export type SquareActivity = Awaited<ReturnType<typeof getSquareActivity>>;
