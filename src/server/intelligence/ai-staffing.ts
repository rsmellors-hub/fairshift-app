import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";

import { assertRole, type Scope } from "@/server/auth/access";
import { consumeLimit } from "@/server/auth/identity";
import { requireEntitlement } from "@/server/billing/entitlement";
import type { Database, DatabaseSession } from "@/server/db/client";
import { aiStaffingAssessments, auditEvents } from "@/server/db/schema";
import { AiProviderError, type StaffingAssessmentProvider } from "@/server/integrations/openai/staffing-assessment";
import { AI_INPUT_VERSION, AI_OUTPUT_SCHEMA_VERSION, ASSESSMENT_INSTRUCTIONS, assessmentJsonSchema, prepareAssessmentInput, validateAssessment, type AssessmentInput, type PreparedInput, type StaffingAssessment } from "@/server/intelligence/ai-staffing-contract";
import { getWeeklyStaffing, type WeeklyStaffing } from "@/server/intelligence/staffing";

// AI-assisted interpretation of the deterministic staffing week. Reading never calls
// the model: a stored assessment is shown only while its input fingerprint matches
// the current evidence. A model call happens only when a manager or owner asks for
// one, and its output is stored only after validation against that evidence.

export type AssessmentKind = "ORGANISATION" | "LOCATION";
type AssessmentScope = Pick<Scope, "userId" | "organisationId" | "locationId" | "role">;
export type StoredAssessment = typeof aiStaffingAssessments.$inferSelect;
export type AssessmentView = {
  state: "CURRENT" | "STALE" | "FAILED" | "NONE";
  // The current deterministic input, used to show the evidence behind each priority.
  prepared: PreparedInput;
  assessment: StaffingAssessment | null;
  record: Pick<StoredAssessment, "id" | "createdAt" | "model" | "responseModel" | "provider" | "failureCode"> | null;
};

export class NoPlanningEvidenceError extends Error {
  constructor() { super("There is no forecast staffing evidence to assess."); this.name = "NoPlanningEvidenceError"; }
}

const scopeKey = (kind: AssessmentKind, scope: AssessmentScope) => kind === "ORGANISATION" ? "ORGANISATION" : `LOCATION:${scope.locationId}`;

// Organisation assessments are the Owner's; a location assessment covers only the
// actor's own (or, for an Owner, currently selected) location.
function authorise(kind: AssessmentKind, scope: AssessmentScope) {
  assertRole(scope as Scope, kind === "ORGANISATION" ? ["OWNER"] : ["OWNER", "MANAGER"]);
}
function scopedStaffing(staffing: Pick<WeeklyStaffing, "methodVersion" | "workloadMethodVersion" | "outlets">, kind: AssessmentKind, scope: AssessmentScope) {
  return kind === "ORGANISATION" ? staffing : { ...staffing, outlets: staffing.outlets.filter(outlet => outlet.outletId === scope.locationId) };
}

export async function getStaffingAssessmentView(db: DatabaseSession, scope: AssessmentScope, kind: AssessmentKind, staffing: Pick<WeeklyStaffing, "methodVersion" | "workloadMethodVersion" | "outlets">): Promise<AssessmentView> {
  authorise(kind, scope);
  const prepared = prepareAssessmentInput(scopedStaffing(staffing, kind, scope), kind);
  const rows = await db.select().from(aiStaffingAssessments)
    .where(and(eq(aiStaffingAssessments.organisationId, scope.organisationId), eq(aiStaffingAssessments.scopeKey, scopeKey(kind, scope))))
    .orderBy(desc(aiStaffingAssessments.createdAt)).limit(20);
  const pick = (row: StoredAssessment) => ({ id: row.id, createdAt: row.createdAt, model: row.model, responseModel: row.responseModel, provider: row.provider, failureCode: row.failureCode });
  const current = rows.find(row => row.status === "AVAILABLE" && row.inputFingerprint === prepared.fingerprint);
  if (current) return { state: "CURRENT", prepared, assessment: current.assessment as StaffingAssessment, record: pick(current) };
  const failed = rows.find(row => row.inputFingerprint === prepared.fingerprint);
  if (failed) return { state: "FAILED", prepared, assessment: null, record: pick(failed) };
  // An assessment of different evidence is never presented as current.
  const older = rows.find(row => row.status === "AVAILABLE");
  return { state: older ? "STALE" : "NONE", prepared, assessment: null, record: older ? pick(older) : null };
}

