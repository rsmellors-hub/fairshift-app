import { createHash } from "node:crypto";
import { and, eq, gt, inArray, lt, ne, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { DatabaseSession } from "@/server/db/client";
import { payAgentEvents, shiftOffers, shifts, workAcceptances, workAllocations, workers, workPayables, workPayouts, workPerformanceResults } from "@/server/db/schema";
import { canonicalJson } from "@/server/domain/canonical-json";
import { worksAt } from "@/server/people/worker-locations";

// Confirmed-work evidence for the FairShift Pay Agent (DEC-SA-011): what a manager confirmed,
// under which preauthorised terms the worker accepted, and what the deterministic payable is.
// Everything is read from persisted records, scoped to one organisation and location; a
// payable outside that scope reads as absent. A missing record is reported as missing, never
// as confirmed, and no performance attribution is inferred: only a stored performance result
// counts. Nothing here calculates, approves or pays money.

export type PayAgentScope = { organisationId: string; locationId: string };

export type MissingFact = "ALLOCATION" | "MANAGER_CONFIRMATION" | "OFFER" | "ACCEPTANCE" | "SHIFT" | "WORKER" | "PERFORMANCE_RESULT";

export type ConfirmedWorkEvidence = {
  organisationId: string;
  locationId: string;
  payableId: string;
  evidenceVersion: string;
  payable: {
    id: string; workerId: string; shiftId: string; offerId: string; allocationId: string; acceptanceId: string;
    status: string; termsVersion: number; calculationMethod: string; earningsModel: string; currencyCode: string;
    rateMinor: number; baseAmountMinor: number; incentiveRequired: boolean; incentiveAmountMinor: number | null;
    // Base plus incentive, or null while a required incentive is still unknown (unknown is not zero).
    finalAmountMinor: number | null;
    approvedAmountMinor: number | null; approvedCurrencyCode: string | null;
    scheduledStartsAt: Date; scheduledEndsAt: Date; confirmedAt: Date; confirmedBy: string | null;
  };
  allocation: { id: string; state: string; confirmedAt: Date | null } | null;
  offer: { id: string; status: string } | null;
  acceptance: { id: string; termsVersion: number; acceptedAt: Date; acknowledged: boolean } | null;
  shift: { id: string; status: string; termsVersion: number; startsAt: Date; endsAt: Date } | null;
  // userId is internal (independent-confirmation check) and never reaches the model.
  // worksHere: the worker is active at the payable's location, their main one or another they were added
  // to (12 Nov 2026), by the same rule the schedule offers work with (worksAt).
  worker: { id: string; status: string; locationId: string | null; workerType: string; userId: string | null; worksHere: boolean } | null;
  performance: { id: string; salesCount: number; salesMinor: number; targetMinor: number; bonusMinor: number; earnedMinor: number; evidenceProvenance: string; confirmedAt: Date } | null;
  payout: { id: string; status: string } | null;
  // A manager has rejected a Pay Agent hold for this payable: it stays unpaid.
  managerRejected: boolean;
  missing: MissingFact[];
  // Day 6, Step 1g: other confirmed work by the same person (the same account, at any location of this
  // business) whose scheduled time overlaps this payable's. Context for the model's judgement, not part
  // of the evidence version: another payable changing never makes this one stale.
  overlappingConfirmedWork: number;
};

const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null);
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

