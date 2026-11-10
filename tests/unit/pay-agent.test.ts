import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access";
import { ProviderCurrencyRateUnavailableError } from "@/server/domain/provider-currency";
import { AiProviderError, OpenAiStaffingAssessmentProvider } from "@/server/integrations/openai/staffing-assessment";
import { CHECK_OF_REASON, HOLD_REASON_CODES, PAY_AGENT_INSTRUCTIONS, PAY_AGENT_SCHEMA_NAME, parsePayDecision, payDecisionJsonSchema, payDecisionSchema } from "@/server/pay-agent/contract";
import { confirmationTiming } from "@/server/pay-agent/evidence";
import { mintPayAgentCredentialForManager, mintPayAgentCredentialForRecovery, payAgentServiceVerifier } from "@/server/pay-agent/identity";
import { isTransientModelFailure, PAY_AGENT_MODEL_TIMEOUT_MS, payAgentModelFor, requestPayDecision } from "@/server/pay-agent/model";
import { payAgentOutcomeExplanation } from "@/server/pay-agent/policy";
import { managerPayAgentView, toPayAgentEventView, WORKER_PAY_STATUS_NOTE, WORKER_PAY_STATUSES, workerPayStatus } from "@/server/pay-agent/presentation";
import { PAY_AGENT_DRY_RUN_ENV, payAgentDryRun, settlementCodeOf } from "@/server/pay-agent/settlement";
import { PaymentDetailsRequiredError } from "@/server/payments/work-payouts";
import { sandboxFixture } from "../helpers/sandbox";

