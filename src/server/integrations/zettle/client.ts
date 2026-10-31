import { z } from "zod";

// Zettle's OAuth and Purchase APIs, as documented by Zettle. Credentials and tokens
// pass through here and are never logged; failures carry a code, not provider text.
// Hosts are fixed. A response that does not match is an error, never an empty result.
const OAUTH_BASE = "https://oauth.zettle.com";
const PURCHASE_BASE = "https://purchase.izettle.com";
const TIMEOUT_MS = 20_000;
export const ZETTLE_REQUIRED_SCOPE = "READ:PURCHASE";
export const ZETTLE_PAGE_SIZE = 1000;

export type ZettleFailure = "AUTH_REJECTED" | "SCOPE_MISSING" | "RATE_LIMITED" | "PROVIDER_UNAVAILABLE" | "MALFORMED_RESPONSE" | "HISTORY_TOO_LARGE";
export class ZettleError extends Error {
  constructor(readonly code: ZettleFailure) { super(`Zettle request failed: ${code}`); this.name = "ZettleError"; }
}

const tokenSchema = z.object({ access_token: z.string().min(1) });
const merchantSchema = z.object({ organizationUuid: z.string().min(1) });
const pageSchema = z.object({ purchases: z.array(z.unknown()), lastPurchaseHash: z.string().min(1).nullish() });

export type ZettlePage = { purchases: unknown[]; lastPurchaseHash: string | null };
export interface ZettleClient {
  // Exchanges a merchant's API key (assertion grant) for a short-lived access token.
  accessToken(credentials: { clientId: string; apiKey: string }): Promise<string>;
  merchantId(token: string): Promise<string>;
  purchases(token: string, query: { startDate: string; limit: number; lastPurchaseHash?: string }): Promise<ZettlePage>;
}

async function request(fetchImpl: typeof fetch, url: string, init: RequestInit, onStatus: (status: number) => ZettleFailure | null = () => null) {
  let response: Response;
  try { response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }); }
  catch { throw new ZettleError("PROVIDER_UNAVAILABLE"); }
  if (!response.ok) {
    const specific = onStatus(response.status);
    if (specific) throw new ZettleError(specific);
    throw new ZettleError(response.status === 429 ? "RATE_LIMITED" : response.status === 401 ? "AUTH_REJECTED" : "PROVIDER_UNAVAILABLE");
  }
  try { return await response.json(); } catch { throw new ZettleError("MALFORMED_RESPONSE"); }
}
function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ZettleError("MALFORMED_RESPONSE");
  return result.data;
}

export function createZettleClient(fetchImpl: typeof fetch = fetch): ZettleClient {
  return {
    async accessToken({ clientId, apiKey }) {
      const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", client_id: clientId, assertion: apiKey });
      const value = await request(fetchImpl, `${OAUTH_BASE}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body },
        status => status === 400 || status === 401 || status === 403 ? "AUTH_REJECTED" : null);
      return parsed(tokenSchema, value).access_token;
    },
    async merchantId(token) {
      const value = await request(fetchImpl, `${OAUTH_BASE}/users/self`, { headers: { Authorization: `Bearer ${token}` } });
      return parsed(merchantSchema, value).organizationUuid;
    },
    async purchases(token, query) {
      const params = new URLSearchParams({ startDate: query.startDate, limit: String(query.limit) });
      if (query.lastPurchaseHash) params.set("lastPurchaseHash", query.lastPurchaseHash);
      const value = await request(fetchImpl, `${PURCHASE_BASE}/purchases/v2?${params}`, { headers: { Authorization: `Bearer ${token}` } },
        status => status === 403 ? "SCOPE_MISSING" : null);
      const page = parsed(pageSchema, value);
      return { purchases: page.purchases, lastPurchaseHash: page.lastPurchaseHash ?? null };
    },
  };
}
