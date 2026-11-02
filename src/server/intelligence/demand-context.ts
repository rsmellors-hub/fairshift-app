import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import type { DatabaseSession } from "@/server/db/client";
import { demandContextDecisions, demandContextProposals, demandContextSignals, outlets } from "@/server/db/schema";
import { prepareContextInput, type ContextInput, type HolidayStatus } from "@/server/intelligence/demand-context-contract";
import { DEMAND_CONTEXT_POLICY_VERSION, SCENARIO_ADJUSTMENT_BPS, type DemandScenario } from "@/server/intelligence/demand-context-policy";
import { bankHolidayDivision, bankHolidaySignal, momentumSignal, signalScopeFailure, type ContextSignal, type SignalDirection, type SignalType } from "@/server/intelligence/demand-signals";
import { isSyntheticSource, type DailySales, type SalesSource } from "@/server/intelligence/forecast";
import type { PlanningBlock } from "@/server/intelligence/workload";

// Reads the contextual layer for a location's planning week. Nothing here calls a model or
// writes. If this layer can't be read, planning carries on from the baseline.

export type StoredContext = {
  meta: ReadonlyMap<string, { province: string | null; country: string | null }>;
  signals: readonly ContextSignal[];
  proposals: readonly (typeof demandContextProposals.$inferSelect)[];
  decisions: readonly (typeof demandContextDecisions.$inferSelect)[];
};

const toSignal = (row: typeof demandContextSignals.$inferSelect): ContextSignal => ({
  id: row.id, organisationId: row.organisationId, outletId: row.outletId, type: row.signalType as SignalType, validFrom: row.validFrom, validTo: row.validTo,
  direction: row.direction as SignalDirection, provenance: row.provenance as ContextSignal["provenance"], sourceLabel: row.sourceLabel, sourceRef: row.sourceRef, summary: row.summary,
  metadata: row.metadata as ContextSignal["metadata"], enteredBy: row.enteredBy, createdAt: row.createdAt, withdrawnAt: row.withdrawnAt,
});

export async function loadStoredContext(db: DatabaseSession, organisationId: string, outletIds: readonly string[], firstDate: string, lastDate: string): Promise<StoredContext> {
  const ids = [...outletIds];
  const [meta, signals, proposals, decisions] = await Promise.all([
    db.select({ id: outlets.id, province: outlets.province, country: outlets.country }).from(outlets).where(and(eq(outlets.organisationId, organisationId), inArray(outlets.id, ids))),
    // Only people's own entries are read back. Calculated and official signals are derived
    // fresh each time, so a stored copy can never stand in for the current calculation.
    db.select().from(demandContextSignals).where(and(eq(demandContextSignals.organisationId, organisationId), inArray(demandContextSignals.outletId, ids), eq(demandContextSignals.signalType, "MANAGER_ENTERED"))).orderBy(desc(demandContextSignals.createdAt)),
    db.select().from(demandContextProposals).where(and(eq(demandContextProposals.organisationId, organisationId), inArray(demandContextProposals.outletId, ids), gte(demandContextProposals.targetDate, firstDate), lte(demandContextProposals.targetDate, lastDate))).orderBy(desc(demandContextProposals.createdAt)),
    db.select().from(demandContextDecisions).where(and(eq(demandContextDecisions.organisationId, organisationId), inArray(demandContextDecisions.outletId, ids), gte(demandContextDecisions.targetDate, firstDate), lte(demandContextDecisions.targetDate, lastDate))).orderBy(desc(demandContextDecisions.sequence)),
  ]);
  return { meta: new Map(meta.map(row => [row.id, row])), signals: signals.map(toSignal), proposals, decisions };
}

export type AppliedContext = { scenario: DemandScenario; adjustmentBps: number; decisionId: string; proposalId: string; policyVersion: string; citedSignalIds: string[] };
export type ContextProposal = { id: string; scenario: DemandScenario; adjustmentBps: number; citedSignalIds: string[]; reason: string; provider: string; model: string; responseModel: string | null; createdAt: Date };
export type ContextDecision = { id: string; action: "ACCEPTED" | "DISMISSED" | "WITHDRAWN"; scenario: DemandScenario; adjustmentBps: number; decidedAt: Date; decidedByRole: string; proposalId: string };
export type ContextDayState = "NO_SIGNAL" | "READY" | "FAILED" | "PROPOSED" | "ACCEPTED" | "DISMISSED" | "STALE_ACCEPTANCE";
export type ContextDay = {
  date: string; state: ContextDayState;
  signals: ContextSignal[]; holidayStatus: HolidayStatus;
  input: ContextInput | null; fingerprint: string | null;
  proposal: ContextProposal | null;
  failureCode: string | null;
  // An accepted decision made on evidence that has since changed. It no longer applies.
  staleDecision: ContextDecision | null;
  decision: ContextDecision | null;
  // What the proposal would do, from the same calculation. Not applied. Null when none is shown.
  preview: { expectedMilliTransactions: number | null; requiredMinutes: number | null; casualGapMinutes: number | null } | null;
};
export type OutletDemandContext = { status: "AVAILABLE" | "UNAVAILABLE"; days: ContextDay[]; accepted: ReadonlyMap<string, AppliedContext> };
export const UNAVAILABLE_CONTEXT: OutletDemandContext = { status: "UNAVAILABLE", days: [], accepted: new Map() };

