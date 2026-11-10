import { after } from "next/server";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Database, DatabaseSession } from "@/server/db/client";
import { localIntelligenceRuns, outlets } from "@/server/db/schema";
import { isDemoOrganisation } from "@/server/demo/organisation";
import { runLocalDiscovery } from "@/server/intelligence/local-intelligence-service";
import { createSourceChecker } from "@/server/intelligence/local-intelligence-sources";
import { getLocalDiscoveryProvider } from "@/server/integrations/openai/web-discovery";

// Local discovery for any business (Owner decision 10 Nov 2026, item 3): it runs when a location's pin is
// confirmed and on the Owner's "Refresh local signals", capped at 3 a day per location, 3 locations per
// business, and 100 calls a day across all businesses other than the demo. The demo business is unlimited
// here (its own daily cap still applies). Every call is a recorded run, so the caps are counted from runs.

export const AI_LIMITS = { perLocationPerDay: 3, locationsPerBusiness: 3, nonDemoCallsPerDay: 100 } as const;
export type DiscoveryAllowance = { allowed: true; left: number | null } | { allowed: false; reason: "LOCATION_LIMIT" | "BUSINESS_LOCATIONS" | "DAILY_AI_LIMIT" | "NO_PIN" | "NOT_CONFIGURED" };

const dayStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

export async function discoveryAllowance(db: DatabaseSession, target: { organisationId: string; outletId: string }, now = new Date()): Promise<DiscoveryAllowance> {
  if (!getLocalDiscoveryProvider()) return { allowed: false, reason: "NOT_CONFIGURED" };
  const [outlet] = await db.select({ latitude: outlets.latitude }).from(outlets).where(and(eq(outlets.id, target.outletId), eq(outlets.organisationId, target.organisationId), eq(outlets.active, true)));
  if (!outlet || outlet.latitude === null) return { allowed: false, reason: "NO_PIN" };
  if (isDemoOrganisation(target.organisationId)) return { allowed: true, left: null };
  const since = dayStart(now);
  const today = await db.select({ outletId: localIntelligenceRuns.outletId, trigger: localIntelligenceRuns.trigger }).from(localIntelligenceRuns)
    .where(and(eq(localIntelligenceRuns.organisationId, target.organisationId), gte(localIntelligenceRuns.createdAt, since)));
  const here = today.filter(run => run.outletId === target.outletId && run.trigger === "MANUAL").length;
  if (here >= AI_LIMITS.perLocationPerDay) return { allowed: false, reason: "LOCATION_LIMIT" };
  const places = new Set(today.map(run => run.outletId));
  if (!places.has(target.outletId) && places.size >= AI_LIMITS.locationsPerBusiness) return { allowed: false, reason: "BUSINESS_LOCATIONS" };
  const demo = [process.env.FAIRSHIFT_SANDBOX_ORGANISATION_ID, process.env.FAIRSHIFT_DEMO_ORGANISATION_ID].filter((id): id is string => !!id && /^[0-9a-f-]{36}$/.test(id));
  const [{ count }] = await db.select({ count: sql<number>`count(*)`.mapWith(Number) }).from(localIntelligenceRuns)
    .where(and(gte(localIntelligenceRuns.createdAt, since), demo.length ? sql`${localIntelligenceRuns.organisationId} not in (${sql.join(demo.map(id => sql`${id}`), sql`, `)})` : undefined));
  if (count >= AI_LIMITS.nonDemoCallsPerDay) return { allowed: false, reason: "DAILY_AI_LIMIT" };
  return { allowed: true, left: AI_LIMITS.perLocationPerDay - here };
}

export const ALLOWANCE_MESSAGE: Record<Exclude<DiscoveryAllowance, { allowed: true }>["reason"], string> = {
  LOCATION_LIMIT: "This location has used its 3 local-signal refreshes today. FairShift checks again tomorrow.",
  BUSINESS_LOCATIONS: "Local signals ran for 3 of your locations today, the most a business can use in a day.",
  DAILY_AI_LIMIT: "Daily AI limit reached. Local signals will be checked again tomorrow.",
  NO_PIN: "Confirm this location’s map pin first, so FairShift knows where to look.",
  NOT_CONFIGURED: "Local signal search isn’t available in this environment.",
};

// Runs one discovery for the location after the response is sent, when the allowance permits.
export async function startDiscovery(db: Database, scope: { organisationId: string; locationId: string; userId?: string }) {
  const target = { organisationId: scope.organisationId, outletId: scope.locationId };
  const allowance = await discoveryAllowance(db, target);
  const provider = getLocalDiscoveryProvider();
  if (!allowance.allowed || !provider) return allowance;
  after(async () => {
    try { await runLocalDiscovery(db, target, { kind: "DAILY", trigger: "MANUAL", requestedBy: scope.userId ?? null, provider, checkSource: createSourceChecker() }); }
    catch { /* recorded as a failed run by runLocalDiscovery where it got that far */ }
  });
  return allowance;
}

export async function pinConfirmed(db: Database, scope: { organisationId: string; locationId: string; userId?: string }) {
  return startDiscovery(db, scope);
}

// Runs today per location of a business, for "Refresh (N of 3 left today)".
export async function refreshesLeft(db: DatabaseSession, organisationId: string, outletIds: string[], now = new Date()) {
  if (!outletIds.length) return new Map<string, number>();
  const rows = await db.select({ outletId: localIntelligenceRuns.outletId, count: sql<number>`count(*)`.mapWith(Number) }).from(localIntelligenceRuns)
    .where(and(eq(localIntelligenceRuns.organisationId, organisationId), inArray(localIntelligenceRuns.outletId, outletIds), eq(localIntelligenceRuns.trigger, "MANUAL"), gte(localIntelligenceRuns.createdAt, dayStart(now))))
    .groupBy(localIntelligenceRuns.outletId);
  return new Map(outletIds.map(id => [id, isDemoOrganisation(organisationId) ? AI_LIMITS.perLocationPerDay : Math.max(0, AI_LIMITS.perLocationPerDay - (rows.find(row => row.outletId === id)?.count ?? 0))]));
}
