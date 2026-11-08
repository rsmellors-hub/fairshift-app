import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { Database } from "@/server/db/client";
import { departments, shiftOffers, shifts, workAllocations, workers, workPolicies } from "@/server/db/schema";
import { localDate, shiftDate, startOfLocalDay } from "@/server/intelligence/forecast";
import { SA_REFERENCE_DATASET, SA_REFERENCE_ORGANISATION, saReferenceLocation } from "@/server/reference/sa-reference";
import { allocateAssignment, createDepartment, createRequirement, createWorkPolicy, offerAssignment, respondToAssignment } from "@/server/scheduling/operations";
import { DEMO_SCENARIO_LOCATION } from "./capacity-scenario";

// The booked casual shift that the DEMO capacity scenario's early notice is about (Owner instruction,
// 8 November 2026): tomorrow, by the Johannesburg date, 10:00–14:00 at Rosebank, on the demo's
// R45.00-an-hour casual terms (the Owner-approved demo value). A synthetic casual worker accepts it
// and it is allocated, all through the normal scheduling operations, so every rule that applies to a
// real booking applies here. Demo setup and Reset demo both call this, so the early notice can always
// be shown, whatever the date. An existing booking for tomorrow is kept, so running it again changes
// nothing. It exists only for the fictional South African demo business.
export const DEMO_BOOKING = { department: "Floor", policy: "Casual floor terms", rateMinor: 4_500, startMinute: 10 * 60, endMinute: 14 * 60 } as const;

// Reserved names (RFC 2606, RFC 6761): mail to them can never reach a real person.
export function isSyntheticEmail(email: string | null | undefined) {
  const domain = email?.split("@")[1]?.trim().toLowerCase() ?? "";
  return /(^|\.)(test|example|invalid|localhost)$/.test(domain) || /(^|\.)example\.(com|net|org)$/.test(domain);
}

export type DemoBooking = { shiftId: string; offerId: string; workerId: string; date: string; created: boolean };

export async function ensureDemoBooking(db: Database, input: { organisationId: string; workerId?: string | null; now?: Date }): Promise<DemoBooking | null> {
  if (input.organisationId !== SA_REFERENCE_ORGANISATION.id) return null;
  const now = input.now ?? new Date(), timezone = SA_REFERENCE_DATASET.timezone;
  const rosebank = saReferenceLocation(DEMO_SCENARIO_LOCATION).id, site = { organisationId: input.organisationId, locationId: rosebank };
  const date = shiftDate(localDate(now, timezone), 1), dayStart = startOfLocalDay(date, timezone).getTime();
  return db.transaction(async tx => {
    // One booking per day, however many demo setups or resets run at once.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`demo-booking:${input.organisationId}`}))`);
    const [booked] = await tx.select({ shiftId: shifts.id, offerId: shiftOffers.id, workerId: shiftOffers.workerId })
      .from(workAllocations).innerJoin(shiftOffers, eq(shiftOffers.id, workAllocations.offerId)).innerJoin(shifts, eq(shifts.id, shiftOffers.shiftId)).innerJoin(workers, eq(workers.id, shiftOffers.workerId))
      .where(and(eq(shifts.outletId, rosebank), eq(shifts.shiftDate, date), eq(shifts.status, "PUBLISHED"), eq(shiftOffers.status, "ACCEPTED"), eq(workAllocations.state, "ALLOCATED"), eq(workers.workerType, "CASUAL"))).limit(1);
    if (booked) return { ...booked, date, created: false };
    const casuals = (await tx.select({ id: workers.id, email: workers.email }).from(workers)
      .where(and(eq(workers.organisationId, input.organisationId), eq(workers.locationId, rosebank), eq(workers.workerType, "CASUAL"), eq(workers.status, "ACTIVE"), isNotNull(workers.userId))).orderBy(asc(workers.id)))
      .filter(row => isSyntheticEmail(row.email));
    const worker = casuals.find(row => row.id === input.workerId) ?? casuals[0];
    if (!worker) return null;
    // The operations open their own transactions; inside this one they become savepoints, so the
    // booking is made whole or not at all.
    const session = tx as unknown as Database;
    const [department] = await tx.select().from(departments).where(and(eq(departments.outletId, rosebank), eq(departments.name, DEMO_BOOKING.department))).limit(1);
    const departmentId = department?.id ?? (await createDepartment(session, DEMO_BOOKING.department, site))[0].id;
    const [policy] = await tx.select().from(workPolicies).where(and(eq(workPolicies.outletId, rosebank), eq(workPolicies.name, DEMO_BOOKING.policy), eq(workPolicies.earningsModel, "HOURLY"),
      eq(workPolicies.rateMinor, DEMO_BOOKING.rateMinor), eq(workPolicies.currencyCode, "ZAR"), isNull(workPolicies.incentiveTargetMinor))).limit(1);
    const policyId = policy?.id ?? (await createWorkPolicy(session, { earningsModel: "HOURLY", rateMinor: DEMO_BOOKING.rateMinor }, DEMO_BOOKING.policy, site))[0].id;
    const shift = await createRequirement(session, { departmentId, policyId, startsAt: new Date(dayStart + DEMO_BOOKING.startMinute * 60_000), endsAt: new Date(dayStart + DEMO_BOOKING.endMinute * 60_000), requiredHeadcount: 1 }, site);
    const offer = await offerAssignment(session, shift.id, worker.id, site);
    await respondToAssignment(session, worker.id, offer.id, shift.termsVersion, "ACCEPTED", true, site);
    await allocateAssignment(session, offer.id, site);
    return { shiftId: shift.id, offerId: offer.id, workerId: worker.id, date, created: true };
  });
}
