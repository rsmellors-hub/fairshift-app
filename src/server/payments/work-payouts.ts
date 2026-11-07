import { assertSandboxFinancialScope, assertSandboxOrganisation } from "@/server/config/deployment";
import { UserFacingError } from "@/server/domain/errors";
import { currencyForCountry } from "@/server/domain/currency";
import { resolveProviderAmount } from "@/server/domain/provider-currency";
import { currentZarConversion } from "@/server/fx/reference-rates";
import { finalPayableMinor } from "@/server/domain/work-payable";
import { randomUUID } from "node:crypto";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { z } from "zod";

import { assertRole, type Scope } from "@/server/auth/access";
import type { Database, DatabaseSession } from "@/server/db/client";
import { auditEvents, organisations, outlets, payAgentEvents, workers, workPayables, workPayouts } from "@/server/db/schema";
import { PayPalPayoutError, type PayoutResult, type PayPalPayoutAdapter } from "@/server/integrations/paypal/payout-client";

// Manager approval of confirmed work payables and their PayPal Sandbox payout.
//
// The approved amount persisted on the payable is the worker's entitlement; nothing here
// recalculates pay from shifts, policies, rates or request input. When PayPal cannot pay that
// operating currency (ZAR), the payout is sent in a supported provider currency (USD) instead,
// converted exactly once at the newest ECB reference rate and frozen on the reservation, so a retry
// or recovery re-sends the identical provider amount and never re-converts (DEC-SA-012); with
// no conversion the provider leg equals the entitlement. Each payable has at most one payout
// (unique payable reference), reserved in the database before PayPal is called. Its sender
// batch/item IDs derive from the payable, so any retry reuses them. No-batch recovery is
// limited to 28 days, inside PayPal's 30-day protection.

export type WorkPayout = typeof workPayouts.$inferSelect;
type WorkPayable = typeof workPayables.$inferSelect;
type PayoutScope = Pick<Scope, "userId" | "organisationId" | "locationId" | "role" | "workerId" | "demo">;
// Who records a payable or payout write: a signed-in Owner or Manager, or the Pay Agent service
// acting on DEC-SA-011 authority (no user, service named). The audit keeps the distinction.
type PayoutActor = { userId: string | null; organisationId: string; locationId: string; service?: "fairshift-pay-agent" };
type Tenancy = Pick<PayoutActor, "organisationId" | "locationId">;

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

// Operating currency and provider payout currency are separate (DEC-SA-010). The currency
// actually sent to PayPal must be one with a recorded genuine PayPal Sandbox payout for
// FairShift (docs/PAYPAL_FINAL_EVIDENCE.md: USD and GBP). A ZAR operating entitlement is never
// sent as ZAR; it reaches PayPal only through the frozen USD demo conversion (DEC-SA-012).
const VERIFIED_PAYOUT_CURRENCIES: ReadonlySet<string> = new Set(["GBP", "USD"]);
export function isVerifiedPayoutCurrency(currencyCode: string) {
  return VERIFIED_PAYOUT_CURRENCIES.has(currencyCode);
}

// The currency sent must be verified, and no SA sender/merchant route is verified, so a ZAR
// tenant/location is refused unless this payout is the authorised demo conversion to a verified
// provider currency. `conversionAuthorised` is true only when a frozen rate converted the ZAR
// entitlement to its provider leg; it never comes from request input. Legacy USD-labelled SA
// obligations carry no conversion, so they are still refused: historical currency evidence does
// not authorise an SA merchant. Non-SA GBP/USD payouts are unaffected.
async function assertPayoutRoute(db: DatabaseSession, scope: Tenancy, providerCurrency: string, conversionAuthorised: boolean) {
  if (!isVerifiedPayoutCurrency(providerCurrency)) throw new UserFacingError("payout-currency-unverified", `PayPal payouts in ${providerCurrency} are not verified for FairShift.`);
  const [location] = await db.select({ locationCountry: outlets.country, organisationCountry: organisations.country })
    .from(outlets).innerJoin(organisations, eq(organisations.id, outlets.organisationId))
    .where(and(eq(outlets.id, scope.locationId), eq(outlets.organisationId, scope.organisationId)));
  if (!location) throw new Error("Location unavailable.");
  if (!conversionAuthorised && [location.locationCountry, location.organisationCountry].some(country => currencyForCountry(country) === "ZAR")) {
    throw new UserFacingError("payout-route-unverified", "A South African PayPal payout route has not been verified for FairShift.");
  }
}

