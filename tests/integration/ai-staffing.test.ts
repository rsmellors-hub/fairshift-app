import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { entitled } from "../helpers/onboarding";
import type { Scope } from "@/server/auth/access";
import { requireScope } from "@/server/auth/request";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { aiStaffingAssessments, auditEvents, organisations, outlets, shiftOffers, shifts, subscriptions, users, workAllocations, workPayables, workPayouts } from "@/server/db/schema";
import { AiProviderError, getStaffingAssessmentProvider, OpenAiStaffingAssessmentProvider, type StaffingAssessmentProvider } from "@/server/integrations/openai/staffing-assessment";
import { AI_OUTPUT_SCHEMA_VERSION, type AssessmentInput, type StaffingAssessment } from "@/server/intelligence/ai-staffing-contract";
import { generateStaffingAssessment, getStaffingAssessmentView, NoPlanningEvidenceError } from "@/server/intelligence/ai-staffing";
import { getWeeklyStaffing } from "@/server/intelligence/staffing";
import { provisionReferenceHistory } from "@/server/reference/provision";
import { REFERENCE_STORE_CODES } from "@/server/reference/uk-retail";
import { allocateAssignment, createDepartment, createRequirement, createTeamMember, createWorkPolicy, offerAssignment, respondToAssignment } from "@/server/scheduling/operations";
import { OwnerWorkspace } from "@/app/owner/workspace";
import { ManagerWorkspace } from "@/app/manager/workspace";
import { generateLocationAssessmentAction, generateOwnerAssessmentAction } from "@/app/intelligence-actions";

vi.mock("@/server/auth/request", () => ({ requireScope: vi.fn() }));
vi.mock("@/server/db/client", () => ({ getDatabase: vi.fn() }));
vi.mock("@/server/config/env", () => ({ getConfigurationStatus: vi.fn(), getAiConfig: vi.fn() }));
vi.mock("@/server/integrations/openai/staffing-assessment", async (original) => ({ ...await original<object>(), getStaffingAssessmentProvider: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); }, notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// Sunday 25 Oct 2026 in London; the planning week is Mon 26 Oct – Sun 1 Nov 2026.
const NOW = new Date("2026-10-25T10:00:00Z");
beforeEach(() => { vi.useFakeTimers({ now: NOW, toFake: ["Date"] }); });
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];
async function user(db: Db) {
  const id = randomUUID();
  await db.insert(users).values({ id, email: `ai-${id.slice(0, 8)}@example.test`, name: "Test user", passwordHash: "test", emailVerifiedAt: new Date() });
  return id;
}
async function referenceCompany(db: Db, { history = true } = {}) {
  const organisationId = randomUUID();
  await db.insert(organisations).values({ id: organisationId, name: "AI company", country: "United Kingdom" });
  await db.insert(subscriptions).values({ id: randomUUID(), organisationId, requestId: randomUUID() });
  await entitled(db, organisationId);
  const rows = REFERENCE_STORE_CODES.map((code, i) => ({ id: randomUUID(), organisationId, name: `${i + 1} ${code} store`, timezone: "Europe/London" }));
  await db.insert(outlets).values(rows);
  if (history) await provisionReferenceHistory(db, { organisationId, outlets: Object.fromEntries(REFERENCE_STORE_CODES.map((code, i) => [code, rows[i].id])) as never, from: "2025-11-24", through: "2025-12-28" });
  const base = { organisationName: "AI company", locationName: rows[0].name };
  const owner: Scope = { userId: await user(db), organisationId, locationId: rows[0].id, role: "OWNER", ...base };
  const manager = async (i: number): Promise<Scope> => ({ userId: await user(db), organisationId, locationId: rows[i].id, role: "MANAGER", ...base, locationName: rows[i].name });
  return { organisationId, rows, owner, manager };
}