let networkGuard: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // These tests cover demo-only isolation, restored by its switch (Owner decision 10 Nov 2026).
  vi.stubEnv("FAIRSHIFT_SANDBOX_SCOPE", "DEMO_ONLY");
  networkGuard = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network call in Pay Agent tests"));
});
afterEach(() => {
  expect(networkGuard).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const ORG = "00000000-0000-4000-8000-000000000001";
const LOCATION = "00000000-0000-4000-8000-000000000002";
const PAYABLE = "00000000-0000-4000-8000-000000000003";
const OTHER = "00000000-0000-4000-8000-000000000005";
const settle = { action: "settle_confirmed_work", payableId: PAYABLE, checks: { hours: "OK", overlap: "OK", timing: "OK", records: "OK" } };
const hold = { action: "hold_for_manager_review", payableId: PAYABLE, reasonCode: "HOURS_MISMATCH", summary: "Accepted schedule shows 6 hours; the shift record shows 8.", checks: { hours: "CONCERN", overlap: "OK", timing: "OK", records: "OK" } };
const wire = (decision: unknown) => JSON.stringify({ decision });

describe("Pay Agent decision contract", () => {
  it("accepts exactly the two allowlisted decisions for the server's payable", () => {
    expect(parsePayDecision(wire(settle), PAYABLE)).toEqual({ ok: true, decision: settle });
    expect(parsePayDecision(wire(hold), PAYABLE)).toEqual({ ok: true, decision: hold });
    for (const reasonCode of HOLD_REASON_CODES) expect(parsePayDecision(wire({ ...hold, reasonCode, checks: { ...settle.checks, [CHECK_OF_REASON[reasonCode]]: "CONCERN" } }), PAYABLE).ok).toBe(true);
    expect(payDecisionSchema.safeParse(settle).success).toBe(true);
  });

  // Day 6, Step 1g: the checklist must agree with the decision.
  it("rejects a checklist that contradicts the decision, or is missing", () => {
    expect(parsePayDecision(wire({ ...settle, checks: { ...settle.checks, overlap: "CONCERN" } }), PAYABLE)).toEqual({ ok: false, reason: "INCONSISTENT_CHECKS" });
    expect(parsePayDecision(wire({ ...hold, checks: settle.checks }), PAYABLE)).toEqual({ ok: false, reason: "INCONSISTENT_CHECKS" });
    expect(parsePayDecision(wire({ ...hold, reasonCode: "OVERLAPPING_WORK" }), PAYABLE)).toEqual({ ok: false, reason: "INCONSISTENT_CHECKS" });
    const { checks: _omit, ...bare } = settle;
    void _omit;
    expect(parsePayDecision(wire(bare), PAYABLE)).toEqual({ ok: false, reason: "SCHEMA_INVALID" });
    expect(parsePayDecision(wire({ ...settle, checks: { ...settle.checks, hours: "MAYBE" } }), PAYABLE)).toEqual({ ok: false, reason: "SCHEMA_INVALID" });
    expect(parsePayDecision(wire({ ...settle, checks: { ...settle.checks, amount: "OK" } }), PAYABLE)).toEqual({ ok: false, reason: "SCHEMA_INVALID" });
  });

  it.each([
    { amount: "999.00" }, { amountMinor: 1 }, { currency: "USD" }, { recipient: "attacker@example.invalid" }, { fxRate: 1 }, { exchangeRate: "18.5" },
    { organisationId: OTHER }, { merchant: OTHER }, { fundingSource: OTHER }, { approved: true }, { url: "https://example.invalid" }, { tool: "createPayout" }, { role: "OWNER" },
  ])("rejects model-supplied financial or extra fields %j on either decision and the envelope", extra => {
    expect(parsePayDecision(wire({ ...settle, ...extra }), PAYABLE)).toEqual({ ok: false, reason: "EXTRA_FIELDS" });
    expect(parsePayDecision(wire({ ...hold, ...extra }), PAYABLE)).toEqual({ ok: false, reason: "EXTRA_FIELDS" });
    expect(parsePayDecision(JSON.stringify({ decision: settle, ...extra }), PAYABLE)).toEqual({ ok: false, reason: "EXTRA_FIELDS" });
  });

  it("rejects an unknown action, an unknown reason and another payable", () => {
    expect(parsePayDecision(wire({ ...settle, action: "createPayout" }), PAYABLE)).toEqual({ ok: false, reason: "UNSUPPORTED_ACTION" });
    expect(parsePayDecision(wire({ ...settle, action: "approve_payment" }), PAYABLE)).toEqual({ ok: false, reason: "UNSUPPORTED_ACTION" });
    expect(parsePayDecision(wire({ ...hold, reasonCode: "WORKER_ASKED" }), PAYABLE)).toEqual({ ok: false, reason: "UNKNOWN_REASON" });
    expect(parsePayDecision(wire({ ...hold, reasonCode: undefined }), PAYABLE)).toEqual({ ok: false, reason: "UNKNOWN_REASON" });
    expect(parsePayDecision(wire({ ...settle, payableId: OTHER }), PAYABLE)).toEqual({ ok: false, reason: "WRONG_PAYABLE" });
    expect(parsePayDecision(wire({ ...hold, payableId: "not-an-id" }), PAYABLE)).toEqual({ ok: false, reason: "WRONG_PAYABLE" });
  });

  it("does not treat prose, claimed success or other shapes as a decision", () => {
    expect(parsePayDecision("Paid successfully!", PAYABLE)).toEqual({ ok: false, reason: "MALFORMED_JSON" });
    for (const output of [settle, [settle], null, {}, { decision: null }, { decision: [settle] }, { decisions: settle }]) {
      expect(parsePayDecision(JSON.stringify(output), PAYABLE)).toEqual({ ok: false, reason: "SCHEMA_INVALID" });
    }
  });

  it("requires a short, plain hold summary", () => {
    for (const summary of ["", "   ", "x".repeat(201), "line one\nline two", 42]) {
      expect(parsePayDecision(wire({ ...hold, summary }), PAYABLE)).toEqual({ ok: false, reason: "INVALID_SUMMARY" });
    }
    expect(parsePayDecision(wire({ ...hold, summary: "x".repeat(200) }), PAYABLE).ok).toBe(true);
  });

  it("asks for a strict schema bound to one payable, with no financial properties", () => {
    const schema = payDecisionJsonSchema(PAYABLE);
    expect(schema).toMatchObject({ type: "object", additionalProperties: false, required: ["decision"] });
    const branches = schema.properties.decision.anyOf;
    expect(branches).toHaveLength(2);
    for (const branch of branches) {
      expect(branch.additionalProperties).toBe(false);
      expect(branch.properties.payableId).toEqual({ type: "string", enum: [PAYABLE] });
      expect(Object.keys(branch.properties).sort()).toEqual([...branch.required].sort());
    }
    expect(Object.keys(branches[0].properties)).toEqual(["action", "payableId", "checks"]);
    expect(Object.keys(branches[1].properties)).toEqual(["action", "payableId", "reasonCode", "summary", "checks"]);
    expect(JSON.stringify(schema)).not.toMatch(/amount|currency|recipient|merchant|funding|rate/i);
    expect(PAY_AGENT_INSTRUCTIONS).toMatch(/never supply an amount, currency, recipient, exchange rate, organisation, merchant, funding source/i);
  });

  it("tells the model that confirmation within 24 hours of the shift end is normal practice, as context only", () => {
    expect(PAY_AGENT_INSTRUCTIONS).toMatch(/within 24 hours of the shift ending.*normal practice.*not by itself a reason to hold/i);
    expect(PAY_AGENT_INSTRUCTIONS).toMatch(/hoursAfterScheduledEnd and withinNormalConfirmationWindow/);
  });

  it("gives the model a server-computed confirmation window, in hours to one decimal, with 24 hours inclusive", () => {
    const end = new Date("2026-11-07T07:00:00Z");
    const after = (minutes: number) => confirmationTiming(end, new Date(end.getTime() + minutes * 60_000));
    // The 850-minute confirmation the model once called "over 24 hours".
    expect(after(850)).toEqual({ minutesAfterScheduledEnd: 850, hoursAfterScheduledEnd: 14.2, withinNormalConfirmationWindow: true });
    expect(after(1_662)).toEqual({ minutesAfterScheduledEnd: 1_662, hoursAfterScheduledEnd: 27.7, withinNormalConfirmationWindow: false });
    expect(after(120)).toMatchObject({ hoursAfterScheduledEnd: 2, withinNormalConfirmationWindow: true });
    expect(after(1_440)).toMatchObject({ hoursAfterScheduledEnd: 24, withinNormalConfirmationWindow: true });
    expect(after(1_441)).toMatchObject({ withinNormalConfirmationWindow: false });
  });
});

describe("Pay Agent service identity", () => {
  it("accepts only a credential minted in this server process", async () => {
    const credential = mintPayAgentCredentialForManager({ organisationId: ORG, locationId: LOCATION, role: "MANAGER" });
    expect(Object.isFrozen(credential)).toBe(true);
    expect(await payAgentServiceVerifier.authenticate(credential)).toEqual({ kind: "service", subject: "fairshift-pay-agent", organisationId: ORG, locationId: LOCATION });
    const forgeries = [{ ...credential }, JSON.parse(JSON.stringify(credential)), structuredClone(credential), { kind: "service", subject: "fairshift-pay-agent", organisationId: ORG, locationId: LOCATION }, "fairshift-pay-agent", ORG, null, undefined, 42];
    for (const forged of forgeries) expect(await payAgentServiceVerifier.authenticate(forged)).toBeNull();
  });

  it("is never minted for a worker or a public demo persona", () => {
    expect(() => mintPayAgentCredentialForManager({ organisationId: ORG, locationId: LOCATION, role: "TEAM_MEMBER" })).toThrow(AccessError);
    expect(() => mintPayAgentCredentialForManager({ organisationId: ORG, locationId: LOCATION, role: "MANAGER", demo: { persona: "MANAGER", group: "public" } })).toThrow(AccessError);
    expect(() => mintPayAgentCredentialForManager({ organisationId: ORG, locationId: LOCATION, role: "OWNER", demo: { persona: "OWNER", group: "public" } })).toThrow(AccessError);
    expect(mintPayAgentCredentialForManager({ organisationId: ORG, locationId: LOCATION, role: "OWNER" })).toBeTruthy();
  });

  it("scopes a recovery credential to the event's own organisation and location", async () => {
    const credential = mintPayAgentCredentialForRecovery({ organisationId: ORG, outletId: LOCATION });
    expect(await payAgentServiceVerifier.authenticate(credential)).toMatchObject({ organisationId: ORG, locationId: LOCATION });
  });
});

describe("Pay Agent model adapter", () => {
  it("uses no model outside the configured Sandbox demo organisation or without AI configuration", () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    expect(payAgentModelFor(ORG)).toBeNull();
    sandboxFixture(ORG);
    expect(payAgentModelFor(OTHER)).toBeNull();
    expect(payAgentModelFor(ORG)).toMatchObject({ provider: "OPENAI" });
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(payAgentModelFor(ORG)).toBeNull();
  });

  it("sends the strict decision schema with store:false and a timeout through the existing Responses transport", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      id: "test-responses-id", model: "test-responses-model", status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: wire(settle) }] }],
    }), { status: 200 }));
    const model = new OpenAiStaffingAssessmentProvider("test-key", "test-configured-model", fetchMock, PAY_AGENT_MODEL_TIMEOUT_MS);
    const response = await requestPayDecision(model, { instructions: PAY_AGENT_INSTRUCTIONS, schemaName: PAY_AGENT_SCHEMA_NAME, schema: payDecisionJsonSchema(PAYABLE), input: "{}" });
    expect(response).toMatchObject({ responseId: "test-responses-id", responseModel: "test-responses-model" });
    expect(parsePayDecision(response.text, PAYABLE)).toEqual({ ok: true, decision: settle });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/responses");
    const body = JSON.parse(options!.body as string);
    expect(body).toMatchObject({ model: "test-configured-model", store: false, text: { format: { type: "json_schema", strict: true, name: PAY_AGENT_SCHEMA_NAME, schema: payDecisionJsonSchema(PAYABLE) } } });
    expect(body.tools).toBeUndefined();
    expect(options!.signal).toBeInstanceOf(AbortSignal);
  });

  it("retries once, and only for a network failure before any response", async () => {
    const reply = { responseId: "r", responseModel: "m", text: wire(settle) };
    const model = (assess: ReturnType<typeof vi.fn>) => ({ provider: "OPENAI" as const, model: "m", assess: assess as never });
    const recovering = vi.fn().mockRejectedValueOnce(new AiProviderError("NETWORK_ERROR")).mockResolvedValueOnce(reply);
    await expect(requestPayDecision(model(recovering), { instructions: "", input: "", schemaName: "s", schema: {} })).resolves.toEqual(reply);
    expect(recovering).toHaveBeenCalledTimes(2);
    const down = vi.fn().mockRejectedValue(new AiProviderError("NETWORK_ERROR"));
    await expect(requestPayDecision(model(down), { instructions: "", input: "", schemaName: "s", schema: {} })).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(down).toHaveBeenCalledTimes(2);
    for (const code of ["TIMEOUT", "REFUSAL", "HTTP_503", "MALFORMED_RESPONSE"] as const) {
      const once = vi.fn().mockRejectedValue(new AiProviderError(code));
      await expect(requestPayDecision(model(once), { instructions: "", input: "", schemaName: "s", schema: {} })).rejects.toMatchObject({ code });
      expect(once).toHaveBeenCalledTimes(1);
    }
  });

  it("classifies only timeouts, network failures, rate limits and provider errors as transient", () => {
    for (const code of ["TIMEOUT", "NETWORK_ERROR", "HTTP_429", "HTTP_500", "HTTP_503"]) expect(isTransientModelFailure(code)).toBe(true);
    for (const code of ["REFUSAL", "INCOMPLETE", "MALFORMED_RESPONSE", "HTTP_400", "HTTP_401", "HTTP_404", "NOT_CONFIGURED"]) expect(isTransientModelFailure(code)).toBe(false);
  });
});

