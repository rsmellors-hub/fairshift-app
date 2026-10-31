import { randomUUID } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import { z } from "zod";

import { assertRole, type Scope } from "@/server/auth/access";
import { requireEntitlement } from "@/server/billing/entitlement";
import type { Database, DatabaseSession } from "@/server/db/client";
import { auditEvents, workers, workPayables, workPayouts } from "@/server/db/schema";
import { PayPalPayoutError, type PayoutResult, type PayPalPayoutAdapter } from "@/server/integrations/paypal/payout-client";

// Manager approval of confirmed work payables and their PayPal Sandbox payout.
//
// The amount sent is the approved amount persisted on the payable; nothing here
// recalculates pay from shifts, policies, rates or request input. Each payable has at
// most one payout (unique payable reference), reserved in the database before PayPal
// is called. Its sender batch/item IDs derive from the payable, so any retry reuses
// them and PayPal pays a sender_batch_id at most once within 30 days.

export type WorkPayout = typeof workPayouts.$inferSelect;
type PayoutScope = Pick<Scope, "userId" | "organisationId" | "locationId" | "role" | "workerId">;

export class PaymentDetailsRequiredError extends Error {
  constructor() { super("Payment details required."); this.name = "PaymentDetailsRequiredError"; }
}
export class PayoutCurrencyUnsupportedError extends Error {
  constructor(currency: string) { super(`Payouts in ${currency} are not supported.`); this.name = "PayoutCurrencyUnsupportedError"; }
}

// A payout that may still be in flight is not retried before this long has passed.
export const STALE_SUBMISSION_MS = 2 * 60_000;
const recipientSchema = z.string().trim().email().max(254);

export const payoutSenderIds = (payableId: string) => {
  const key = payableId.replaceAll("-", "").toUpperCase();
  return { senderBatchId: `FSWP-B-${key}`, senderItemId: `FSWP-I-${key}` };
};

// Decimal string of an integer minor-unit amount, for currencies with two decimal
// places only. Other minor-unit scales are refused rather than guessed.
export function payoutAmount(amountMinor: number, currencyCode: string) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error("Payout amount must be a positive whole number of minor units.");
  let digits: number | undefined;
  try { digits = new Intl.NumberFormat("en", { style: "currency", currency: currencyCode }).resolvedOptions().maximumFractionDigits; } catch { digits = undefined; }
  if (!/^[A-Z]{3}$/.test(currencyCode) || digits !== 2) throw new PayoutCurrencyUnsupportedError(currencyCode);
  return `${Math.floor(amountMinor / 100)}.${String(amountMinor % 100).padStart(2, "0")}`;
}

// PayPal statuses mapped conservatively. Only an item-level SUCCESS is paid; a batch
// that is processed or successful says nothing certain about the worker's item.
export function payoutStatusFromProvider(result: Pick<PayoutResult, "itemStatus" | "batchStatus">): "PROCESSING" | "PAID" | "FAILED" {
  const item = result.itemStatus?.toUpperCase() ?? null;
  if (item === "SUCCESS") return "PAID";
  if (item && ["FAILED", "RETURNED", "BLOCKED", "REFUNDED", "REVERSED"].includes(item)) return "FAILED";
  if (item) return "PROCESSING"; // PENDING, UNCLAIMED, ONHOLD and anything unrecognised.
  if (["DENIED", "CANCELED"].includes(result.batchStatus?.toUpperCase() ?? "")) return "FAILED";
  return "PROCESSING";
}

async function scopedPayable(db: DatabaseSession, scope: PayoutScope, payableId: string, lock = false) {
  z.uuid().parse(payableId);
  const query = db.select().from(workPayables).where(and(
    eq(workPayables.id, payableId), eq(workPayables.organisationId, scope.organisationId), eq(workPayables.outletId, scope.locationId),
  ));
  const [payable] = lock ? await query.for("update") : await query;
  if (!payable) throw new Error("Payable unavailable.");
  return payable;
}

async function authorise(db: DatabaseSession, scope: PayoutScope) {
  assertRole(scope as Scope, ["OWNER", "MANAGER"]);
  await requireEntitlement(db, scope.organisationId);
}