// The evidence version is the SHA-256 of the canonical JSON (sorted keys) of exactly these
// persisted fields, so it changes whenever authority, work or entitlement evidence changes:
//   payable:     id, organisation_id, outlet_id, shift_id, worker_id, offer_id, allocation_id,
//                acceptance_id, terms_version, calculation_method, earnings_model, currency_code,
//                rate_minor, scheduled_starts_at, scheduled_ends_at, base_amount_minor,
//                confirmed_at, confirmed_by, incentive_required, incentive_amount_minor,
//                performance_result_id
//   allocation:  id, offer_id, acceptance_id, state, confirmed_at
//   offer:       id, shift_id, worker_id, status
//   shift:       id, outlet_id, terms_version, status, starts_at, ends_at
//   acceptance:  id, offer_id, worker_id, terms_version
//   worker:      id, organisation_id, location_id, status
//   performance: id, sales_count, sales_minor, target_minor, bonus_minor, earned_minor,
//                evidence_provenance, confirmed_at
// A missing record contributes null. Deliberately excluded: the payable's status and approval
// columns, every payout row, the worker's payment destination and every updated_at, because
// settlement itself changes them; those are checked freshly by the settlement gates instead.
export const EVIDENCE_VERSION_SCHEME = 1;
export function evidenceVersionOf(input: {
  payable: typeof workPayables.$inferSelect;
  allocation: typeof workAllocations.$inferSelect | null;
  offer: typeof shiftOffers.$inferSelect | null;
  shift: typeof shifts.$inferSelect | null;
  acceptance: Pick<typeof workAcceptances.$inferSelect, "id" | "offerId" | "workerId" | "termsVersion"> | null;
  worker: Pick<typeof workers.$inferSelect, "id" | "organisationId" | "locationId" | "status"> | null;
  performance: typeof workPerformanceResults.$inferSelect | null;
}) {
  const { payable: p, allocation: a, offer: o, shift: s, acceptance: c, worker: w, performance: r } = input;
  return sha256(canonicalJson({
    scheme: EVIDENCE_VERSION_SCHEME,
    payable: {
      id: p.id, organisationId: p.organisationId, outletId: p.outletId, shiftId: p.shiftId, workerId: p.workerId, offerId: p.offerId,
      allocationId: p.allocationId, acceptanceId: p.acceptanceId, termsVersion: p.termsVersion, calculationMethod: p.calculationMethod,
      earningsModel: p.earningsModel, currencyCode: p.currencyCode, rateMinor: p.rateMinor, scheduledStartsAt: iso(p.scheduledStartsAt),
      scheduledEndsAt: iso(p.scheduledEndsAt), baseAmountMinor: p.baseAmountMinor, confirmedAt: iso(p.confirmedAt), confirmedBy: p.confirmedBy,
      incentiveRequired: p.incentiveRequired, incentiveAmountMinor: p.incentiveAmountMinor, performanceResultId: p.performanceResultId,
    },
    allocation: a ? { id: a.id, offerId: a.offerId, acceptanceId: a.acceptanceId, state: a.state, confirmedAt: iso(a.confirmedAt) } : null,
    offer: o ? { id: o.id, shiftId: o.shiftId, workerId: o.workerId, status: o.status } : null,
    shift: s ? { id: s.id, outletId: s.outletId, termsVersion: s.termsVersion, status: s.status, startsAt: iso(s.startsAt), endsAt: iso(s.endsAt) } : null,
    acceptance: c ? { id: c.id, offerId: c.offerId, workerId: c.workerId, termsVersion: c.termsVersion } : null,
    worker: w ? { id: w.id, organisationId: w.organisationId, locationId: w.locationId, status: w.status } : null,
    performance: r ? {
      id: r.id, salesCount: r.salesCount, salesMinor: r.salesMinor, targetMinor: r.targetMinor, bonusMinor: r.bonusMinor,
      earnedMinor: r.earnedMinor, evidenceProvenance: r.evidenceProvenance, confirmedAt: iso(r.confirmedAt),
    } : null,
  }));
}

