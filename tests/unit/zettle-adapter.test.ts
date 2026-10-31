import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { credentialKey, openCredentials, sealCredentials } from "@/server/commerce/credentials";
import { normaliseZettlePurchases } from "@/server/commerce/zettle-adapter";
import { createZettleClient, ZettleError } from "@/server/integrations/zettle/client";

const outletId = "20000000-0000-4000-8000-000000000001";
const purchase = (over: Record<string, unknown> = {}) => ({ purchaseUUID1: "589c2de6-3ee4-11eb-9e70-a2ac075b17fd", amount: 70000, currency: "GBP", timestamp: "2026-10-20T14:46:43.592+0000", refund: false, ...over });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("Zettle purchase normalisation", () => {
  it("keeps only canonical facts and accepts Zettle's offset without a colon", () => {
    const { observations, refundsExcluded } = normaliseZettlePurchases([purchase({ userDisplayName: "A Person", products: [{ name: "Thing" }], payments: [{ attributes: { maskedPan: "1234" } }], userId: 7 })], outletId);
    expect(refundsExcluded).toBe(0);
    expect(observations).toEqual([{ outletId, sourceTransactionId: "589c2de6-3ee4-11eb-9e70-a2ac075b17fd", occurredAt: "2026-10-20T14:46:43.592+00:00", currencyCode: "GBP", grossAmountMinor: 70000, status: "COMPLETED" }]);
    expect(JSON.stringify(observations)).not.toMatch(/Person|Thing|1234/);
  });
  it("excludes refunds and counts them rather than netting them or reading them as sales", () => {
    const { observations, refundsExcluded } = normaliseZettlePurchases([purchase(), purchase({ purchaseUUID1: "r1", amount: -70000, refund: true }), purchase({ purchaseUUID1: "r2", amount: -5 })], outletId);
    expect(observations).toHaveLength(1);
    expect(refundsExcluded).toBe(2);
  });
  it("keeps a real zero-value sale distinct from a refund", () => {
    expect(normaliseZettlePurchases([purchase({ amount: 0 })], outletId).observations[0].grossAmountMinor).toBe(0);
  });
  it("falls back to the deprecated identity field only", () => {
    expect(normaliseZettlePurchases([purchase({ purchaseUUID1: undefined, purchaseUUID: "legacy" })], outletId).observations[0].sourceTransactionId).toBe("legacy");
  });
  for (const [name, bad] of [["no identity", purchase({ purchaseUUID1: undefined })], ["decimal amount", purchase({ amount: 1.5 })], ["text amount", purchase({ amount: "10" })], ["missing time", purchase({ timestamp: undefined })], ["time with no offset", purchase({ timestamp: "2026-10-20T14:46:43" })], ["date only", purchase({ timestamp: "2026-10-20" })]] as const) {
    it(`rejects the whole page for ${name}, keeping nothing`, () => {
      expect(() => normaliseZettlePurchases([purchase(), bad], outletId)).toThrow(ZettleError);
    });
  }
});

describe("Zettle client", () => {
  it("uses the assertion grant and requests the purchase list with the documented parameters", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/token")) { const body = init!.body as URLSearchParams; expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer"); expect(body.get("assertion")).toBe("key"); return json({ access_token: "tok", expires_in: 7200 }); }
      expect(new Headers(init!.headers).get("Authorization")).toBe("Bearer tok");
      return json({ purchases: [], lastPurchaseHash: null });
    });
    const client = createZettleClient(fetchImpl as typeof fetch);
    expect(await client.accessToken({ clientId: "c", apiKey: "key" })).toBe("tok");
    await client.purchases("tok", { startDate: "2026-07-01", limit: 1000, lastPurchaseHash: "h" });
    const called = new URL(String(fetchImpl.mock.calls[1][0]));
    expect(called.origin + called.pathname).toBe("https://purchase.izettle.com/purchases/v2");
    expect(Object.fromEntries(called.searchParams)).toEqual({ startDate: "2026-07-01", limit: "1000", lastPurchaseHash: "h" });
  });
  const failing = (status: number) => createZettleClient((async () => new Response("secret provider text", { status })) as typeof fetch);
  it.each([[400, "AUTH_REJECTED"], [401, "AUTH_REJECTED"], [403, "AUTH_REJECTED"], [429, "RATE_LIMITED"], [500, "PROVIDER_UNAVAILABLE"]])("maps a token %i to %s without provider text", async (status, code) => {
    const error = await failing(status).accessToken({ clientId: "c", apiKey: "k" }).catch(e => e);
    expect(error).toBeInstanceOf(ZettleError);
    expect(error.code).toBe(code);
    expect(error.message).not.toContain("secret");
  });
  it("maps a forbidden purchase read to a missing scope", async () => {
    await expect(failing(403).purchases("t", { startDate: "2026-01-01", limit: 1 })).rejects.toMatchObject({ code: "SCOPE_MISSING" });
  });
  it("treats a network failure as unavailable, not as no sales", async () => {
    const client = createZettleClient((async () => { throw new Error("down"); }) as typeof fetch);
    await expect(client.purchases("t", { startDate: "2026-01-01", limit: 1 })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
  it("treats an unreadable or unexpected body as malformed, not as an empty list", async () => {
    await expect(createZettleClient((async () => new Response("<html>")) as typeof fetch).purchases("t", { startDate: "2026-01-01", limit: 1 })).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
    await expect(createZettleClient((async () => json({ items: [] })) as typeof fetch).purchases("t", { startDate: "2026-01-01", limit: 1 })).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
    await expect(createZettleClient((async () => json({})) as typeof fetch).accessToken({ clientId: "c", apiKey: "k" })).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  });
});

describe("sealed merchant credentials", () => {
  const key = randomBytes(32), org = "o", outlet = "l", value = { clientId: "c", apiKey: "very-secret-key" };
  it("round-trips and never contains the key in clear", () => {
    const sealed = sealCredentials(value, key, org, outlet);
    expect(sealed).not.toContain("very-secret-key");
    expect(openCredentials(sealed, key, org, outlet)).toEqual(value);
  });
  it("cannot be opened for another organisation or location, or under another key", () => {
    const sealed = sealCredentials(value, key, org, outlet);
    expect(() => openCredentials(sealed, key, "other", outlet)).toThrow();
    expect(() => openCredentials(sealed, key, org, "other")).toThrow();
    expect(() => openCredentials(sealed, randomBytes(32), org, outlet)).toThrow();
  });
  it("accepts only a 32-byte base64 key", () => {
    expect(credentialKey(randomBytes(32).toString("base64"))).toHaveLength(32);
    for (const bad of ["", "short", randomBytes(16).toString("base64")]) expect(credentialKey(bad)).toBeNull();
  });
});
