import { randomUUID } from "node:crypto";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { resolveScope } from "@/server/auth/access";
import { hashPassword } from "@/server/auth/identity";
import { inviteMember, redeemInvitation } from "@/server/auth/tenancy";
import type { Database } from "@/server/db/client";
import { auditEvents, departments, memberships, shiftOffers, users, workAcceptances, workAllocations, workers, workPolicies } from "@/server/db/schema";
import { SA_REFERENCE_ORGANISATION, saReferenceLocation, type SA_REFERENCE_STORE_CODES } from "@/server/reference/sa-reference";
import { allocateAssignment, createDepartment, createRequirement, createWorkPolicy, offerAssignment, respondToAssignment } from "@/server/scheduling/operations";
import { UserFacingError } from "@/server/domain/errors";
import { DEMO_BOOKING } from "./booking";
import { DEMO_ACCOUNTS } from "./provision";

// Two more fictional casual workers for the demo business (Owner add-on, 12 November 2026), made the
// way the judges' accounts are: invited by the demo Owner, redeemed, audited. Thabo Molefe works at
// Pretoria Central and Rosebank; Sipho Ndlovu at Rosebank, with a sign-in. Each is paid to their own
// PayPal Sandbox personal account, which no other worker in the business uses. Sign-in addresses use a
// reserved test domain, so no mail reaches a real mailbox. Idempotent: an existing person is kept, and
// a password is set only for an account created now.
export const DEMO_PEOPLE = {
  THABO: { email: "thabo.molefe@people.jacaranda-demo.example.test", firstName: "Thabo", surname: "Molefe", locations: ["SA03", "SA01"] },
  SIPHO: { email: "sipho.ndlovu@people.jacaranda-demo.example.test", firstName: "Sipho", surname: "Ndlovu", locations: ["SA01"] },
} as const;
export type DemoPerson = keyof typeof DEMO_PEOPLE;

const organisationId = SA_REFERENCE_ORGANISATION.id;

type StoreCode = (typeof SA_REFERENCE_STORE_CODES)[number];
async function demoOwnerScope(db: Database, locationCode: StoreCode) {
  const [owner] = await db.select({ id: memberships.id, userId: memberships.userId }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(users.email, DEMO_ACCOUNTS.OWNER.email), eq(memberships.organisationId, organisationId), eq(memberships.role, "OWNER")));
  if (!owner) throw new Error("Demo setup hasn't run: the demo Owner doesn't exist.");
  return resolveScope(db, owner.userId, owner.id, saReferenceLocation(locationCode).id);
}