// One validated evidence object for a payable, or null when it is absent or out of scope.
export async function loadConfirmedWork(db: DatabaseSession, scope: PayAgentScope, payableId: string): Promise<ConfirmedWorkEvidence | null> {
  if (!z.uuid().safeParse(payableId).success) return null;
  const [payable] = await db.select().from(workPayables).where(and(
    eq(workPayables.id, payableId), eq(workPayables.organisationId, scope.organisationId), eq(workPayables.outletId, scope.locationId),
  ));
  if (!payable) return null;
  const [allocation] = await db.select().from(workAllocations).where(and(eq(workAllocations.id, payable.allocationId), eq(workAllocations.offerId, payable.offerId)));
  const [offer] = await db.select().from(shiftOffers).where(and(eq(shiftOffers.id, payable.offerId), eq(shiftOffers.shiftId, payable.shiftId), eq(shiftOffers.workerId, payable.workerId)));
  const [shift] = await db.select().from(shifts).where(and(eq(shifts.id, payable.shiftId), eq(shifts.outletId, scope.locationId)));
  const [acceptance] = await db.select({ id: workAcceptances.id, offerId: workAcceptances.offerId, workerId: workAcceptances.workerId, termsVersion: workAcceptances.termsVersion, acceptedAt: workAcceptances.acceptedAt, snapshot: workAcceptances.snapshot })
    .from(workAcceptances).where(and(eq(workAcceptances.id, payable.acceptanceId), eq(workAcceptances.offerId, payable.offerId), eq(workAcceptances.workerId, payable.workerId)));
  // Never the worker's name, contact details or payment destination.
  const [worker] = await db.select({ id: workers.id, organisationId: workers.organisationId, locationId: workers.locationId, status: workers.status, workerType: workers.workerType, userId: workers.userId,
    worksHere: sql<boolean>`${worksAt(scope.locationId)}` })
    .from(workers).where(and(eq(workers.id, payable.workerId), eq(workers.organisationId, scope.organisationId)));
  const [performance] = payable.performanceResultId ? await db.select().from(workPerformanceResults).where(and(
    eq(workPerformanceResults.id, payable.performanceResultId), eq(workPerformanceResults.allocationId, payable.allocationId),
    eq(workPerformanceResults.organisationId, scope.organisationId), eq(workPerformanceResults.outletId, scope.locationId),
  )) : [];
  const [payout] = await db.select({ id: workPayouts.id, status: workPayouts.status }).from(workPayouts).where(eq(workPayouts.payableId, payable.id));
  const [rejection] = await db.select({ id: payAgentEvents.id }).from(payAgentEvents)
    .where(and(eq(payAgentEvents.payableId, payable.id), eq(payAgentEvents.status, "HOLD_REJECTED"))).limit(1);
  // The same person's worker records in this business: one account has one record, so a second
  // identity at another location shows up by the same email or telephone. Never sent to the model.
  const [contact] = await db.select({ email: workers.email, telephone: workers.telephone }).from(workers).where(eq(workers.id, payable.workerId));
  const digits = (value: string | null | undefined) => (value ?? "").replace(/\D/g, "");
  const sameperson = (await db.select({ id: workers.id }).from(workers).where(and(eq(workers.organisationId, scope.organisationId), or(eq(workers.id, payable.workerId),
    contact?.email ? sql`lower(${workers.email}) = lower(${contact.email})` : undefined,
    digits(contact?.telephone).length >= 6 ? sql`regexp_replace(coalesce(${workers.telephone}, ''), '[^0-9]', '', 'g') = ${digits(contact?.telephone)}` : undefined)))).map(row => row.id);
  const [{ overlapping }] = await db.select({ overlapping: sql<number>`count(*)`.mapWith(Number) }).from(workPayables)
    .where(and(eq(workPayables.organisationId, scope.organisationId), inArray(workPayables.workerId, sameperson.length ? sameperson : [payable.workerId]), ne(workPayables.id, payable.id),
      lt(workPayables.scheduledStartsAt, payable.scheduledEndsAt), gt(workPayables.scheduledEndsAt, payable.scheduledStartsAt)));

  const missing: MissingFact[] = [];
  if (!allocation) missing.push("ALLOCATION");
  if (!allocation?.confirmedAt || !payable.confirmedBy) missing.push("MANAGER_CONFIRMATION");
  if (!offer) missing.push("OFFER");
  if (!acceptance) missing.push("ACCEPTANCE");
  if (!shift) missing.push("SHIFT");
  if (!worker) missing.push("WORKER");
  if (payable.incentiveRequired && !performance) missing.push("PERFORMANCE_RESULT");
  const incentiveKnown = !payable.incentiveRequired || payable.incentiveAmountMinor !== null;
  const finalAmount = payable.baseAmountMinor + (payable.incentiveAmountMinor ?? 0);
  return {
    organisationId: scope.organisationId, locationId: scope.locationId, payableId: payable.id,
    evidenceVersion: evidenceVersionOf({ payable, allocation: allocation ?? null, offer: offer ?? null, shift: shift ?? null, acceptance: acceptance ?? null, worker: worker ?? null, performance: performance ?? null }),
    payable: {
      id: payable.id, workerId: payable.workerId, shiftId: payable.shiftId, offerId: payable.offerId, allocationId: payable.allocationId, acceptanceId: payable.acceptanceId,
      status: payable.status, termsVersion: payable.termsVersion, calculationMethod: payable.calculationMethod, earningsModel: payable.earningsModel,
      currencyCode: payable.currencyCode, rateMinor: payable.rateMinor, baseAmountMinor: payable.baseAmountMinor, incentiveRequired: payable.incentiveRequired,
      incentiveAmountMinor: payable.incentiveAmountMinor, finalAmountMinor: incentiveKnown && Number.isSafeInteger(finalAmount) ? finalAmount : null,
      approvedAmountMinor: payable.approvedAmountMinor, approvedCurrencyCode: payable.approvedCurrencyCode,
      scheduledStartsAt: payable.scheduledStartsAt, scheduledEndsAt: payable.scheduledEndsAt, confirmedAt: payable.confirmedAt, confirmedBy: payable.confirmedBy,
    },
    allocation: allocation ? { id: allocation.id, state: allocation.state, confirmedAt: allocation.confirmedAt } : null,
    offer: offer ? { id: offer.id, status: offer.status } : null,
    acceptance: acceptance ? { id: acceptance.id, termsVersion: acceptance.termsVersion, acceptedAt: acceptance.acceptedAt, acknowledged: (acceptance.snapshot as { acknowledged?: unknown } | null)?.acknowledged === true } : null,
    shift: shift ? { id: shift.id, status: shift.status, termsVersion: shift.termsVersion, startsAt: shift.startsAt, endsAt: shift.endsAt } : null,
    worker: worker ? { id: worker.id, status: worker.status, locationId: worker.locationId, workerType: worker.workerType, userId: worker.userId, worksHere: !!worker.worksHere } : null,
    performance: performance ? {
      id: performance.id, salesCount: performance.salesCount, salesMinor: performance.salesMinor, targetMinor: performance.targetMinor,
      bonusMinor: performance.bonusMinor, earnedMinor: performance.earnedMinor, evidenceProvenance: performance.evidenceProvenance, confirmedAt: performance.confirmedAt,
    } : null,
    payout: payout ?? null,
    managerRejected: !!rejection,
    missing,
    overlappingConfirmedWork: overlapping,
  };
}

