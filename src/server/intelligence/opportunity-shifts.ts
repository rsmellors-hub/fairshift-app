import { and, eq, inArray } from "drizzle-orm";
import type { Scope } from "@/server/auth/access";
import type { Database, DatabaseSession } from "@/server/db/client";
import { shiftOpportunityEvidence } from "@/server/db/schema";
import { UserFacingError } from "@/server/domain/errors";
import { dayOpportunities, parseWindowParam, selectOpportunity, type OpportunityDemand } from "@/server/intelligence/opportunity";
import { getWeeklyStaffing } from "@/server/intelligence/staffing";
import { createRequirement } from "@/server/scheduling/operations";

export type ShiftOpportunityEvidence = typeof shiftOpportunityEvidence.$inferSelect;

// Creates a shift from a current opportunity, keeping a frozen record of why. The window is
// only a pointer: the figures are recalculated here for this session's own location, so a
// form can neither invent evidence nor reach another location. Pay comes from the work
// policy through the existing path and never from this evidence.
export async function createShiftFromOpportunity(db: Database, input: { departmentId: string; policyId: string; startsAt: Date; endsAt: Date; requiredHeadcount: number; date: string; window: string }, scope: Scope, now = new Date()) {
  const staffing = await getWeeklyStaffing(db, scope, now);
  const outlet = staffing.outlets.find(row => row.outletId === scope.locationId);
  const day = outlet?.days.find(row => row.planningDate === input.date);
  const opportunity = outlet && day ? selectOpportunity(dayOpportunities(outlet, day), input.window) : null;
  if (!parseWindowParam(input.window) || !opportunity) throw new UserFacingError("opportunity-changed", "This casual requirement has changed. Check the latest figures.");
  if (input.startsAt.getTime() >= Date.parse(opportunity.endsAt) || input.endsAt.getTime() <= Date.parse(opportunity.startsAt)) throw new UserFacingError("opportunity-outside-window", "This shift doesn’t overlap the time it’s meant to cover.");
  const requirement = { departmentId: input.departmentId, policyId: input.policyId, startsAt: input.startsAt, endsAt: input.endsAt, requiredHeadcount: input.requiredHeadcount };
  return db.transaction(async tx => {
    const shift = await createRequirement(tx as unknown as Database, requirement, scope);
    await tx.insert(shiftOpportunityEvidence).values({ shiftId: shift.id, organisationId: scope.organisationId, outletId: scope.locationId, localDate: opportunity.localDate,
      windowStartsAt: new Date(opportunity.startsAt), windowEndsAt: new Date(opportunity.endsAt), evidence: opportunity, createdBy: scope.userId, createdAt: now });
    return shift;
  });
}

// The recorded reason for these shifts, within the viewer's organisation and location.
export async function getShiftOpportunityEvidence(db: DatabaseSession, scope: Pick<Scope, "organisationId" | "locationId">, shiftIds: readonly string[]) {
  if (!shiftIds.length) return new Map<string, OpportunityDemand>();
  const rows = await db.select().from(shiftOpportunityEvidence).where(and(eq(shiftOpportunityEvidence.organisationId, scope.organisationId), eq(shiftOpportunityEvidence.outletId, scope.locationId), inArray(shiftOpportunityEvidence.shiftId, [...shiftIds])));
  return new Map(rows.map(row => [row.shiftId, row.evidence as OpportunityDemand]));
}
