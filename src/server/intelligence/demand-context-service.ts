import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { assertRole, type Scope } from "@/server/auth/access";
import { consumeLimit } from "@/server/auth/identity";
import { requireEntitlement } from "@/server/billing/entitlement";
import type { Database } from "@/server/db/client";
import { auditEvents, demandContextDecisions, demandContextProposals, demandContextSignals } from "@/server/db/schema";
import { UserFacingError } from "@/server/domain/errors";
import { AiProviderError, type StaffingAssessmentProvider } from "@/server/integrations/openai/staffing-assessment";
import { CONTEXT_INPUT_VERSION, CONTEXT_INSTRUCTIONS, CONTEXT_OUTPUT_SCHEMA_VERSION, contextJsonSchema, outputFingerprint, validateContextOutput } from "@/server/intelligence/demand-context-contract";
import { DEMAND_CONTEXT_POLICY_VERSION, SCENARIO_ADJUSTMENT_BPS, type DemandScenario } from "@/server/intelligence/demand-context-policy";
import { managerSignalId } from "@/server/intelligence/demand-signals";
import { localDate, shiftDate } from "@/server/intelligence/forecast";
import { getWeeklyStaffing } from "@/server/intelligence/staffing";

// Changes to the contextual layer, for the session's own location only. No form field names a
// location, and the figures are always re-read here. A model is called only when a person asks,
// and a proposal changes nothing until a person accepts it.

type ContextScope = Pick<Scope, "userId" | "organisationId" | "locationId" | "role" | "organisationName" | "locationName">;
const MAX_SIGNAL_DAYS = 14, MAX_DAYS_AHEAD = 60;

async function authorise(db: Database, scope: ContextScope) {
  assertRole(scope as Scope, ["OWNER", "MANAGER"]);
  await requireEntitlement(db, scope.organisationId);
}
const audit = (db: Pick<Database, "insert">, scope: ContextScope, action: string, entityType: string, entityId: string, metadata: Record<string, unknown>) =>
  db.insert(auditEvents).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: scope.locationId, action, entityType, entityId, correlationId: `demand-context:${scope.locationId}`, metadata: { actorUserId: scope.userId, ...metadata } });

async function currentDay(db: Database, scope: ContextScope, date: string, now: Date) {
  const staffing = await getWeeklyStaffing(db, scope as Scope, now);
  const outlet = staffing.outlets.find(row => row.outletId === scope.locationId);
  const day = outlet?.demandContext?.days.find(row => row.date === date) ?? null;
  return { outlet: outlet ?? null, day };
}

const managerSignalSchema = z.object({
  validFrom: z.iso.date(), validTo: z.iso.date(),
  summary: z.string().trim().min(3).max(200).refine(value => !/[\u0000-\u001f\u007f]/.test(value), "No control characters."),
  direction: z.enum(["UP", "DOWN", "UNSPECIFIED"]),
}).strict();

// A Manager's own note about their location. It is recorded as exactly that: never as a
// verified event, whatever it says.
export async function addManagerSignal(db: Database, scope: ContextScope, raw: unknown, now = new Date()) {
  await authorise(db, scope);
  const parsed = managerSignalSchema.safeParse(raw);
  if (!parsed.success) throw new UserFacingError("context-signal-invalid", "Enter the dates, a short description and what you expect.");
  const value = parsed.data;
  const { outlet } = await currentDay(db, scope, value.validFrom, now);
  const today = outlet ? localDate(now, outlet.timezone) : value.validFrom;
  if (value.validTo < value.validFrom || value.validFrom < today || value.validFrom > shiftDate(today, MAX_DAYS_AHEAD) || value.validTo > shiftDate(value.validFrom, MAX_SIGNAL_DAYS - 1)) throw new UserFacingError("context-signal-dates", "Choose dates from today onwards, up to two weeks long.");
  const id = managerSignalId(randomUUID());
  const [row] = await db.insert(demandContextSignals).values({ id, organisationId: scope.organisationId, outletId: scope.locationId, signalType: "MANAGER_ENTERED", validFrom: value.validFrom, validTo: value.validTo, direction: value.direction,
    provenance: "MANAGER_ENTERED", sourceLabel: "Manager entered, not independently verified", sourceRef: null, summary: value.summary, metadata: {}, enteredBy: scope.userId, createdAt: now }).returning();
  await audit(db, scope, "DEMAND_CONTEXT_SIGNAL_ADDED", "demand_context_signal", id, { validFrom: value.validFrom, validTo: value.validTo, direction: value.direction });
  return row;
}