export type WorkEvidenceGap =
  | "COMPLETION_REQUIRED" | "INDEPENDENT_CONFIRMATION_REQUIRED" | "ALLOCATION_REQUIRED"
  | "ACCEPTANCE_REQUIRED" | "TERMS_REQUIRED" | "WORKER_NOT_ELIGIBLE" | "EVIDENCE_INVALID";

// The authority DEC-SA-011 rests on, as exact existing rules (no tolerances): the payable's
// allocation is still allocated and was confirmed by an identified manager who is not the
// worker, the offer was accepted, the acceptance is of the payable's terms version, and the
// worker is active at this location.
export function workEvidenceGap(evidence: ConfirmedWorkEvidence): WorkEvidenceGap | null {
  const { payable, allocation, offer, acceptance, shift, worker } = evidence;
  if (!allocation?.confirmedAt || allocation.confirmedAt.getTime() !== payable.confirmedAt.getTime() || !payable.confirmedBy) return "COMPLETION_REQUIRED";
  if (worker?.userId && worker.userId === payable.confirmedBy) return "INDEPENDENT_CONFIRMATION_REQUIRED";
  if (allocation.state !== "ALLOCATED") return "ALLOCATION_REQUIRED";
  if (!offer || offer.status !== "ACCEPTED") return "ACCEPTANCE_REQUIRED";
  if (!acceptance || acceptance.termsVersion !== payable.termsVersion) return "TERMS_REQUIRED";
  if (!worker || worker.status !== "ACTIVE" || !worker.worksHere) return "WORKER_NOT_ELIGIBLE";
  if (!shift) return "EVIDENCE_INVALID";
  return null;
}