describe("dry-run configuration and settlement codes", () => {
  it("is on unless the server's configuration says exactly false", () => {
    expect(payAgentDryRun()).toBe(true);
    for (const value of ["true", "0", "off", "FALSE", "no", " false", ""]) {
      vi.stubEnv(PAY_AGENT_DRY_RUN_ENV, value);
      expect(payAgentDryRun()).toBe(true);
    }
    vi.stubEnv(PAY_AGENT_DRY_RUN_ENV, "false");
    expect(payAgentDryRun()).toBe(false);
  });

  it("keeps the payout engine's own refusal codes, including the missing demo rate", () => {
    expect(settlementCodeOf(new ProviderCurrencyRateUnavailableError("ZAR", "USD"))).toBe("provider-fx-rate-unavailable");
    expect(settlementCodeOf(new PaymentDetailsRequiredError())).toBe("payment-details-required");
    expect(settlementCodeOf(new Error("database unavailable"))).toBe("SETTLEMENT_CHECK_FAILED");
  });

  it("explains outcomes without claiming a payment", () => {
    expect(payAgentOutcomeExplanation("DRY_RUN_ELIGIBLE")).toMatch(/nothing was sent to PayPal/);
    expect(payAgentOutcomeExplanation("provider-fx-rate-unavailable")).toMatch(/unpaid/);
    expect(payAgentOutcomeExplanation("SOMETHING_NEW")).toMatch(/Nothing is paid until PayPal confirms it/);
    expect(payAgentOutcomeExplanation(null)).toBeNull();
  });
});

