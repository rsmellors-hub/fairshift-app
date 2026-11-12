import { and, asc, eq, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import { UserFacingError } from "@/server/domain/errors";
import { isReservedTestAddress } from "@/server/domain/reserved-email";
import type { Database, DatabaseSession } from "@/server/db/client";
import { randomUUID } from "node:crypto";
import { auditEvents, departments, shiftOffers, shifts, workAllocations, workers, workPolicies } from "@/server/db/schema";
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
export const isSyntheticEmail = isReservedTestAddress;

export type DemoBooking = { shiftId: string; offerId: string; workerId: string; date: string; created: boolean };

// Two ways in. Keeping (demo setup, the hourly scheduler, entering the demo): a booking is made only
// when tomorrow at Rosebank has no shift at all and no demo booking was ever made for that date, so
// whatever happened to it (an early notice sent, a cancellation, a judge's own shift) stands until
// Reset demo. Rebuilding (Reset demo only, after it has closed live shifts): a fresh booking is made
// when no live one exists. Either way nothing is notified: the booking goes through the scheduling
// operations, which send no messages, and an early notice is only ever sent by an Owner.
export async function ensureDemoBooking(db: Database, input: { organisationId: string; workerId?: string | null; now?: Date; rebuild?: boolean }): Promise<DemoBooking | null> {
  if (input.organisationId !== SA_REFERENCE_ORGANISATION.id) return null;
  const now = input.now ?? new Date(), timezone = SA_REFERENCE_DATASET.timezone;
  const rosebank = saReferenceLocation(DEMO_SCENARIO_LOCATION).id, site = { organisationId: input.organisationId, locationId: rosebank };
  const date = shiftDate(localDate(now, timezone), 1), dayStart = startOfLocalDay(date, timezone).getTime();
  return db.transaction(async tx => {
    // One booking per day, however many demo setups, resets and scheduler passes run at once.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`demo-booking:${input.organisationId}`}))`);
    const [booked] = await tx.select({ shiftId: shifts.id, offerId: shiftOffers.id, workerId: shiftOffers.workerId })
      .from(workAllocations).innerJoin(shiftOffers, eq(shiftOffers.id, workAllocations.offerId)).innerJoin(shifts, eq(shifts.id, shiftOffers.shiftId)).innerJoin(workers, eq(workers.id, shiftOffers.workerId))
      .where(and(eq(shifts.outletId, rosebank), eq(shifts.shiftDate, date), eq(shifts.status, "PUBLISHED"), eq(shiftOffers.status, "ACCEPTED"), eq(workAllocations.state, "ALLOCATED"), eq(workers.workerType, "CASUAL"))).limit(1);
    if (booked) return { ...booked, date, created: false };
    if (!input.rebuild) {
      // The daily open offer's own shift (ensureDemoOpenOffer) doesn't count as a judge's shift.
      const offered = await demoOfferShiftIds(tx, input.organisationId, date);
      const [anyShift] = await tx.select({ id: shifts.id }).from(shifts).where(and(eq(shifts.outletId, rosebank), eq(shifts.shiftDate, date), offered.length ? notInArray(shifts.id, offered) : undefined)).limit(1);
      const [madeBefore] = await tx.select({ id: auditEvents.id }).from(auditEvents)
        .where(and(eq(auditEvents.organisationId, input.organisationId), eq(auditEvents.action, "DEMO_BOOKING_CREATED"), sql`${auditEvents.metadata}->>'date' = ${date}`)).limit(1);
      if (anyShift || madeBefore) return null;
    }
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
    const [policy] = await tx.select().from(workPolicies).where(and(eq(workPolicies.outletId, rosebank), eq(workPolicies.name, DEMO_BOOKING.policy), isNull(workPolicies.supersededAt), eq(workPolicies.earningsModel, "HOURLY"),
      eq(workPolicies.rateMinor, DEMO_BOOKING.rateMinor), eq(workPolicies.currencyCode, "ZAR"), isNull(workPolicies.incentiveTargetMinor))).limit(1);
    const policyId = policy?.id ?? (await createWorkPolicy(session, { earningsModel: "HOURLY", rateMinor: DEMO_BOOKING.rateMinor }, DEMO_BOOKING.policy, site))[0].id;
    const shift = await createRequirement(session, { departmentId, policyId, startsAt: new Date(dayStart + DEMO_BOOKING.startMinute * 60_000), endsAt: new Date(dayStart + DEMO_BOOKING.endMinute * 60_000), requiredHeadcount: 1 }, site);
    const offer = await offerAssignment(session, shift.id, worker.id, site);
    await respondToAssignment(session, worker.id, offer.id, shift.termsVersion, "ACCEPTED", true, site);
    await allocateAssignment(session, offer.id, site);
    await tx.insert(auditEvents).values({ id: randomUUID(), organisationId: input.organisationId, outletId: rosebank, action: "DEMO_BOOKING_CREATED", entityType: "shift", entityId: shift.id,
      correlationId: `demo-booking:${date}`, metadata: { date, offerId: offer.id, workerId: worker.id, rebuild: !!input.rebuild } });
    return { shiftId: shift.id, offerId: offer.id, workerId: worker.id, date, created: true };
  });
}

// The daily open offer (Owner instruction, 12 November 2026): with the public demo off, judges sign in
// to the demo business, and each day the Judge Worker has one open offer to answer, for the day after
// tomorrow at Rosebank (15:00–19:00, the same casual terms). It is made through the normal scheduling
// operations (createRequirement, offerAssignment), so the clash and availability checks apply; when they
// refuse it, nothing is kept for that day. Once per date, recorded as DEMO_OFFER_CREATED, whatever the
// worker then does with it. Demo business only.
export const DEMO_OFFER = { startMinute: 15 * 60, endMinute: 19 * 60 } as const;
async function demoOfferShiftIds(db: DatabaseSession, organisationId: string, date: string) {
  const rows = await db.select({ shiftId: auditEvents.entityId }).from(auditEvents)
    .where(and(eq(auditEvents.organisationId, organisationId), eq(auditEvents.action, "DEMO_OFFER_CREATED"), sql`${auditEvents.metadata}->>'date' = ${date}`));
  return rows.map(row => row.shiftId).filter((id): id is string => !!id);
}
export type DemoOffer = { shiftId: string | null; offerId: string | null; workerId: string; date: string; created: boolean; refused?: string };
export async function ensureDemoOpenOffer(db: Database, input: { organisationId: string; workerId: string; now?: Date }): Promise<DemoOffer | null> {
  if (input.organisationId !== SA_REFERENCE_ORGANISATION.id) return null;
  const now = input.now ?? new Date(), timezone = SA_REFERENCE_DATASET.timezone;
  const rosebank = saReferenceLocation(DEMO_SCENARIO_LOCATION).id, site = { organisationId: input.organisationId, locationId: rosebank };
  const date = shiftDate(localDate(now, timezone), 2), dayStart = startOfLocalDay(date, timezone).getTime();
  try {
    return await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`demo-offer:${input.organisationId}`}))`);
      const [made] = await demoOfferShiftIds(tx, input.organisationId, date);
      if (made) return { shiftId: made, offerId: null, workerId: input.workerId, date, created: false };
      const session = tx as unknown as Database;
      const [department] = await tx.select().from(departments).where(and(eq(departments.outletId, rosebank), eq(departments.name, DEMO_BOOKING.department))).limit(1);
      const departmentId = department?.id ?? (await createDepartment(session, DEMO_BOOKING.department, site))[0].id;
      const [policy] = await tx.select().from(workPolicies).where(and(eq(workPolicies.outletId, rosebank), eq(workPolicies.name, DEMO_BOOKING.policy), isNull(workPolicies.supersededAt), eq(workPolicies.earningsModel, "HOURLY"),
        eq(workPolicies.rateMinor, DEMO_BOOKING.rateMinor), eq(workPolicies.currencyCode, "ZAR"), isNull(workPolicies.incentiveTargetMinor))).limit(1);
      const policyId = policy?.id ?? (await createWorkPolicy(session, { earningsModel: "HOURLY", rateMinor: DEMO_BOOKING.rateMinor }, DEMO_BOOKING.policy, site))[0].id;
      const shift = await createRequirement(session, { departmentId, policyId, startsAt: new Date(dayStart + DEMO_OFFER.startMinute * 60_000), endsAt: new Date(dayStart + DEMO_OFFER.endMinute * 60_000), requiredHeadcount: 1 }, site);
      const offer = await offerAssignment(session, shift.id, input.workerId, site);
      await tx.insert(auditEvents).values({ id: randomUUID(), organisationId: input.organisationId, outletId: rosebank, action: "DEMO_OFFER_CREATED", entityType: "shift", entityId: shift.id,
        correlationId: `demo-offer:${date}`, metadata: { date, offerId: offer.id, workerId: input.workerId } });
      return { shiftId: shift.id, offerId: offer.id, workerId: input.workerId, date, created: true };
    });
  } catch (error) {
    // Refused by a scheduling rule (the worker is unavailable or already working): nothing is kept.
    if (error instanceof UserFacingError) return { shiftId: null, offerId: null, workerId: input.workerId, date, created: false, refused: error.feedback };
    throw error;
  }
}
