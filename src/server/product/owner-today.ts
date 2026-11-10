import { and, asc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { assertRole, type Scope } from "@/server/auth/access";
import type { DatabaseSession } from "@/server/db/client";
import { offerRounds, outlets, payAgentEvents, payQueries, shiftOffers, shifts, teamInvitations, workAllocations, workPayables, workPayouts } from "@/server/db/schema";
import type { WeeklyStaffing } from "@/server/intelligence/staffing";
import { approvedShiftFor } from "@/server/scheduling/shift-suggestions";
import { suggestShifts } from "@/server/scheduling/shift-rules";

// Owner Today's "Needs you" and KPI tiles (design: OwnerToday, 10 Nov 2026). Each count is read from the
// records that make it true, and each item links to the one place it's resolved.
export type TodayNeeds = {
  suggestions: { count: number; locations: string[] };
  // Each count also names one location where it's true, so its link opens Pay at that location.
  held: number; heldAt: string | null;
  unconfirmed: { count: number; amountMinor: number; currency: string | null; at: string | null };
  invitations: { count: number; firstSent: Date | null; firstExpiry: Date | null };
  failedPayouts: number; failedAt: string | null;
  queries: number; queriesAt: string | null;
  offers: { open: number; accepted: number; nextClose: Date | null };
};

export async function getTodayNeeds(db: DatabaseSession, scope: Scope, week: WeeklyStaffing | null, now = new Date()): Promise<TodayNeeds> {
  assertRole(scope, ["OWNER"]);
  const places = await db.select({ id: outlets.id }).from(outlets).where(and(eq(outlets.organisationId, scope.organisationId), eq(outlets.active, true)));
  const ids = places.map(place => place.id);
  // Suggested shifts not yet approved, from the same cut as Fill shifts.
  let count = 0; const named = new Set<string>();
  for (const outlet of week?.outlets ?? []) {
    for (const suggestion of suggestShifts(outlet).filter(row => Date.parse(row.startsAt) > now.getTime())) {
      if ((await approvedShiftFor(db, { locationId: outlet.outletId }, suggestion)).length) continue;
      count += 1; named.add(outlet.outletName);
    }
  }
  if (!ids.length) return { suggestions: { count, locations: [...named] }, held: 0, heldAt: null, unconfirmed: { count: 0, amountMinor: 0, currency: null, at: null }, invitations: { count: 0, firstSent: null, firstExpiry: null }, failedPayouts: 0, failedAt: null, queries: 0, queriesAt: null, offers: { open: 0, accepted: 0, nextClose: null } };
  const [[held], unconfirmed, invitations, [failed], offers, [round]] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int`, at: sql<string | null>`min(${payAgentEvents.outletId}::text)` }).from(payAgentEvents).where(and(eq(payAgentEvents.organisationId, scope.organisationId), eq(payAgentEvents.decision, "HOLD"), isNull(payAgentEvents.resolution))),
    db.select({ pay: shifts.guaranteedBasePayMinor, currency: shifts.currencyCode, at: shifts.outletId }).from(workAllocations).innerJoin(shiftOffers, eq(shiftOffers.id, workAllocations.offerId)).innerJoin(shifts, eq(shifts.id, shiftOffers.shiftId))
      .where(and(inArray(shifts.outletId, ids), eq(workAllocations.state, "ALLOCATED"), isNull(workAllocations.confirmedAt), lt(shifts.endsAt, now))),
    db.select({ createdAt: teamInvitations.createdAt, expiresAt: teamInvitations.expiresAt }).from(teamInvitations)
      .where(and(eq(teamInvitations.organisationId, scope.organisationId), inArray(teamInvitations.state, ["CREATED_NOT_SENT", "SENT", "DELIVERY_FAILED"]))).orderBy(asc(teamInvitations.createdAt)),
    db.select({ n: sql<number>`count(*)::int`, at: sql<string | null>`min(${workPayouts.outletId}::text)` }).from(workPayouts).where(and(eq(workPayouts.organisationId, scope.organisationId), eq(workPayouts.status, "FAILED"))),
    db.select({ status: shiftOffers.status }).from(shiftOffers).innerJoin(shifts, eq(shifts.id, shiftOffers.shiftId)).where(and(inArray(shifts.outletId, ids), gt(shifts.startsAt, now), inArray(shiftOffers.status, ["OFFERED", "ACCEPTED"]))),
    db.select({ closesAt: sql<Date | null>`min(${offerRounds.closesAt})` }).from(offerRounds).where(and(eq(offerRounds.organisationId, scope.organisationId), gt(offerRounds.closesAt, now))),
  ]);
  // Workers' open questions about a shift's pay, answered by the Owner.
  const [asked] = await db.select({ n: sql<number>`count(*)::int`, at: sql<string | null>`min(${payQueries.outletId}::text)` }).from(payQueries).where(and(eq(payQueries.organisationId, scope.organisationId), eq(payQueries.status, "OPEN")));
  // Payables still pending review also count as pay to confirm.
  const [pending] = await db.select({ n: sql<number>`count(*)::int`, at: sql<string | null>`min(${workPayables.outletId}::text)`, amount: sql<number>`coalesce(sum(${workPayables.baseAmountMinor}), 0)::bigint` }).from(workPayables).where(and(eq(workPayables.organisationId, scope.organisationId), eq(workPayables.status, "PENDING_REVIEW")));
  // Only an active location can be opened; otherwise the link opens Pay at the current one.
  const open = (id: string | null | undefined) => id && ids.includes(id) ? id : null;
  return {
    suggestions: { count, locations: [...named] },
    held: held?.n ?? 0, heldAt: open(held?.at),
    unconfirmed: { count: unconfirmed.length + (pending?.n ?? 0), amountMinor: unconfirmed.reduce((sum, row) => sum + Number(row.pay), 0) + Number(pending?.amount ?? 0), currency: unconfirmed[0]?.currency ?? null, at: open(unconfirmed[0]?.at ?? pending?.at) },
    invitations: { count: invitations.length, firstSent: invitations[0]?.createdAt ?? null, firstExpiry: invitations[0]?.expiresAt ?? null },
    failedPayouts: failed?.n ?? 0, failedAt: open(failed?.at),
    queries: asked?.n ?? 0, queriesAt: open(asked?.at),
    offers: { open: offers.filter(row => row.status === "OFFERED").length, accepted: offers.filter(row => row.status === "ACCEPTED").length, nextClose: round?.closesAt ? new Date(round.closesAt) : null },
  };
}