async function audit(db: DatabaseSession, scope: PayoutScope, action: string, entityType: string, entityId: string, payableId: string, metadata: Record<string, unknown>) {
  await db.insert(auditEvents).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: scope.locationId, action, entityType, entityId, correlationId: `payable:${payableId}`, metadata: { actorUserId: scope.userId, ...metadata } });
}

// Explicit manager approval of the calculated amount. The approved amount and currency
// are copied from the persisted payable; the manager approves, never edits, them.
// Idempotent: approving an approved payable returns it unchanged.
export async function approveWorkPayable(db: Database, scope: PayoutScope, payableId: string) {
  await authorise(db, scope);
  return db.transaction(async (tx) => {
    const payable = await scopedPayable(tx, scope, payableId, true);
    if (payable.status === "APPROVED") return payable;
    if (payable.status !== "PENDING_REVIEW") throw new Error("Payable cannot be approved.");
    if (scope.workerId && scope.workerId === payable.workerId) throw new Error("A payable cannot be approved by its own worker.");
    if (payable.baseAmountMinor <= 0) throw new Error("There is no amount to approve.");
    const [approved] = await tx.update(workPayables).set({
      status: "APPROVED", approvedAt: new Date(), approvedBy: scope.userId,
      approvedAmountMinor: payable.baseAmountMinor, approvedCurrencyCode: payable.currencyCode, updatedAt: new Date(),
    }).where(and(eq(workPayables.id, payable.id), eq(workPayables.status, "PENDING_REVIEW"))).returning();
    if (!approved) throw new Error("Payable approval changed concurrently.");
    await audit(tx, scope, "PAYABLE_APPROVED", "work_payable", approved.id, approved.id, {
      approvedAmountMinor: approved.approvedAmountMinor, approvedCurrencyCode: approved.approvedCurrencyCode, baseAmountMinor: approved.baseAmountMinor,
      allocationId: approved.allocationId, acceptanceId: approved.acceptanceId, termsVersion: approved.termsVersion,
    });
    return approved;
  });
}

type Mode = "FIRST" | "RECONCILE";

// Records what PayPal said about a create request. On a reconciliation attempt, a
// refusal or a request that never left cannot prove the earlier request did not pay,
// so the payout stays under reconciliation rather than becoming NOT_SENT or FAILED.
async function recordCreateOutcome(db: DatabaseSession, scope: PayoutScope, payout: WorkPayout, mode: Mode, outcome: { result: PayoutResult } | { error: unknown }) {
  const now = new Date();
  let values: Partial<WorkPayout>;
  if ("result" in outcome) {
    const status = payoutStatusFromProvider(outcome.result);
    values = {
      status, paypalBatchId: outcome.result.batchId, paypalItemId: outcome.result.itemId ?? null, paypalTransactionId: outcome.result.transactionId ?? null,
      paypalBatchStatus: outcome.result.batchStatus ?? null, paypalStatus: outcome.result.itemStatus ?? null,
      lastError: outcome.result.itemErrorCode ? { code: outcome.result.itemErrorCode } : null,
      submittedAt: payout.submittedAt ?? now, statusCheckedAt: now, paidAt: status === "PAID" ? now : null,
    };
  } else {
    const error = outcome.error instanceof PayPalPayoutError ? outcome.error : null;
    const kind = error?.outcome ?? "UNKNOWN";
    const lastError = { code: error?.code ?? "PAYOUT_REQUEST_FAILED", httpStatus: error?.status ?? null, debugId: error?.debugId ?? null, outcome: kind };
    if (kind === "DUPLICATE" && error?.originalBatchId) {
      // PayPal holds an earlier payout for this sender_batch_id; adopt it and read its state.
      values = { status: "PROCESSING", paypalBatchId: error.originalBatchId, lastError, submittedAt: payout.submittedAt ?? now };
    } else if (kind === "NOT_SENT" && mode === "FIRST") {
      values = { status: "NOT_SENT", lastError };
    } else if (kind === "REJECTED" && mode === "FIRST") {
      values = { status: "FAILED", lastError, statusCheckedAt: now };
    } else {
      values = { status: "RECONCILIATION_REQUIRED", lastError };
    }
  }
  const [updated] = await db.update(workPayouts).set({ ...values, updatedAt: now })
    .where(and(eq(workPayouts.id, payout.id), eq(workPayouts.status, "SUBMITTING"))).returning();
  if (!updated) throw new Error("Payout state changed concurrently.");
  await audit(db, scope, "PAYOUT_PROVIDER_RESPONSE", "work_payout", updated.id, updated.payableId, {
    mode, status: updated.status, paypalBatchId: updated.paypalBatchId, paypalStatus: updated.paypalStatus, error: values.lastError ?? null,
  });
  return updated;
}