// HTTP callers pass a factory so refusals happen before reading provider credentials
// or constructing a client. Tests/internal callers may supply an existing adapter.
export type PayoutClientSource = PayPalPayoutAdapter | (() => PayPalPayoutAdapter);
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

// PayPal's SUCCESS confirms payment only of the provider amount and currency FairShift sent.
// An item reporting another amount or currency, or none, stays unconfirmed: the money is not
// called paid, and it is not resent either, because PayPal may already have paid something.
function reconciledStatus(result: PayoutResult, payout: Pick<WorkPayout, "providerAmountMinor" | "providerCurrency">) {
  const status = payoutStatusFromProvider(result);
  if (status !== "PAID") return { status, amountError: null };
  const returned = result.itemAmount;
  if (!returned) return { status: "PROCESSING" as const, amountError: "PROVIDER_AMOUNT_UNAVAILABLE" };
  if (returned.currency !== payout.providerCurrency || returned.value !== payoutAmount(payout.providerAmountMinor, payout.providerCurrency)) return { status: "PROCESSING" as const, amountError: "PROVIDER_AMOUNT_MISMATCH" };
  return { status, amountError: null };
}

async function scopedPayable(db: DatabaseSession, scope: Tenancy, payableId: string, lock = false) {
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

// The correlation of a payout's audit trail: its work payable, or its tip allocation line.
const obligationOf = (payout: Pick<WorkPayout, "payableId" | "tipLineId">) => payout.payableId ? `payable:${payout.payableId}` : `tip-line:${payout.tipLineId}`;
async function audit(db: DatabaseSession, scope: PayoutActor, action: string, entityType: string, entityId: string, correlation: string, metadata: Record<string, unknown>) {
  await db.insert(auditEvents).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: scope.locationId, action, entityType, entityId, correlationId: correlation.includes(":") ? correlation : `payable:${correlation}`,
    metadata: { actorUserId: scope.userId, ...(scope.service ? { actorService: scope.service } : {}), ...metadata } });
}

// A Pay Agent hold awaiting a manager, or a manager's rejection of one, also stops the manual
// approve and send actions, so a rejected payment stays unpaid (DEC-SA-011 hold resolution).
async function assertNoPayAgentHold(db: DatabaseSession, payableId: string) {
  const events = await db.select({ status: payAgentEvents.status }).from(payAgentEvents)
    .where(eq(payAgentEvents.payableId, payableId)).orderBy(desc(payAgentEvents.createdAt));
  if (events.some(event => event.status === "HOLD_REJECTED")) throw new UserFacingError("pay-agent-rejected", "A manager rejected this payment, so it stays unpaid.");
  if (events[0]?.status === "DECIDED_HOLD") throw new UserFacingError("pay-agent-hold", "The Pay Agent is holding this payment for review. Release or reject the hold first.");
}

