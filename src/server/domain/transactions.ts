import { randomUUID } from "node:crypto";

import { DEMO_OUTLET_ID } from "@/server/constants";
import type { PayPalConfig } from "@/server/config/env";
import type { Database, DatabaseSession } from "@/server/db/client";
import {
  attachPayPalCapture,
  attachPayPalOrder,
  createPendingSale,
  getSaleByCaptureId,
  getSaleByOrderId,
  markSaleFailure,
  reconcileSale,
  updateConnection,
  writeAuditEvent,
  type SaleTransaction,
} from "@/server/db/repository";
import { decimalToMinorUnits } from "@/server/domain/money";
import { mapCaptureStatus } from "@/server/domain/payment-status";
import { PayPalApiError, type PayPalAdapter } from "@/server/integrations/paypal/client";

function providerDate(value?: string) {
  return value ? new Date(value) : undefined;
}

function safeFailureCode(error: unknown) {
  return error instanceof PayPalApiError ? error.code : "UNEXPECTED_ERROR";
}

export async function createSandboxOrder(
  db: Database,
  paypal: PayPalAdapter,
  config: PayPalConfig,
) {
  const saleId = randomUUID();
  const internalReference = `FS-${saleId}`;
  const amountMinor = decimalToMinorUnits(config.PAYPAL_SANDBOX_AMOUNT);
  await createPendingSale(db, {
    id: saleId,
    internalReference,
    currencyCode: config.PAYPAL_SANDBOX_CURRENCY,
    grossAmountMinor: amountMinor,
  });

  try {
    const order = await paypal.createOrder({
      internalReference,
      outletReference: DEMO_OUTLET_ID,
      currencyCode: config.PAYPAL_SANDBOX_CURRENCY,
      amount: config.PAYPAL_SANDBOX_AMOUNT,
      returnUrl: `${config.APP_BASE_URL}/checkout/return`,
      cancelUrl: `${config.APP_BASE_URL}/checkout/cancel`,
    });

    const sale = await attachPayPalOrder(db, saleId, order.orderId, order.providerStatus);
    if (!sale) throw new Error("Pending sale disappeared before PayPal order attachment.");

    await updateConnection(db, "CONNECTED");
    await writeAuditEvent(db, {
      id: randomUUID(),
      action: "PAYPAL_SANDBOX_ORDER_CREATED",
      entityType: "sale_transaction",
      entityId: sale.id,
      correlationId: internalReference,
      metadata: {
        paypalOrderId: order.orderId,
        currencyCode: sale.currencyCode,
        grossAmountMinor: sale.grossAmountMinor,
      },
    });

    return { sale, approvalUrl: order.approvalUrl };
  } catch (error) {
    const failureCode = safeFailureCode(error);
    await markSaleFailure(db, saleId, failureCode);
    await updateConnection(db, "ERROR");
    await writeAuditEvent(db, {
      id: randomUUID(),
      action: "PAYPAL_SANDBOX_ORDER_CREATE_FAILED",
      entityType: "sale_transaction",
      entityId: saleId,
      correlationId: internalReference,
      metadata: { failureCode },
    });
    throw error;
  }
}