async function sendReserved(db: DatabaseSession, paypal: PayPalPayoutAdapter, scope: PayoutScope, payout: WorkPayout, mode: Mode) {
  let outcome: { result: PayoutResult } | { error: unknown };
  try {
    outcome = { result: await paypal.createPayout({
      senderBatchId: payout.senderBatchId,
      senderItemId: payout.senderItemId,
      recipient: payout.recipient,
      amount: payoutAmount(payout.amountMinor, payout.currencyCode),
      currency: payout.currencyCode,
      purpose: "SERVICES",
      emailSubject: "FairShift work earnings",
      emailMessage: "Your manager-approved FairShift work earnings have been sent to your PayPal account.",
      note: "Manager-approved FairShift work earnings",
    }) };
  } catch (error) {
    outcome = { error };
  }
  return recordCreateOutcome(db, scope, payout, mode, outcome);
}

export type SubmitResult = { payout: WorkPayout; submitted: boolean };

// Sends the approved payable to PayPal once. A repeat, retry or concurrent request
// finds the existing reservation and returns it without calling PayPal; only a payout
// that certainly never reached PayPal (NOT_SENT) can be sent again, with the same IDs.
export async function submitWorkPayout(db: Database, paypal: PayPalPayoutAdapter, scope: PayoutScope, payableId: string): Promise<SubmitResult> {
  await authorise(db, scope);
  const payable = await scopedPayable(db, scope, payableId);
  const [existing] = await db.select().from(workPayouts).where(eq(workPayouts.payableId, payable.id));
  if (existing && existing.status !== "NOT_SENT") return { payout: existing, submitted: false };
  if (payable.status !== "APPROVED" || payable.approvedAmountMinor === null || payable.approvedCurrencyCode === null) throw new Error("Approve the payable before payout.");
  const amountMinor = payable.approvedAmountMinor, currencyCode = payable.approvedCurrencyCode;
  payoutAmount(amountMinor, currencyCode);
  const [worker] = await db.select({ email: workers.paypalPayoutEmail }).from(workers)
    .where(and(eq(workers.id, payable.workerId), eq(workers.organisationId, scope.organisationId)));
  const recipient = recipientSchema.safeParse(worker?.email ?? "");
  if (!recipient.success) throw new PaymentDetailsRequiredError();

  const now = new Date();
  let reserved: WorkPayout | undefined;
  if (!existing) {
    [reserved] = await db.insert(workPayouts).values({
      id: randomUUID(), payableId: payable.id, organisationId: payable.organisationId, outletId: payable.outletId, workerId: payable.workerId,
      amountMinor, currencyCode, recipient: recipient.data, ...payoutSenderIds(payable.id),
      status: "SUBMITTING", requestedBy: scope.userId, reservedAt: now, updatedAt: now,
    }).onConflictDoNothing({ target: workPayouts.payableId }).returning();
  } else {
    [reserved] = await db.update(workPayouts).set({ status: "SUBMITTING", recipient: recipient.data, attempts: sql`${workPayouts.attempts} + 1`, requestedBy: scope.userId, updatedAt: now })
      .where(and(eq(workPayouts.id, existing.id), eq(workPayouts.status, "NOT_SENT"))).returning();
  }
  if (!reserved) {
    const [current] = await db.select().from(workPayouts).where(eq(workPayouts.payableId, payable.id));
    return { payout: current, submitted: false };
  }
  await audit(db, scope, "PAYOUT_RESERVED", "work_payout", reserved.id, payable.id, {
    amountMinor, currencyCode, senderBatchId: reserved.senderBatchId, senderItemId: reserved.senderItemId, attempt: reserved.attempts,
  });
  return { payout: await sendReserved(db, paypal, scope, reserved, "FIRST"), submitted: true };
}