// A model response built only from the supplied input, as a well-behaved model would.
function validAssessment(input: AssessmentInput): StaffingAssessment {
  const first = input.rankedGapDays[0];
  const top = input.locations.find(location => location.key === first.locationKey)!;
  const day = top.days.find(candidate => candidate.date === first.date)!;
  return {
    schemaVersion: AI_OUTPUT_SCHEMA_VERSION,
    summary: `Casual staffing pressure is highest at [[${top.key}]].`,
    priorities: [
      { rank: 1, locationKey: top.key, date: day.date, severity: "HIGH", category: "CASUAL_GAP", reason: "This is the largest casual gap in the planning week.", evidence: [{ metric: "casualGapMinutes", value: day.casualGapMinutes! }, { metric: "requiredMinutes", value: day.requiredMinutes! }], action: "FILL_SHIFTS", actionNote: "Plan casual shifts for this day first." },
      { rank: 2, locationKey: top.key, date: null, severity: "MEDIUM", category: "CASUAL_GAP", reason: "The location needs casual cover across the week.", evidence: [{ metric: "casualGapMinutes", value: top.week!.casualGapMinutes }], action: "FILL_SHIFTS", actionNote: "Then cover the remaining days." },
    ],
    constraints: [{ type: "SYNTHETIC_REFERENCE_DATA", locationKey: null, note: "Forecasts come from synthetic reference history, not live sales." }, { type: "STALE_EVIDENCE", locationKey: null, note: "The planning week is mapped from older history." }],
    signalCommentary: "Treat the ranking as directional: the history is synthetic and older than the planning week.",
  };
}
function fakeProvider(respond: (input: AssessmentInput) => unknown = validAssessment) {
  const assess = vi.fn(async (request: { input: string }) => ({ responseId: "resp_test", responseModel: "gpt-test-2026", text: JSON.stringify(respond(JSON.parse(request.input))) }));
  return { provider: "OPENAI" as const, model: "gpt-test", assess } as StaffingAssessmentProvider & { assess: typeof assess };
}
const counts = async (db: Db) => Object.fromEntries(await Promise.all(Object.entries({ shifts, shiftOffers, workAllocations, workPayables, workPayouts }).map(async ([name, table]) => [name, (await db.select().from(table)).length])));

