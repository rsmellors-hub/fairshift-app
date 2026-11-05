import { UserFacingError } from "@/server/domain/errors";
import { currencyForCountry } from "@/server/domain/currency";
import { finalPayableMinor } from "@/server/domain/work-payable";
import { randomUUID } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import { z } from "zod";

import { assertRole, type Scope } from "@/server/auth/access";
import type { Database, DatabaseSession } from "@/server/db/client";
import { auditEvents, organisations, outlets, workers, workPayables, workPayouts } from "@/server/db/schema";
import { PayPalPayoutError, type PayoutResult, type PayPalPayoutAdapter } from "@/server/integrations/paypal/payout-client";

// Manager approval of confirmed work payables and their PayPal Sandbox payout.
//
// The amount sent is the approved amount persisted on the payable; nothing here
// recalculates pay from shifts, policies, rates or request input. Each payable has at
// most one payout (unique payable reference), reserved in the database before PayPal
// is called. Its sender batch/item IDs derive from the payable, so any retry reuses
// them. No-batch recovery is limited to 28 days, inside PayPal's 30-day protection.

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
// PayPal protects sender_batch_id for 30 days; leave a two-day safety margin.
const NO_BATCH_RECOVERY_WINDOW_MS = 28 * 24 * 60 * 60_000;

function assertNoBatchRecoveryWindow(payout: WorkPayout) {
  // reservedAt is persisted before the FIRST create call and immutable in the DB.
  // It is an earlier, conservative bound even if sending was delayed or NOT_SENT.
  // submittedAt is only set after a response, and updatedAt moves on every retry.
  // Never coerce missing/ambiguous timestamps or fall back to either of those fields.
  const firstAttempt = payout.reservedAt instanceof Date ? payout.reservedAt.getTime() : NaN;
  const age = Date.now() - firstAttempt;
  if (!Number.isFinite(age) || age < 0 || age >= NO_BATCH_RECOVERY_WINDOW_MS) {
    throw new UserFacingError("payout-investigation-required", "This payment is still unconfirmed. It cannot be safely resent. Investigate the original payout with PayPal before taking further payment action.");
  }
}

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

// Operating currency and provider payout currency are separate (DEC-SA-010). A payout is
// sent only in a currency with a recorded genuine PayPal Sandbox payout for FairShift
// (docs/PAYPAL_FINAL_EVIDENCE.md: USD and GBP). Anything else, including ZAR, is refused
// before a payout is reserved: no conversion, no substitute currency, and the approved
// earnings stay recorded and unpaid. This historical currency evidence does not authorise
// an SA merchant, even for legacy GBP/USD payables. Widening the route needs verification.
const VERIFIED_PAYOUT_CURRENCIES: ReadonlySet<string> = new Set(["GBP", "USD"]);
export function isVerifiedPayoutCurrency(currencyCode: string) {
  return VERIFIED_PAYOUT_CURRENCIES.has(currencyCode);
}

// No SA sender/merchant route is verified. Check persisted tenant/location geography as
// well as currency so old USD-labelled SA obligations cannot use the historical route.
async function assertPayoutRoute(db: DatabaseSession, scope: PayoutScope, currencyCode: string) {
  if (!isVerifiedPayoutCurrency(currencyCode)) throw new UserFacingError("payout-currency-unverified", `PayPal payouts in ${currencyCode} are not verified for FairShift.`);
  const [location] = await db.select({ locationCountry: outlets.country, organisationCountry: organisations.country })
    .from(outlets).innerJoin(organisations, eq(organisations.id, outlets.organisationId))
    .where(and(eq(outlets.id, scope.locationId), eq(outlets.organisationId, scope.organisationId)));
  if (!location) throw new Error("Location unavailable.");
  if ([location.locationCountry, location.organisationCountry].some(country => currencyForCountry(country) === "ZAR")) {
    throw new UserFacingError("payout-route-unverified", "A South African PayPal payout route has not been verified for FairShift.");
  }
}

// HTTP callers pass a factory so refusals happen before reading provider credentials
// or constructing a client. Tests/internal callers may supply an existing adapter.
type PayoutClientSource = PayPalPayoutAdapter | (() => PayPalPayoutAdapter);
const payoutClient = (source: PayoutClientSource) => typeof source === "function" ? source() : source;

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

