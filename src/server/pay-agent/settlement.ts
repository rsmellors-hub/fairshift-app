import { assertSandboxOrganisation } from "@/server/config/deployment";
import type { Database, DatabaseSession } from "@/server/db/client";
import { UserFacingError } from "@/server/domain/errors";
import { BASE_PAYABLE_METHOD } from "@/server/domain/work-payable";
import { PaymentDetailsRequiredError, PayoutCurrencyUnsupportedError, prepareWorkPayout, submitConfirmedWorkPayout, type PayoutClientSource } from "@/server/payments/work-payouts";
import type { ConfirmedWorkSettlement, PayAgentIdentity, SettlementAuthority, SettlementResult } from "./contract";
import { loadConfirmedWork, workEvidenceGap, type ConfirmedWorkEvidence } from "./evidence";

// ConfirmedWorkSettlement over the existing payout engine (work-payouts.ts): the same frozen
// ZAR/USD provider leg, verified-route gate, unique reservation, sender IDs and recovery. A
// SETTLE recommendation is only a request to run these gates; it never sets a financial fact.

// Dry-run is ON unless the server's configuration says exactly "false". It is never read from a
// request. While on, every gate is evaluated and the outcome recorded, and then nothing is
// approved, reserved or sent: no PayPal request, no batch, no provider ID, no PAID.
export const PAY_AGENT_DRY_RUN_ENV = "FAIRSHIFT_PAY_AGENT_DRY_RUN";
export function payAgentDryRun(): boolean {
  return process.env[PAY_AGENT_DRY_RUN_ENV] !== "false";
}

export type SettlementCommand = { eventId: string; payableId: string; expectedEvidenceVersion: string; authority: SettlementAuthority };
type Gate = { ok: true; evidence: ConfirmedWorkEvidence; amountMinor: number; currencyCode: string } | { ok: false; code: string };
const blocked = (code: string): Gate => ({ ok: false, code });

// The engine's refusals keep their own codes (e.g. provider-fx-rate-unavailable,
// payout-route-unverified), so the recorded block reason is exactly the engine's reason.
export function settlementCodeOf(error: unknown): string {
  if (error instanceof PaymentDetailsRequiredError) return "payment-details-required";
  if (error instanceof PayoutCurrencyUnsupportedError) return "payout-currency-unsupported";
  if (error instanceof UserFacingError) return error.feedback;
  return "SETTLEMENT_CHECK_FAILED";
}

// Every gate before any provider step, in order: organisation/location scope, authoritative
// manager confirmation of allocated work under accepted terms, the current evidence version,
// no manager rejection, approved compensation (the deterministic payable from preauthorised
// accepted terms, with any required incentive known), an independent releasing manager,
// payout uniqueness, deployment mode, then the engine's own provider checks: the authorised
// frozen FX conversion (DEC-SA-012), a verified provider currency and route, a payable amount
// and the worker's own saved payment destination. No write.
export async function evaluateSettlementGates(db: DatabaseSession, identity: PayAgentIdentity, command: SettlementCommand): Promise<Gate> {
  const evidence = await loadConfirmedWork(db, identity, command.payableId);
  if (!evidence) return blocked("EVIDENCE_UNAVAILABLE");
  const gap = workEvidenceGap(evidence);
  if (gap) return blocked(gap);
  if (evidence.evidenceVersion !== command.expectedEvidenceVersion) return blocked("EVIDENCE_STALE");
  if (evidence.managerRejected) return blocked("MANAGER_REJECTED");
  const { payable } = evidence;
  if (payable.calculationMethod !== BASE_PAYABLE_METHOD) return blocked("COMPENSATION_UNVERIFIED");
  if (payable.finalAmountMinor === null) return blocked("PERFORMANCE_REQUIRED");
  if (payable.finalAmountMinor <= 0) return blocked("NOTHING_PAYABLE");
  if (payable.status === "APPROVED" && (payable.approvedAmountMinor !== payable.finalAmountMinor || payable.approvedCurrencyCode !== payable.currencyCode)) return blocked("COMPENSATION_MISMATCH");
  if (command.authority.kind === "MANAGER_RELEASED_HOLD" && evidence.worker?.userId && command.authority.userId === evidence.worker.userId) return blocked("INDEPENDENT_CONFIRMATION_REQUIRED");
  if (evidence.payout) return blocked("PAYOUT_EXISTS");
  try {
    assertSandboxOrganisation(identity.organisationId);
    await prepareWorkPayout(db, identity, { workerId: payable.workerId, amountMinor: payable.finalAmountMinor, currencyCode: payable.currencyCode });
  } catch (error) {
    return blocked(settlementCodeOf(error));
  }
  return { ok: true, evidence, amountMinor: payable.finalAmountMinor, currencyCode: payable.currencyCode };
}

export function confirmedWorkSettlement(db: Database, paypal: PayoutClientSource): ConfirmedWorkSettlement {
  return {
    async settleConfirmedWork(identity, command): Promise<SettlementResult> {
      const dryRun = payAgentDryRun();
      const gate = await evaluateSettlementGates(db, identity, command);
      if (!gate.ok) return { status: "SETTLEMENT_BLOCKED", code: gate.code, dryRun };
      if (dryRun) return { status: "DRY_RUN_ELIGIBLE", dryRun: true };
      // Live settlement, only after an explicit configuration change. The payable is approved under
      // DEC-SA-011's existing authority (the confirming manager, or the manager who released a hold)
      // and reserved through the shared engine, with the evidence re-checked under the row lock.
      const authorisedBy = command.authority.kind === "MANAGER_RELEASED_HOLD" ? command.authority.userId : gate.evidence.payable.confirmedBy!;
      try {
        const { payout, submitted } = await submitConfirmedWorkPayout(db, paypal, {
          organisationId: identity.organisationId, locationId: identity.locationId, authorisedBy, basis: command.authority.kind, payAgentEventId: command.eventId,
          verify: async tx => {
            const current = await loadConfirmedWork(tx, identity, command.payableId);
            if (!current || current.evidenceVersion !== command.expectedEvidenceVersion) throw new UserFacingError("EVIDENCE_STALE", "This work's evidence changed before payment.");
            if (current.managerRejected) throw new UserFacingError("MANAGER_REJECTED", "A manager rejected this payment.");
            const gap = workEvidenceGap(current);
            if (gap) throw new UserFacingError(gap, "This work's authority is incomplete.");
          },
        }, command.payableId);
        return { status: "SETTLEMENT_SUBMITTED", payoutId: payout.id, payoutStatus: payout.status, submitted, dryRun: false };
      } catch (error) {
        const code = settlementCodeOf(error);
        // An unexpected failure is reported to the orchestrator, which records it only after
        // checking whether the shared engine already holds a payout for this payable.
        if (code === "SETTLEMENT_CHECK_FAILED") throw error;
        return { status: "SETTLEMENT_BLOCKED", code, dryRun: false };
      }
    },
  };
}