// Explicit manager approval of the calculated amount. The approved amount and currency
// are copied from the persisted payable; the manager approves, never edits, them.
// Idempotent: approving an approved payable returns it unchanged.
export async function approveWorkPayable(db: Database, scope: PayoutScope, payableId: string) {
  authoriseFinancialObligation(scope);
  return db.transaction(async (tx) => {
    const payable = await scopedPayable(tx, scope, payableId, true);
    if (payable.status === "APPROVED") return payable;
    await assertNoPayAgentHold(tx, payable.id);
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
async function recordCreateOutcome(db: DatabaseSession, scope: PayoutActor, payout: WorkPayout, mode: Mode, outcome: { result: PayoutResult } | { error: unknown }) {
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
  await audit(db, scope, "PAYOUT_PROVIDER_RESPONSE", "work_payout", updated.id, obligationOf(updated), {
    mode, status: updated.status, paypalBatchId: updated.paypalBatchId, paypalStatus: updated.paypalStatus, error: values.lastError ?? null,
  });
  return updated;
}

async function sendReserved(db: DatabaseSession, paypal: PayPalPayoutAdapter, scope: PayoutActor, payout: WorkPayout, mode: Mode) {
  let outcome: { result: PayoutResult } | { error: unknown };
  try {
    outcome = { result: await paypal.createPayout({
      senderBatchId: payout.senderBatchId,
      senderItemId: payout.senderItemId,
      recipient: payout.recipient,
      amount: payoutAmount(payout.providerAmountMinor, payout.providerCurrency),
      currency: payout.providerCurrency,
      purpose: "SERVICES",
      ...(payout.tipLineId
        ? { emailSubject: "FairShift tips", emailMessage: "Your tips, released under your employer's standing tip policy, have been sent to your PayPal account.", note: "FairShift tip release" }
        : { emailSubject: "FairShift work earnings", emailMessage: "Your manager-approved FairShift work earnings have been sent to your PayPal account.", note: "Manager-approved FairShift work earnings" }),
    }) };
  } catch (error) {
    outcome = { error };
  }
  return recordCreateOutcome(db, scope, payout, mode, outcome);
}

export type SubmitResult = { payout: WorkPayout; submitted: boolean };

// Every pre-reservation check of this engine, without any write: the provider leg actually sent
// to PayPal (for a new reservation it is resolved now — a ZAR entitlement converts to USD at the
// newest ECB reference rate, or fails closed when none from the last 3 business days exists; re-sending an unsent payout
// reuses its frozen values, so a later rate change cannot alter the reservation and the amount is
// never re-converted), the verified provider currency and route, a two-decimal amount, and the
// worker's own saved payment destination. The Pay Agent's dry run evaluates exactly these checks.
export async function prepareWorkPayout(db: DatabaseSession, scope: Tenancy, input: { workerId: string; amountMinor: number; currencyCode: string; existing?: WorkPayout }) {
  const providerLeg = input.existing
    ? { providerCurrency: input.existing.providerCurrency, providerAmountMinor: input.existing.providerAmountMinor, fxRateMicros: input.existing.fxRateMicros, fxRateSource: input.existing.fxRateSource }
    : await resolveProviderAmount({ amountMinor: input.amountMinor, currencyCode: input.currencyCode }, () => currentZarConversion(db));
  await assertPayoutRoute(db, scope, providerLeg.providerCurrency, providerLeg.fxRateMicros !== null);
  payoutAmount(providerLeg.providerAmountMinor, providerLeg.providerCurrency);
  const [worker] = await db.select({ email: workers.paypalPayoutEmail }).from(workers)
    .where(and(eq(workers.id, input.workerId), eq(workers.organisationId, scope.organisationId)));
  const recipient = recipientSchema.safeParse(worker?.email ?? "");
  if (!recipient.success) throw new PaymentDetailsRequiredError();
  return { providerLeg, recipient: recipient.data };
}

// Reserves and sends an approved payable once. A repeat, retry or concurrent request finds the
// existing reservation and returns it without calling PayPal; only a payout that certainly never
// reached PayPal (NOT_SENT) can be sent again, with the same IDs.
async function submitApprovedPayout(db: Database, paypal: PayoutClientSource, actor: PayoutActor, payable: WorkPayable): Promise<SubmitResult> {
  const [existing] = await db.select().from(workPayouts).where(eq(workPayouts.payableId, payable.id));
  if (existing && existing.status !== "NOT_SENT") return { payout: existing, submitted: false };
  if (payable.status !== "APPROVED" || payable.approvedAmountMinor === null || payable.approvedCurrencyCode === null) throw new Error("Approve the payable before payout.");
  const amountMinor = payable.approvedAmountMinor, currencyCode = payable.approvedCurrencyCode;
  const { providerLeg, recipient } = await prepareWorkPayout(db, actor, { workerId: payable.workerId, amountMinor, currencyCode, existing });
  const client = payoutClient(paypal);

  const now = new Date();
  let reserved: WorkPayout | undefined;
  if (!existing) {
    [reserved] = await db.insert(workPayouts).values({
      id: randomUUID(), payableId: payable.id, organisationId: payable.organisationId, outletId: payable.outletId, workerId: payable.workerId,
      amountMinor, currencyCode,
      providerCurrency: providerLeg.providerCurrency, providerAmountMinor: providerLeg.providerAmountMinor, fxRateMicros: providerLeg.fxRateMicros, fxRateSource: providerLeg.fxRateSource,
      recipient, ...payoutSenderIds(payable.id),
      status: "SUBMITTING", requestedBy: actor.userId, reservedAt: now, updatedAt: now,
    }).onConflictDoNothing({ target: workPayouts.payableId }).returning();
  } else {
    [reserved] = await db.update(workPayouts).set({ status: "SUBMITTING", recipient, attempts: sql`${workPayouts.attempts} + 1`, requestedBy: actor.userId, updatedAt: now })
      .where(and(eq(workPayouts.id, existing.id), eq(workPayouts.status, "NOT_SENT"))).returning();
  }
  if (!reserved) {
    const [current] = await db.select().from(workPayouts).where(eq(workPayouts.payableId, payable.id));
    return { payout: current, submitted: false };
  }
  await audit(db, actor, "PAYOUT_RESERVED", "work_payout", reserved.id, payable.id, {
    amountMinor, currencyCode, providerAmountMinor: reserved.providerAmountMinor, providerCurrency: reserved.providerCurrency,
    fxRateMicros: reserved.fxRateMicros, fxRateSource: reserved.fxRateSource,
    senderBatchId: reserved.senderBatchId, senderItemId: reserved.senderItemId, attempt: reserved.attempts,
  });
  return { payout: await sendReserved(db, client, actor, reserved, "FIRST"), submitted: true };
}

// Sends the manager-approved payable to PayPal once (see submitApprovedPayout).
export async function submitWorkPayout(db: Database, paypal: PayoutClientSource, scope: PayoutScope, payableId: string): Promise<SubmitResult> {
  assertSandboxFinancialScope(scope);
  authoriseFinancialObligation(scope);
  const payable = await scopedPayable(db, scope, payableId);
  await assertNoPayAgentHold(db, payable.id);
  return submitApprovedPayout(db, paypal, scope, payable);
}

// FS-APPROVER-DEC-001 (7 Nov 2026): an automatic casual settlement keeps the confirming, or
// hold-releasing, manager as approver of record, on this audit basis.
export const CASUAL_APPROVER_BASIS = {
  MANAGER_CONFIRMED_COMPLETION: "Manager confirmation at preauthorised fixed terms (DEC-SA-011)",
  MANAGER_RELEASED_HOLD: "Manager released a Pay Agent hold on work confirmed at preauthorised fixed terms (DEC-SA-011)",
} as const;

export type ConfirmedWorkAuthority = {
  organisationId: string; locationId: string;
  // The manager whose confirmation completed the work, or who released a Pay Agent hold.
  authorisedBy: string; basis: "MANAGER_CONFIRMED_COMPLETION" | "MANAGER_RELEASED_HOLD"; payAgentEventId: string;
  // Re-checks the Pay Agent's evidence under the payable's row lock; throws to refuse.
  verify: (tx: DatabaseSession, payable: WorkPayable) => Promise<void>;
};

// The Pay Agent's entry to this engine (DEC-SA-011). Casual compensation was preauthorised and
// accepted before the work, and a manager confirmed the work, so no second discretionary approval
// is asked for: the payable is approved on that existing authority (recorded as the authorising
// manager, with the basis and the service in the audit), then reserved and sent exactly as
// submitWorkPayout does, with the same frozen provider leg, route gate, uniqueness and recovery.
export async function submitConfirmedWorkPayout(db: Database, paypal: PayoutClientSource, authority: ConfirmedWorkAuthority, payableId: string): Promise<SubmitResult> {
  assertSandboxOrganisation(authority.organisationId);
  const actor: PayoutActor = { userId: null, organisationId: authority.organisationId, locationId: authority.locationId, service: "fairshift-pay-agent" };
  const payable = await db.transaction(async tx => {
    const locked = await scopedPayable(tx, actor, payableId, true);
    await authority.verify(tx, locked);
    if (locked.status === "APPROVED") return locked;
    if (locked.status !== "PENDING_REVIEW") throw new Error("Payable cannot be approved.");
    if (locked.baseAmountMinor <= 0) throw new Error("There is no amount to approve.");
    if (locked.incentiveRequired && locked.incentiveAmountMinor === null) throw new UserFacingError("performance-required", "Confirm the sales results for this shift first.");
    const [approved] = await tx.update(workPayables).set({
      status: "APPROVED", approvedAt: new Date(), approvedBy: authority.authorisedBy,
      approvedAmountMinor: finalPayableMinor(locked), approvedCurrencyCode: locked.currencyCode, updatedAt: new Date(),
    }).where(and(eq(workPayables.id, locked.id), eq(workPayables.status, "PENDING_REVIEW"))).returning();
    if (!approved) throw new Error("Payable approval changed concurrently.");
    await audit(tx, actor, "PAYABLE_APPROVED", "work_payable", approved.id, approved.id, {
      basis: authority.basis, authorisedBy: authority.authorisedBy, payAgentEventId: authority.payAgentEventId,
      approverOfRecord: authority.authorisedBy, approverDecision: "FS-APPROVER-DEC-001", approverBasis: CASUAL_APPROVER_BASIS[authority.basis],
      approvedAmountMinor: approved.approvedAmountMinor, approvedCurrencyCode: approved.approvedCurrencyCode, baseAmountMinor: approved.baseAmountMinor, incentiveAmountMinor: approved.incentiveAmountMinor,
      allocationId: approved.allocationId, acceptanceId: approved.acceptanceId, termsVersion: approved.termsVersion,
    });
    return approved;
  });
  return submitApprovedPayout(db, paypal, actor, payable);
}

// Obtains the latest provider state. With a PayPal batch ID it reads the payout; with
// an unknown outcome it may re-send the identical request (same sender_batch_id,
// amount, currency and recipient) only within the conservative recovery window.
export async function refreshWorkPayout(db: Database, paypal: PayoutClientSource, scope: PayoutScope, payableId: string): Promise<WorkPayout> {
  assertSandboxFinancialScope(scope);
  authoriseFinancialObligation(scope);
  const payable = await scopedPayable(db, scope, payableId);
  const [payout] = await db.select().from(workPayouts).where(eq(workPayouts.payableId, payable.id));
  if (!payout) throw new Error("No payout has been sent for this payable.");
  return refreshPayout(db, paypal, scope, payout);
}

// The shared reconciliation of one payout row (a work payable's or a tip line's).
async function refreshPayout(db: Database, paypal: PayoutClientSource, scope: PayoutScope, payout: WorkPayout): Promise<WorkPayout> {

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
      await audit(db, scope, "PAYOUT_STATUS_UPDATED", "work_payout", updated.id, obligationOf(updated), { from: payout.status, to: updated.status, paypalStatus: updated.paypalStatus, paypalBatchStatus: updated.paypalBatchStatus, amountError });
    }
    return updated;
  }

  const stale = new Date(Date.now() - STALE_SUBMISSION_MS);
  if (payout.status === "RECONCILIATION_REQUIRED" || (payout.status === "SUBMITTING" && payout.updatedAt < stale)) {
    assertNoBatchRecoveryWindow(payout);
    // A no-batch refresh can create a payment; it must pass the same route gate, using the
    // frozen provider currency and the frozen fact that this payout was an authorised
    // conversion (fxRateMicros present). The rate is never re-read, so a config change cannot
    // change recovery. Known-batch GET reconciliation above stays available for existing obligations.
    await assertPayoutRoute(db, scope, payout.providerCurrency, payout.fxRateMicros !== null);
    const client = payoutClient(paypal);
    const [claimed] = await db.update(workPayouts).set({ status: "SUBMITTING", attempts: sql`${workPayouts.attempts} + 1`, updatedAt: new Date() })
      .where(and(eq(workPayouts.id, payout.id), eq(workPayouts.status, payout.status), payout.status === "SUBMITTING" ? lt(workPayouts.updatedAt, stale) : eq(workPayouts.updatedAt, payout.updatedAt))).returning();
    if (!claimed) {
      const [current] = await db.select().from(workPayouts).where(eq(workPayouts.id, payout.id));
      return current;
    }
    await audit(db, scope, "PAYOUT_RECONCILIATION_REQUESTED", "work_payout", claimed.id, obligationOf(claimed), { attempt: claimed.attempts, senderBatchId: claimed.senderBatchId });
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
    if (reconciled.paypalBatchId && !reconciled.paypalStatus) {
      const [current] = await db.select().from(workPayouts).where(eq(workPayouts.id, reconciled.id));
      return refreshPayout(db, paypal, scope, current);
    }
    return reconciled;
  }
  return payout;
}

// ---------------------------------------------------------------------------------------------
// Tip allocation lines (FS-TIP-AGENT-DEC-001) through this same engine: the same verified route,
// frozen ECB provider leg (prepareWorkPayout), unique reservation and recorded PayPal outcome.
// The line's deterministic share is the amount; the recipient is the staff member's own saved
// destination. At most one payout per line (unique tip_line_id), with sender IDs derived from it.
export const tipPayoutSenderIds = (lineId: string) => {
  const key = lineId.replaceAll("-", "").toUpperCase();
  return { senderBatchId: `FSTP-B-${key}`, senderItemId: `FSTP-I-${key}` };
};

type TipLine = { id: string; organisationId: string; outletId: string; workerId: string; shareMinor: number; currencyCode: string };
type PreparedPayout = Awaited<ReturnType<typeof prepareWorkPayout>>;

// Reserves the line's payout inside the caller's transaction (which holds the line and the staff
// member's day lock), or returns null when one already exists. The approver of record is the Owner
// (FS-TIP-AGENT-DEC-001), recorded as requested_by and, with the basis, in the audit.
export async function reserveTipLinePayout(tx: DatabaseSession, scope: Tenancy, line: TipLine, prepared: PreparedPayout, approver: { userId: string; basis: string }) {
  const now = new Date();
  const [reserved] = await tx.insert(workPayouts).values({
    id: randomUUID(), tipLineId: line.id, organisationId: line.organisationId, outletId: line.outletId, workerId: line.workerId,
    amountMinor: line.shareMinor, currencyCode: line.currencyCode,
    providerCurrency: prepared.providerLeg.providerCurrency, providerAmountMinor: prepared.providerLeg.providerAmountMinor, fxRateMicros: prepared.providerLeg.fxRateMicros, fxRateSource: prepared.providerLeg.fxRateSource,
    recipient: prepared.recipient, ...tipPayoutSenderIds(line.id),
    status: "SUBMITTING", requestedBy: approver.userId, reservedAt: now, updatedAt: now,
  }).onConflictDoNothing({ target: workPayouts.tipLineId }).returning();
  if (!reserved) return null;
  await audit(tx, { userId: null, ...scope, service: "fairshift-pay-agent" }, "PAYOUT_RESERVED", "work_payout", reserved.id, obligationOf(reserved), {
    tipLineId: line.id, approverOfRecord: approver.userId, approverDecision: "FS-TIP-AGENT-DEC-001", approverBasis: approver.basis,
    amountMinor: reserved.amountMinor, currencyCode: reserved.currencyCode, providerAmountMinor: reserved.providerAmountMinor, providerCurrency: reserved.providerCurrency,
    fxRateMicros: reserved.fxRateMicros, fxRateSource: reserved.fxRateSource, senderBatchId: reserved.senderBatchId, senderItemId: reserved.senderItemId,
  });
  return reserved;
}

// Sends a reservation made by reserveTipLinePayout (status SUBMITTING), exactly as a work payout.
export async function sendReservedPayout(db: Database, paypal: PayoutClientSource, scope: Tenancy, payout: WorkPayout) {
  return sendReserved(db, payoutClient(paypal), { userId: null, ...scope, service: "fairshift-pay-agent" }, payout, "FIRST");
}

// Latest provider state of a tip line's payout, through the same reconciliation as a work payout.
export async function refreshTipLinePayout(db: Database, paypal: PayoutClientSource, scope: PayoutScope, lineId: string) {
  assertSandboxFinancialScope(scope);
  if (scope.role !== "OWNER") throw new UserFacingError("tip-owner-only", "Only the Owner manages tip payments.");
  z.uuid().parse(lineId);
  const [payout] = await db.select().from(workPayouts).where(and(eq(workPayouts.tipLineId, lineId), eq(workPayouts.organisationId, scope.organisationId), eq(workPayouts.outletId, scope.locationId)));
  if (!payout) throw new Error("No payout has been sent for this tip line.");
  return refreshPayout(db, paypal, scope, payout);
}
