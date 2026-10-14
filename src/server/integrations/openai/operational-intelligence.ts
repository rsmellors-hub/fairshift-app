import { z } from "zod";

import type { ForecastResult } from "@/server/intelligence/forecast";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

export const aiAssessmentSchema = z.object({
  demandOutlook: z.enum([
    "BELOW_BASELINE",
    "NEAR_BASELINE",
    "ABOVE_BASELINE",
    "UNCERTAIN",
  ]),
  signalQuality: z.enum(["LOW", "MODERATE", "HIGH"]),
  staffingAssessment: z.enum([
    "BASELINE_REASONABLE",
    "REVIEW_UPWARD",
    "REVIEW_DOWNWARD",
    "INSUFFICIENT_EVIDENCE",
  ]),
  summary: z.string().min(1).max(600),
  managerAction: z.string().min(1).max(600),
}).strict();

export type AiAssessment = z.infer<typeof aiAssessmentSchema>;

export type AiAssessmentResult =
  | {
      status: "AVAILABLE";
      provider: "OPENAI";
      model: string;
      assessment: AiAssessment;
    }
  | {
      status: "NOT_CONFIGURED" | "UNAVAILABLE";
      provider: "OPENAI";
      model: string;
    };

export const aiEvidenceSchema = z.object({
  targetDate: z.iso.date(),
  source: z.enum(["PAYPAL_SANDBOX", "DEMO_SEEDED"]),
  forecastMethod: z.string().min(1),
  dataAsOf: z.iso.datetime(),
  forecastSalesMinor: z.number().int().nonnegative(),
  lowerSalesMinor: z.number().int().nonnegative(),
  upperSalesMinor: z.number().int().nonnegative(),
  support: z.enum(["LOW", "MODERATE"]),
  basis: z.enum(["SAME_WEEKDAY", "RECENT_OBSERVED_DAYS"]),
  eligibleDays: z.number().int().positive(),
  eligibleTransactions: z.number().int().positive(),
  selectedEvidenceDays: z.number().int().positive(),
  deterministicRecommendedWorkers: z.number().int().nonnegative(),
  deterministicWorkerDelta: z.number().int(),
  tradingHours: z.number().int().positive(),
  salesMinorPerLabourHour: z.number().int().positive(),
  minimumWorkers: z.number().int().nonnegative(),
  comparisonWorkers: z.number().int().nonnegative(),
  drivers: z.array(z.string()).min(1),
}).strict();

export type AiEvidence = z.infer<typeof aiEvidenceSchema>;

export function buildAiEvidence(result: ForecastResult): AiEvidence | null {
  if (result.status !== "AVAILABLE") return null;

  return aiEvidenceSchema.parse({
    targetDate: result.targetDate,
    source: result.source,
    forecastMethod: result.methodVersion,
    dataAsOf: result.dataAsOf,
    forecastSalesMinor: result.forecastSalesMinor,
    lowerSalesMinor: result.lowerSalesMinor,
    upperSalesMinor: result.upperSalesMinor,
    support: result.support,
    basis: result.basis,
    eligibleDays: result.eligibleDays,
    eligibleTransactions: result.eligibleTransactions,
    selectedEvidenceDays: result.evidence.length,
    deterministicRecommendedWorkers: result.staffing.workers,
    deterministicWorkerDelta: result.staffing.workerDelta,
    tradingHours: result.staffing.policy.tradingHours,
    salesMinorPerLabourHour: result.staffing.policy.salesMinorPerLabourHour,
    minimumWorkers: result.staffing.policy.minimumWorkers,
    comparisonWorkers: result.staffing.policy.comparisonWorkers,
    drivers: result.drivers,
  });
}

const responseEnvelopeSchema = z.object({
  output: z.array(z.object({
    content: z.array(z.object({
      type: z.string(),
      text: z.string().optional(),
    }).passthrough()).optional(),
  }).passthrough()).optional(),
}).passthrough();

function extractOutputText(raw: unknown): string {
  const parsed = responseEnvelopeSchema.parse(raw);

  for (const item of parsed.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && content.text) return content.text;
    }
  }

  throw new Error("OpenAI response contained no output_text.");
}

const SYSTEM_INSTRUCTIONS = `
You are FairShift operational decision support.

Use only the supplied structured evidence.

The deterministic demand forecast and deterministic staffing baseline are
authoritative application evidence. Do not replace the worker count.

Assess:
1. demand outlook,
2. signal quality,
3. whether the deterministic staffing baseline appears reasonable or warrants
   manager review,
4. the most important manager action.

Do not invent weather, events, promotions, refunds, disputes, labour
availability, worker performance or other facts not supplied.

Do not calculate wages, gratuities, incentives or payouts.
Do not hire, fire, rank or discipline workers.
Do not create individual worker quotas.
Human manager judgement remains required.

DEMO_SEEDED means synthetic commercial history and must never be described as
PayPal-verified history.

Return only JSON matching the requested schema.
`.trim();

export async function getAiOperationalAssessment(
  forecast: ForecastResult,
  options: {
    apiKey?: string;
    model?: string;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<AiAssessmentResult> {
  const model = options.model ?? process.env.OPENAI_MODEL ?? "gpt-6-luna";
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;

  const evidence = buildAiEvidence(forecast);
  if (!evidence) {
    return { status: "UNAVAILABLE", provider: "OPENAI", model };
  }

  if (!apiKey) {
    return { status: "NOT_CONFIGURED", provider: "OPENAI", model };
  }

  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    const response = await fetchImpl(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        instructions: SYSTEM_INSTRUCTIONS,
        input: JSON.stringify(evidence),
        text: {
          format: {
            type: "json_schema",
            name: "fairshift_operational_assessment",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                demandOutlook: {
                  type: "string",
                  enum: [
                    "BELOW_BASELINE",
                    "NEAR_BASELINE",
                    "ABOVE_BASELINE",
                    "UNCERTAIN",
                  ],
                },
                signalQuality: {
                  type: "string",
                  enum: ["LOW", "MODERATE", "HIGH"],
                },
                staffingAssessment: {
                  type: "string",
                  enum: [
                    "BASELINE_REASONABLE",
                    "REVIEW_UPWARD",
                    "REVIEW_DOWNWARD",
                    "INSUFFICIENT_EVIDENCE",
                  ],
                },
                summary: { type: "string" },
                managerAction: { type: "string" },
              },
              required: [
                "demandOutlook",
                "signalQuality",
                "staffingAssessment",
                "summary",
                "managerAction",
              ],
            },
          },
        },
      }),
    });

    if (!response.ok) {
      return { status: "UNAVAILABLE", provider: "OPENAI", model };
    }

    const text = extractOutputText(await response.json());
    const assessment = aiAssessmentSchema.parse(JSON.parse(text));

    return {
      status: "AVAILABLE",
      provider: "OPENAI",
      model,
      assessment,
    };
  } catch {
    return { status: "UNAVAILABLE", provider: "OPENAI", model };
  }
}
