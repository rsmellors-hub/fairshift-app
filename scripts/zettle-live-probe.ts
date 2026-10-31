import { createHmac } from "node:crypto";
import { pathToFileURL } from "node:url";

import { normaliseZettlePurchases } from "../src/server/commerce/zettle-adapter";
import { createZettleClient, ZETTLE_PAGE_SIZE, ZettleError } from "../src/server/integrations/zettle/client";

// Read-only check of a merchant's real Zettle responses against what the adapter expects.
// It writes nothing to FairShift. Its output is safe to keep as evidence: it reports key
// names, types and counts. Identifiers and names appear only as keyed pseudonyms, stable
// between runs with the same key, so staff identity can be compared without being exposed.
//
//   ZETTLE_CLIENT_ID=... ZETTLE_API_KEY=... pnpm zettle:probe [--days 120]
const OUTLET_PLACEHOLDER = "00000000-0000-4000-8000-000000000000";
const MAX_PAGES = 200;

type Credentials = { clientId: string; apiKey: string };
type Step = { step: string; status: number | "NETWORK_ERROR"; providerError?: string };
type Json = Record<string, unknown>;

function collectShape(value: unknown, path: string, shape: Map<string, Set<string>>, depth = 0) {
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (path) shape.set(path, (shape.get(path) ?? new Set()).add(type));
  if (depth >= 6) return;
  if (Array.isArray(value)) value.forEach(item => collectShape(item, `${path}[]`, shape, depth + 1));
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) collectShape(item, path ? `${path}.${key}` : key, shape, depth + 1);
}
const shapeOf = (...values: unknown[]) => {
  const shape = new Map<string, Set<string>>();
  values.forEach(value => collectShape(value, "", shape));
  return Object.fromEntries([...shape].sort(([a], [b]) => a.localeCompare(b)).map(([path, types]) => [path, [...types].sort().join("|")]));
};

// Provider error codes are short tokens. Anything else may carry account text and is dropped.
const safeErrorCode = (value: unknown) => typeof value === "string" && /^[A-Za-z_:.-]{1,60}$/.test(value) ? value : undefined;

const STEP_NAMES: [RegExp, string][] = [[/\/token$/, "token"], [/\/users\/self$/, "identity"], [/\/purchases\/v2$/, "purchases"]];

function classify(steps: Step[]): string | null {
  const failed = steps.find(step => step.status === "NETWORK_ERROR" || step.status >= 400);
  if (!failed) return null;
  if (failed.status === "NETWORK_ERROR") return `endpoint: ${failed.step} could not be reached`;
  if (failed.step === "token" && failed.providerError === "unsupported_grant_type") return "grant: Zettle refused the grant type";
  if (failed.step === "token" && failed.providerError === "invalid_client") return "credentials: Zettle refused the client ID";
  if (failed.step === "token" && failed.providerError === "invalid_grant") return "credentials: Zettle refused the key or the client ID paired with it";
  if (failed.status === 403) return `scope or account eligibility: ${failed.step} returned 403`;
  if (failed.status === 401) return `credentials: ${failed.step} refused the token`;
  if (failed.status === 429) return `rate limit: ${failed.step} returned 429`;
  if (failed.status >= 500) return `provider: ${failed.step} returned ${failed.status}`;
  return `provider response: ${failed.step} returned ${failed.status}`;
}

const text = (value: unknown) => typeof value === "string" && value.length ? value : null;
const tally = (values: Iterable<string>) => { const counts: Record<string, number> = {}; for (const value of values) counts[value] = (counts[value] ?? 0) + 1; return counts; };

// Evidence for the staff-identity questions. Reports relationships, never the values.
function staffEvidence(purchases: Json[], identity: Json | null, alias: (value: string) => string) {
  const uuidToNames = new Map<string, Map<string, number>>(), nameToUuids = new Map<string, Set<string>>();
  const byId = new Map(purchases.map(purchase => [text(purchase.purchaseUUID1) ?? text(purchase.purchaseUUID), purchase]));
  for (const purchase of purchases) {
    const uuid = text(purchase.userUuid), name = text(purchase.userDisplayName);
    if (uuid) { const names = uuidToNames.get(uuid) ?? new Map<string, number>(); uuidToNames.set(uuid, names); const key = name ? alias(name) : "(no name)"; names.set(key, (names.get(key) ?? 0) + 1); }
    if (uuid && name) nameToUuids.set(name, (nameToUuids.get(name) ?? new Set()).add(uuid));
  }
  const refunds = purchases.filter(purchase => purchase.refund === true || (typeof purchase.amount === "number" && purchase.amount < 0));
  const linked = refunds.map(refund => ({ refund, original: byId.get(text(refund.refundsPurchaseUUID1)) }));
  const originals = linked.filter(link => link.original);
  const staffKeys = [...new Set(purchases.flatMap(purchase => Object.keys(purchase)))].filter(key => /user|staff|operator|employee|cashier|clerk/i.test(key)).sort();
  return {
    staffRelatedKeys: staffKeys,
    purchases: purchases.length,
    withUserUuid: purchases.filter(purchase => text(purchase.userUuid)).length,
    withUserId: purchases.filter(purchase => purchase.userId !== undefined && purchase.userId !== null).length,
    withUserDisplayName: purchases.filter(purchase => text(purchase.userDisplayName)).length,
    distinctUserUuids: uuidToNames.size,
    userUuids: [...uuidToNames].map(([uuid, names]) => ({ user: alias(uuid), namesSeen: Object.fromEntries(names), equalsOrganisationUuid: uuid === text(identity?.organizationUuid), equalsAuthenticatedUserUuid: uuid === text(identity?.uuid) })),
    namesUsedByMoreThanOneUuid: [...nameToUuids.values()].filter(uuids => uuids.size > 1).length,
    refunds: {
      total: refunds.length,
      withUserUuid: refunds.filter(refund => text(refund.userUuid)).length,
      linkedToOriginal: refunds.filter(refund => text(refund.refundsPurchaseUUID1)).length,
      originalInRetrievedWindow: originals.length,
      sameUserUuidAsOriginal: originals.filter(link => text(link.refund.userUuid) && link.refund.userUuid === link.original?.userUuid).length,
      differentUserUuidFromOriginal: originals.filter(link => text(link.refund.userUuid) && text(link.original?.userUuid) && link.refund.userUuid !== link.original?.userUuid).length,
    },
  };
}

