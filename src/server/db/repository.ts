import { and, desc, eq } from "drizzle-orm";

import { DEMO_ORGANISATION_ID, DEMO_OUTLET_ID } from "@/server/constants";
import type { Database, DatabaseSession } from "@/server/db/client";
import {
  auditEvents,
  outlets,
  paypalConnections,
  providerEvents,
  saleTransactions,
} from "@/server/db/schema";

export type SaleTransaction = typeof saleTransactions.$inferSelect;
export type ProviderEvent = typeof providerEvents.$inferSelect;

export async function getDemoOutlet(db: Database) {
  const [outlet] = await db.select().from(outlets).where(eq(outlets.id, DEMO_OUTLET_ID)).limit(1);
  return outlet ?? null;
}

export async function listDemoOutletTransactions(db: Database, limit = 20) {
  return db
    .select()
    .from(saleTransactions)
    .where(and(eq(saleTransactions.outletId, DEMO_OUTLET_ID), eq(saleTransactions.source, "PAYPAL_SANDBOX")))
    .orderBy(desc(saleTransactions.createdAt))
    .limit(limit);
}

export async function getConnection(db: Database) {
  const [connection] = await db
    .select()
    .from(paypalConnections)
    .where(eq(paypalConnections.outletId, DEMO_OUTLET_ID))
    .limit(1);
  return connection ?? null;
}

export async function updateConnection(
  db: Database,
  status: "CONNECTED" | "ERROR" | "NOT_CONFIGURED",
  merchantId?: string | null,
) {
  const now = new Date();
  const [connection] = await db
    .update(paypalConnections)
    .set({
      status,
      merchantId: merchantId ?? null,
      lastCheckedAt: now,
      updatedAt: now,
    })
    .where(eq(paypalConnections.outletId, DEMO_OUTLET_ID))
    .returning();
  return connection;
}

export async function createPendingSale(
  db: Database,
  input: {
    id: string;
    internalReference: string;
    currencyCode: string;
    grossAmountMinor: number;
  },
) {
  const [sale] = await db
    .insert(saleTransactions)
    .values({
      id: input.id,
      internalReference: input.internalReference,
      paypalCustomId: input.internalReference,
      outletId: DEMO_OUTLET_ID,
      currencyCode: input.currencyCode,
      grossAmountMinor: input.grossAmountMinor,
      providerStatus: "ORDER_CREATING",
      reconciliationState: "NOT_RECONCILED",
      verificationState: "PENDING",
    })
    .returning();
  return sale;
}

export async function attachPayPalOrder(
  db: Database,
  saleId: string,
  paypalOrderId: string,
  providerStatus: string,
) {
  const [sale] = await db
    .update(saleTransactions)
    .set({ paypalOrderId, providerStatus, updatedAt: new Date(), failureCode: null })
    .where(and(eq(saleTransactions.id, saleId), eq(saleTransactions.outletId, DEMO_OUTLET_ID)))
    .returning();
  return sale ?? null;
}

export async function attachPayPalCapture(
  db: Database,
  saleId: string,
  input: {
    captureId: string;
    status: string;
    providerCreatedAt?: Date;
    providerUpdatedAt?: Date;
  },
) {
  const [sale] = await db
    .update(saleTransactions)
    .set({
      paypalCaptureId: input.captureId,
      providerStatus: input.status,
      providerCreatedAt: input.providerCreatedAt,
      providerUpdatedAt: input.providerUpdatedAt,
      reconciliationState: "PENDING",
      verificationState: "PENDING",
      updatedAt: new Date(),
      failureCode: null,
    })
    .where(and(eq(saleTransactions.id, saleId), eq(saleTransactions.outletId, DEMO_OUTLET_ID)))
    .returning();
  return sale ?? null;
}

export async function markSaleFailure(db: Database, saleId: string, failureCode: string) {
  const [sale] = await db
    .update(saleTransactions)
    .set({
      providerStatus: "FAILED",
      reconciliationState: "ERROR",
      verificationState: "FAILED",
      failureCode,
      updatedAt: new Date(),
    })
    .where(and(eq(saleTransactions.id, saleId), eq(saleTransactions.outletId, DEMO_OUTLET_ID)))
    .returning();
  return sale ?? null;
}

export async function getSaleByOrderId(db: DatabaseSession, paypalOrderId: string) {
  const [sale] = await db
    .select()
    .from(saleTransactions)
    .where(
      and(
        eq(saleTransactions.paypalOrderId, paypalOrderId),
        eq(saleTransactions.outletId, DEMO_OUTLET_ID),
      ),
    )
    .limit(1);
  return sale ?? null;
}

export async function getSaleByCaptureId(db: DatabaseSession, paypalCaptureId: string) {
  const [sale] = await db
    .select()
    .from(saleTransactions)
    .where(
      and(
        eq(saleTransactions.paypalCaptureId, paypalCaptureId),
        eq(saleTransactions.outletId, DEMO_OUTLET_ID),
      ),
    )
    .limit(1);
  return sale ?? null;
}

export async function reconcileSale(
  db: DatabaseSession,
  saleId: string,
  input: {
    captureId: string;
    providerStatus: string;
    reconciliationState: "PENDING" | "RECONCILED" | "ERROR";
    verificationState: "PENDING" | "VERIFIED" | "FAILED";
    providerCreatedAt?: Date;
    providerUpdatedAt?: Date;
    failureCode?: string | null;
  },
) {
  const now = new Date();
  const [sale] = await db
    .update(saleTransactions)
    .set({
      paypalCaptureId: input.captureId,
      providerStatus: input.providerStatus,
      reconciliationState: input.reconciliationState,
      verificationState: input.verificationState,
      providerCreatedAt: input.providerCreatedAt,
      providerUpdatedAt: input.providerUpdatedAt,
      reconciledAt: now,
      failureCode: input.failureCode ?? null,
      updatedAt: now,
    })
    .where(and(eq(saleTransactions.id, saleId), eq(saleTransactions.outletId, DEMO_OUTLET_ID)))
    .returning();
  return sale ?? null;
}

export async function insertOrGetProviderEvent(
  db: Database,
  input: typeof providerEvents.$inferInsert,
) {
  const [inserted] = await db
    .insert(providerEvents)
    .values(input)
    .onConflictDoNothing({ target: providerEvents.providerEventId })
    .returning();

  if (inserted) return { event: inserted, inserted: true };

  const [existing] = await db
    .select()
    .from(providerEvents)
    .where(eq(providerEvents.providerEventId, input.providerEventId))
    .limit(1);

  if (!existing) throw new Error("Provider event conflict could not be resolved.");
  return { event: existing, inserted: false };
}

export async function updateProviderEvent(
  db: DatabaseSession,
  providerEventId: string,
  input: {
    processingState: "PROCESSED" | "IGNORED" | "UNMATCHED" | "ERROR";
    saleTransactionId?: string | null;
  },
) {
  const [event] = await db
    .update(providerEvents)
    .set({
      processingState: input.processingState,
      saleTransactionId: input.saleTransactionId ?? null,
      processedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(providerEvents.providerEventId, providerEventId))
    .returning();
  return event ?? null;
}

export async function writeAuditEvent(
  db: DatabaseSession,
  input: {
    id: string;
    action: string;
    entityType: string;
    entityId?: string | null;
    correlationId: string;
    metadata?: Record<string, string | number | boolean | null>;
  },
) {
  await db.insert(auditEvents).values({
    id: input.id,
    organisationId: DEMO_ORGANISATION_ID,
    outletId: DEMO_OUTLET_ID,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    correlationId: input.correlationId,
    metadata: input.metadata ?? {},
  });
}
