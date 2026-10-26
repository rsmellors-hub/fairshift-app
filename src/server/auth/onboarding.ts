import { randomUUID } from "node:crypto";
import { outlets } from "@/server/db/schema";
import { organisationEntitled } from "@/server/billing/entitlement";
import { requireCustomerOwner } from "@/server/billing/ownership";
import { assertLocationCapacity } from "@/server/billing/locations";
import { resolveLocationTimezone } from "@/server/domain/timezone";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { DatabaseSession } from "@/server/db/client";
import { memberships, organisations, users } from "@/server/db/schema";
import { personalDetails, addressDetails, workplaceDetails } from "@/lib/workplace";
export { personalDetails } from "@/lib/workplace";

export const businessDetails = addressDetails.extend({
  name: z.string().trim().min(1).max(150),
});
export async function savePersonalDetails(db: DatabaseSession, userId: string, input: unknown) {
  const value = personalDetails.strict().parse(input);
  const [user] = await db.update(users).set({...value, name: `${value.firstName} ${value.surname}`})
    .where(eq(users.id, userId)).returning();
  if (!user) throw new Error("Account unavailable.");
  return user;
}
export async function saveBusinessDetails(db: DatabaseSession, userId: string, organisationId: string, input: unknown) {
  const value = businessDetails.strict().parse(input);
  const [authority] = await db.select().from(memberships).innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.userId, userId), eq(memberships.organisationId, organisationId), eq(memberships.role, "OWNER"), eq(memberships.state, "ACTIVE")));
  if (!await organisationEntitled(db,organisationId)) throw new Error("An active organisation subscription is required.");
  if (!authority?.auth_users.emailVerifiedAt) throw new Error("Access denied.");
  const [organisation] = await db.update(organisations).set({...value, updatedAt: new Date()})
    .where(eq(organisations.id, organisationId)).returning();
  return organisation;
}

// Entitlement and setup are separate: setup may finish only after authoritative activation.
export async function completeWorkplace(db: import("@/server/db/client").Database, scope: import("@/server/billing/ownership").CustomerScope, input: unknown) {
  const value=workplaceDetails.parse(input);
  return db.transaction(async tx=>{
    await requireCustomerOwner(tx,scope);
    const [org]=await tx.select().from(organisations).where(eq(organisations.id,scope.organisationId)).for("update");
    if (!org || !await organisationEntitled(tx,scope.organisationId)) throw new Error("An active organisation subscription is required before workplace setup.");
    const existing=await tx.select().from(outlets).where(eq(outlets.organisationId,org.id));
    let location=existing.find(row=>row.active);
    if (org.setupCompletedAt && location) return location;
    const locationValues={name:value.locationName,address:value.locationAddress,city:value.locationCity,
      province:value.locationProvince ?? null,postalCode:value.locationPostalCode,country:value.locationCountry,updatedAt:new Date()};
    if (!location) {
      await assertLocationCapacity(tx,org.id);
      const timezone=resolveLocationTimezone({locationCountry:value.locationCountry,organisationCountry:value.sameAddress ? value.locationCountry : value.country});
      [location]=await tx.insert(outlets).values({id:randomUUID(),organisationId:org.id,...locationValues,timezone}).returning();
    } else {
      [location]=await tx.update(outlets).set(locationValues).where(eq(outlets.id,location.id)).returning();
    }
    await savePersonalDetails(tx,scope.userId,personalDetails.parse(value));
    const address=value.sameAddress ? {businessAddress:value.locationAddress,city:value.locationCity,province:value.locationProvince,
      postalCode:value.locationPostalCode,country:value.locationCountry} : addressDetails.parse(value);
    await tx.update(organisations).set({...address,province:address.province ?? null,name:value.name,setupCompletedAt:org.setupCompletedAt ?? new Date(),updatedAt:new Date()}).where(eq(organisations.id,org.id));
    return location;
  });
}