describe("AI staffing intelligence", () => {
  it("stores a validated assessment of the deterministic week, reuses it while current, and never calls the model to render", async () => {
    const t = await createTestDatabase();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const c = await referenceCompany(t.db);
      const before = await counts(t.db);
      const staffing = await getWeeklyStaffing(t.db, c.owner, NOW);
      expect((await getStaffingAssessmentView(t.db, c.owner, "ORGANISATION", staffing)).state).toBe("NONE");

      const provider = fakeProvider();
      const { record, generated } = await generateStaffingAssessment(t.db, c.owner, "ORGANISATION", provider, NOW);
      expect(generated).toBe(true);
      expect(provider.assess).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(provider.assess.mock.calls[0][0].input) as AssessmentInput;
      // Owner input: every location, aggregate figures only, nothing identifying.
      expect(sent.locations).toHaveLength(5);
      for (const text of [...c.rows.map(row => row.name), ...c.rows.map(row => row.id), "AI company", c.organisationId, "@"]) expect(provider.assess.mock.calls[0][0].input).not.toContain(text);
      expect(record).toMatchObject({ status: "AVAILABLE", scopeKey: "ORGANISATION", outletId: null, provider: "OPENAI", model: "gpt-test", responseModel: "gpt-test-2026", providerResponseId: "resp_test",
        planningStart: "2026-10-26", planningEnd: "2026-11-01", evidenceThrough: "2025-12-28", inputVersion: "fs-staffing-ai-input-v1", outputSchemaVersion: AI_OUTPUT_SCHEMA_VERSION, failureCode: null });
      expect(record.input).toEqual(sent);
      expect(Object.values(record.locationKeys as Record<string, string>).sort()).toEqual(c.rows.map(row => row.id).sort());

      // The stored numbers are the deterministic ones.
      const view = await getStaffingAssessmentView(t.db, c.owner, "ORGANISATION", await getWeeklyStaffing(t.db, c.owner, NOW));
      expect(view.state).toBe("CURRENT");
      const top = view.assessment!.priorities[0];
      const outletId = view.prepared.locationKeys[top.locationKey];
      const day = staffing.outlets.find(outlet => outlet.outletId === outletId)!.days.find(d => d.planningDate === top.date)!;
      expect(top.evidence).toEqual([{ metric: "casualGapMinutes", value: day.casualGapMinutes }, { metric: "requiredMinutes", value: day.requiredMinutes }]);

      // Same evidence: no second model call.
      expect((await generateStaffingAssessment(t.db, c.owner, "ORGANISATION", provider, NOW)).generated).toBe(false);
      // Rendering the Owner forecast repeatedly reads the stored assessment and calls nothing.
      vi.mocked(getDatabase).mockReturnValue(t.db);
      vi.mocked(getConfigurationStatus).mockReturnValue({ databaseConfigured: true, aiConfigured: true } as ReturnType<typeof getConfigurationStatus>);
      vi.mocked(requireScope).mockResolvedValue(c.owner);
      let html = "";
      for (let i = 0; i < 2; i++) html = renderToStaticMarkup(await OwnerWorkspace({ area: "forecast" }));
      expect(provider.assess).toHaveBeenCalledTimes(1);
      expect(getStaffingAssessmentProvider).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      const name = c.rows.find(row => row.id === outletId)!.name;
      for (const text of ["AI-assisted interpretation", "What to staff first", "gpt-test-2026", `Casual staffing pressure is highest at <strong>${name}</strong>`, "High priority", "Recommended: Fill shifts", "Synthetic reference history", "does not change them, create shifts or approve pay",
        // Calculated figures and the reference disclosure are still present and labelled.
        "Staffing by location", "No AI is used in these figures", "labelled synthetic input"]) expect(html).toContain(text);
      // Days the AI did not single out are counted from the calculated figures.
      const unlisted = staffing.outlets.flatMap(outlet => outlet.days.filter(d => (d.casualGapMinutes ?? 0) > 0 && !(outlet.outletId === outletId && d.planningDate === top.date))).length;
      expect(html).toContain(`${unlisted} other planning days also have a casual labour gap not listed above`);
      expect(html).not.toContain("[[L");
      // Nothing operational or financial was created by the AI path.
      expect(await counts(t.db)).toEqual(before);
      expect((await t.db.select().from(auditEvents)).map(event => event.action).filter(action => action.startsWith("AI_"))).toEqual(["AI_STAFFING_ASSESSMENT_CREATED"]);
    } finally { fetchSpy.mockRestore(); await t.close(); }
  });

  it("supersedes an assessment when the deterministic evidence changes, and never shows it as current", async () => {
    const t = await createTestDatabase();
    try {
      const c = await referenceCompany(t.db);
      const manager = await c.manager(0);
      const provider = fakeProvider();
      await generateStaffingAssessment(t.db, manager, "LOCATION", provider, NOW);
      expect((await getStaffingAssessmentView(t.db, manager, "LOCATION", await getWeeklyStaffing(t.db, manager, NOW))).state).toBe("CURRENT");
      // An allocated casual shift on Saturday changes coverage, so the evidence changes.
      const [department] = await createDepartment(t.db, "Sales floor", manager);
      const [policy] = await createWorkPolicy(t.db, { earningsModel: "HOURLY", rateMinor: 1_200 }, "Casual hourly", manager);
      const shift = await createRequirement(t.db, { departmentId: department.id, policyId: policy.id, startsAt: new Date("2026-10-31T09:00:00Z"), endsAt: new Date("2026-10-31T17:00:00Z"), requiredHeadcount: 1 }, manager);
      const { worker } = await createTeamMember(t.db, { firstName: "Casual", surname: "Worker", telephone: "+441132000000", email: "casual@example.test" }, manager);
      const offer = await offerAssignment(t.db, shift.id, worker.id, manager);
      await respondToAssignment(t.db, worker.id, offer.id, 1, "ACCEPTED", true, manager);
      await allocateAssignment(t.db, offer.id, manager);
      const stale = await getStaffingAssessmentView(t.db, manager, "LOCATION", await getWeeklyStaffing(t.db, manager, NOW));
      expect(stale).toMatchObject({ state: "STALE", assessment: null });
      vi.mocked(getDatabase).mockReturnValue(t.db);
      vi.mocked(getConfigurationStatus).mockReturnValue({ databaseConfigured: true, aiConfigured: true } as ReturnType<typeof getConfigurationStatus>);
      vi.mocked(requireScope).mockResolvedValue(manager);
      const html = renderToStaticMarkup(await ManagerWorkspace({ area: "plan" }));
      expect(html).toContain("The planning evidence or assessment method has changed since the last AI assessment");
      expect(html).not.toContain("High priority");
      expect(html).toContain("Generate AI assessment");
      // A new assessment of the new evidence becomes current.
      expect((await generateStaffingAssessment(t.db, manager, "LOCATION", provider, NOW)).generated).toBe(true);
      expect((await getStaffingAssessmentView(t.db, manager, "LOCATION", await getWeeklyStaffing(t.db, manager, NOW))).state).toBe("CURRENT");
      expect(provider.assess).toHaveBeenCalledTimes(2);
    } finally { await t.close(); }
  });

  it("keeps deterministic planning usable and shows no AI text when the provider fails or its output is rejected", async () => {
    const t = await createTestDatabase();
    try {
      const c = await referenceCompany(t.db);
      const timeout: StaffingAssessmentProvider = { provider: "OPENAI", model: "gpt-test", assess: vi.fn(async () => { throw new AiProviderError("TIMEOUT"); }) };
      const result = await generateStaffingAssessment(t.db, c.owner, "ORGANISATION", timeout, NOW);
      expect(result.record).toMatchObject({ status: "FAILED", failureCode: "TIMEOUT", assessment: null, responseModel: null });
      vi.mocked(getDatabase).mockReturnValue(t.db);
      vi.mocked(getConfigurationStatus).mockReturnValue({ databaseConfigured: true, aiConfigured: true } as ReturnType<typeof getConfigurationStatus>);
      vi.mocked(requireScope).mockResolvedValue(c.owner);
      let html = renderToStaticMarkup(await OwnerWorkspace({ area: "forecast" }));
      expect(html).toContain("The latest AI assessment of this planning evidence failed: the AI service did not respond in time");
      expect(html).toContain("Try the AI assessment again");
      expect(html).toContain("Staffing by location");
      expect(html).not.toContain("High priority");

      // A model that changes a calculated figure is rejected and nothing it said is shown.
      const tampered = fakeProvider(input => { const output = validAssessment(input); output.priorities[0].evidence[0].value += 60; return output; });
      expect((await generateStaffingAssessment(t.db, c.owner, "ORGANISATION", tampered, NOW)).record).toMatchObject({ status: "FAILED", failureCode: "VALIDATION_NUMBER_MISMATCH", assessment: null });
      const prose = fakeProvider(input => ({ ...validAssessment(input), summary: "Hire twelve extra staff: 12 shifts needed." }));
      expect((await generateStaffingAssessment(t.db, c.owner, "ORGANISATION", prose, NOW)).record).toMatchObject({ status: "FAILED", failureCode: "VALIDATION_NUMBER_IN_TEXT" });
      const malformed: StaffingAssessmentProvider = { provider: "OPENAI", model: "gpt-test", assess: vi.fn(async () => ({ responseId: null, responseModel: "gpt-test", text: "{not json" })) };
      expect((await generateStaffingAssessment(t.db, c.owner, "ORGANISATION", malformed, NOW)).record).toMatchObject({ status: "FAILED", failureCode: "VALIDATION_SCHEMA" });
      html = renderToStaticMarkup(await OwnerWorkspace({ area: "forecast" }));
      expect(html).toContain("its output did not match the calculated evidence, so it was rejected");
      expect(html).not.toContain("Hire twelve");

      // Not configured: the deterministic page is complete and no assessment is offered or invented.
      vi.mocked(getConfigurationStatus).mockReturnValue({ databaseConfigured: true, aiConfigured: false } as ReturnType<typeof getConfigurationStatus>);
      html = renderToStaticMarkup(await OwnerWorkspace({ area: "forecast" }));
      expect(html).toContain("AI assessment is not configured in this environment");
      expect(html).not.toContain("<button class=\"secondary-button\">Generate AI assessment");
      vi.mocked(getStaffingAssessmentProvider).mockReturnValue(null);
      await expect(generateOwnerAssessmentAction()).rejects.toThrow("REDIRECT:/owner/forecast?ai=not-configured");

      // A failing assessment store never hides the forecast.
      vi.mocked(getConfigurationStatus).mockReturnValue({ databaseConfigured: true, aiConfigured: true } as ReturnType<typeof getConfigurationStatus>);
      const db = new Proxy(t.db, { get: (target, key) => key === "select" ? (...args: unknown[]) => { const query = (target.select as (...a: unknown[]) => { from: (table: unknown) => unknown })(...args); return new Proxy(query, { get: (q, k) => k === "from" ? (table: unknown) => { if (table === aiStaffingAssessments) throw new Error("store down"); return (q.from as (t: unknown) => unknown)(table); } : Reflect.get(q, k) }); } : Reflect.get(target, key) });
      vi.mocked(getDatabase).mockReturnValue(db as typeof t.db);
      html = renderToStaticMarkup(await OwnerWorkspace({ area: "forecast" }));
      expect(html).toContain("Staffing by location");
      expect(html).toContain("AI assessment is unavailable because the staffing evidence could not be loaded");
    } finally { await t.close(); }
  });

  it("scopes assessments: managers see only their own location, owners the organisation, and no tenant sees another's", async () => {
    const t = await createTestDatabase();
    try {
      const c = await referenceCompany(t.db);
      // Another tenant; isolation does not depend on its history.
      const other = await referenceCompany(t.db, { history: false });
      const provider = fakeProvider();
      const [manager0, manager1] = [await c.manager(0), await c.manager(1)];
      // A manager's assessment covers only their own location.
      const located = await generateStaffingAssessment(t.db, manager0, "LOCATION", provider, NOW);
      expect(located.record).toMatchObject({ scopeKey: `LOCATION:${manager0.locationId}`, outletId: manager0.locationId });
      expect(Object.values(located.record.locationKeys as Record<string, string>)).toEqual([manager0.locationId]);
      expect((located.record.input as AssessmentInput).locations).toHaveLength(1);
      // Managers cannot read or create the organisation assessment; workers cannot use either.
      const staffing0 = await getWeeklyStaffing(t.db, manager0, NOW);
      await expect(generateStaffingAssessment(t.db, manager0, "ORGANISATION", provider, NOW)).rejects.toThrow("Access denied.");
      await expect(getStaffingAssessmentView(t.db, manager0, "ORGANISATION", staffing0)).rejects.toThrow("Access denied.");
      const worker: Scope = { ...manager0, role: "TEAM_MEMBER", workerId: randomUUID() };
      await expect(generateStaffingAssessment(t.db, worker, "LOCATION", provider, NOW)).rejects.toThrow("Access denied.");
      await expect(getStaffingAssessmentView(t.db, worker, "LOCATION", staffing0)).rejects.toThrow("Access denied.");
      // Another location's manager sees nothing of it, even when handed every outlet's evidence.
      await generateStaffingAssessment(t.db, c.owner, "ORGANISATION", provider, NOW);
      const everything = await getWeeklyStaffing(t.db, c.owner, NOW);
      const view1 = await getStaffingAssessmentView(t.db, manager1, "LOCATION", everything);
      expect(view1.state).toBe("NONE");
      expect(Object.values(view1.prepared.locationKeys)).toEqual([manager1.locationId]);
      expect((await getStaffingAssessmentView(t.db, c.owner, "ORGANISATION", everything)).prepared.input.locations).toHaveLength(5);
      // The other tenant sees nothing, and a forged scope reads its own organisation only.
      const otherStaffing = await getWeeklyStaffing(t.db, other.owner, NOW);
      expect((await getStaffingAssessmentView(t.db, other.owner, "ORGANISATION", otherStaffing)).state).toBe("NONE");
      expect((await getStaffingAssessmentView(t.db, { ...other.owner, locationId: manager0.locationId }, "LOCATION", everything)).state).toBe("NONE");
      await expect(generateStaffingAssessment(t.db, { ...await other.manager(0), locationId: manager0.locationId }, "LOCATION", provider, NOW)).rejects.toThrow();

      // The manager page shows only the manager's own location.
      vi.mocked(getDatabase).mockReturnValue(t.db);
      vi.mocked(getConfigurationStatus).mockReturnValue({ databaseConfigured: true, aiConfigured: true } as ReturnType<typeof getConfigurationStatus>);
      vi.mocked(requireScope).mockResolvedValue(manager0);
      const html = renderToStaticMarkup(await ManagerWorkspace({ area: "plan" }));
      expect(html).toContain("What to staff first");
      expect(html).toContain(`highest at <strong>${c.rows[0].name}</strong>`);
      for (const row of c.rows.slice(1)) expect(html).not.toContain(row.name);
      expect(html).toContain(`/manager/plan?date=`);
      expect(html).toContain("#add-requirement");
      expect(html).not.toContain("Operational interpretation");
      // The hand-off from a dated priority opens shift planning; nothing is created by it.
      expect(html).not.toMatch(/<details[^>]*id="add-requirement"[^>]* open/);
      expect(renderToStaticMarkup(await ManagerWorkspace({ area: "plan", date: "2026-10-31" }))).toMatch(/<details[^>]*id="add-requirement"[^>]* open/);
      // Through the action, the scope comes from the session only.
      vi.mocked(getStaffingAssessmentProvider).mockReturnValue(provider);
      await expect(generateLocationAssessmentAction()).rejects.toThrow("REDIRECT:/manager/plan?ai=saved");
    } finally { await t.close(); }
  });

  it("does not call the model without planning evidence, and keeps stored assessments immutable and scoped", async () => {
    const t = await createTestDatabase();
    try {
      const organisationId = randomUUID(), outletId = randomUUID();
      await t.db.insert(organisations).values({ id: organisationId, name: "Empty company", country: "United Kingdom" });
      await t.db.insert(subscriptions).values({ id: randomUUID(), organisationId, requestId: randomUUID() });
      await entitled(t.db, organisationId);
      await t.db.insert(outlets).values({ id: outletId, organisationId, name: "Empty store", timezone: "Europe/London" });
      const owner: Scope = { userId: await user(t.db), organisationId, locationId: outletId, role: "OWNER", organisationName: "Empty company", locationName: "Empty store" };
      const provider = fakeProvider();
      await expect(generateStaffingAssessment(t.db, owner, "ORGANISATION", provider, NOW)).rejects.toThrow(NoPlanningEvidenceError);
      expect(provider.assess).not.toHaveBeenCalled();

      const c = await referenceCompany(t.db);
      const { record } = await generateStaffingAssessment(t.db, c.owner, "ORGANISATION", provider, NOW);
      await expect(t.db.update(aiStaffingAssessments).set({ assessment: { summary: "changed" } }).where(eq(aiStaffingAssessments.id, record.id))).rejects.toThrow();
      await expect(t.db.delete(aiStaffingAssessments).where(eq(aiStaffingAssessments.id, record.id))).rejects.toThrow();
      // A location assessment must name a location of its own organisation.
      await expect(t.db.insert(aiStaffingAssessments).values({ ...record, id: randomUUID(), outletId, scopeKey: `LOCATION:${outletId}`, inputFingerprint: "0".repeat(64) })).rejects.toThrow();
      await expect(t.db.insert(aiStaffingAssessments).values({ ...record, id: randomUUID(), assessment: null })).rejects.toThrow();
    } finally { await t.close(); }
  });
});

