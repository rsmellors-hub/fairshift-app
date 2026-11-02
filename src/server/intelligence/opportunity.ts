import { STAFFING_METHOD_VERSION, type OutletStaffing, type StaffingDay } from "@/server/intelligence/staffing";
import { formatClock, parseClock, transactionCount, WORKLOAD_FORECAST_METHOD_VERSION, type ServicePeriod } from "@/server/intelligence/workload";

// Opportunity Demand: a time window at one location on one local date where the business's
// own policy asks for more staff than regular cover supplies. Derived on read and never
// stored as demand. Shifts, offers and pay remain the existing workflow's.
export type OpportunityDemand = {
  organisationId: string; outletId: string; localDate: string;
  windowStart: string; windowEnd: string; startsAt: string; endsAt: string;
  state: "OPEN" | "FILLED";
  expectedTransactions: number; lowerTransactions: number; upperTransactions: number; support: "LOW" | "MODERATE" | null;
  commercial: { expectedSalesMinor: number; currency: string } | null;
  requiredMinutes: number; regularMinutes: number; allocatedCasualMinutes: number; remainingCasualMinutes: number; peakCasualStaff: number;
  workloadMethodVersion: string; staffingMethodVersion: string; workloadPolicyVersion: string;
  provenance: { source: string; synthetic: boolean; dataset: string | null; dataThrough: string } | null;
  // Set only when this window's figures include a Manager-accepted contextual scenario.
  acceptedContext?: { scenario: string; adjustmentBps: number; decisionId: string; proposalId: string; policyVersion: string; citedSignalIds: string[] };
};

function toOpportunity(outlet: OutletStaffing, day: StaffingDay, period: ServicePeriod): OpportunityDemand {
  return {
    organisationId: outlet.organisationId, outletId: outlet.outletId, localDate: day.planningDate,
    windowStart: formatClock(period.start), windowEnd: formatClock(period.end), startsAt: period.startsAt, endsAt: period.endsAt,
    state: period.state === "OPEN" ? "OPEN" : "FILLED",
    expectedTransactions: transactionCount(period.expectedMilliTransactions), lowerTransactions: transactionCount(period.lowerMilliTransactions), upperTransactions: transactionCount(period.upperMilliTransactions), support: day.support,
    commercial: outlet.currency ? { expectedSalesMinor: period.expectedSalesMinor, currency: outlet.currency } : null,
    requiredMinutes: period.requiredMinutes, regularMinutes: period.regularMinutes, allocatedCasualMinutes: period.allocatedCasualMinutes, remainingCasualMinutes: period.remainingMinutes, peakCasualStaff: period.peakCasualStaff,
    workloadMethodVersion: WORKLOAD_FORECAST_METHOD_VERSION, staffingMethodVersion: STAFFING_METHOD_VERSION, workloadPolicyVersion: outlet.policy!.version,
    provenance: outlet.evidence && { source: outlet.evidence.source, synthetic: outlet.evidence.source === "REFERENCE" || outlet.evidence.source === "DEMO_SEEDED", dataset: outlet.evidence.dataset, dataThrough: outlet.evidence.dataThrough },
    ...(day.context ? { acceptedContext: { scenario: day.context.scenario, adjustmentBps: day.context.adjustmentBps, decisionId: day.context.decisionId, proposalId: day.context.proposalId, policyVersion: day.context.policyVersion, citedSignalIds: day.context.citedSignalIds } } : {}),
  };
}

// Every window on a day where casual work is, or was, needed.
export function dayOpportunities(outlet: OutletStaffing, day: StaffingDay): OpportunityDemand[] {
  return outlet.policy ? day.periods.filter(period => period.state !== "COVERED").map(period => toOpportunity(outlet, day, period)) : [];
}
export function outletOpportunities(outlet: OutletStaffing) { return outlet.days.flatMap(day => dayOpportunities(outlet, day)); }

// A window reference as carried in a link or form: only ever a pointer, re-read on the server.
export const windowParam = (opportunity: Pick<OpportunityDemand, "windowStart" | "windowEnd">) => `${opportunity.windowStart}-${opportunity.windowEnd}`;
export function parseWindowParam(value: string | null | undefined) {
  const match = value ? /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(value) : null;
  return match && parseClock(match[1]) !== null && parseClock(match[2]) !== null ? { windowStart: match[1], windowEnd: match[2] } : null;
}

// The day's open window to start from: the one named, else the largest remaining.
export function selectOpportunity(opportunities: readonly OpportunityDemand[], window: string | null | undefined) {
  const named = parseWindowParam(window);
  const open = opportunities.filter(row => row.state === "OPEN");
  if (window && !named) return null;
  if (named) return open.find(row => row.windowStart === named.windowStart && row.windowEnd === named.windowEnd) ?? null;
  return open.reduce<OpportunityDemand | null>((best, row) => !best || row.remainingCasualMinutes > best.remainingCasualMinutes ? row : best, null);
}
