import { sandboxOrganisationId } from "@/server/config/deployment";
import { getAiConfig, getConfigurationStatus } from "@/server/config/env";
import { AiProviderError, OpenAiStaffingAssessmentProvider, type AssessmentRequest, type AssessmentResponse, type StaffingAssessmentProvider } from "@/server/integrations/openai/staffing-assessment";

// The Pay Agent's model, through the existing OpenAI Responses transport: strict Structured
// Outputs, store:false and the configured OPENAI_MODEL, server-side only.
export const PAY_AGENT_MODEL_TIMEOUT_MS = 30_000;
// The model view is small; anything larger is refused rather than sent.
export const PAY_AGENT_MAX_INPUT_CHARS = 8_000;

// FS-HACK-SA-SUBMISSION-001 authorises OpenAI calls only for the isolated South African demo
// organisation: the configured Sandbox organisation of a hosted Sandbox demo deployment. For
// every other organisation, and whenever AI is not configured, no model is used and the event
// records a retryable MODEL_NOT_CONFIGURED outcome; the payment obligation is unchanged.
export function payAgentModelFor(organisationId: string): StaffingAssessmentProvider | null {
  if (sandboxOrganisationId() !== organisationId) return null;
  if (!getConfigurationStatus().aiConfigured) return null;
  const { OPENAI_API_KEY, OPENAI_MODEL } = getAiConfig();
  return new OpenAiStaffingAssessmentProvider(OPENAI_API_KEY, OPENAI_MODEL, fetch, PAY_AGENT_MODEL_TIMEOUT_MS);
}

// At most one retry, and only for a connection failure before any response arrived. A timeout
// is not retried here: the provider may still have processed it.
export async function requestPayDecision(model: StaffingAssessmentProvider, request: AssessmentRequest): Promise<AssessmentResponse> {
  try { return await model.assess(request); }
  catch (error) {
    if (error instanceof AiProviderError && error.code === "NETWORK_ERROR") return model.assess(request);
    throw error;
  }
}

// Failures worth another attempt later: timeouts, network, rate limits and provider errors.
// A refusal, an incomplete or malformed response, or another HTTP 4xx is terminal.
export function isTransientModelFailure(code: string) {
  return code === "TIMEOUT" || code === "NETWORK_ERROR" || code === "HTTP_429" || /^HTTP_5\d\d$/.test(code);
}