export async function provisionDemoPeople(db: Database, input: { passwords: Partial<Record<DemoPerson, string>>; receivers: Partial<Record<DemoPerson, string>>; only?: DemoPerson[]; now?: Date }) {
  const now = input.now ?? new Date();
  for (const value of Object.values(input.passwords)) if (!value || value.length < 16) throw new Error("Passwords must be at least 16 characters.");
  const inviter = await demoOwnerScope(db, "SA01");
  const created: DemoPerson[] = [], result = {} as Partial<Record<DemoPerson, { membershipId: string; workerId: string }>>;
  for (const key of input.only ?? Object.keys(DEMO_PEOPLE) as DemoPerson[]) {
    const person = DEMO_PEOPLE[key], receiver = input.receivers[key]?.trim().toLowerCase(), password = input.passwords[key];
    if (!receiver || !password) throw new Error(`${person.firstName} needs a receiving account and a password.`);
    // Never reuse a receiving account: refused before anything is written for this person.
    const [taken] = await db.select({ id: workers.id }).from(workers).innerJoin(users, eq(users.id, workers.userId))
      .where(and(eq(workers.organisationId, organisationId), sql`lower(${workers.paypalPayoutEmail}) = ${receiver}`, ne(users.email, person.email)));
    if (taken) throw new Error(`${person.firstName}'s receiving account is already used by another worker.`);
    let [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, person.email));
    if (!user) {
      [user] = await db.insert(users).values({ id: randomUUID(), email: person.email, name: `${person.firstName} ${person.surname}`, firstName: person.firstName, surname: person.surname,
        passwordHash: await hashPassword(password), emailVerifiedAt: now }).returning({ id: users.id });
      created.push(key);
    }
    let [membership] = await db.select({ id: memberships.id, workerId: memberships.workerId }).from(memberships)
      .where(and(eq(memberships.userId, user.id), eq(memberships.organisationId, organisationId), eq(memberships.state, "ACTIVE")));
    if (!membership) {
      const { token } = await inviteMember(db, inviter, { role: "TEAM_MEMBER", email: person.email, firstName: person.firstName, surname: person.surname,
        telephone: "+27 11 000 0000", locationIds: person.locations.map(code => saReferenceLocation(code).id) });
      const redeemed = await redeemInvitation(db, user.id, { token });
      membership = { id: redeemed.id, workerId: redeemed.workerId };
    }
    if (!membership.workerId) throw new Error(`${person.firstName} has no worker record.`);
    const [set] = await db.update(workers).set({ paypalPayoutEmail: receiver, updatedAt: now })
      .where(and(eq(workers.id, membership.workerId), eq(workers.organisationId, organisationId), isNull(workers.paypalPayoutEmail))).returning({ id: workers.id });
    if (set) await db.insert(auditEvents).values({ id: randomUUID(), organisationId, action: "PAYOUT_DESTINATION_ADDED", entityType: "worker", entityId: membership.workerId,
      correlationId: `demo-people:${key}`, metadata: { source: "DEMO_PEOPLE_PROVISIONING" } });
    result[key] = { membershipId: membership.id, workerId: membership.workerId };
  }
  await db.insert(auditEvents).values({ id: randomUUID(), organisationId, action: "DEMO_PEOPLE_PROVISIONED", entityType: "organisation", entityId: organisationId,
    correlationId: `demo-people:${organisationId}`, metadata: { created, people: result } });
  return { created, people: result };
}

