import { describe, expect, it } from "vitest";
import { runProbe } from "../../scripts/zettle-live-probe";

const API_KEY = "api-key-do-not-print", CLIENT_ID = "client-id-do-not-print", TOKEN = "access-token-do-not-print";
const ORG = "org-uuid-do-not-print", SELF = "self-uuid-do-not-print", STAFF_A = "staff-a-uuid-do-not-print", STAFF_B = "staff-b-uuid-do-not-print";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const sale = (id: string, over: Record<string, unknown> = {}) => ({ purchaseUUID1: id, amount: 1000, currency: "GBP", timestamp: "2026-10-20T14:46:43.592+0000", refund: false, userUuid: STAFF_A, userDisplayName: "Private Person", payments: [{ attributes: { maskedPan: "411111******1111" } }], ...over });

function provider(pages: unknown[][], over: Partial<Record<"token" | "identity" | "purchases", () => Response>> = {}) {
  const queue = [...pages, []];
  return (async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    if (path === "/token") return over.token?.() ?? json({ access_token: TOKEN, expires_in: 7200, scope: "READ:PURCHASE" });
    if (path === "/users/self") return over.identity?.() ?? json({ uuid: SELF, organizationUuid: ORG });
    if (over.purchases) return over.purchases();
    const next = queue.shift() ?? [];
    return json({ purchases: next, lastPurchaseHash: next.length ? `hash-${queue.length}` : null });
  }) as typeof fetch;
}
const probe = (fetchImpl: typeof fetch) => runProbe({ clientId: CLIENT_ID, apiKey: API_KEY }, { fetchImpl, now: new Date("2026-11-01T00:00:00Z") });

describe("Zettle live probe", () => {
  it("reports shape, counts and pseudonyms without any secret, identifier, name or card detail", async () => {
    const report = await probe(provider([[sale("purchase-id-do-not-print"), sale("second-id-do-not-print", { userUuid: STAFF_B })]]));
    expect(report.contract).toBe("READABLE");
    const output = JSON.stringify(report);
    expect(output).not.toMatch(/do-not-print|Private Person|411111/);
    expect(report.purchasesRead.shape).toMatchObject({ userUuid: "string", amount: "number" });
    expect(report.token).toMatchObject({ expiresIn: 7200, scope: "READ:PURCHASE" });
  });
  it("answers whether the staff field is one person, stable, or really the account", async () => {
    const report = await probe(provider([[sale("a"), sale("b"), sale("c", { userUuid: ORG, userDisplayName: "Other" }), sale("d", { userUuid: undefined, userDisplayName: undefined })]]));
    expect(report.staff).toMatchObject({ purchases: 4, withUserUuid: 3, withUserDisplayName: 3, distinctUserUuids: 2, namesUsedByMoreThanOneUuid: 0 });
    expect(report.staff.userUuids.map(user => user.equalsOrganisationUuid)).toEqual([false, true]);
    expect(Object.values(report.staff.userUuids[0].namesSeen)).toEqual([2]);
  });
  it("gives the same pseudonym on every run with the same key, so a changed identity shows", async () => {
    const pages = () => provider([[sale("a")]]);
    expect((await probe(pages())).staff.userUuids[0].user).toBe((await probe(pages())).staff.userUuids[0].user);
  });
  it("reports how a refund relates to its original sale", async () => {
    const report = await probe(provider([[sale("a"), sale("r1", { amount: -1000, refund: true, refundsPurchaseUUID1: "a" }), sale("r2", { amount: -1000, refund: true, refundsPurchaseUUID1: "a", userUuid: STAFF_B }), sale("r3", { amount: -1000, refund: true, refundsPurchaseUUID1: "outside-window", userUuid: undefined })]]));
    expect(report.staff.refunds).toEqual({ total: 3, withUserUuid: 2, linkedToOriginal: 3, originalInRetrievedWindow: 2, sameUserUuidAsOriginal: 1, differentUserUuidFromOriginal: 1 });
  });
  it.each([
    ["bad key", { token: () => json({ error: "invalid_grant", error_description: "secret text" }, 400) }, /^credentials:/],
    ["bad client", { token: () => json({ error: "invalid_client" }, 401) }, /^credentials: Zettle refused the client ID/],
    ["bad grant", { token: () => json({ error: "unsupported_grant_type" }, 400) }, /^grant:/],
    ["identity scope", { identity: () => json({}, 403) }, /^scope or account eligibility: identity/],
    ["purchase scope", { purchases: () => json({}, 403) }, /^scope or account eligibility: purchases/],
    ["outage", { purchases: () => json({}, 503) }, /^provider: purchases/],
    ["unexpected identity", { identity: () => json({ somethingElse: true }) }, /^implementation or response shape:/],
  ] as const)("classifies %s and reports the contract as not readable", async (_name, over, expected) => {
    const report = await probe(provider([], over));
    expect(report.contract).toBe("NOT_READABLE");
    expect(report.failure).toMatch(expected);
    expect(JSON.stringify(report)).not.toContain("secret text");
  });
  it("does not call a purchase shape the adapter refuses readable", async () => {
    const report = await probe(provider([[sale("a", { amount: "10.00" })]]));
    expect(report.contract).toBe("NOT_READABLE");
    expect(report.adapter).toEqual({ checked: true, accepted: false, code: "MALFORMED_RESPONSE" });
  });
  it("does not call pagination that stops without an empty page readable", async () => {
    const fetchImpl = provider([], { purchases: () => json({ purchases: [sale("a")], lastPurchaseHash: null }) });
    const report = await probe(fetchImpl);
    expect(report.purchasesRead.pagination.stoppedWithoutHash).toBe(true);
    expect(report.contract).toBe("NOT_READABLE");
  });
  it("treats no purchases as an empty read, not as sales", async () => {
    const report = await probe(provider([]));
    expect(report.contract).toBe("READABLE");
    expect(report.purchasesRead).toMatchObject({ count: 0, tradingDays: 0, firstDay: null });
  });
});
