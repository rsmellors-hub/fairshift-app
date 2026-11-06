import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAiStaffingAssessmentProvider, AiProviderError } from "@/server/integrations/openai/staffing-assessment";
import { createPayAgent } from "@/server/pay-agent/orchestrator";
import {
  payActionJsonSchema, payActionSchema, settlementEvidenceSchema,
  type AttemptKey, type PayAgentInvocationBinding, type PayAgentJournal, type PayAgentModelEvidence, type PayAgentResult, type SettlementEvidence,
} from "@/server/pay-agent/contract";
import { evaluateConfirmedWork } from "@/server/pay-agent/policy";

let networkGuard: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  networkGuard = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network call in Pay Agent tests"));
});
afterEach(() => {
  expect(networkGuard).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

const ORG = "00000000-0000-4000-8000-000000000001";
const LOCATION = "00000000-0000-4000-8000-000000000002";
const PAYABLE = "00000000-0000-4000-8000-000000000003";
const EVENT = "00000000-0000-4000-8000-000000000004";
const OTHER = "00000000-0000-4000-8000-000000000005";
const RECIPIENT = "00000000-0000-4000-8000-000000000006";
const MERCHANT = "00000000-0000-4000-8000-000000000007";
const identity = { kind: "service" as const, subject: "fairshift-pay-agent" as const, organisationId: ORG, locationId: LOCATION };
const action = { action: "settle_confirmed_work", payableId: PAYABLE };
const fixture = (): SettlementEvidence => ({
  eventId: EVENT, eventType: "manager_confirmed_work", organisationId: ORG, locationId: LOCATION, payableId: PAYABLE, entitlementVersion: "test-entitlement-1", version: "test-version-1",
  references: { payable: "test-payable", preauthorisedTerms: "test-terms", acceptance: "test-acceptance", managerCompletion: "test-completion", performance: "test-performance", paymentAuthority: "test-authority", funding: "test-funding", recipient: "test-recipient", providerEligibility: "test-eligibility" },
  amountMinor: 12100, currencyCode: "GBP", recipientId: RECIPIENT, merchantId: MERCHANT,
  payout: { status: "NONE", reference: null },
});

// Test double ONLY. Production requires durable unique/CAS storage, not this Map.
class TestJournal implements PayAgentJournal {
  rows = new Map<string, { attemptId: string; binding: PayAgentInvocationBinding; result?: PayAgentResult; modelEvidence?: PayAgentModelEvidence | null }>();
  async claim(key: AttemptKey, binding: PayAgentInvocationBinding) {
    const id = JSON.stringify(key);
    const existing = this.rows.get(id);
    if (existing?.result) return { state: "existing" as const, result: existing.result };
    if (existing) return { state: "busy" as const };
    const attemptId = `test-attempt-${this.rows.size}`;
    this.rows.set(id, { attemptId, binding: structuredClone(binding) });
    return { state: "claimed" as const, attemptId };
  }
  async finish(key: AttemptKey, attemptId: string, result: PayAgentResult, modelEvidence: PayAgentModelEvidence | null) {
    const row = this.rows.get(JSON.stringify(key));
    if (!row || row.attemptId !== attemptId || row.result) throw new Error("claim changed");
    row.result = result;
    row.modelEvidence = modelEvidence;
  }
}
function setup() {
  const snapshot = fixture();
  const journal = new TestJournal();
  const authenticate = vi.fn(async (credential: unknown) => { void credential; return identity; });
  const load = vi.fn(async (eventId: string, serviceIdentity: unknown): Promise<unknown> => { void eventId; void serviceIdentity; return structuredClone(snapshot); });
  const assess = vi.fn(async (request: unknown) => { void request; return { responseId: "test-response", responseModel: "test-model", text: JSON.stringify(action) }; });
  const finish = vi.spyOn(journal, "finish");
  const deps = { identityVerifier: { authenticate }, evidenceReader: { loadConfirmedWork: load }, journal, model: { provider: "OPENAI" as const, model: "test-model", assess } };
  const agent = createPayAgent(deps);
  return { snapshot, journal, authenticate, load, assess, finish, deps, agent, run: (raw: unknown = { eventId: EVENT }) => agent.onConfirmedWork(raw, "test-opaque-credential") };
}

describe("Pay Agent strict local action contract", () => {
  it("allows exactly one payable-bound action and no financial arguments", () => {
    expect(payActionSchema.parse(action)).toEqual(action);
    expect(payActionJsonSchema(PAYABLE)).toMatchObject({ additionalProperties: false, required: ["action", "payableId"], properties: { payableId: { enum: [PAYABLE] } } });
  });
  it.each([
    { amount: "999.00" }, { amountMinor: 1 }, { currency: "USD" }, { recipient: "attacker@example.invalid" },
    { merchant: OTHER }, { funding: OTHER }, { approved: true }, { url: "https://example.invalid" },
    { tool: "createPayout" }, { arguments: { amount: 1 } }, { role: "OWNER" },
  ])("rejects model-supplied extra arguments %j", async extra => {
    const s = setup();
    s.assess.mockResolvedValueOnce({ responseId: "r", responseModel: "test", text: JSON.stringify({ ...action, ...extra }) });
    const result = await s.run();
    expect(result.code).toBe("TOOL_REFUSED");
    expect(result.executionEnabled).toBe(false);
    expect(s.load).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("attacker");
    expect(result.status).toBe("blocked");
    expect(s.finish).toHaveBeenCalledWith(expect.objectContaining({ payableId: PAYABLE }), expect.any(String), result, expect.any(Object));
    expect(s.snapshot.payout.status).toBe("NONE");
  });
  it.each([
    { ...action, action: "createPayout" }, { ...action, payableId: OTHER },
    { ...action, payableId: "not-an-id" }, [action, action], null, {},
  ])("refuses substituted, missing or multiple actions %j", async output => {
    const s = setup();
    s.assess.mockResolvedValueOnce({ responseId: "r", responseModel: "test", text: JSON.stringify(output) });
    expect((await s.run()).code).toBe("TOOL_REFUSED");
  });
  it("does not treat claimed success or non-JSON prose as payment", async () => {
    const s = setup();
    s.assess.mockResolvedValueOnce({ responseId: "r", responseModel: "test", text: "Paid successfully!" });
    expect((await s.run()).code).toBe("TOOL_REFUSED");
  });
});

describe("service identity, evidence and execution boundary", () => {
  it("uses a verified service identity, proposes an action and stays disabled", async () => {
    const s = setup();
    expect(evaluateConfirmedWork(s.snapshot).status).toBe("ready");
    const before = structuredClone(s.snapshot);
    const result = await s.run();
    expect(result).toMatchObject({ code: "EXECUTION_DISABLED", status: "blocked", executionEnabled: false });
    expect(result.evidenceReferences).toContain("test-completion");
    expect(s.authenticate).toHaveBeenCalledWith("test-opaque-credential");
    expect(s.load).toHaveBeenCalledWith(EVENT, identity);
    expect(s.snapshot).toEqual(before);
    expect(s.finish).toHaveBeenCalledWith(expect.anything(), expect.any(String), result, { provider: "OPENAI", configuredModel: "test-model", responseModel: "test-model", responseId: "test-response" });
    const request = s.assess.mock.calls[0][0] as { input: string; schemaName: string };
    expect(request.schemaName).toBe("fairshift_pay_agent_action_v1");
    for (const secret of ["amountMinor", "currencyCode", "merchantId", "recipientId", String(before.amountMinor), MERCHANT, RECIPIENT, "test-opaque-credential"]) expect(request.input).not.toContain(secret);
  });
  it.each([null, { ...identity, kind: "worker" }, { ...identity, subject: "another-service" }, { ...identity, role: "OWNER" }])("refuses unauthenticated or wrong-purpose identities %j", async verified => {
    const s = setup();
    s.authenticate.mockResolvedValueOnce(verified as typeof identity);
    expect((await s.run()).code).toBe("UNAUTHORISED");
    expect(s.load).not.toHaveBeenCalled();
    expect(s.assess).not.toHaveBeenCalled();
  });
  it("does not disclose authentication exceptions", async () => {
    const s = setup();
    s.authenticate.mockRejectedValueOnce(new Error("credential-secret"));
    const result = await s.run();
    expect(result.code).toBe("IDENTITY_UNAVAILABLE");
    expect(JSON.stringify(result)).not.toContain("credential-secret");
  });
  it.each([{ eventId: EVENT, amount: 1 }, { eventId: EVENT, payableId: OTHER }, { eventId: EVENT, identity }, { payableId: PAYABLE }, { eventId: "bad" }])("rejects caller financial facts or forged trigger %j", async raw => {
    const s = setup();
    expect((await s.run(raw)).code).toBe("INVALID_TRIGGER");
    expect(s.load).not.toHaveBeenCalled();
  });
  it.each(["organisationId", "locationId", "eventId"] as const)("refuses mis-scoped persisted %s", async field => {
    const s = setup();
    s.snapshot[field] = OTHER;
    expect((await s.run()).code).toBe("UNAUTHORISED");
    expect(s.assess).not.toHaveBeenCalled();
  });
  it.each([
    ["managerCompletion", "COMPLETION_REQUIRED"], ["preauthorisedTerms", "TERMS_REQUIRED"],
    ["acceptance", "ACCEPTANCE_REQUIRED"], ["performance", "PERFORMANCE_REQUIRED"],
    ["paymentAuthority", "AUTHORITY_REQUIRED"], ["funding", "FUNDING_REQUIRED"],
    ["recipient", "RECIPIENT_REQUIRED"], ["providerEligibility", "PROVIDER_ELIGIBILITY_REQUIRED"],
  ] as const)("refuses missing persisted %s", async (field, code) => {
    const s = setup();
    s.snapshot.references[field] = null;
    const result = await s.run();
    expect(result.code).toBe(code);
    expect(result.evidenceReferences).toContain("test-payable");
    expect(s.assess).not.toHaveBeenCalled();
    expect(s.journal.rows.size).toBe(0);
  });
  it.each(["ZAR", "JPY", "EUR", null])("refuses currency %s even with an asserted provider route", async currency => {
    const s = setup();
    s.snapshot.currencyCode = currency;
    expect((await s.run()).code).toBe("CURRENCY_UNSUPPORTED");
    expect(s.assess).not.toHaveBeenCalled();
    expect(s.journal.rows.size).toBe(0);
    expect(s.snapshot.payout).toEqual({ status: "NONE", reference: null });
    expect(s.finish).not.toHaveBeenCalled();
  });
  it("does not infer funding or recipient from an eligibility flag", async () => {
    const s = setup();
    s.snapshot.merchantId = null;
    expect((await s.run()).code).toBe("FUNDING_REQUIRED");
    s.snapshot.merchantId = MERCHANT;
    s.snapshot.recipientId = null;
    expect((await s.run()).code).toBe("RECIPIENT_REQUIRED");
  });
  it("refuses missing or invalid deterministic amount", async () => {
    const s = setup();
    s.snapshot.amountMinor = null;
    expect((await s.run()).code).toBe("FINANCIAL_FACTS_REQUIRED");
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(settlementEvidenceSchema.safeParse({ ...fixture(), amountMinor: value }).success).toBe(false);
  });
  it("blocks absent or malformed evidence, and reports read failure as uncertainty", async () => {
    const s = setup();
    s.load.mockResolvedValueOnce(null);
    expect((await s.run()).code).toBe("EVIDENCE_UNAVAILABLE");
    s.load.mockResolvedValueOnce({ ...fixture(), eventType: "worker_requested_payout" });
    expect((await s.run()).code).toBe("EVIDENCE_INVALID");
    s.load.mockRejectedValueOnce(new Error("database-secret"));
    expect(await s.run()).toMatchObject({ code: "EVIDENCE_UNAVAILABLE", status: "uncertain" });
    expect(s.assess).not.toHaveBeenCalled();
  });
});

describe("persisted settlement statuses, repeats and failures", () => {
  it.each([
    ["SUBMITTING", "processing"], ["PROCESSING", "processing"], ["RECONCILIATION_REQUIRED", "uncertain"],
    ["PAID", "completed"], ["FAILED", "blocked"], ["NOT_SENT", "blocked"],
  ] as const)("preserves %s as %s without another model/action", async (status, expected) => {
    const s = setup();
    s.snapshot.payout = { status, reference: "test-original-payout" };
    expect((await s.run()).status).toBe(expected);
    expect(s.assess).not.toHaveBeenCalled();
  });
  it("refuses an inconsistent empty status with an existing payout reference", async () => {
    const s = setup();
    s.snapshot.payout.reference = "test-original-payout";
    expect((await s.run()).code).toBe("EVIDENCE_INVALID");
    expect(s.assess).not.toHaveBeenCalled();
  });
  it("requires a persisted payout reference to report payment status", async () => {
    const s = setup();
    s.snapshot.payout.status = "PAID";
    expect((await s.run()).code).toBe("EVIDENCE_INVALID");
  });
  it("deduplicates repeated triggers and different event IDs for the same payable evidence", async () => {
    const s = setup();
    const first = await s.run();
    expect(await s.run()).toEqual(first);
    s.snapshot.eventId = OTHER;
    expect(await s.run({ eventId: OTHER })).toEqual(first);
    expect(s.assess).toHaveBeenCalledTimes(1);
    expect(s.journal.rows.size).toBe(1);
  });
  it("allows only one concurrent model call and does not steal a busy claim", async () => {
    const s = setup();
    let release!: () => void;
    let started!: () => void;
    const inFlight = new Promise<void>(resolve => { started = resolve; });
    s.assess.mockImplementationOnce(async () => {
      started();
      await new Promise<void>(resolve => { release = resolve; });
      return { responseId: "r", responseModel: "test", text: JSON.stringify(action) };
    });
    const first = s.run();
    await inFlight;
    expect(await s.run()).toMatchObject({ code: "TRIGGER_PROCESSING", status: "processing" });
    release();
    expect((await first).code).toBe("EXECUTION_DISABLED");
    expect(s.assess).toHaveBeenCalledTimes(1);
  });
  it.each(["TIMEOUT", "NETWORK_ERROR", "REFUSAL", "INCOMPLETE", "MALFORMED_RESPONSE", "HTTP_429"] as const)("persists safe model failure %s without retrying on repeat", async code => {
    const s = setup();
    s.assess.mockRejectedValueOnce(new AiProviderError(code));
    const result = await s.run();
    expect(result).toMatchObject({ code: "MODEL_FAILED", status: "blocked", executionEnabled: false });
    expect(await s.run()).toEqual(result);
    expect(s.assess).toHaveBeenCalledTimes(1);
    expect(s.snapshot.payout.status).toBe("NONE");
  });
  it("fails safely without a configured model", async () => {
    const s = setup();
    const agent = createPayAgent({ ...s.deps, model: null });
    expect((await agent.onConfirmedWork({ eventId: EVENT }, "test")).code).toBe("MODEL_NOT_CONFIGURED");
    expect(s.journal.rows.size).toBe(0);
  });
  it.each(["amountMinor", "merchantId", "version"] as const)("refuses %s changed during a model call", async field => {
    const s = setup();
    s.assess.mockImplementationOnce(async () => {
      if (field === "amountMinor") s.snapshot.amountMinor = 999;
      else s.snapshot[field] = OTHER;
      return { responseId: "r", responseModel: "test", text: JSON.stringify(action) };
    });
    expect((await s.run()).code).toBe("EVIDENCE_CHANGED");
  });
  it("refuses changed currency binding before post-model eligibility handling", async () => {
    const s = setup();
    s.assess.mockImplementationOnce(async () => {
      s.snapshot.currencyCode = "ZAR";
      return { responseId: "r", responseModel: "test", text: JSON.stringify(action) };
    });
    expect((await s.run()).code).toBe("EVIDENCE_CHANGED");
  });
  it("reports payment completed concurrently only from the shared persisted record", async () => {
    const s = setup();
    s.assess.mockImplementationOnce(async () => {
      s.snapshot.payout = { status: "PAID", reference: "test-original-payout" };
      s.snapshot.version = "test-version-2";
      return { responseId: "r", responseModel: "test", text: JSON.stringify(action) };
    });
    expect(await s.run()).toMatchObject({ code: "PAYOUT_COMPLETED", status: "completed" });
  });
  it("does not call the model when journal claim fails", async () => {
    const s = setup();
    vi.spyOn(s.journal, "claim").mockRejectedValueOnce(new Error("db-secret"));
    expect(await s.run()).toMatchObject({ code: "JOURNAL_UNAVAILABLE", status: "uncertain" });
    expect(s.assess).not.toHaveBeenCalled();
  });
  it("does not release a claim when durable finish fails", async () => {
    const s = setup();
    s.finish.mockRejectedValueOnce(new Error("db-secret"));
    expect((await s.run()).code).toBe("JOURNAL_UNAVAILABLE");
    expect((await s.run()).code).toBe("TRIGGER_PROCESSING");
    expect(s.assess).toHaveBeenCalledTimes(1);
  });
});

describe("post-model original invocation binding", () => {
  function refreshedCase(change: (value: SettlementEvidence) => void) {
    const s = setup();
    const original = structuredClone(s.snapshot);
    const refreshed = structuredClone(original);
    change(refreshed);
    s.load.mockResolvedValueOnce(original).mockResolvedValueOnce(refreshed);
    return { ...s, original, refreshed };
  }
  function expectBlockedAttempt(s: ReturnType<typeof refreshedCase>, result: PayAgentResult, code = "EVIDENCE_CHANGED") {
    expect(result).toMatchObject({ status: "blocked", code, executionEnabled: false });
    expect(result.code).not.toBe("PAYOUT_COMPLETED");
    expect(result.explanation).not.toContain("confirms this payment is paid");
    expect(result.evidenceReferences).not.toContain("test-substituted-payout");
    expect(s.snapshot).toEqual(s.original);
    expect(s.finish).toHaveBeenCalledExactlyOnceWith({ organisationId: ORG, locationId: LOCATION, payableId: PAYABLE, version: "test-version-1" }, expect.any(String), result, expect.any(Object));
    const [row] = s.journal.rows.values();
    expect(row.result).toEqual(result);
    expect(row.result?.status).toBe("blocked");
  }
  it.each(["NONE", "SUBMITTING", "PROCESSING", "RECONCILIATION_REQUIRED", "PAID", "FAILED", "NOT_SENT"] as const)("refuses another payable's %s before accepting any status", async status => {
    const s = refreshedCase(value => {
      value.payableId = OTHER;
      value.version = "test-version-2";
      value.payout = { status, reference: status === "NONE" ? null : "test-substituted-payout" };
    });
    expectBlockedAttempt(s, await s.run());
  });
  it.each(["organisationId", "locationId", "eventId"] as const)("refuses changed %s before accepting PAID", async field => {
    const s = refreshedCase(value => {
      value[field] = OTHER;
      value.version = "test-version-2";
      value.payout = { status: "PAID", reference: "test-substituted-payout" };
    });
    expectBlockedAttempt(s, await s.run(), "UNAUTHORISED");
  });
  it.each(["payable", "preauthorisedTerms", "acceptance", "managerCompletion", "performance", "paymentAuthority", "funding", "recipient", "providerEligibility"] as const)("refuses substituted %s evidence before accepting PAID", async field => {
    const s = refreshedCase(value => {
      value.references[field] = "test-other-evidence";
      value.version = "test-version-2";
      value.payout = { status: "PAID", reference: "test-substituted-payout" };
    });
    expectBlockedAttempt(s, await s.run());
  });
  it.each(["amountMinor", "currencyCode", "recipientId", "merchantId"] as const)("refuses changed %s before accepting PAID", async field => {
    const s = refreshedCase(value => {
      if (field === "amountMinor") value.amountMinor = 999;
      else if (field === "currencyCode") value.currencyCode = "USD";
      else value[field] = OTHER;
      value.version = "test-version-2";
      value.payout = { status: "PAID", reference: "test-substituted-payout" };
    });
    expectBlockedAttempt(s, await s.run());
  });
  it("refuses an evidence-version substitution without a payout-state change", async () => {
    const s = refreshedCase(value => { value.version = "test-version-2"; });
    expectBlockedAttempt(s, await s.run());
  });
  it.each([false, true])("refuses changed entitlement version even when payment completes: %s", async completed => {
    const s = refreshedCase(value => {
      value.entitlementVersion = "test-other-entitlement";
      if (completed) {
        value.version = "test-version-2";
        value.payout = { status: "PAID", reference: "test-substituted-payout" };
      }
    });
    expectBlockedAttempt(s, await s.run());
  });
  it("refuses a changed payout projection without advancing its full evidence version", async () => {
    const s = refreshedCase(value => { value.payout = { status: "PAID", reference: "test-substituted-payout" }; });
    expectBlockedAttempt(s, await s.run());
  });
  it.each([
    ["SUBMITTING", "processing", "PAYOUT_PROCESSING"], ["PROCESSING", "processing", "PAYOUT_PROCESSING"],
    ["RECONCILIATION_REQUIRED", "uncertain", "PAYOUT_UNCERTAIN"], ["PAID", "completed", "PAYOUT_COMPLETED"],
    ["FAILED", "blocked", "PAYOUT_FAILED"], ["NOT_SENT", "blocked", "PAYOUT_NOT_SENT"],
  ] as const)("accepts same-entitlement concurrent %s with a versioned status update", async (status, expectedStatus, code) => {
    const s = refreshedCase(value => {
      value.version = "test-version-2";
      value.payout = { status, reference: "test-same-payable-payout" };
    });
    const result = await s.run();
    expect(result).toMatchObject({ status: expectedStatus, code, executionEnabled: false });
    expect(s.snapshot).toEqual(s.original);
    expect(s.finish).toHaveBeenCalledWith(expect.objectContaining({ payableId: PAYABLE, version: s.original.version }), expect.any(String), result, expect.any(Object));
    expect([...s.journal.rows.values()][0].binding).toMatchObject({ eventId: EVENT, entitlementVersion: "test-entitlement-1", evidenceFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });
  it("refuses an unsupported BLOCKED provider-state projection", async () => {
    const s = refreshedCase(value => {
      value.payout = { status: "BLOCKED" as SettlementEvidence["payout"]["status"], reference: "test-substituted-payout" };
    });
    expectBlockedAttempt(s, await s.run(), "EVIDENCE_INVALID");
  });
  it("journals refreshed-reader failure as uncertain, preserves entitlement and does not retry", async () => {
    const s = setup();
    const original = structuredClone(s.snapshot);
    s.load.mockResolvedValueOnce(original).mockRejectedValueOnce(new Error("synthetic read outage"));
    const result = await s.run();
    expect(result).toMatchObject({ status: "uncertain", code: "EVIDENCE_UNAVAILABLE", executionEnabled: false });
    expect(s.finish).toHaveBeenCalledWith(expect.objectContaining({ payableId: PAYABLE, version: original.version }), expect.any(String), result, expect.any(Object));
    expect(await s.run()).toEqual(result);
    expect(s.assess).toHaveBeenCalledTimes(1);
    expect(s.snapshot).toEqual(original);
    expect([...s.journal.rows.values()][0].result?.status).toBe("uncertain");
  });
});

describe("existing OpenAI Responses transport integration (mock HTTP only)", () => {
  it("sends a strict action schema with store:false through the existing provider", async () => {
    const s = setup();
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      id: "test-responses-id", model: "test-responses-model", status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(action) }] }],
    }), { status: 200 }));
    const model = new OpenAiStaffingAssessmentProvider("test-key", "test-configured-model", fetchMock);
    const agent = createPayAgent({ ...s.deps, model });
    expect((await agent.onConfirmedWork({ eventId: EVENT }, "test")).code).toBe("EXECUTION_DISABLED");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/responses");
    const body = JSON.parse(options!.body as string);
    expect(body).toMatchObject({ model: "test-configured-model", store: false, text: { format: { type: "json_schema", strict: true, schema: payActionJsonSchema(PAYABLE) } } });
    expect(body.tools).toBeUndefined();
    expect(s.finish.mock.calls[0][3]).toEqual({ provider: "OPENAI", configuredModel: "test-configured-model", responseModel: "test-responses-model", responseId: "test-responses-id" });
  });
  it("rejects transport refusal without calling a settlement service", async () => {
    const s = setup();
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      model: "test-model", status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "No" }] }],
    }), { status: 200 }));
    const model = new OpenAiStaffingAssessmentProvider("test-key", "test-model", fetchMock);
    expect((await createPayAgent({ ...s.deps, model }).onConfirmedWork({ eventId: EVENT }, "test")).code).toBe("MODEL_FAILED");
  });
});