describe("Pay Agent presentation", () => {
  const event = {
    id: "00000000-0000-4000-8000-000000000009", status: "DECIDED_HOLD", outcomeCode: null, errorClass: null, decision: "HOLD", reasonCode: "HOURS_MISMATCH",
    summary: "Accepted schedule shows 6 hours; the shift record shows 8.", dryRun: null, configuredModel: "configured-model", responseModel: "response-model",
    responseId: "resp_1", resolution: null, resolutionNote: null, resolvedAt: null, attemptCount: 1, updatedAt: new Date(0),
  };

  it("maps every journal state to one of five plain worker statuses, with Paid only for a provider-confirmed payout", () => {
    const base = { workConfirmed: true, hasPayable: true };
    expect(workerPayStatus({ workConfirmed: true, hasPayable: false })).toBe("Shift confirmed");
    expect(workerPayStatus({ workConfirmed: false, hasPayable: false })).toBeNull();
    for (const agentStatus of ["PENDING", "CLAIMED", "BLOCKED", "SKIPPED", "REJECTED_OUTPUT", "FAILED_RETRYABLE", "FAILED_TERMINAL", null]) expect(workerPayStatus({ ...base, agentStatus })).toBe("Earnings recorded");
    for (const agentStatus of ["DECIDED_SETTLE", "HOLD_RELEASED", "SETTLING", "DRY_RUN_ELIGIBLE", "SETTLEMENT_BLOCKED", "SETTLEMENT_SUBMITTED"]) expect(workerPayStatus({ ...base, agentStatus })).toBe("Pay pending");
    for (const agentStatus of ["DECIDED_HOLD", "HOLD_REJECTED"]) expect(workerPayStatus({ ...base, agentStatus })).toBe("Under review");
    expect(workerPayStatus({ ...base, approved: true, agentStatus: "PENDING" })).toBe("Pay pending");
    for (const payoutStatus of ["SUBMITTING", "PROCESSING", "RECONCILIATION_REQUIRED", "FAILED", "NOT_SENT"]) expect(workerPayStatus({ ...base, payoutStatus, agentStatus: "SETTLEMENT_SUBMITTED" })).toBe("Pay pending");
    expect(workerPayStatus({ ...base, payoutStatus: "PAID", agentStatus: "DRY_RUN_ELIGIBLE" })).toBe("Paid");
    expect(workerPayStatus({ ...base, payoutStatus: "PAID", agentStatus: "HOLD_REJECTED" })).toBe("Paid");
    for (const status of WORKER_PAY_STATUSES) expect(WORKER_PAY_STATUS_NOTE[status]).not.toMatch(/[A-Z]{2,}_[A-Z]{2,}/);
  });

  it("gives managers labels and actions, and no claim internals", () => {
    expect(managerPayAgentView(event)).toMatchObject({ status: "Held for the Owner", decision: "Hold for the Owner", reason: "Hours mismatch", summary: event.summary, model: "response-model", responseId: "resp_1", canResolve: true, canRetry: false });
    expect(managerPayAgentView({ ...event, status: "DRY_RUN_ELIGIBLE", decision: "SETTLE", reasonCode: null, summary: null, outcomeCode: "DRY_RUN_ELIGIBLE", dryRun: true }))
      .toMatchObject({ status: "Demo dry run: all checks passed", decision: "Settle", dryRun: true, canRetry: true, canResolve: false, explanation: expect.stringMatching(/nothing was sent to PayPal/) });
    expect(managerPayAgentView({ ...event, status: "SETTLEMENT_SUBMITTED", decision: "SETTLE", reasonCode: null, summary: null, outcomeCode: "PAYOUT_RESERVED" })).toMatchObject({ canRetry: false, canResolve: false });
    const view = toPayAgentEventView({ ...event, claimToken: "secret-token", leaseExpiresAt: new Date(), evidenceVersion: "f".repeat(64) } as typeof event);
    expect(view).not.toHaveProperty("claimToken");
    expect(view).not.toHaveProperty("evidenceVersion");
  });
});