// PayPal's SUCCESS confirms payment only of the amount FairShift approved. An item reporting
// another amount or currency, or none, stays unconfirmed: the money is not called paid, and it
// is not resent either, because PayPal may already have paid something.
function reconciledStatus(result: PayoutResult, payout: Pick<WorkPayout, "amountMinor" | "currencyCode">) {
  const status = payoutStatusFromProvider(result);
  if (status !== "PAID") return { status, amountError: null };
  const returned = result.itemAmount;
  if (!returned) return { status: "PROCESSING" as const, amountError: "PROVIDER_AMOUNT_UNAVAILABLE" };
  if (returned.currency !== payout.currencyCode || returned.value !== payoutAmount(payout.amountMinor, payout.currencyCode)) return { status: "PROCESSING" as const, amountError: "PROVIDER_AMOUNT_MISMATCH" };
  return { status, amountError: null };
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

function authoriseFinancialObligation(scope: PayoutScope) {
  assertRole(scope as Scope, ["OWNER", "MANAGER"]);
}

async function audit(db: DatabaseSession, scope: PayoutScope, action: string, entityType: string, entityId: string, payableId: string, metadata: Record<string, unknown>) {
  await db.insert(auditEvents).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: scope.locationId, action, entityType, entityId, correlationId: `payable:${payableId}`, metadata: { actorUserId: scope.userId, ...metadata } });
}