export async function captureSandboxOrder(
  db: Database,
  paypal: PayPalAdapter,
  orderId: string,
) {
  const sale = await getSaleByOrderId(db, orderId);
  if (!sale) throw new TransactionError("ORDER_NOT_FOUND", 404);

  if (sale.paypalCaptureId) {
    const reconciled = await reconcileCapture(db, paypal, sale.paypalCaptureId);
    if (!reconciled) throw new TransactionError("CAPTURE_NOT_MATCHED", 409);
    return reconciled;
  }

  try {
    const result = await paypal.captureOrder(orderId, `FS-CAPTURE-${sale.id}`);
    if (result.orderId !== sale.paypalOrderId) {
      throw new TransactionError("PAYPAL_ORDER_MISMATCH", 409);
    }
    if (result.customId !== sale.paypalCustomId) {
      throw new TransactionError("PAYPAL_CUSTOM_ID_MISMATCH", 409);
    }

    const captureAmount = decimalToMinorUnits(result.capture.amount.value);
    if (
      result.capture.amount.currency_code !== sale.currencyCode ||
      captureAmount !== sale.grossAmountMinor
    ) {
      throw new TransactionError("PAYPAL_AMOUNT_MISMATCH", 409);
    }

    await attachPayPalCapture(db, sale.id, {
      captureId: result.capture.id,
      status: result.capture.status,
      providerCreatedAt: providerDate(result.capture.create_time),
      providerUpdatedAt: providerDate(result.capture.update_time),
    });

    const reconciled = await reconcileCapture(db, paypal, result.capture.id);
    if (!reconciled) throw new TransactionError("CAPTURE_NOT_MATCHED", 409);
    return reconciled;
  } catch (error) {
    const failureCode = error instanceof TransactionError ? error.code : safeFailureCode(error);
    await markSaleFailure(db, sale.id, failureCode);
    await writeAuditEvent(db, {
      id: randomUUID(),
      action: "PAYPAL_SANDBOX_CAPTURE_FAILED",
      entityType: "sale_transaction",
      entityId: sale.id,
      correlationId: sale.internalReference,
      metadata: { failureCode, paypalOrderId: orderId },
    });
    throw error;
  }
}

export async function reconcileCapture(
  db: DatabaseSession,
  paypal: PayPalAdapter,
  captureId: string,
): Promise<SaleTransaction | null> {
  const capture = await paypal.getCapture(captureId);
  const relatedOrderId = capture.supplementary_data?.related_ids.order_id;
  const sale =
    (await getSaleByCaptureId(db, capture.id)) ??
    (relatedOrderId ? await getSaleByOrderId(db, relatedOrderId) : null);

  if (!sale) return null;

  const amountMinor = decimalToMinorUnits(capture.amount.value);
  const evidenceMatches =
    capture.id === captureId &&
    capture.amount.currency_code === sale.currencyCode &&
    amountMinor === sale.grossAmountMinor &&
    (!relatedOrderId || relatedOrderId === sale.paypalOrderId);

  const mapped = mapCaptureStatus(capture.status);
  const result = await reconcileSale(db, sale.id, {
    captureId: capture.id,
    providerStatus: capture.status,
    reconciliationState: evidenceMatches ? mapped.reconciliationState : "ERROR",
    verificationState: evidenceMatches ? mapped.verificationState : "FAILED",
    providerCreatedAt: providerDate(capture.create_time),
    providerUpdatedAt: providerDate(capture.update_time),
    failureCode: evidenceMatches ? null : "RECONCILIATION_EVIDENCE_MISMATCH",
  });

  if (!result) throw new Error("Sale disappeared during reconciliation.");

  await writeAuditEvent(db, {
    id: randomUUID(),
    action: result.verificationState === "VERIFIED" ? "PAYPAL_CAPTURE_VERIFIED" : "PAYPAL_CAPTURE_RECONCILED",
    entityType: "sale_transaction",
    entityId: result.id,
    correlationId: result.internalReference,
    metadata: {
      paypalOrderId: result.paypalOrderId,
      paypalCaptureId: capture.id,
      providerStatus: capture.status,
      verificationState: result.verificationState,
      evidenceMatches,
    },
  });

  return result;
}

export class TransactionError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = "TransactionError";
  }
}

export function serializeSale(sale: SaleTransaction) {
  return {
    id: sale.id,
    internalReference: sale.internalReference,
    outletId: sale.outletId,
    paypalOrderId: sale.paypalOrderId,
    paypalCaptureId: sale.paypalCaptureId,
    currencyCode: sale.currencyCode,
    grossAmountMinor: sale.grossAmountMinor,
    providerStatus: sale.providerStatus,
    reconciliationState: sale.reconciliationState,
    verificationState: sale.verificationState,
    providerCreatedAt: sale.providerCreatedAt?.toISOString() ?? null,
    providerUpdatedAt: sale.providerUpdatedAt?.toISOString() ?? null,
    reconciledAt: sale.reconciledAt?.toISOString() ?? null,
    createdAt: sale.createdAt.toISOString(),
    updatedAt: sale.updatedAt.toISOString(),
  };
}