export type PreModelOutcome = { status: "SKIPPED" | "BLOCKED"; code: "PAYOUT_EXISTS" | "NOTHING_PAYABLE" | "MANAGER_REJECTED" | "PERFORMANCE_REQUIRED" | WorkEvidenceGap };

// Deterministic outcomes that need no model: a payout the shared engine already owns, a
// manager's rejection, incomplete authority, an unknown incentive or nothing to pay.
export function preModelCheck(evidence: ConfirmedWorkEvidence): PreModelOutcome | null {
  if (evidence.payout) return { status: "SKIPPED", code: "PAYOUT_EXISTS" };
  if (evidence.managerRejected) return { status: "BLOCKED", code: "MANAGER_REJECTED" };
  const gap = workEvidenceGap(evidence);
  if (gap) return { status: "BLOCKED", code: gap };
  if (evidence.payable.finalAmountMinor === null) return { status: "BLOCKED", code: "PERFORMANCE_REQUIRED" };
  if (evidence.payable.finalAmountMinor <= 0) return { status: "SKIPPED", code: "NOTHING_PAYABLE" };
  return null;
}

const minutesBetween = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / 60_000);
// The normal manager confirmation window: within 24 hours of the scheduled end. Server-computed
// context for the model's judgement (the model once misread 850 minutes as over 24 hours); it is
// not a payment rule and decides nothing by itself.
export const NORMAL_CONFIRMATION_WINDOW_MINUTES = 24 * 60;
export function confirmationTiming(scheduledEndsAt: Date, confirmedAt: Date) {
  const minutes = minutesBetween(scheduledEndsAt, confirmedAt);
  return { minutesAfterScheduledEnd: minutes, hoursAfterScheduledEnd: Math.round(minutes / 6) / 10, withinNormalConfirmationWindow: minutes <= NORMAL_CONFIRMATION_WINDOW_MINUTES };
}

// What the model may see: the payable ID, the evidence version and work facts. No names,
// contact details, payment destination, amounts, currency, rates or funding configuration.
export function modelView(evidence: ConfirmedWorkEvidence) {
  const { payable, allocation, acceptance, shift, performance } = evidence;
  return {
    payableId: evidence.payableId,
    evidenceVersion: evidence.evidenceVersion,
    acceptedSchedule: { start: iso(payable.scheduledStartsAt), end: iso(payable.scheduledEndsAt), minutes: minutesBetween(payable.scheduledStartsAt, payable.scheduledEndsAt) },
    shiftRecord: shift ? { start: iso(shift.startsAt), end: iso(shift.endsAt), minutes: minutesBetween(shift.startsAt, shift.endsAt), status: shift.status, termsVersion: shift.termsVersion } : null,
    terms: { earningsModel: payable.earningsModel, payableTermsVersion: payable.termsVersion, acceptedTermsVersion: acceptance?.termsVersion ?? null, acceptanceAcknowledged: acceptance?.acknowledged ?? null },
    allocation: allocation ? { state: allocation.state, confirmedAt: iso(allocation.confirmedAt) } : null,
    managerConfirmation: { confirmedAt: iso(payable.confirmedAt), ...confirmationTiming(payable.scheduledEndsAt, payable.confirmedAt), confirmerRecorded: payable.confirmedBy !== null },
    incentive: { required: payable.incentiveRequired, resolved: payable.finalAmountMinor !== null },
    performance: performance ? { salesCount: performance.salesCount, evidenceProvenance: performance.evidenceProvenance, confirmedAt: iso(performance.confirmedAt) } : null,
    missing: evidence.missing,
    // Facts FairShift computed for the model to judge (Day 6, Step 1g). The rules above don't hold on these.
    anomalyChecks: {
      // Minutes the payable's accepted schedule runs beyond the shift record (negative: shorter).
      payableMinutesBeyondShiftRecord: shift ? minutesBetween(payable.scheduledStartsAt, payable.scheduledEndsAt) - minutesBetween(shift.startsAt, shift.endsAt) : null,
      // Other confirmed work by the same person, at any location of this business, at an overlapping time.
      overlappingConfirmedWork: evidence.overlappingConfirmedWork,
    },
  };
}