describe("OpenAI staffing assessment provider", () => {
  it("sends strict structured-output requests without storage, and classifies failures", async () => {
    let body: Record<string, unknown> = {};
    const ok = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => { body = JSON.parse(String(init?.body)); return Response.json({ id: "resp_1", model: "gpt-6-luna-2026", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "{\"a\":1}" }] }] }); });
    const provider = new OpenAiStaffingAssessmentProvider("test-key", "gpt-6-luna", ok as typeof fetch);
    expect(await provider.assess({ instructions: "task", input: "{}", schemaName: "s", schema: { type: "object" } })).toEqual({ responseId: "resp_1", responseModel: "gpt-6-luna-2026", text: "{\"a\":1}" });
    expect(body).toMatchObject({ model: "gpt-6-luna", instructions: "task", input: "{}", store: false, text: { format: { type: "json_schema", name: "s", strict: true, schema: { type: "object" } } } });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fail = (respond: () => Response | Promise<Response>) => new OpenAiStaffingAssessmentProvider("k", "m", vi.fn(async () => respond()) as typeof fetch).assess({ instructions: "", input: "", schemaName: "s", schema: {} });
    await expect(fail(() => { throw new DOMException("t", "TimeoutError"); })).rejects.toMatchObject({ code: "TIMEOUT" });
    await expect(fail(() => { throw new TypeError("fetch failed"); })).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    await expect(fail(() => Response.json({ error: { message: "secret detail" } }, { status: 429 }))).rejects.toMatchObject({ code: "HTTP_429" });
    await expect(fail(() => Response.json({ model: "m", status: "incomplete", output: [] }))).rejects.toMatchObject({ code: "INCOMPLETE" });
    await expect(fail(() => Response.json({ model: "m", status: "completed", output: [{ content: [{ type: "refusal", refusal: "no" }] }] }))).rejects.toMatchObject({ code: "REFUSAL" });
    await expect(fail(() => Response.json({ model: "m", status: "completed", output: [] }))).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
    await expect(fail(() => new Response("<html>", { status: 200 }))).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  });
});
