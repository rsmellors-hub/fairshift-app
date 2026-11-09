import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Database } from "@/server/db/client";
import { departments, organisations, outlets, shiftOffers, shifts, workPolicies } from "@/server/db/schema";
import { resolveLocationCurrency } from "@/server/domain/currency";
import { localDate } from "@/server/intelligence/forecast";
import { acknowledgeWageNotChecked } from "@/server/scheduling/wage-acknowledgement";

// Since Day 6, Step 3a, FairShift refuses commission casual terms when they are written and when a shift
// is created or offered. Commission shifts and offers made before that rule still exist in data, and the
// rest of the flow (acceptance, allocation, confirmation, attribution) must keep handling them, so these
// tests write such rows directly, exactly as FairShift's operations stored them.
type Scope = { organisationId: string; locationId: string };

export async function legacyCommissionShift(db: Database, scope: Scope, input: { departmentId: string; startsAt: Date; endsAt: Date; requiredHeadcount?: number; commissionBps?: number }) {
  const [outlet] = await db.select().from(outlets).where(and(eq(outlets.id, scope.locationId), eq(outlets.organisationId, scope.organisationId)));
  const [organisation] = await db.select({ country: organisations.country }).from(organisations).where(eq(organisations.id, scope.organisationId));
  const [department] = await db.select().from(departments).where(and(eq(departments.id, input.departmentId), eq(departments.outletId, scope.locationId)));
  if (!outlet || !department) throw new Error("Fixture location or department unavailable.");
  const currencyCode = resolveLocationCurrency({ locationCountry: outlet.country, organisationCountry: organisation?.country });
  const commission = { earningsModel: "COMMISSION" as const, rateMinor: null, commissionBps: input.commissionBps ?? 500, commissionBasis: "VERIFIED_ATTRIBUTED_SALES" as const };
  const [policy] = await db.insert(workPolicies).values({ id: randomUUID(), outletId: scope.locationId, name: "Legacy commission terms", ...commission, currencyCode }).returning();
  const [shift] = await db.insert(shifts).values({ id: randomUUID(), outletId: scope.locationId, departmentId: department.id, roleName: department.name, policyId: policy.id,
    startsAt: input.startsAt, endsAt: input.endsAt, shiftDate: localDate(input.startsAt, outlet.timezone), requiredHeadcount: input.requiredHeadcount ?? 1,
    status: "PUBLISHED", publishedAt: new Date(), currencyCode, ...commission, expectedEarningsMinor: null, guaranteedBasePayMinor: 0,
    gratuityPolicy: "No gratuity terms apply.", incentivePolicy: "No incentive applies to this assignment." }).returning();
  return { policy, shift };
}

export async function legacyCommissionOffer(db: Database, shiftId: string, workerId: string) {
  const [offer] = await db.insert(shiftOffers).values({ id: randomUUID(), shiftId, workerId }).returning();
  return offer;
}

// The Owner's acknowledgement that the minimum wage isn't checked at a location (Day 6, Step 3a), for
// fixtures in countries FairShift holds no wage rule for. A synthetic Owner identity.
export async function ownerAcknowledgesWageNotChecked(db: Database, scope: Scope) {
  return acknowledgeWageNotChecked(db, { ...scope, userId: randomUUID(), role: "OWNER", organisationName: "Fixture", locationName: "Fixture" }, true);
}
