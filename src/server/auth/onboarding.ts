import { randomUUID } from "node:crypto";
import { outlets } from "@/server/db/schema";
import { organisationEntitled } from "@/server/billing/entitlement";
import { requireCustomerOwner } from "@/server/billing/ownership";
import { assertLocationCapacity } from "@/server/billing/locations";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { DatabaseSession } from "@/server/db/client";
import { memberships, organisations, users } from "@/server/db/schema";

export const personalDetails = z.object({
  title: z.enum(["Mr", "Mrs", "Ms", "Dr", "Other"]),
  firstName: z.string().trim().min(1).max(100),
  surname: z.string().trim().min(1).max(100),
  position: z.string().trim().min(1).max(150),
  telephone: z.string().trim().regex(/^\+?[0-9 ()-]{6,30}$/),
});
export const businessDetails = z.object({
  name: z.string().trim().min(1).max(150),
  businessAddress: z.string().trim().min(1).max(300),
  city: z.string().trim().min(1).max(100),
  province: z.string().trim().min(1).max(100),
  postalCode: z.string().trim().min(1).max(30),
  country: z.string().trim().min(1).max(100),
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
  const value=personalDetails.merge(businessDetails).extend({locationName:z.string().trim().max(150).optional()}).strict().parse(input);
  return db.transaction(async tx=>{
    await requireCustomerOwner(tx,scope);
    const [org]=await tx.select().from(organisations).where(eq(organisations.id,scope.organisationId)).for("update");
    if (!org || !await organisationEntitled(tx,scope.organisationId)) throw new Error("An active organisation subscription is required before workplace setup.");
    const existing=await tx.select().from(outlets).where(eq(outlets.organisationId,org.id));
    let location=existing.find(row=>row.active);
    if (!location) {
      if (!value.locationName) throw new Error("Enter your first operating location.");
      await assertLocationCapacity(tx,org.id);
      [location]=await tx.insert(outlets).values({id:randomUUID(),organisationId:org.id,name:value.locationName,timezone:"Africa/Johannesburg"}).returning();
    }
    await savePersonalDetails(tx,scope.userId,personalDetails.parse(value));
    await tx.update(organisations).set({...businessDetails.parse(value),setupCompletedAt:org.setupCompletedAt ?? new Date(),updatedAt:new Date()}).where(eq(organisations.id,org.id));
    return location;
  });
}