// Explicit manager approval of the calculated amount. The approved amount and currency
// are copied from the persisted payable; the manager approves, never edits, them.
// Idempotent: approving an approved payable returns it unchanged.
export async function approveWorkPayable(db: Database, scope: PayoutScope, payableId: string) {
  authoriseFinancialObligation(scope);
  return db.transaction(async (tx) => {
    const payable = await scopedPayable(tx, scope, payableId, true);
    if (payable.status === "APPROVED") return payable;
    if (payable.status !== "PENDING_REVIEW") throw new Error("Payable cannot be approved.");
    if (scope.workerId && scope.workerId === payable.workerId) throw new Error("A payable cannot be approved by its own worker.");
    if (payable.baseAmountMinor <= 0) throw new Error("There is no amount to approve.");
    // Unknown sales are not zero sales: an incentive cannot be approved away by omission.
    if (payable.incentiveRequired && payable.incentiveAmountMinor === null) throw new UserFacingError("performance-required", "Confirm the sales results for this shift first.");
    const [approved] = await tx.update(workPayables).set({
      status: "APPROVED", approvedAt: new Date(), approvedBy: scope.userId,
      approvedAmountMinor: finalPayableMinor(payable), approvedCurrencyCode: payable.currencyCode, updatedAt: new Date(),
    }).where(and(eq(workPayables.id, payable.id), eq(workPayables.status, "PENDING_REVIEW"))).returning();
    if (!approved) throw new Error("Payable approval changed concurrently.");
    await audit(tx, scope, "PAYABLE_APPROVED", "work_payable", approved.id, approved.id, {
      approvedAmountMinor: approved.approvedAmountMinor, approvedCurrencyCode: approved.approvedCurrencyCode, baseAmountMinor: approved.baseAmountMinor, incentiveAmountMinor: approved.incentiveAmountMinor,
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
    const { status, amountError } = reconciledStatus(outcome.result, payout);
    const errorCode = amountError ?? outcome.result.itemErrorCode;
    values = {
      status, paypalBatchId: outcome.result.batchId, paypalItemId: outcome.result.itemId ?? null, paypalTransactionId: outcome.result.transactionId ?? null,
      paypalBatchStatus: outcome.result.batchStatus ?? null, paypalStatus: outcome.result.itemStatus ?? null,
      lastError: errorCode ? { code: errorCode } : null,
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
export async function submitWorkPayout(db: Database, paypal: PayoutClientSource, scope: PayoutScope, payableId: string): Promise<SubmitResult> {
  authoriseFinancialObligation(scope);
  const payable = await scopedPayable(db, scope, payableId);
  const [existing] = await db.select().from(workPayouts).where(eq(workPayouts.payableId, payable.id));
  if (existing && existing.status !== "NOT_SENT") return { payout: existing, submitted: false };
  if (payable.status !== "APPROVED" || payable.approvedAmountMinor === null || payable.approvedCurrencyCode === null) throw new Error("Approve the payable before payout.");
  const amountMinor = payable.approvedAmountMinor, currencyCode = payable.approvedCurrencyCode;
  await assertPayoutRoute(db, scope, currencyCode);
  payoutAmount(amountMinor, currencyCode);
  const [worker] = await db.select({ email: workers.paypalPayoutEmail }).from(workers)
    .where(and(eq(workers.id, payable.workerId), eq(workers.organisationId, scope.organisationId)));
  const recipient = recipientSchema.safeParse(worker?.email ?? "");
  if (!recipient.success) throw new PaymentDetailsRequiredError();
  const client = payoutClient(paypal);

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
  return { payout: await sendReserved(db, client, scope, reserved, "FIRST"), submitted: true };
}

// Obtains the latest provider state. With a PayPal batch ID it reads the payout; with
// an unknown outcome it may re-send the identical request (same sender_batch_id,
// amount, currency and recipient) only within the conservative recovery window.
export async function refreshWorkPayout(db: Database, paypal: PayoutClientSource, scope: PayoutScope, payableId: string): Promise<WorkPayout> {
  authoriseFinancialObligation(scope);
  const payable = await scopedPayable(db, scope, payableId);
  const [payout] = await db.select().from(workPayouts).where(eq(workPayouts.payableId, payable.id));
  if (!payout) throw new Error("No payout has been sent for this payable.");

  if (payout.paypalBatchId) {
    const now = new Date();
    let result: PayoutResult;
    try {
      result = await payoutClient(paypal).getPayout(payout.paypalBatchId, payout.senderItemId);
    } catch (error) {
      const code = error instanceof PayPalPayoutError ? error.code : "STATUS_REQUEST_FAILED";
      await db.update(workPayouts).set({ lastError: { code, httpStatus: error instanceof PayPalPayoutError ? error.status ?? null : null, debugId: error instanceof PayPalPayoutError ? error.debugId ?? null : null, outcome: "STATUS_UNAVAILABLE" }, updatedAt: now })
        .where(eq(workPayouts.id, payout.id));
      throw new Error("PayPal payout status could not be retrieved. The recorded status is unchanged.", { cause: error });
    }
    if (result.batchId !== payout.paypalBatchId) throw new Error("PayPal returned a different payout batch.");
    const { status, amountError } = reconciledStatus(result, payout);
    const errorCode = amountError ?? result.itemErrorCode;
    const [updated] = await db.update(workPayouts).set({
      status, paypalItemId: payout.paypalItemId ?? result.itemId ?? null, paypalTransactionId: payout.paypalTransactionId ?? result.transactionId ?? null,
      paypalBatchStatus: result.batchStatus ?? null, paypalStatus: result.itemStatus ?? null,
      lastError: errorCode ? { code: errorCode } : null,
      statusCheckedAt: now, paidAt: status === "PAID" ? payout.paidAt ?? now : amountError ? null : payout.paidAt, updatedAt: now,
    }).where(and(eq(workPayouts.id, payout.id), eq(workPayouts.paypalBatchId, payout.paypalBatchId))).returning();
    if (updated.status !== payout.status || (amountError && (payout.lastError as { code?: string } | null)?.code !== amountError)) {
      await audit(db, scope, "PAYOUT_STATUS_UPDATED", "work_payout", updated.id, payable.id, { from: payout.status, to: updated.status, paypalStatus: updated.paypalStatus, paypalBatchStatus: updated.paypalBatchStatus, amountError });
    }
    return updated;
  }

  const stale = new Date(Date.now() - STALE_SUBMISSION_MS);
  if (payout.status === "RECONCILIATION_REQUIRED" || (payout.status === "SUBMITTING" && payout.updatedAt < stale)) {
    assertNoBatchRecoveryWindow(payout);
    // A no-batch refresh can create a payment; it must pass the same route gate.
    // Known-batch GET reconciliation above stays available for existing obligations.
    await assertPayoutRoute(db, scope, payout.currencyCode);
    const client = payoutClient(paypal);
    const [claimed] = await db.update(workPayouts).set({ status: "SUBMITTING", attempts: sql`${workPayouts.attempts} + 1`, updatedAt: new Date() })
      .where(and(eq(workPayouts.id, payout.id), eq(workPayouts.status, payout.status), payout.status === "SUBMITTING" ? lt(workPayouts.updatedAt, stale) : eq(workPayouts.updatedAt, payout.updatedAt))).returning();
    if (!claimed) {
      const [current] = await db.select().from(workPayouts).where(eq(workPayouts.id, payout.id));
      return current;
    }
    await audit(db, scope, "PAYOUT_RECONCILIATION_REQUESTED", "work_payout", claimed.id, payable.id, { attempt: claimed.attempts, senderBatchId: claimed.senderBatchId });
    // Claiming/auditing can take time. Check again immediately before provider create.
    try {
      assertNoBatchRecoveryWindow(claimed);
    } catch (error) {
      // No provider request was made. Keep the prior provider error and all evidence.
      await db.update(workPayouts).set({ status: "RECONCILIATION_REQUIRED", updatedAt: new Date() })
        .where(and(eq(workPayouts.id, claimed.id), eq(workPayouts.status, "SUBMITTING"), eq(workPayouts.updatedAt, claimed.updatedAt)));
      throw error;
    }
    const reconciled = await sendReserved(db, client, scope, claimed, "RECONCILE");
    // An adopted earlier payout is read straight away for its item status.
    return reconciled.paypalBatchId && !reconciled.paypalStatus ? refreshWorkPayout(db, paypal, scope, payableId) : reconciled;
  }
  return payout;
}
