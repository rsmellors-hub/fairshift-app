import { describe, expect, it, vi } from "vitest";
import { normaliseSquarePayments, normaliseSquareRefunds } from "@/server/commerce/square-adapter";
import { squareSandboxCredentials } from "@/server/commerce/square-connection";
import { demoToolsAllowed } from "@/server/commerce/square-demo";
import { createSquareClient, SquareError } from "@/server/integrations/square/client";

const OUTLET = "11111111-1111-4111-8111-111111111111", TOKEN = "fixture-token-not-a-real-secret";
const respond = (status: number, body: unknown) => vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;
const payment = (over: Record<string, unknown> = {}) => ({ id: "P1", status: "COMPLETED", location_id: "L1", created_at: "2026-01-19T10:00:00.000Z", amount_money: { amount: 500, currency: "GBP" }, team_member_id: "TM", ...over });

describe("Square client", () => {
  it("only ever calls Square Sandbox, on the pinned version, with the token in the header", async () => {
    const fetchImpl = respond(200, { payments: [] });
    await createSquareClient(fetchImpl).payments(TOKEN, { locationId: "L1", beginTime: "2026-01-19T00:00:00.000Z" });
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/^https:\/\/connect\.squareupsandbox\.com\/v2\/payments\?/);
    expect(url).toContain("location_id=L1");
    expect(url).not.toContain(TOKEN);
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}`, "Square-Version": "2026-09-16" });
  });
  it.each([[401, "AUTH_REJECTED"], [403, "SCOPE_MISSING"], [429, "RATE_LIMITED"], [500, "PROVIDER_UNAVAILABLE"], [404, "PROVIDER_UNAVAILABLE"]])("reads HTTP %i as %s and carries no provider text or token", async (status, code) => {
    const error = await createSquareClient(respond(status, { errors: [{ code: "X", detail: "provider text" }] })).locations(TOKEN).catch(value => value);
    expect(error).toBeInstanceOf(SquareError);
    expect(error.code).toBe(code);
    expect(String(error.message)).not.toMatch(/provider text|fixture-token/);
  });
  it("reads a refused network or an unreadable response as failure, never as an empty list", async () => {
    const down = vi.fn(async () => { throw new Error("socket"); }) as unknown as typeof fetch;
    await expect(createSquareClient(down).payments(TOKEN, { locationId: "L", beginTime: "x" })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    await expect(createSquareClient(respond(200, "<html>")).payments(TOKEN, { locationId: "L", beginTime: "x" })).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
    await expect(createSquareClient(respond(200, { payments: "nope" })).payments(TOKEN, { locationId: "L", beginTime: "x" })).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
    await expect(createSquareClient(respond(200, { locations: [{ id: "no-merchant" }] })).locations(TOKEN)).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  });
  it("treats Square's omitted list as none, because that is how it reports none", async () => {
    await expect(createSquareClient(respond(200, {})).payments(TOKEN, { locationId: "L", beginTime: "x" })).resolves.toEqual({ items: [], cursor: null });
  });
  it("sends the team member on a Sandbox payment and reports a reused key apart from a refusal", async () => {
    const created = respond(200, { payment: { id: "P9", status: "COMPLETED" } });
    await expect(createSquareClient(created).createSandboxPayment(TOKEN, { idempotencyKey: "k", locationId: "L", teamMemberId: "TM", amountMinor: 101, currencyCode: "GBP" })).resolves.toEqual({ id: "P9", status: "COMPLETED" });
    const body = JSON.parse(String((vi.mocked(created).mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).toEqual({ idempotency_key: "k", source_id: "cnon:card-nonce-ok", autocomplete: true, location_id: "L", team_member_id: "TM", amount_money: { amount: 101, currency: "GBP" } });
    await expect(createSquareClient(respond(400, { errors: [{ code: "IDEMPOTENCY_KEY_REUSED" }] })).createSandboxPayment(TOKEN, { idempotencyKey: "k", locationId: "L", teamMemberId: "TM", amountMinor: 1, currencyCode: "GBP" })).rejects.toMatchObject({ code: "IDEMPOTENCY_REJECTED" });
    await expect(createSquareClient(respond(400, { errors: [{ code: "INVALID_VALUE" }] })).createSandboxPayment(TOKEN, { idempotencyKey: "k", locationId: "L", teamMemberId: "TM", amountMinor: 1, currencyCode: "GBP" })).rejects.toMatchObject({ code: "PAYMENT_REJECTED" });
  });
  it("offers no seller's own record or inactive member as a worker identity", async () => {
    const members = await createSquareClient(respond(200, { team_members: [{ id: "A", status: "ACTIVE", given_name: "Ann", family_name: "Example" }, { id: "O", status: "ACTIVE", is_owner: true }, { id: "I", status: "INACTIVE" }] })).teamMembers(TOKEN, "L");
    expect(members).toEqual([{ id: "A", name: "Ann Example" }]);
  });
});

describe("Square adapter", () => {
  it("keeps only the facts FairShift uses, never the customer's or card's", () => {
    const { observations, evidence } = normaliseSquarePayments([payment({ card_details: { card: { last_4: "4242" } }, buyer_email_address: "person@example.test", note: "worker TM2", reference_id: "TM2", tip_money: { amount: 99, currency: "GBP" } })], OUTLET, "L1");
    expect(observations).toEqual([{ outletId: OUTLET, sourceTransactionId: "P1", occurredAt: "2026-01-19T10:00:00.000Z", currencyCode: "GBP", grossAmountMinor: 500, status: "COMPLETED" }]);
    expect(evidence).toEqual([{ providerPaymentId: "P1", providerLocationId: "L1", providerStatus: "COMPLETED", providerTeamMemberId: "TM" }]);
    expect(JSON.stringify({ observations, evidence })).not.toMatch(/4242|person@|TM2|tip|"99"/);
  });
  it("never takes an identity from a note, reference or metadata", () => {
    const { evidence } = normaliseSquarePayments([payment({ team_member_id: undefined, note: "TM", reference_id: "TM", metadata: { team_member_id: "TM" } })], OUTLET, "L1");
    expect(evidence[0].providerTeamMemberId).toBeNull();
  });
  it.each(["APPROVED", "PENDING", "CANCELED", "FAILED"])("does not treat a %s payment as a sale", status => {
    expect(normaliseSquarePayments([payment({ status })], OUTLET, "L1")).toEqual({ observations: [], evidence: [], notCompleted: 1 });
  });
  it.each([["a missing id", { id: undefined }], ["a text amount", { amount_money: { amount: "5", currency: "GBP" } }], ["a negative amount", { amount_money: { amount: -5, currency: "GBP" } }], ["an unreadable time", { created_at: "yesterday" }], ["another location", { location_id: "L2" }]])("refuses %s rather than guessing", (_name, over) => {
    expect(() => normaliseSquarePayments([payment(over)], OUTLET, "L1")).toThrow(SquareError);
  });
  it("links a refund to its payment and reads no refund identity", () => {
    const [refund] = normaliseSquareRefunds([{ id: "R1", status: "COMPLETED", location_id: "L1", payment_id: "P1", created_at: "2026-01-19T11:00:00Z", amount_money: { amount: 101, currency: "GBP" }, team_member_id: "OTHER" }], "L1");
    expect(refund).toMatchObject({ providerRefundId: "R1", providerPaymentId: "P1", amountMinor: 101 });
    expect(JSON.stringify(refund)).not.toContain("OTHER");
  });
});

describe("Sandbox guards", () => {
  it("demo tools need the explicit flag and a Sandbox connection, whatever the build mode", () => {
    expect(demoToolsAllowed("SANDBOX", "enabled")).toBe(true);
    expect(demoToolsAllowed("SANDBOX", undefined)).toBe(false);
    expect(demoToolsAllowed("SANDBOX", "true")).toBe(false);
    expect(demoToolsAllowed("PRODUCTION", "enabled")).toBe(false);
    expect(demoToolsAllowed(null, "enabled")).toBe(false);
    expect(demoToolsAllowed(undefined, "enabled")).toBe(false);
    vi.stubEnv("NODE_ENV", "production");
    expect(demoToolsAllowed("SANDBOX", "enabled")).toBe(true);
    expect(demoToolsAllowed("SANDBOX", undefined)).toBe(false);
    vi.unstubAllEnvs();
  });
  it("treats anything but the sandbox environment as not configured", () => {
    const ok = { SQUARE_ENVIRONMENT: "sandbox", SQUARE_ACCESS_TOKEN: "t", SQUARE_APPLICATION_ID: "a" };
    expect(squareSandboxCredentials(ok)).toEqual({ applicationId: "a", accessToken: "t" });
    expect(squareSandboxCredentials({ ...ok, SQUARE_ENVIRONMENT: "production" })).toBeNull();
    expect(squareSandboxCredentials({ ...ok, SQUARE_ACCESS_TOKEN: "" })).toBeNull();
    expect(squareSandboxCredentials({})).toBeNull();
  });
});
