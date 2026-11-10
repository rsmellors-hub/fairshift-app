import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { assertRole, type Scope } from "@/server/auth/access";
import { auditActor } from "@/server/auth/audit-actor";
import { requireEntitlement } from "@/server/billing/entitlement";
import type { Database, DatabaseSession } from "@/server/db/client";
import { auditEvents, locationShiftRules, organisationHoursRules, organisations, outlets, users, workers } from "@/server/db/schema";
import { UserFacingError } from "@/server/domain/errors";

// Editable settings (Day 6, item 3, 10 Nov 2026). Rules are written as new dated versions (the latest
// stands), never edited in place; every change is audited. Nothing here sets a pay amount.

const audit = (db: DatabaseSession, scope: { organisationId: string; userId: string; role: string; demo?: unknown }, outletId: string | null, action: string, entityType: string, entityId: string, detail: Record<string, unknown>) =>
  db.insert(auditEvents).values({ id: randomUUID(), organisationId: scope.organisationId, outletId, action, entityType, entityId, correlationId: `${action.toLowerCase()}:${entityId}:${Date.now()}`, metadata: { ...auditActor(scope), ...detail } });

// Shift lengths in whole quarter-hours between 1 and 16 hours; the first offer round in minutes.
const shiftRulesInput = z.object({
  minMinutes: z.number().int().min(60).max(960), maxMinutes: z.number().int().min(60).max(960), preferredMinutes: z.number().int().min(60).max(960),
  firstRoundMinutes: z.number().int().min(0).max(7 * 24 * 60), firstRoundCutoffMinutes: z.number().int().min(0).max(7 * 24 * 60),
});
export async function setShiftRules(db: Database, scope: Scope, input: unknown) {
  assertRole(scope, ["OWNER"]);
  await requireEntitlement(db, scope.organisationId);
  const parsed = shiftRulesInput.safeParse(input);
  const value = parsed.success ? parsed.data : null;
  if (!value || [value.minMinutes, value.maxMinutes, value.preferredMinutes].some(m => m % 15) || !(value.minMinutes <= value.preferredMinutes && value.preferredMinutes <= value.maxMinutes))
    throw new UserFacingError("shift-rules-invalid", "Shift lengths must be in quarter-hours from 1 to 16 hours, with the shortest ≤ the usual ≤ the longest.");
  const [location] = await db.select({ id: outlets.id }).from(outlets).where(and(eq(outlets.id, scope.locationId), eq(outlets.organisationId, scope.organisationId)));
  if (!location) throw new Error("Location unavailable.");
  const id = randomUUID();
  await db.transaction(async tx => {
    await tx.insert(locationShiftRules).values({ id, organisationId: scope.organisationId, outletId: scope.locationId, ...value, source: "OWNER", createdBy: scope.userId });
    await audit(tx, scope, scope.locationId, "SHIFT_RULES_SET", "location_shift_rules", id, value);
  });
  return id;
}

// The guaranteed-hours alert: FairShift only alerts the Owner; it never offers regular hours itself.
const hoursRuleInput = z.object({ weeklyThresholdMinutes: z.number().int().min(60).max(4800), referenceWeeks: z.number().int().min(1).max(52) });
export async function setHoursRule(db: Database, scope: Scope, input: unknown) {
  assertRole(scope, ["OWNER"]);
  await requireEntitlement(db, scope.organisationId);
  const parsed = hoursRuleInput.safeParse(input);
  if (!parsed.success) throw new UserFacingError("hours-rule-invalid", "Set an average of 1 to 80 hours a week over 1 to 52 weeks.");
  const id = randomUUID();
  await db.transaction(async tx => {
    await tx.insert(organisationHoursRules).values({ id, organisationId: scope.organisationId, ...parsed.data, source: "OWNER", createdBy: scope.userId });
    await audit(tx, scope, null, "HOURS_RULE_SET", "organisation_hours_rules", id, parsed.data);
  });
  return id;
}

