import { z } from "zod";

import { getAiConfig, getConfigurationStatus } from "@/server/config/env";

// OpenAI Responses API with strict Structured Outputs. The response body is
// returned as text for FairShift to validate; nothing here trusts its content.
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

export type AiFailureCode = "NOT_CONFIGURED" | "TIMEOUT" | "NETWORK_ERROR" | `HTTP_${number}` | "REFUSAL" | "INCOMPLETE" | "MALFORMED_RESPONSE";
export class AiProviderError extends Error {
  constructor(readonly code: AiFailureCode) { super(`AI provider request failed (${code}).`); this.name = "AiProviderError"; }
}

export type AssessmentRequest = { instructions: string; input: string; schemaName: string; schema: object };
export type AssessmentResponse = { responseId: string | null; responseModel: string; text: string };
export interface StaffingAssessmentProvider {
  readonly provider: "OPENAI";
  readonly model: string;
  assess(request: AssessmentRequest): Promise<AssessmentResponse>;
}

const envelopeSchema = z.object({
  id: z.string().optional(),
  model: z.string().min(1),
  status: z.string().optional(),
  output: z.array(z.object({
    type: z.string().optional(),
    content: z.array(z.object({ type: z.string(), text: z.string().optional(), refusal: z.string().optional() }).passthrough()).optional(),
  }).passthrough()).optional(),
}).passthrough();

export class OpenAiStaffingAssessmentProvider implements StaffingAssessmentProvider {
  readonly provider = "OPENAI" as const;
  constructor(private readonly apiKey: string, readonly model: string, private readonly fetchImpl: typeof fetch = fetch, private readonly timeoutMs = 60_000) {}

  async assess(request: AssessmentRequest): Promise<AssessmentResponse> {
    let response: Response;
    try {
      response = await this.fetchImpl(OPENAI_RESPONSES_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          instructions: request.instructions,
          input: request.input,
          // Planning evidence is not retained by the provider for later retrieval.
          store: false,
          text: { format: { type: "json_schema", name: request.schemaName, strict: true, schema: request.schema } },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new AiProviderError(error instanceof DOMException && error.name === "TimeoutError" ? "TIMEOUT" : "NETWORK_ERROR");
    }
    if (!response.ok) {
      // Status only: provider error bodies are not logged or stored.
      console.error("OpenAI staffing assessment request failed", { status: response.status });
      throw new AiProviderError(`HTTP_${response.status}`);
    }
    let envelope: z.infer<typeof envelopeSchema>;
    try { envelope = envelopeSchema.parse(await response.json()); } catch { throw new AiProviderError("MALFORMED_RESPONSE"); }
    if (envelope.status && envelope.status !== "completed") throw new AiProviderError("INCOMPLETE");
    const contents = (envelope.output ?? []).flatMap(item => item.content ?? []);
    if (contents.some(content => content.type === "refusal")) throw new AiProviderError("REFUSAL");
    const text = contents.find(content => content.type === "output_text" && content.text)?.text;
    if (!text) throw new AiProviderError("MALFORMED_RESPONSE");
    return { responseId: envelope.id ?? null, responseModel: envelope.model, text };
  }
}

// Null when no AI credentials are configured; callers then offer no AI assessment.
export function getStaffingAssessmentProvider(): StaffingAssessmentProvider | null {
  if (!getConfigurationStatus().aiConfigured) return null;
  const config = getAiConfig();
  return new OpenAiStaffingAssessmentProvider(config.OPENAI_API_KEY, config.OPENAI_MODEL);
}