// The held-payment scenario (Owner add-on, 12 November 2026): Thabo has confirmed work at Pretoria
// Central and at Rosebank at overlapping times on the same day, so the Pay Agent's own overlap check can
// hold the second payment for the Owner. The first booking is made through the normal operations. The
// second is tried the same way; the booking clash check refuses it, as it should. It is then written as
// a labelled DEMO scenario: the same offer, accepted terms and allocation records the operations write,
// without the clash check. Nothing here confirms work, writes a payable or a Pay Agent decision: a
// Manager confirms both shifts after they end, and the Pay Agent evaluates them for real. Idempotent per
// date: an existing scenario is returned as it is.
export const OVERLAP_SCENARIO_LABEL = "DEMO scenario: overlapping work at two locations (synthetic)";
export async function createOverlapScenario(db: Database, input: { workerId: string; startsAt: Date; endsAt: Date }) {
  const [existing] = await db.select({ metadata: auditEvents.metadata }).from(auditEvents)
    .where(and(eq(auditEvents.organisationId, organisationId), eq(auditEvents.action, "DEMO_SCENARIO_CREATED"), eq(auditEvents.entityId, input.workerId),
      sql`${auditEvents.metadata}->>'startsAt' = ${input.startsAt.toISOString()}`)).limit(1);
  if (existing) return { ...(existing.metadata as Record<string, unknown>), created: false };
  const shiftAt = async (code: StoreCode) => {
    const scope = await demoOwnerScope(db, code), site = { organisationId, locationId: scope.locationId };
    const [department] = await db.select().from(departments).where(and(eq(departments.outletId, site.locationId), eq(departments.name, DEMO_BOOKING.department))).limit(1);
    const departmentId = department?.id ?? (await createDepartment(db, DEMO_BOOKING.department, site))[0].id;
    const [policy] = await db.select().from(workPolicies).where(and(eq(workPolicies.outletId, site.locationId), eq(workPolicies.name, DEMO_BOOKING.policy), isNull(workPolicies.supersededAt),
      eq(workPolicies.earningsModel, "HOURLY"), eq(workPolicies.rateMinor, DEMO_BOOKING.rateMinor), eq(workPolicies.currencyCode, "ZAR"), isNull(workPolicies.incentiveTargetMinor))).limit(1);
    const policyId = policy?.id ?? (await createWorkPolicy(db, { earningsModel: "HOURLY", rateMinor: DEMO_BOOKING.rateMinor }, DEMO_BOOKING.policy, site))[0].id;
    return { site, shift: await createRequirement(db, { departmentId, policyId, startsAt: input.startsAt, endsAt: input.endsAt, requiredHeadcount: 1 }, site) };
  };

  // Pretoria Central, through the normal operations.
  const first = await shiftAt("SA03");
  const firstOffer = await offerAssignment(db, first.shift.id, input.workerId, first.site);
  await respondToAssignment(db, input.workerId, firstOffer.id, first.shift.termsVersion, "ACCEPTED", true, first.site);
  await allocateAssignment(db, firstOffer.id, first.site);

  // Rosebank, at an overlapping time: the clash check must refuse the normal offer.
  const second = await shiftAt("SA01");
  let refusal: string | null = null;
  try { await offerAssignment(db, second.shift.id, input.workerId, second.site); }
  catch (error) { refusal = error instanceof UserFacingError ? error.feedback : null; if (!refusal) throw error; }
  if (refusal !== "worker-working") throw new Error("The booking clash check did not refuse the overlapping offer; the scenario was not written.");

  const secondOfferId = await db.transaction(async tx => {
    const [worker] = await tx.select().from(workers).where(eq(workers.id, input.workerId));
    const [department] = await tx.select().from(departments).where(eq(departments.id, second.shift.departmentId!));
    const now = new Date(), shift = second.shift, offerId = randomUUID();
    await tx.insert(shiftOffers).values({ id: offerId, shiftId: shift.id, workerId: input.workerId, status: "ACCEPTED", respondedAt: now, acceptedAt: now });
    // The accepted-terms snapshot, field for field as respondToAssignment records it.
    const snapshot = { authUserId: worker.userId, workerId: input.workerId, workerName: worker.displayName, offerId, assignmentId: shift.id, locationId: second.site.locationId, locationName: saReferenceLocation("SA01").name,
      departmentId: shift.departmentId, departmentName: department?.name ?? shift.roleName, startsAt: shift.startsAt.toISOString(), endsAt: shift.endsAt.toISOString(),
      earningsModel: shift.earningsModel, currencyCode: shift.currencyCode, rateMinor: shift.rateMinor ?? (shift.earningsModel === "DAILY" ? shift.guaranteedBasePayMinor : null),
      commissionBps: shift.commissionBps, commissionBasis: shift.commissionBasis, expectedEarningsMinor: shift.earningsModel === "COMMISSION" ? null : shift.expectedEarningsMinor ?? shift.guaranteedBasePayMinor,
      incentivePolicy: shift.incentivePolicy, incentiveBasis: shift.incentiveBasis, incentiveTargetMinor: shift.incentiveTargetMinor, incentiveAmountMinor: shift.incentiveAmountMinor, gratuityPolicy: shift.gratuityPolicy,
      termsVersion: shift.termsVersion, acceptedAt: now.toISOString(), acknowledged: true };
    const acceptanceId = randomUUID();
    await tx.insert(workAcceptances).values({ id: acceptanceId, offerId, workerId: input.workerId, termsVersion: shift.termsVersion, snapshot, acceptedAt: now });
    await tx.insert(workAllocations).values({ id: randomUUID(), offerId, acceptanceId });
    await tx.insert(auditEvents).values({ id: randomUUID(), organisationId, outletId: second.site.locationId, action: "DEMO_SCENARIO_CREATED", entityType: "worker", entityId: input.workerId,
      correlationId: `demo-overlap:${input.workerId}`, metadata: { label: OVERLAP_SCENARIO_LABEL, synthetic: true, startsAt: input.startsAt.toISOString(), endsAt: input.endsAt.toISOString(),
        normalShiftId: first.shift.id, normalOfferId: firstOffer.id, scenarioShiftId: shift.id, scenarioOfferId: offerId, clashCheck: refusal } });
    return offerId;
  });
  return { label: OVERLAP_SCENARIO_LABEL, normalShiftId: first.shift.id, normalOfferId: firstOffer.id, scenarioShiftId: second.shift.id, scenarioOfferId: secondOfferId, clashCheck: refusal, created: true };
}