// The business's name and address. Its country is fixed after setup: it sets currency, time zone and
// wage rules for every location.
const businessInput = z.object({
  name: z.string().trim().min(1).max(150), businessAddress: z.string().trim().min(1).max(300), city: z.string().trim().min(1).max(100),
  province: z.string().trim().max(100), postalCode: z.string().trim().min(1).max(30),
}).strict();
export async function updateBusinessDetails(db: Database, scope: Scope, input: unknown) {
  assertRole(scope, ["OWNER"]);
  await requireEntitlement(db, scope.organisationId);
  const parsed = businessInput.safeParse(input);
  if (!parsed.success) throw new UserFacingError("business-invalid", "Enter the business name, street address, city and postal code.");
  const value = { ...parsed.data, province: parsed.data.province || null };
  return db.transaction(async tx => {
    const [before] = await tx.select().from(organisations).where(eq(organisations.id, scope.organisationId)).for("update");
    if (!before) throw new Error("Business unavailable.");
    const changed = Object.entries(value).filter(([key, val]) => before[key as keyof typeof before] !== val).map(([key]) => key);
    if (changed.length) await tx.update(organisations).set({ ...value, updatedAt: new Date() }).where(eq(organisations.id, scope.organisationId));
    await audit(tx, scope, null, "BUSINESS_UPDATED", "organisation", scope.organisationId, { fields: changed });
    return { changed };
  });
}

// A signed-in person's own name and phone (their email is their sign-in and isn't changed here). A
// casual worker's record follows.
const ownInput = z.object({ firstName: z.string().trim().min(1).max(100), surname: z.string().trim().min(1).max(100), telephone: z.union([z.literal(""), z.string().trim().regex(/^\+?[0-9 ()-]{6,30}$/)]) });
export async function updateOwnDetails(db: Database, scope: Scope, input: unknown) {
  const parsed = ownInput.safeParse(input);
  if (!parsed.success) throw new UserFacingError("details-invalid", "Enter your first name, surname and a valid phone number (or leave the phone blank).");
  const value = { ...parsed.data, telephone: parsed.data.telephone || null };
  await db.transaction(async tx => {
    await tx.update(users).set({ firstName: value.firstName, surname: value.surname, name: `${value.firstName} ${value.surname}`, telephone: value.telephone }).where(eq(users.id, scope.userId));
    if (scope.role === "TEAM_MEMBER" && scope.workerId)
      await tx.update(workers).set({ firstName: value.firstName, surname: value.surname, displayName: `${value.firstName} ${value.surname}`, telephone: value.telephone, updatedAt: new Date() })
        .where(and(eq(workers.id, scope.workerId), eq(workers.userId, scope.userId), eq(workers.organisationId, scope.organisationId)));
    await audit(tx, scope, scope.locationId, "OWN_DETAILS_UPDATED", scope.role === "TEAM_MEMBER" ? "worker" : "user", scope.workerId ?? scope.userId, { fields: ["name", "telephone"] });
  });
}

// The same for an Owner or Manager from their account page, across every business they belong to.
export async function updateOwnAccountDetails(db: Database, userId: string, input: unknown) {
  const parsed = ownInput.safeParse(input);
  if (!parsed.success) throw new UserFacingError("details-invalid", "Enter your first name, surname and a valid phone number (or leave the phone blank).");
  const value = { ...parsed.data, telephone: parsed.data.telephone || null };
  await db.transaction(async tx => {
    await tx.update(users).set({ firstName: value.firstName, surname: value.surname, name: `${value.firstName} ${value.surname}`, telephone: value.telephone }).where(eq(users.id, userId));
    await tx.insert(auditEvents).values({ id: randomUUID(), organisationId: null, outletId: null, action: "OWN_DETAILS_UPDATED", entityType: "user", entityId: userId, correlationId: `own-details:${userId}:${Date.now()}`,
      metadata: { actorUserId: userId, sessionType: "SIGNED_IN", fields: ["name", "telephone"] } });
  });
}
