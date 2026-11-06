import { createHash } from "node:crypto";
import type { StaffingAssessmentProvider } from "@/server/integrations/openai/staffing-assessment";
import {
  completionTriggerSchema, PAY_AGENT_INSTRUCTIONS, payActionJsonSchema, payActionSchema,
  serviceIdentitySchema, settlementEvidenceSchema,
  type AttemptKey, type PayAgentEvidenceReader, type PayAgentIdentity,
  type PayAgentIdentityVerifier, type PayAgentJournal, type PayAgentModelEvidence, type PayAgentResult, type SettlementEvidence,
} from "./contract";
import { evaluateConfirmedWork, payAgentResult } from "./policy";

export type PayAgentDependencies = {
  identityVerifier: PayAgentIdentityVerifier;
  evidenceReader: PayAgentEvidenceReader;
  journal: PayAgentJournal;
  // Reuse the existing Responses transport/configuration; no new live client here.
  model: StaffingAssessmentProvider | null;
};
const fingerprint = (value: object) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function matchesOriginalBinding(original: SettlementEvidence, current: SettlementEvidence) {
  // Include every projected authority/identity/financial field and entitlement
  // version. Only the payout observation and its full evidence version may advance.
  const binding = (evidence: SettlementEvidence) => ({ ...evidence, version: null, payout: null });
  if (fingerprint(binding(current)) !== fingerprint(binding(original))) return false;
  const payoutChanged = fingerprint(current.payout) !== fingerprint(original.payout);
  // A changed full version without a payout change is unexplained; a changed
  // payout without a changed full version is an inconsistent reader projection.
  return current.version === original.version ? !payoutChanged : payoutChanged;
}

export function createPayAgent(deps: PayAgentDependencies) {
  async function read(eventId: string, identity: PayAgentIdentity): Promise<SettlementEvidence | PayAgentResult> {
    let raw: unknown;
    try { raw = await deps.evidenceReader.loadConfirmedWork(eventId, identity); }
    catch { return payAgentResult("EVIDENCE_UNAVAILABLE", "uncertain"); }
    if (raw === null) return payAgentResult("EVIDENCE_UNAVAILABLE");
    const parsed = settlementEvidenceSchema.safeParse(raw);
    if (!parsed.success) return payAgentResult("EVIDENCE_INVALID");
    const evidence = parsed.data;
    if (evidence.eventId !== eventId || evidence.organisationId !== identity.organisationId || evidence.locationId !== identity.locationId) return payAgentResult("UNAUTHORISED");
    return evidence;
  }

  // Future durable completion-event consumer entry point. No worker payout request.
  // There are deliberately no routes, event subscriptions or production adapters.
  async function onConfirmedWork(raw: unknown, credential: unknown): Promise<PayAgentResult> {
    let authenticated: unknown;
    try { authenticated = await deps.identityVerifier.authenticate(credential); }
    catch { return payAgentResult("IDENTITY_UNAVAILABLE"); }
    const identity = serviceIdentitySchema.safeParse(authenticated);
    if (!identity.success) return payAgentResult("UNAUTHORISED");
    const trigger = completionTriggerSchema.safeParse(raw);
    if (!trigger.success) return payAgentResult("INVALID_TRIGGER");
    const evidence = await read(trigger.data.eventId, identity.data);
    if ("status" in evidence) return evidence;
    const preflight = evaluateConfirmedWork(evidence);
    if (preflight.status !== "ready") return preflight;
    if (!deps.model) return payAgentResult("MODEL_NOT_CONFIGURED", "blocked", evidence);
    const key: AttemptKey = { organisationId: evidence.organisationId, locationId: evidence.locationId, payableId: evidence.payableId, version: evidence.version };
    let claim: Awaited<ReturnType<PayAgentJournal["claim"]>>;
    try { claim = await deps.journal.claim(key, { eventId: evidence.eventId, entitlementVersion: evidence.entitlementVersion, evidenceFingerprint: fingerprint(evidence) }); }
    catch { return payAgentResult("JOURNAL_UNAVAILABLE", "uncertain", evidence); }
    if (claim.state === "existing") return claim.result;
    if (claim.state === "busy") return payAgentResult("TRIGGER_PROCESSING", "processing", evidence);

    let result: PayAgentResult;
    let modelEvidence: PayAgentModelEvidence | null = null;
    try {
      const response = await deps.model.assess({
        instructions: PAY_AGENT_INSTRUCTIONS,
        schemaName: "fairshift_pay_agent_action_v1",
        schema: payActionJsonSchema(evidence.payableId),
        // Financial values/identities and arbitrary prose never enter the prompt.
        input: JSON.stringify({ payableId: evidence.payableId, trigger: "manager_confirmed_work", evidenceVersion: evidence.version, evidenceReferences: preflight.evidenceReferences }),
      });
      modelEvidence = { provider: deps.model.provider, configuredModel: deps.model.model, responseModel: response.responseModel, responseId: response.responseId };
      let rawAction: unknown;
      try { rawAction = JSON.parse(response.text); } catch { rawAction = null; }
      const action = payActionSchema.safeParse(rawAction);
      if (!action.success || action.data.payableId !== evidence.payableId) {
        result = payAgentResult("TOOL_REFUSED", "blocked", evidence);
      } else {
        const current = await read(trigger.data.eventId, identity.data);
        if ("status" in current) result = current;
        // Refuse using ORIGINAL references, never another payable's payout evidence.
        else if (!matchesOriginalBinding(evidence, current)) result = payAgentResult("EVIDENCE_CHANGED", "blocked", evidence);
        else {
          const currentState = evaluateConfirmedWork(current);
          // A status-only update for this same entitlement may be reported truthfully.
          if (currentState.status !== "ready") result = currentState;
          // Sole action dispatch: no dynamic lookup, provider call, payout mutation,
          // approval bypass or injectable executor. Integration is a separate package.
          else result = payAgentResult("EXECUTION_DISABLED", "blocked", current);
        }
      }
    } catch {
      // Never persist/echo raw model text, provider errors or credentials.
      result = payAgentResult("MODEL_FAILED", "blocked", evidence);
    }
    try { await deps.journal.finish(key, claim.attemptId, result, modelEvidence); }
    catch { return payAgentResult("JOURNAL_UNAVAILABLE", "uncertain", evidence); }
    return result;
  }
  return { onConfirmedWork };
}
