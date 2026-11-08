import { z } from "zod";
import { getAiConfig, getConfigurationStatus } from "@/server/config/env";
import { AiProviderError } from "@/server/integrations/openai/staffing-assessment";

// OpenAI Responses API with the web search tool and strict Structured Outputs, for local
// intelligence. One request per run, no follow-up turns: the tool-call ceiling bounds the searches
// inside it. The answer comes back as text for FairShift to validate, with the searches the model
// ran and every page it consulted, which FairShift checks citations against. Nothing is retained by
// the provider for later retrieval.
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

export type DiscoveryRequest = { instructions: string; input: string; schemaName: string; schema: object; maxToolCalls: number;
  userLocation: { country: string | null; city: string | null; region: string | null; timezone: string } | null };
export type DiscoverySearch = { action: "search" | "open_page" | "find_in_page" | "other"; queries: string[]; url: string | null };
export type DiscoveryResponse = { responseId: string | null; responseModel: string; text: string; searches: DiscoverySearch[]; consultedUrls: string[]; citedUrls: string[] };
export interface LocalDiscoveryProvider {
  readonly provider: "OPENAI";
  readonly model: string;
  discover(request: DiscoveryRequest): Promise<DiscoveryResponse>;
}

const actionSchema = z.object({ type: z.string(), query: z.string().nullish(), queries: z.array(z.string()).nullish(), url: z.string().nullish(),
  sources: z.array(z.object({ url: z.string().nullish() }).passthrough()).nullish() }).passthrough();
const envelopeSchema = z.object({
  id: z.string().optional(), model: z.string().min(1), status: z.string().optional(),
  output: z.array(z.object({ type: z.string().optional(), action: actionSchema.nullish(),
    content: z.array(z.object({ type: z.string(), text: z.string().optional(), refusal: z.string().optional(),
      annotations: z.array(z.object({ type: z.string(), url: z.string().nullish() }).passthrough()).optional() }).passthrough()).optional(),
  }).passthrough()).optional(),
}).passthrough();

// ISO 3166 codes for the countries FairShift locations are recorded in; anything else sends no country.
const COUNTRY_CODE: Record<string, string> = { "south africa": "ZA", za: "ZA", "united kingdom": "GB", uk: "GB", england: "GB", wales: "GB", scotland: "GB", "northern ireland": "GB" };
export const countryCode = (country: string | null) => (country && COUNTRY_CODE[country.trim().toLowerCase()]) ?? null;

export class OpenAiWebDiscoveryProvider implements LocalDiscoveryProvider {
  readonly provider = "OPENAI" as const;
  constructor(private readonly apiKey: string, readonly model: string, private readonly fetchImpl: typeof fetch = fetch, private readonly timeoutMs = 180_000) {}

  async discover(request: DiscoveryRequest): Promise<DiscoveryResponse> {
    const location = request.userLocation;
    const code = location ? countryCode(location.country) : null;
    let response: Response;
    try {
      response = await this.fetchImpl(OPENAI_RESPONSES_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          instructions: request.instructions,
          input: request.input,
          tools: [{ type: "web_search", ...(location ? { user_location: { type: "approximate", ...(code ? { country: code } : {}), ...(location.city ? { city: location.city } : {}), ...(location.region ? { region: location.region } : {}), timezone: location.timezone } } : {}) }],
          tool_choice: "required",
          max_tool_calls: request.maxToolCalls,
          include: ["web_search_call.action.sources"],
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
      console.error("OpenAI local intelligence request failed", { status: response.status });
      throw new AiProviderError(`HTTP_${response.status}`);
    }
    let envelope: z.infer<typeof envelopeSchema>;
    try { envelope = envelopeSchema.parse(await response.json()); } catch { throw new AiProviderError("MALFORMED_RESPONSE"); }
    if (envelope.status && envelope.status !== "completed") throw new AiProviderError("INCOMPLETE");
    const output = envelope.output ?? [];
    const contents = output.flatMap(item => item.content ?? []);
    if (contents.some(content => content.type === "refusal")) throw new AiProviderError("REFUSAL");
    const text = contents.find(content => content.type === "output_text" && content.text)?.text;
    if (!text) throw new AiProviderError("MALFORMED_RESPONSE");
    return { responseId: envelope.id ?? null, responseModel: envelope.model, text, ...searchesOf(output) };
  }
}

// What the search did, from the provider's own record of it.
export function searchesOf(output: readonly { type?: string; action?: z.infer<typeof actionSchema> | null; content?: { annotations?: { type: string; url?: string | null }[] }[] }[]) {
  const searches: DiscoverySearch[] = [], consulted = new Set<string>(), cited = new Set<string>();
  for (const item of output) {
    if (item.type === "web_search_call" && item.action) {
      const action = item.action;
      const kind = action.type === "search" || action.type === "open_page" || action.type === "find_in_page" ? action.type : "other";
      const queries = [...(action.queries ?? []), ...(action.query ? [action.query] : [])].filter((query, i, all) => query && all.indexOf(query) === i);
      searches.push({ action: kind, queries, url: action.url ?? null });
      for (const source of action.sources ?? []) if (source.url) consulted.add(source.url);
      if (action.url) consulted.add(action.url);
    }
    for (const content of item.content ?? []) for (const annotation of content.annotations ?? []) if (annotation.type === "url_citation" && annotation.url) cited.add(annotation.url);
  }
  return { searches, consultedUrls: [...consulted, ...[...cited].filter(url => !consulted.has(url))], citedUrls: [...cited] };
}

// Null when no AI credentials are configured; local intelligence then runs on feeds and people's entries alone.
export function getLocalDiscoveryProvider(): LocalDiscoveryProvider | null {
  if (!getConfigurationStatus().aiConfigured) return null;
  const config = getAiConfig();
  return new OpenAiWebDiscoveryProvider(config.OPENAI_API_KEY, config.OPENAI_MODEL);
}
