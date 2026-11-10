import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { resolveScope } from "@/server/auth/access";
import { organisationEntitled } from "@/server/billing/entitlement";
import { assertLocationCapacity } from "@/server/billing/locations";
import { requireCustomerOwner, type CustomerScope } from "@/server/billing/ownership";
import type { Database, DatabaseSession } from "@/server/db/client";
import { auditEvents, memberships, organisations, outlets, saleTransactions, teamInvitations, workPolicies } from "@/server/db/schema";
import { UserFacingError } from "@/server/domain/errors";
import { resolveLocationTimezone } from "@/server/domain/timezone";
import { setRegularCoverage, setTradingHours, setWorkloadPolicy } from "@/server/intelligence/business-policy";
import { parseCoverageText, parseTradingText } from "@/server/intelligence/workload";
import { setVenueFacts } from "@/server/settings/settings";

// The design's onboarding (Setup, 10 Nov 2026), after the account and the PayPal Sandbox trial:
// 3 Venue, 4 Sales history, 5 Pay terms, 6 Team. Saving the first venue completes workplace setup, so the
// later steps use the product's own forms. Nothing here is specific to a country or to the demo business.

export const SETUP_STEPS = ["venue", "sales", "pay", "team"] as const;
export type SetupStep = typeof SETUP_STEPS[number];

const venueInput = z.object({
  locationId: z.uuid().nullable(),
  name: z.string().trim().min(1).max(150), address: z.string().trim().min(1).max(200), city: z.string().trim().min(1).max(100), postalCode: z.string().trim().max(20),
  venueType: z.enum(["CAFE_RESTAURANT", "BAR", "TAKEAWAY"]), seats: z.number().int().min(1).max(5000),
  customerTypes: z.array(z.string()), customerNote: z.string(),
  trading: z.array(z.string()).length(7), coverage: z.array(z.string()).length(7),
  transactionsPerStaffHour: z.number().int().min(1).max(1000), minimumStaffWhileOpen: z.number().int().min(0).max(100),
});

// Saves a venue: the first completes workplace setup; with locationId, an added location is filled in.
export async function saveSetupVenue(db: Database, scope: CustomerScope, input: unknown) {
  const parsed = venueInput.safeParse(input);
  if (!parsed.success) throw new UserFacingError("venue-invalid", "Enter the venue’s name, street address, city, type, seats, bills per person per hour and the minimum on the floor.");
  const value = parsed.data;
  const week = (texts: string[], parse: (text: string) => unknown, code: string) => texts.map(text => { const t = text.trim(); if (!t) return null; try { return parse(t); } catch { throw new UserFacingError(code, "A day’s times couldn’t be read."); } });
  const trading = week(value.trading, parseTradingText, "trading-hours-invalid"), coverage = week(value.coverage, parseCoverageText, "regular-coverage-invalid");
  if (trading.some(day => day === null)) throw new UserFacingError("trading-hours-invalid", "Give opening hours for every day, or write closed.");
  const location = await db.transaction(async tx => {
    await requireCustomerOwner(tx, scope);
    const [org] = await tx.select().from(organisations).where(eq(organisations.id, scope.organisationId)).for("update");
    if (!org || !await organisationEntitled(tx, scope.organisationId)) throw new UserFacingError("subscription-required", "Start your free trial before setting up your venue.");
    const values = { name: value.name, address: value.address, city: value.city, postalCode: value.postalCode || null, country: org.country, updatedAt: new Date() };
    const existing = await tx.select().from(outlets).where(eq(outlets.organisationId, org.id));
    let row = value.locationId ? existing.find(place => place.id === value.locationId) : existing.find(place => place.active);
    if (value.locationId && !row) throw new Error("Location unavailable.");
    if (!row) {
      await assertLocationCapacity(tx, org.id);
      const timezone = resolveLocationTimezone({ locationCountry: org.country, organisationCountry: org.country, existingTimezones: existing.map(place => place.timezone) });
      [row] = await tx.insert(outlets).values({ id: randomUUID(), organisationId: org.id, ...values, timezone }).returning();
    } else [row] = await tx.update(outlets).set(values).where(eq(outlets.id, row.id)).returning();
    await tx.update(organisations).set({ businessAddress: org.businessAddress ?? value.address, city: org.city ?? value.city, postalCode: org.postalCode ?? (value.postalCode || null),
      setupCompletedAt: org.setupCompletedAt ?? new Date(), updatedAt: new Date() }).where(eq(organisations.id, org.id));
    await tx.insert(auditEvents).values({ id: randomUUID(), organisationId: org.id, outletId: row.id, action: "SETUP_VENUE_SAVED", entityType: "outlet", entityId: row.id, correlationId: `setup-venue:${row.id}:${Date.now()}`,
      metadata: { actorUserId: scope.userId, actorRole: "OWNER", sessionType: "SIGNED_IN" } });
    return row;
  });
  // The owner's own settings for the venue, through the product's ordinary setters.
  const [owner] = await db.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.userId, scope.userId), eq(memberships.organisationId, scope.organisationId), eq(memberships.role, "OWNER"), eq(memberships.state, "ACTIVE")));
  const at = await resolveScope(db, scope.userId, owner.id, location.id);
  await setVenueFacts(db, at, { customerTypes: value.customerTypes, customerNote: value.customerNote, venueType: value.venueType, seats: value.seats });
  await setTradingHours(db, at, trading);
  if (coverage.some(day => day !== null)) await setRegularCoverage(db, at, coverage);
  await setWorkloadPolicy(db, at, "LOCATION", { transactionsPerStaffHour: value.transactionsPerStaffHour, minimumStaffWhileOpen: value.minimumStaffWhileOpen });
  return location;
}

// What each step has, for the progress bar and the "continue" rules.
export async function setupProgress(db: DatabaseSession, organisationId: string, locationId: string | null) {
  if (!locationId) return { venue: false, pin: false, sales: false, pay: false, team: 0 };
  const [location] = await db.select().from(outlets).where(and(eq(outlets.id, locationId), eq(outlets.organisationId, organisationId)));
  const [{ sales }] = await db.select({ sales: sql<number>`count(*)::int` }).from(saleTransactions).where(eq(saleTransactions.outletId, locationId));
  const [{ pay }] = await db.select({ pay: sql<number>`count(*)::int` }).from(workPolicies).where(and(eq(workPolicies.outletId, locationId), eq(workPolicies.earningsModel, "HOURLY"), isNull(workPolicies.supersededAt)));
  const [{ team }] = await db.select({ team: sql<number>`count(*)::int` }).from(teamInvitations).where(and(eq(teamInvitations.organisationId, organisationId), eq(teamInvitations.outletId, locationId)));
  return { venue: !!location?.address, pin: !!location?.pinConfirmedAt, sales: sales > 0, pay: pay > 0, team };
}