// Obtains the latest provider state. With a PayPal batch ID it reads the payout; with
// an unknown outcome it re-sends the identical request (same sender_batch_id, amount,
// currency and recipient), which PayPal processes at most once, to learn the result.
export async function refreshWorkPayout(db: Database, paypal: PayPalPayoutAdapter, scope: PayoutScope, payableId: string): Promise<WorkPayout> {
  await authorise(db, scope);
  const payable = await scopedPayable(db, scope, payableId);
  const [payout] = await db.select().from(workPayouts).where(eq(workPayouts.payableId, payable.id));
  if (!payout) throw new Error("No payout has been sent for this payable.");

  if (payout.paypalBatchId) {
    const now = new Date();
    let result: PayoutResult;
    try {
      result = await paypal.getPayout(payout.paypalBatchId, payout.senderItemId);
    } catch (error) {
      const code = error instanceof PayPalPayoutError ? error.code : "STATUS_REQUEST_FAILED";
      await db.update(workPayouts).set({ lastError: { code, httpStatus: error instanceof PayPalPayoutError ? error.status ?? null : null, debugId: error instanceof PayPalPayoutError ? error.debugId ?? null : null, outcome: "STATUS_UNAVAILABLE" }, updatedAt: now })
        .where(eq(workPayouts.id, payout.id));
      throw new Error("PayPal payout status could not be retrieved. The recorded status is unchanged.", { cause: error });
    }
    if (result.batchId !== payout.paypalBatchId) throw new Error("PayPal returned a different payout batch.");
    const status = payoutStatusFromProvider(result);
    const [updated] = await db.update(workPayouts).set({
      status, paypalItemId: payout.paypalItemId ?? result.itemId ?? null, paypalTransactionId: payout.paypalTransactionId ?? result.transactionId ?? null,
      paypalBatchStatus: result.batchStatus ?? null, paypalStatus: result.itemStatus ?? null,
      lastError: result.itemErrorCode ? { code: result.itemErrorCode } : null,
      statusCheckedAt: now, paidAt: status === "PAID" ? payout.paidAt ?? now : payout.paidAt, updatedAt: now,
    }).where(and(eq(workPayouts.id, payout.id), eq(workPayouts.paypalBatchId, payout.paypalBatchId))).returning();
    if (updated.status !== payout.status) {
      await audit(db, scope, "PAYOUT_STATUS_UPDATED", "work_payout", updated.id, payable.id, { from: payout.status, to: updated.status, paypalStatus: updated.paypalStatus, paypalBatchStatus: updated.paypalBatchStatus });
    }
    return updated;
  }

  const stale = new Date(Date.now() - STALE_SUBMISSION_MS);
  if (payout.status === "RECONCILIATION_REQUIRED" || (payout.status === "SUBMITTING" && payout.updatedAt < stale)) {
    const [claimed] = await db.update(workPayouts).set({ status: "SUBMITTING", attempts: sql`${workPayouts.attempts} + 1`, updatedAt: new Date() })
      .where(and(eq(workPayouts.id, payout.id), eq(workPayouts.status, payout.status), payout.status === "SUBMITTING" ? lt(workPayouts.updatedAt, stale) : eq(workPayouts.updatedAt, payout.updatedAt))).returning();
    if (!claimed) {
      const [current] = await db.select().from(workPayouts).where(eq(workPayouts.id, payout.id));
      return current;
    }
    await audit(db, scope, "PAYOUT_RECONCILIATION_REQUESTED", "work_payout", claimed.id, payable.id, { attempt: claimed.attempts, senderBatchId: claimed.senderBatchId });
    const reconciled = await sendReserved(db, paypal, scope, claimed, "RECONCILE");
    // An adopted earlier payout is read straight away for its item status.
    return reconciled.paypalBatchId && !reconciled.paypalStatus ? refreshWorkPayout(db, paypal, scope, payableId) : reconciled;
  }
  return payout;
}