export async function withdrawManagerSignal(db: Database, scope: ContextScope, signalId: string, now = new Date()) {
  await authorise(db, scope);
  const [row] = await db.update(demandContextSignals).set({ withdrawnAt: now, withdrawnBy: scope.userId })
    .where(and(eq(demandContextSignals.id, signalId), eq(demandContextSignals.organisationId, scope.organisationId), eq(demandContextSignals.outletId, scope.locationId), eq(demandContextSignals.signalType, "MANAGER_ENTERED"))).returning();
  if (!row) throw new UserFacingError("context-not-found", "That context is no longer available.");
  await audit(db, scope, "DEMAND_CONTEXT_SIGNAL_WITHDRAWN", "demand_context_signal", signalId, {});
  return row;
}

export type ProposeResult = { record: typeof demandContextProposals.$inferSelect; generated: boolean };

// Asks the model for a bounded scenario on one date. A provider failure or rejected output is
// recorded as a failed attempt, and the baseline and everything from it carry on regardless.
export async function proposeDemandContext(db: Database, scope: ContextScope, date: string, provider: StaffingAssessmentProvider, now = new Date()): Promise<ProposeResult> {
  await authorise(db, scope);
  const { day } = await currentDay(db, scope, date, now);
  if (!day?.input || !day.fingerprint) throw new UserFacingError("context-no-baseline", "There’s no demand baseline for that day.");
  if (!day.signals.length) throw new UserFacingError("context-no-signal", "There’s no context for that day, so there’s nothing to weigh against the baseline.");
  const reusable = async () => (await db.select().from(demandContextProposals).where(and(eq(demandContextProposals.organisationId, scope.organisationId), eq(demandContextProposals.outletId, scope.locationId), eq(demandContextProposals.targetDate, date), eq(demandContextProposals.inputFingerprint, day.fingerprint!), eq(demandContextProposals.status, "AVAILABLE"))))[0];
  // The same evidence is never put to the model twice, so a later call can't replace an answer.
  const existing = await reusable();
  if (existing) return { record: existing, generated: false };
  await consumeLimit(db, `demand-context:${scope.organisationId}:${scope.locationId}`, 20);

  type Outcome = { scenario: DemandScenario; citedSignalIds: string[]; reason: string; responseModel: string; responseId: string | null } | { failureCode: string; responseModel: string | null; responseId: string | null };
  let outcome: Outcome;
  try {
    const response = await provider.assess({ instructions: CONTEXT_INSTRUCTIONS, input: JSON.stringify(day.input), schemaName: "fairshift_demand_context", schema: contextJsonSchema(day.input) });
    let raw: unknown;
    try { raw = JSON.parse(response.text); } catch { raw = undefined; }
    // The evidence is read again: an answer about evidence that has moved isn't used.
    const after = await currentDay(db, scope, date, new Date());
    const validated = validateContextOutput(raw, { organisationId: scope.organisationId, outletId: scope.locationId, date, signals: day.signals, inputFingerprint: day.fingerprint, currentFingerprint: after.day?.fingerprint ?? "" });
    // Which rule rejected it, for diagnosis; never the model's text.
    if (!validated.ok) console.error("Demand context output rejected", { code: validated.code, responseId: response.responseId });
    outcome = validated.ok ? { ...validated.output, responseModel: response.responseModel, responseId: response.responseId } : { failureCode: `VALIDATION_${validated.code}`, responseModel: response.responseModel, responseId: response.responseId };
  } catch (error) {
    outcome = { failureCode: error instanceof AiProviderError ? error.code : "PROVIDER_ERROR", responseModel: null, responseId: null };
  }
  // Calculated and official signals are kept as they were put to the model, with their sources.
  const derived = day.signals.filter(signal => signal.type !== "MANAGER_ENTERED");
  if (derived.length) await db.insert(demandContextSignals).values(derived.map(signal => ({ id: signal.id, organisationId: signal.organisationId, outletId: signal.outletId, signalType: signal.type, validFrom: signal.validFrom, validTo: signal.validTo, direction: signal.direction, provenance: signal.provenance, sourceLabel: signal.sourceLabel, sourceRef: signal.sourceRef, summary: signal.summary, metadata: signal.metadata, createdAt: now }))).onConflictDoNothing();
  const base = { organisationId: scope.organisationId, outletId: scope.locationId, targetDate: date, policyVersion: DEMAND_CONTEXT_POLICY_VERSION, inputVersion: CONTEXT_INPUT_VERSION, outputSchemaVersion: CONTEXT_OUTPUT_SCHEMA_VERSION, inputFingerprint: day.fingerprint, input: day.input,
    provider: provider.provider, model: provider.model, responseModel: outcome.responseModel, providerResponseId: outcome.responseId, requestedBy: scope.userId, createdAt: now };
  const values = "scenario" in outcome
    ? { ...base, id: randomUUID(), status: "AVAILABLE", scenario: outcome.scenario, citedSignalIds: outcome.citedSignalIds, reason: outcome.reason, failureCode: null }
    : { ...base, id: randomUUID(), status: "FAILED", scenario: null, citedSignalIds: null, reason: null, failureCode: outcome.failureCode };
  const [record] = await db.insert(demandContextProposals).values(values).onConflictDoNothing().returning();
  if (!record) return { record: (await reusable())!, generated: false };
  await audit(db, scope, record.status === "AVAILABLE" ? "DEMAND_CONTEXT_PROPOSED" : "DEMAND_CONTEXT_PROPOSAL_FAILED", "demand_context_proposal", record.id, { date, model: record.model, responseModel: record.responseModel, scenario: record.scenario, failureCode: record.failureCode });
  return { record, generated: true };
}

