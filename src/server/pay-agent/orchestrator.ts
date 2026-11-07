import { eq } from "drizzle-orm";

import type { Database } from "@/server/db/client";
import { workPayouts } from "@/server/db/schema";
import { AiProviderError, type AssessmentResponse, type StaffingAssessmentProvider } from "@/server/integrations/openai/staffing-assessment";
import {
  completionTriggerSchema, PAY_AGENT_INSTRUCTIONS, PAY_AGENT_SCHEMA_NAME, parsePayDecision, payDecisionJsonSchema, serviceIdentitySchema,
  type ConfirmedWorkSettlement, type PayAgentIdentity, type PayAgentIdentityVerifier, type SettlementResult,
} from "./contract";
import { loadConfirmedWork, modelView, preModelCheck, type ConfirmedWorkEvidence } from "./evidence";
import {
  claimForModel, claimForSettlement, finishClaim, getPayAgentEvent, MAX_MODEL_ATTEMPTS, MODEL_NOT_CONFIGURED_RETRY_SECONDS, recordModelCall,
  RETRY_DELAY_SECONDS, type ClaimFinish, type PayAgentEvent,
} from "./journal";
import { isTransientModelFailure, PAY_AGENT_MAX_INPUT_CHARS, requestPayDecision } from "./model";

// Processes one durable Pay Agent event (DEC-SA-011): authenticate the server-minted service
// identity, claim the event atomically, re-read the persisted evidence, ask the model for one
// bounded recommendation, validate it, and send a SETTLE through the settlement gates. Every
// path ends in a durable journal state; nothing here can mark work paid, and a failure never
// changes the confirmation, the payable or a payout.

export type PayAgentDependencies = {
  db: Database;
  identityVerifier: PayAgentIdentityVerifier;
  // Server configuration only: null when no model is configured or permitted for the organisation.
  model: (organisationId: string) => StaffingAssessmentProvider | null;
  settlement: ConfirmedWorkSettlement;
};

export type PayAgentRun = { eventId: string | null; status: string; outcomeCode: string | null; event: PayAgentEvent | null };

const MODEL_PHASE: ReadonlySet<string> = new Set(["PENDING", "CLAIMED", "FAILED_RETRYABLE", "REJECTED_OUTPUT", "FAILED_TERMINAL"]);
const SETTLEMENT_PHASE: ReadonlySet<string> = new Set(["DECIDED_SETTLE", "HOLD_RELEASED", "SETTLING", "DRY_RUN_ELIGIBLE", "SETTLEMENT_BLOCKED"]);

const fromEvent = (event: PayAgentEvent): PayAgentRun => ({ eventId: event.id, status: event.status, outcomeCode: event.outcomeCode, event });
const refused = (status: string, eventId: string | null = null): PayAgentRun => ({ eventId, status, outcomeCode: null, event: null });

// A retryable failure waits before automatic recovery; after MAX_MODEL_ATTEMPTS model calls it is terminal.
function retryLater(outcomeCode: string, errorClass: string, modelCalls: number, extra: Partial<ClaimFinish> = {}): ClaimFinish {
  if (modelCalls >= MAX_MODEL_ATTEMPTS) return { ...extra, status: "FAILED_TERMINAL", outcomeCode: "ATTEMPTS_EXHAUSTED", errorClass };
  return { ...extra, status: "FAILED_RETRYABLE", outcomeCode, errorClass, retryAfterSeconds: RETRY_DELAY_SECONDS[Math.min(modelCalls, RETRY_DELAY_SECONDS.length - 1)] };
}

function settlementFinish(result: SettlementResult): ClaimFinish {
  switch (result.status) {
    case "DRY_RUN_ELIGIBLE": return { status: "DRY_RUN_ELIGIBLE", outcomeCode: "DRY_RUN_ELIGIBLE", dryRun: true };
    case "SETTLEMENT_BLOCKED": return { status: "SETTLEMENT_BLOCKED", outcomeCode: result.code.slice(0, 64), dryRun: result.dryRun };
    case "SETTLEMENT_SUBMITTED": return { status: "SETTLEMENT_SUBMITTED", outcomeCode: result.submitted ? "PAYOUT_RESERVED" : "PAYOUT_EXISTS", payoutId: result.payoutId, dryRun: result.dryRun };
  }
}

