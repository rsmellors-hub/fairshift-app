import { z } from "zod";

// Square's Locations, Team, Payments and Refunds APIs, called directly over HTTPS. The host
// is fixed to Square Sandbox, so a production token cannot reach production through this
// client. Tokens pass through and are never logged; failures carry a code, not provider text.
// A response that does not match is an error, never an empty result.
const SANDBOX_BASE = "https://connect.squareupsandbox.com";
const SQUARE_VERSION = "2026-09-16";
const TIMEOUT_MS = 20_000;
export const SQUARE_PAGE_SIZE = 100;
// Square's documented test source for a successful Sandbox card payment.
const SANDBOX_CARD_SOURCE = "cnon:card-nonce-ok";

export type SquareFailure = "AUTH_REJECTED" | "SCOPE_MISSING" | "RATE_LIMITED" | "PROVIDER_UNAVAILABLE" | "MALFORMED_RESPONSE" | "HISTORY_TOO_LARGE" | "IDEMPOTENCY_REJECTED" | "PAYMENT_REJECTED";
export class SquareError extends Error {
  constructor(readonly code: SquareFailure) { super(`Square request failed: ${code}`); this.name = "SquareError"; }
}

const locationSchema = z.object({ id: z.string().min(1), merchant_id: z.string().min(1), status: z.string(), currency: z.string() });
const memberSchema = z.object({ id: z.string().min(1), status: z.string(), is_owner: z.boolean().optional(), given_name: z.string().optional(), family_name: z.string().optional() });
const createdPaymentSchema = z.object({ payment: z.object({ id: z.string().min(1), status: z.string() }) });

export type SquareLocation = z.infer<typeof locationSchema>;
export type SquareTeamMember = { id: string; name: string };
export type SquarePage = { items: unknown[]; cursor: string | null };
export type SquareWindowQuery = { locationId: string; beginTime: string; cursor?: string };
export interface SquareClient {
  locations(token: string): Promise<SquareLocation[]>;
  teamMembers(token: string, locationId: string): Promise<SquareTeamMember[]>;
  payments(token: string, query: SquareWindowQuery): Promise<SquarePage>;
  refunds(token: string, query: SquareWindowQuery): Promise<SquarePage>;
  createSandboxPayment(token: string, input: { idempotencyKey: string; locationId: string; teamMemberId: string; amountMinor: number; currencyCode: string }): Promise<{ id: string; status: string }>;
}

const errorBody = z.object({ errors: z.array(z.object({ code: z.string() })).min(1) });
async function request(fetchImpl: typeof fetch, token: string, path: string, init: RequestInit = {}) {
  let response: Response;
  try {
    response = await fetchImpl(`${SANDBOX_BASE}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Square-Version": SQUARE_VERSION, "Content-Type": "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch { throw new SquareError("PROVIDER_UNAVAILABLE"); }
  if (!response.ok) {
    if (response.status === 401) throw new SquareError("AUTH_REJECTED");
    if (response.status === 403) throw new SquareError("SCOPE_MISSING");
    if (response.status === 429) throw new SquareError("RATE_LIMITED");
    if (response.status >= 500 || init.method !== "POST") throw new SquareError("PROVIDER_UNAVAILABLE");
    const body = errorBody.safeParse(await response.json().catch(() => null));
    throw new SquareError(body.success && body.data.errors.some(error => error.code === "IDEMPOTENCY_KEY_REUSED") ? "IDEMPOTENCY_REJECTED" : "PAYMENT_REJECTED");
  }
  try { return await response.json(); } catch { throw new SquareError("MALFORMED_RESPONSE"); }
}
function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new SquareError("MALFORMED_RESPONSE");
  return result.data;
}
const memberName = (member: z.infer<typeof memberSchema>) => [member.given_name, member.family_name].filter(Boolean).join(" ") || "Unnamed team member";

export function createSquareClient(fetchImpl: typeof fetch = fetch): SquareClient {
  const listPage = async (token: string, path: string, key: string, query: SquareWindowQuery): Promise<SquarePage> => {
    const params = new URLSearchParams({ location_id: query.locationId, begin_time: query.beginTime, sort_order: "ASC" });
    if (key === "payments") params.set("limit", String(SQUARE_PAGE_SIZE));
    if (query.cursor) params.set("cursor", query.cursor);
    const value = parsed(z.object({ cursor: z.string().min(1).optional() }).catchall(z.unknown()), await request(fetchImpl, token, `${path}?${params}`));
    // Square omits an empty list, so absence is the only way it reports none.
    const items = value[key] === undefined ? [] : parsed(z.array(z.unknown()), value[key]);
    return { items, cursor: value.cursor ?? null };
  };
  return {
    async locations(token) {
      return parsed(z.object({ locations: z.array(locationSchema).default([]) }), await request(fetchImpl, token, "/v2/locations")).locations;
    },
    async teamMembers(token, locationId) {
      const members: SquareTeamMember[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const value = parsed(z.object({ team_members: z.array(memberSchema).default([]), cursor: z.string().min(1).optional() }), await request(fetchImpl, token, "/v2/team-members/search", {
          method: "POST", body: JSON.stringify({ query: { filter: { location_ids: [locationId], status: "ACTIVE" } }, limit: SQUARE_PAGE_SIZE, ...(cursor ? { cursor } : {}) }),
        }));
        // The seller's own record is not a worker's identity. Names are read to show the
        // manager what they are choosing, and are not stored.
        members.push(...value.team_members.filter(member => member.status === "ACTIVE" && !member.is_owner).map(member => ({ id: member.id, name: memberName(member) })));
        if (!value.cursor) return members;
        if (value.cursor === cursor) throw new SquareError("MALFORMED_RESPONSE");
        cursor = value.cursor;
      }
      throw new SquareError("HISTORY_TOO_LARGE");
    },
    payments: (token, query) => listPage(token, "/v2/payments", "payments", query),
    refunds: (token, query) => listPage(token, "/v2/refunds", "refunds", query),
    async createSandboxPayment(token, input) {
      const value = await request(fetchImpl, token, "/v2/payments", { method: "POST", body: JSON.stringify({
        idempotency_key: input.idempotencyKey, source_id: SANDBOX_CARD_SOURCE, autocomplete: true, location_id: input.locationId, team_member_id: input.teamMemberId,
        amount_money: { amount: input.amountMinor, currency: input.currencyCode },
      }) });
      return parsed(createdPaymentSchema, value).payment;
    },
  };
}
