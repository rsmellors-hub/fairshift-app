import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { assertRole, type Scope } from "@/server/auth/access";
import { auditActor } from "@/server/auth/audit-actor";
import type { DatabaseSession } from "@/server/db/client";
import { auditEvents, organisations, outlets } from "@/server/db/schema";
import { wageJurisdiction, type WageJurisdiction } from "@/server/domain/statutory-wage";

// Day 6, Step 3a (Owner instruction, 9–10 November 2026): where FairShift holds no wage rule for a
// location's country or a shift's date, the minimum wage is not checked, and shifts there are offered
// only after the Owner has acknowledged that for the location. The acknowledgement is the audit row
// itself (append-only), naming the Owner, the time and the country it was given for; it lapses if the
// location's country changes. It never sets or approves a rate, and it never lets pay below a known
// floor, commission, or unreadable terms through.

export const WAGE_NOT_CHECKED_ACKNOWLEDGED = "WAGE_NOT_CHECKED_ACKNOWLEDGED";
export const WAGE_NOT_CHECKED_STATEMENT = "FairShift doesn’t check the minimum wage here. I’m responsible for making sure the pay offered at this location meets the minimum wage that applies.";

export type WageAcknowledgement = { at: Date; by: string; country: string | null };
const countryKey = (jurisdiction: WageJurisdiction) => jurisdiction.country?.trim().toLowerCase() ?? null;

async function locationJurisdiction(db: DatabaseSession, scope: Pick<Scope, "organisationId" | "locationId">) {
  const [row] = await db.select({ outletCountry: outlets.country, organisationCountry: organisations.country }).from(outlets)
    .innerJoin(organisations, eq(organisations.id, outlets.organisationId))
    .where(and(eq(outlets.id, scope.locationId), eq(outlets.organisationId, scope.organisationId)));
  if (!row) throw new Error("Location unavailable.");
  return wageJurisdiction({ locationCountry: row.outletCountry, organisationCountry: row.organisationCountry });
}

// The Owner's latest acknowledgement for this location, if it was given for the location's current country.
export async function wageNotCheckedAcknowledgement(db: DatabaseSession, scope: Pick<Scope, "organisationId" | "locationId">, jurisdiction?: WageJurisdiction): Promise<WageAcknowledgement | null> {
  const current = jurisdiction ?? await locationJurisdiction(db, scope);
  const [row] = await db.select({ createdAt: auditEvents.createdAt, metadata: auditEvents.metadata }).from(auditEvents)
    .where(and(eq(auditEvents.organisationId, scope.organisationId), eq(auditEvents.outletId, scope.locationId), eq(auditEvents.action, WAGE_NOT_CHECKED_ACKNOWLEDGED)))
    .orderBy(desc(auditEvents.createdAt)).limit(1);
  if (!row) return null;
  const metadata = row.metadata as { actorUserId?: string; countryKey?: string | null; country?: string | null };
  if ((metadata.countryKey ?? null) !== countryKey(current)) return null;
  return { at: row.createdAt, by: metadata.actorUserId ?? "", country: metadata.country ?? null };
}

// Owner only, for the Owner's current location, with the statement confirmed.
export async function acknowledgeWageNotChecked(db: DatabaseSession, scope: Scope, confirmed: boolean) {
  assertRole(scope, ["OWNER"]);
  if (!confirmed) throw new Error("Confirm the statement to acknowledge it.");
  const jurisdiction = await locationJurisdiction(db, scope);
  const id = randomUUID();
  await db.insert(auditEvents).values({ id, organisationId: scope.organisationId, outletId: scope.locationId, action: WAGE_NOT_CHECKED_ACKNOWLEDGED, entityType: "outlet", entityId: scope.locationId,
    correlationId: `wage-acknowledgement:${id}`, metadata: { ...auditActor(scope), country: jurisdiction.country, countryKey: countryKey(jurisdiction), jurisdiction: jurisdiction.jurisdiction, reason: jurisdiction.jurisdiction === null ? jurisdiction.reason : "NO_REFERENCE_FOR_SOME_DATES", statement: WAGE_NOT_CHECKED_STATEMENT } });
  return id;
}