export function createPayAgent(deps: PayAgentDependencies) {
  async function authenticate(credential: unknown): Promise<PayAgentIdentity | null> {
    try {
      const identity = serviceIdentitySchema.safeParse(await deps.identityVerifier.authenticate(credential));
      return identity.success ? identity.data : null;
    } catch { return null; }
  }

  // The current durable state, when this caller could not, or need not, take the event.
  async function current(identity: PayAgentIdentity, eventId: string): Promise<PayAgentRun> {
    const event = await getPayAgentEvent(deps.db, identity, eventId);
    return event ? fromEvent(event) : refused("NOT_FOUND", eventId);
  }

  async function finish(identity: PayAgentIdentity, claimed: PayAgentEvent, values: ClaimFinish): Promise<PayAgentRun> {
    const row = await finishClaim(deps.db, claimed, values);
    // A lost claim means another attempt owns the event: report its state, never ours.
    return row ? fromEvent(row) : current(identity, claimed.id);
  }

  async function readEvidence(identity: PayAgentIdentity, payableId: string): Promise<ConfirmedWorkEvidence | null | "UNREADABLE"> {
    try { return await loadConfirmedWork(deps.db, identity, payableId); } catch { return "UNREADABLE"; }
  }

  async function decide(identity: PayAgentIdentity, event: PayAgentEvent, manual: boolean): Promise<PayAgentRun> {
    const claimed = await claimForModel(deps.db, identity, event.id, { manual });
    if (!claimed) return current(identity, event.id);
    const evidence = await readEvidence(identity, claimed.payableId);
    if (evidence === "UNREADABLE") return finish(identity, claimed, retryLater("EVIDENCE_UNAVAILABLE", "EVIDENCE_READ_FAILED", claimed.modelCallCount));
    if (!evidence) return finish(identity, claimed, { status: "BLOCKED", outcomeCode: "EVIDENCE_UNAVAILABLE" });
    if (evidence.evidenceVersion !== claimed.evidenceVersion) return finish(identity, claimed, { status: "BLOCKED", outcomeCode: "EVIDENCE_STALE" });
    const deterministic = preModelCheck(evidence);
    if (deterministic) return finish(identity, claimed, { status: deterministic.status, outcomeCode: deterministic.code });
    if (claimed.modelCallCount >= MAX_MODEL_ATTEMPTS) return finish(identity, claimed, { status: "FAILED_TERMINAL", outcomeCode: "ATTEMPTS_EXHAUSTED", errorClass: "ATTEMPTS_EXHAUSTED" });
    let model: StaffingAssessmentProvider | null;
    try { model = deps.model(identity.organisationId); } catch { model = null; }
    if (!model) return finish(identity, claimed, { status: "FAILED_RETRYABLE", outcomeCode: "MODEL_NOT_CONFIGURED", errorClass: "NOT_CONFIGURED", retryAfterSeconds: MODEL_NOT_CONFIGURED_RETRY_SECONDS });
    const input = JSON.stringify(modelView(evidence));
    if (input.length > PAY_AGENT_MAX_INPUT_CHARS) return finish(identity, claimed, { status: "FAILED_TERMINAL", outcomeCode: "MODEL_FAILED", errorClass: "INPUT_TOO_LARGE" });
    // Counted before the call, so an interrupted call still counts towards the limit.
    const counted = await recordModelCall(deps.db, claimed);
    if (!counted) return current(identity, claimed.id);
    const configuredModel = model.model.slice(0, 100);

    let response: AssessmentResponse;
    try {
      response = await requestPayDecision(model, { instructions: PAY_AGENT_INSTRUCTIONS, schemaName: PAY_AGENT_SCHEMA_NAME, schema: payDecisionJsonSchema(claimed.payableId), input });
    } catch (error) {
      // A classified code only; never the provider's message or body.
      const code = error instanceof AiProviderError ? error.code : "UNEXPECTED_ERROR";
      return finish(identity, counted, code === "UNEXPECTED_ERROR" || isTransientModelFailure(code)
        ? retryLater("MODEL_FAILED", code, counted.modelCallCount, { configuredModel })
        : { status: "FAILED_TERMINAL", outcomeCode: "MODEL_FAILED", errorClass: code, configuredModel });
    }
    const modelEvidence = { configuredModel, responseModel: response.responseModel.slice(0, 100), responseId: response.responseId ? response.responseId.slice(0, 200) : null };
    const decision = parsePayDecision(response.text, claimed.payableId);
    if (!decision.ok) return finish(identity, counted, { status: "REJECTED_OUTPUT", outcomeCode: "OUTPUT_REJECTED", errorClass: decision.reason, ...modelEvidence });

    // A recommendation applies only to the evidence the model saw.
    const after = await readEvidence(identity, claimed.payableId);
    if (after === "UNREADABLE") return finish(identity, counted, retryLater("EVIDENCE_UNAVAILABLE", "EVIDENCE_READ_FAILED", counted.modelCallCount, modelEvidence));
    if (!after || after.evidenceVersion !== claimed.evidenceVersion) return finish(identity, counted, { status: "BLOCKED", outcomeCode: "EVIDENCE_CHANGED", ...modelEvidence });
    const late = preModelCheck(after);
    if (late) return finish(identity, counted, { status: late.status, outcomeCode: late.code, ...modelEvidence });
    if (decision.decision.action === "hold_for_manager_review") {
      return finish(identity, counted, { status: "DECIDED_HOLD", decision: "HOLD", reasonCode: decision.decision.reasonCode, summary: decision.decision.summary, ...modelEvidence });
    }
    const decided = await finishClaim(deps.db, counted, { status: "DECIDED_SETTLE", decision: "SETTLE", ...modelEvidence });
    if (!decided) return current(identity, claimed.id);
    return settle(identity, decided, false);
  }

  async function settle(identity: PayAgentIdentity, event: PayAgentEvent, manual: boolean): Promise<PayAgentRun> {
    const claimed = await claimForSettlement(deps.db, identity, event.id, { manual });
    if (!claimed) return current(identity, event.id);
    let result: SettlementResult;
    try {
      result = await deps.settlement.settleConfirmedWork(identity, {
        eventId: claimed.id, payableId: claimed.payableId, expectedEvidenceVersion: claimed.evidenceVersion,
        authority: claimed.resolution === "RELEASED" && claimed.resolvedBy ? { kind: "MANAGER_RELEASED_HOLD", userId: claimed.resolvedBy } : { kind: "MANAGER_CONFIRMED_COMPLETION" },
      });
    } catch {
      // A failure is never a payment. If the shared engine holds a payout for this payable, that
      // payout and its existing recovery are the truth; otherwise nothing was reserved.
      const [payout] = await deps.db.select({ id: workPayouts.id, status: workPayouts.status }).from(workPayouts).where(eq(workPayouts.payableId, claimed.payableId));
      result = payout ? { status: "SETTLEMENT_SUBMITTED", payoutId: payout.id, payoutStatus: payout.status, submitted: false, dryRun: false } : { status: "SETTLEMENT_BLOCKED", code: "SETTLEMENT_UNAVAILABLE", dryRun: false };
    }
    return finish(identity, claimed, settlementFinish(result));
  }

  // `manual` is a manager's explicit retry: it may restart a rejected output or terminal model
  // failure (within MAX_MODEL_ATTEMPTS) and re-run the gates after a dry run or a block.
  async function process(raw: unknown, credential: unknown, options: { manual?: boolean } = {}): Promise<PayAgentRun> {
    const identity = await authenticate(credential);
    if (!identity) return refused("UNAUTHORISED");
    const trigger = completionTriggerSchema.safeParse(raw);
    if (!trigger.success) return refused("INVALID_TRIGGER");
    // Scoped read: another organisation's or location's event looks exactly like none.
    const event = await getPayAgentEvent(deps.db, identity, trigger.data.eventId);
    if (!event) return refused("NOT_FOUND", trigger.data.eventId);
    if (SETTLEMENT_PHASE.has(event.status)) return settle(identity, event, !!options.manual);
    if (MODEL_PHASE.has(event.status)) return decide(identity, event, !!options.manual);
    return fromEvent(event);
  }

  return { process };
}
