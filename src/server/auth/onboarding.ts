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
  if (!authority?.auth_users.emailVerifiedAt) throw new Error("Access denied.");
  const [organisation] = await db.update(organisations).set({...value, updatedAt: new Date()})
    .where(eq(organisations.id, organisationId)).returning();
  return organisation;
}