export type ContextAction = "ACCEPTED" | "DISMISSED" | "WITHDRAWN";

// A person's decision on a proposal. The form supplies only the proposal: the scenario and its
// assumption are read here, so no value can be typed in. Accepting or dismissing requires the
// evidence to be unchanged since the proposal. Withdrawing returns the day to its baseline.
export async function decideDemandContext(db: Database, scope: ContextScope, input: { proposalId: string; action: ContextAction }, now = new Date()) {
  await authorise(db, scope);
  const missing = () => new UserFacingError("context-not-found", "That proposal is no longer available.");
  if (!z.uuid().safeParse(input.proposalId).success || !["ACCEPTED", "DISMISSED", "WITHDRAWN"].includes(input.action)) throw missing();
  const [proposal] = await db.select().from(demandContextProposals).where(and(eq(demandContextProposals.id, input.proposalId), eq(demandContextProposals.organisationId, scope.organisationId), eq(demandContextProposals.outletId, scope.locationId), eq(demandContextProposals.status, "AVAILABLE")));
  if (!proposal) throw missing();
  const { day } = await currentDay(db, scope, proposal.targetDate, now);
  if (input.action !== "WITHDRAWN" && (!day || day.fingerprint !== proposal.inputFingerprint)) throw new UserFacingError("context-changed", "The evidence has changed since this was proposed, so it can’t be decided on. Ask for a new proposal.");
  const scenario = proposal.scenario as DemandScenario;
  return db.transaction(async tx => {
    const [locked] = await tx.select({ id: demandContextProposals.id }).from(demandContextProposals).where(eq(demandContextProposals.id, proposal.id)).for("update");
    if (!locked) throw missing();
    const [latest] = await tx.select().from(demandContextDecisions).where(and(eq(demandContextDecisions.outletId, scope.locationId), eq(demandContextDecisions.targetDate, proposal.targetDate))).orderBy(desc(demandContextDecisions.sequence)).limit(1);
    if (input.action === "WITHDRAWN" && (!latest || latest.proposalId !== proposal.id || latest.action === "WITHDRAWN")) throw new UserFacingError("context-not-found", "There’s no decision on this proposal to withdraw.");
    // Pressing a button twice records one decision.
    if (latest && latest.proposalId === proposal.id && latest.action === input.action) return latest;
    const [decision] = await tx.insert(demandContextDecisions).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: scope.locationId, targetDate: proposal.targetDate, sequence: (latest?.sequence ?? 0) + 1, proposalId: proposal.id, action: input.action, scenario, adjustmentBps: SCENARIO_ADJUSTMENT_BPS[scenario],
      policyVersion: proposal.policyVersion, inputFingerprint: proposal.inputFingerprint, outputFingerprint: outputFingerprint({ scenario, citedSignalIds: proposal.citedSignalIds, reason: proposal.reason! }), signalIds: proposal.citedSignalIds, decidedBy: scope.userId, decidedByRole: scope.role, decidedAt: now }).returning();
    await audit(tx as unknown as Database, scope, `DEMAND_CONTEXT_${input.action}`, "demand_context_decision", decision.id, { proposalId: proposal.id, date: proposal.targetDate, scenario, adjustmentBps: decision.adjustmentBps, policyVersion: decision.policyVersion, inputFingerprint: decision.inputFingerprint });
    return decision;
  });
}