type BaselineDay = { planningDate: string; expectedMilliTransactions: number | null; lowerMilliTransactions: number | null; upperMilliTransactions: number | null; support: "LOW" | "MODERATE" | null; closed: boolean | null; blocks: PlanningBlock[] };

// One outlet's week of context, worked out from its baseline. An accepted scenario applies only
// when its decision still stands, was made under this policy, and its fingerprint matches the
// evidence now: otherwise the day is back on its baseline and says so.
export function resolveOutletContext(input: {
  organisationId: string; outletId: string; stored: StoredContext; days: readonly BaselineDay[];
  evidence: { source: SalesSource; dataThrough: string } | null; evidenceDays: readonly DailySales[];
}): OutletDemandContext {
  const { organisationId, outletId, stored, evidence } = input;
  const location = stored.meta.get(outletId) ?? { province: null, country: null };
  const division = bankHolidayDivision(location);
  const momentum = evidence ? momentumSignal({ organisationId, outletId, source: evidence.source, synthetic: isSyntheticSource(evidence.source), days: input.evidenceDays, dataThrough: evidence.dataThrough }) : null;
  const managerSignals = stored.signals.filter(signal => signal.outletId === outletId && signal.organisationId === organisationId);
  const accepted = new Map<string, AppliedContext>();
  const days = input.days.map((day): ContextDay => {
    const date = day.planningDate;
    const holiday = division ? bankHolidaySignal({ organisationId, outletId, division, date }) : null;
    const holidayStatus: HolidayStatus = !division ? "NATION_NOT_STATED" : holiday ? "HOLIDAY_ON_DATE" : "NO_HOLIDAY_ON_DATE";
    const scope = { organisationId, outletId, date };
    const signals = [...(momentum ? [momentum] : []), ...(holiday ? [holiday] : []), ...managerSignals].filter(signal => !signalScopeFailure(signal, scope));
    const hasBaseline = !day.closed && !!evidence && day.expectedMilliTransactions !== null && day.lowerMilliTransactions !== null && day.upperMilliTransactions !== null;
    const empty = { date, signals, holidayStatus, proposal: null, failureCode: null, staleDecision: null, decision: null, preview: null };
    if (!hasBaseline) return { ...empty, state: "NO_SIGNAL", input: null, fingerprint: null };
    const prepared = prepareContextInput({ organisationId, outletId, date, blocks: day.blocks, expectedMilliTransactions: day.expectedMilliTransactions!, lowerMilliTransactions: day.lowerMilliTransactions!, upperMilliTransactions: day.upperMilliTransactions!, support: day.support,
      evidence: { source: evidence!.source, synthetic: isSyntheticSource(evidence!.source), dataThrough: evidence!.dataThrough }, signals, holidayStatus });
    const here = <T extends { outletId: string; targetDate: string }>(rows: readonly T[]) => rows.filter(row => row.outletId === outletId && row.targetDate === date);
    const rows = here(stored.proposals), matching = rows.filter(row => row.inputFingerprint === prepared.fingerprint);
    const current = matching.find(row => row.status === "AVAILABLE");
    const proposal: ContextProposal | null = current ? { id: current.id, scenario: current.scenario as DemandScenario, adjustmentBps: SCENARIO_ADJUSTMENT_BPS[current.scenario as DemandScenario], citedSignalIds: current.citedSignalIds as string[], reason: current.reason!, provider: current.provider, model: current.model, responseModel: current.responseModel, createdAt: current.createdAt } : null;
    const latest = here(stored.decisions)[0];
    const decision: ContextDecision | null = latest ? { id: latest.id, action: latest.action as ContextDecision["action"], scenario: latest.scenario as DemandScenario, adjustmentBps: latest.adjustmentBps, decidedAt: latest.decidedAt, decidedByRole: latest.decidedByRole, proposalId: latest.proposalId } : null;
    const base = { ...empty, input: prepared.input, fingerprint: prepared.fingerprint, proposal };
    if (latest && latest.action === "ACCEPTED") {
      const stands = latest.inputFingerprint === prepared.fingerprint && latest.policyVersion === DEMAND_CONTEXT_POLICY_VERSION && SCENARIO_ADJUSTMENT_BPS[latest.scenario as DemandScenario] === latest.adjustmentBps;
      if (stands) {
        accepted.set(date, { scenario: latest.scenario as DemandScenario, adjustmentBps: latest.adjustmentBps, decisionId: latest.id, proposalId: latest.proposalId, policyVersion: latest.policyVersion, citedSignalIds: rows.find(row => row.id === latest.proposalId)?.citedSignalIds as string[] ?? [] });
        return { ...base, state: "ACCEPTED", decision };
      }
      return { ...base, state: "STALE_ACCEPTANCE", staleDecision: decision };
    }
    if (latest?.action === "DISMISSED" && latest.inputFingerprint === prepared.fingerprint) return { ...base, state: "DISMISSED", decision };
    if (proposal) return { ...base, state: "PROPOSED" };
    if (!signals.length) return { ...base, state: "NO_SIGNAL" };
    const failed = matching[0];
    return failed?.status === "FAILED" ? { ...base, state: "FAILED", failureCode: failed.failureCode } : { ...base, state: "READY" };
  });
  return { status: "AVAILABLE", days, accepted };
}