export async function runProbe(credentials: Credentials, options: { fetchImpl?: typeof fetch; now?: Date; days?: number } = {}) {
  const fetchImpl = options.fetchImpl ?? fetch, now = options.now ?? new Date(), days = options.days ?? 120;
  const alias = (value: string) => `id_${createHmac("sha256", credentials.apiKey).update(value).digest("hex").slice(0, 10)}`;
  const steps: Step[] = [];
  const bodies: Record<string, unknown[]> = { token: [], identity: [], purchases: [] };

  // Sees responses on their way to the real client, which stays the only caller of Zettle.
  const recording: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const step = STEP_NAMES.find(([pattern]) => pattern.test(path))?.[1] ?? "other";
    let response: Response;
    try { response = await fetchImpl(url, init); }
    catch (error) { steps.push({ step, status: "NETWORK_ERROR" }); throw error; }
    let body: unknown = null;
    try { body = await response.clone().json(); } catch { body = null; }
    const failure = body && typeof body === "object" ? body as Json : {};
    const providerError = response.ok ? undefined : safeErrorCode(failure.error) ?? safeErrorCode(failure.errorType);
    steps.push({ step, status: response.status, ...(providerError ? { providerError } : {}) });
    if (response.ok && step in bodies) bodies[step].push(body);
    return response;
  };

  const client = createZettleClient(recording);
  const purchases: Json[] = [];
  const pagination = { pages: 0, endedOnEmptyPage: false, repeatedHash: false, stoppedWithoutHash: false, reachedPageLimit: false };
  let clientError: string | null = null;
  const startDate = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
  try {
    const token = await client.accessToken(credentials);
    await client.merchantId(token);
    let hash: string | undefined;
    for (;;) {
      if (pagination.pages === MAX_PAGES) { pagination.reachedPageLimit = true; break; }
      const page = await client.purchases(token, { startDate, limit: ZETTLE_PAGE_SIZE, lastPurchaseHash: hash });
      pagination.pages++;
      if (!page.purchases.length) { pagination.endedOnEmptyPage = true; break; }
      purchases.push(...page.purchases as Json[]);
      if (!page.lastPurchaseHash) { pagination.stoppedWithoutHash = true; break; }
      if (page.lastPurchaseHash === hash) { pagination.repeatedHash = true; break; }
      hash = page.lastPurchaseHash;
    }
  } catch (error) {
    if (!(error instanceof ZettleError)) throw error;
    clientError = error.code;
  }

  let adapter: Json = { checked: false };
  if (!clientError) {
    try { const { observations, refundsExcluded } = normaliseZettlePurchases(purchases, OUTLET_PLACEHOLDER); adapter = { checked: true, accepted: true, observations: observations.length, refundsExcluded }; }
    catch (error) { if (!(error instanceof ZettleError)) throw error; adapter = { checked: true, accepted: false, code: error.code }; }
  }
  const tokenBody = bodies.token[0] as Json | undefined, identity = (bodies.identity[0] as Json | undefined) ?? null;
  const times = purchases.map(purchase => text(purchase.timestamp)).filter((value): value is string => value !== null).sort();
  const failure = classify(steps) ?? (clientError ? `implementation or response shape: client reported ${clientError}` : null);
  const paginationClean = pagination.pages === 0 || pagination.endedOnEmptyPage;
  return {
    probedAt: now.toISOString(),
    window: { startDate, days },
    contract: failure === null && adapter.accepted === true && paginationClean ? "READABLE" : "NOT_READABLE",
    failure,
    steps,
    token: tokenBody ? { shape: shapeOf(tokenBody), expiresIn: tokenBody.expires_in ?? null, scope: typeof tokenBody.scope === "string" ? tokenBody.scope : null } : null,
    identity: identity ? { shape: shapeOf(identity) } : null,
    purchasesRead: {
      count: purchases.length, pagination, firstDay: times[0]?.slice(0, 10) ?? null, lastDay: times.at(-1)?.slice(0, 10) ?? null,
      tradingDays: new Set(times.map(time => time.slice(0, 10))).size,
      currencies: tally(purchases.map(purchase => String(purchase.currency))),
      responseEnvelopeKeys: [...new Set(bodies.purchases.flatMap(body => body && typeof body === "object" ? Object.keys(body) : []))].sort(),
      shape: shapeOf(...purchases),
    },
    adapter,
    staff: staffEvidence(purchases, identity, alias),
  };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const clientId = process.env.ZETTLE_CLIENT_ID?.trim(), apiKey = process.env.ZETTLE_API_KEY?.trim();
  if (!clientId || !apiKey) { console.error("ZETTLE_CLIENT_ID and ZETTLE_API_KEY must be set. Nothing was requested."); process.exit(2); }
  const daysFlag = process.argv.indexOf("--days");
  const days = daysFlag > -1 ? Number(process.argv[daysFlag + 1]) : 120;
  if (!Number.isInteger(days) || days < 1) { console.error("--days must be a positive whole number."); process.exit(2); }
  const report = await runProbe({ clientId, apiKey }, { days });
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.contract === "READABLE" ? 0 : 1);
}