export type GenerateResult = { record: StoredAssessment; generated: boolean };

export async function generateStaffingAssessment(db: Database, scope: AssessmentScope, kind: AssessmentKind, provider: StaffingAssessmentProvider, now = new Date()): Promise<GenerateResult> {
  authorise(kind, scope);
  await requireEntitlement(db, scope.organisationId);
  const staffing = await getWeeklyStaffing(db, scope as Scope, now);
  const prepared = prepareAssessmentInput(scopedStaffing(staffing, kind, scope), kind);
  if (!prepared.hasEvidence) throw new NoPlanningEvidenceError();
  const key = scopeKey(kind, scope);
  const existing = async () => (await db.select().from(aiStaffingAssessments).where(and(eq(aiStaffingAssessments.organisationId, scope.organisationId),
    eq(aiStaffingAssessments.scopeKey, key), eq(aiStaffingAssessments.inputFingerprint, prepared.fingerprint), eq(aiStaffingAssessments.status, "AVAILABLE"))))[0];
  // The same evidence is never assessed twice.
  const reuse = await existing();
  if (reuse) return { record: reuse, generated: false };
  await consumeLimit(db, `ai-staffing:${scope.organisationId}:${key}`, 10);

  let outcome: { assessment: StaffingAssessment; responseModel: string; responseId: string | null } | { failureCode: string; responseModel: string | null; responseId: string | null };
  try {
    const response = await provider.assess({ instructions: ASSESSMENT_INSTRUCTIONS, input: JSON.stringify(prepared.input), schemaName: "fairshift_staffing_assessment", schema: assessmentJsonSchema(prepared.input) });
    let raw: unknown;
    try { raw = JSON.parse(response.text); } catch { raw = undefined; }
    const validated = validateAssessment(raw, prepared.input);
    // Which rule and field rejected it, for diagnosis; never the model's text.
    if (!validated.ok) console.error("AI staffing assessment rejected", { code: validated.code, detail: validated.detail, responseId: response.responseId });
    outcome = validated.ok
      ? { assessment: validated.assessment, responseModel: response.responseModel, responseId: response.responseId }
      : { failureCode: `VALIDATION_${validated.code}`, responseModel: response.responseModel, responseId: response.responseId };
  } catch (error) {
    outcome = { failureCode: error instanceof AiProviderError ? error.code : "PROVIDER_ERROR", responseModel: null, responseId: null };
  }

  const base = {
    organisationId: scope.organisationId, outletId: kind === "LOCATION" ? scope.locationId : null, scopeKey: key,
    inputVersion: AI_INPUT_VERSION, outputSchemaVersion: AI_OUTPUT_SCHEMA_VERSION, inputFingerprint: prepared.fingerprint,
    input: prepared.input, locationKeys: prepared.locationKeys, planningStart: prepared.input.planningPeriod?.firstDate ?? null,
    planningEnd: prepared.input.planningPeriod?.lastDate ?? null, evidenceThrough: prepared.evidenceThrough,
    provider: provider.provider, model: provider.model, responseModel: outcome.responseModel, providerResponseId: outcome.responseId,
    requestedBy: scope.userId, createdAt: now,
  };
  const values = "assessment" in outcome
    ? { ...base, id: randomUUID(), status: "AVAILABLE", assessment: outcome.assessment, failureCode: null }
    : { ...base, id: randomUUID(), status: "FAILED", assessment: null, failureCode: outcome.failureCode };
  const [record] = await db.insert(aiStaffingAssessments).values(values).onConflictDoNothing().returning();
  // A concurrent request stored an assessment of the same evidence first.
  if (!record) return { record: (await existing())!, generated: false };
  await db.insert(auditEvents).values({ id: randomUUID(), organisationId: scope.organisationId, outletId: kind === "LOCATION" ? scope.locationId : null,
    action: record.status === "AVAILABLE" ? "AI_STAFFING_ASSESSMENT_CREATED" : "AI_STAFFING_ASSESSMENT_FAILED", entityType: "ai_staffing_assessment", entityId: record.id,
    correlationId: `ai-staffing:${prepared.fingerprint}`, metadata: { actorUserId: scope.userId, kind, model: record.model, responseModel: record.responseModel, failureCode: record.failureCode } });
  return { record, generated: true };
}

export type { AssessmentInput };
