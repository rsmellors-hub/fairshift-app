import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNotNull } from "drizzle-orm";
import { consumeLimit, newToken, tokenHash } from "@/server/auth/identity";
import { organisationEntitled, workplaceComplete } from "@/server/billing/entitlement";
import type { Database, DatabaseSession } from "@/server/db/client";
import { auditEvents, memberships, sessions, users, workers } from "@/server/db/schema";
import { UserFacingError } from "@/server/domain/errors";
import { ensureDemoBooking } from "./booking";
import { DEMO_MEMBERSHIP_ROLE, DEMO_PERSONAS, DEMO_SESSION_MS, demoPersona, type DemoConfig, type DemoPersona } from "./config";

const ENTRY_LIMIT = 300;

// Records the demo session and persona, and nothing about the person using it.
export const demoAudit = (db: DatabaseSession, organisationId: string, action: string, group: string, metadata: Record<string, unknown>) =>
  db.insert(auditEvents).values({ id: randomUUID(), organisationId, action, entityType: "demo_session", entityId: group, correlationId: `demo:${group}`, metadata });

const unavailable = () => new UserFacingError("demo-unavailable", "The demo isn’t available right now.");

// The three accounts must exist as configured and belong to the demo organisation, with the
// manager and worker at one location. Anything else closes the demo.
export async function demoIdentities(db: DatabaseSession, config: DemoConfig) {
  const rows = await db.select({ membership: memberships, emailVerifiedAt: users.emailVerifiedAt }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
    .where(and(inArray(memberships.id, DEMO_PERSONAS.map(persona => config[persona])), eq(memberships.organisationId, config.organisationId), eq(memberships.state, "ACTIVE")));
  const found = (persona: DemoPersona) => rows.find(row => row.membership.id === config[persona] && row.membership.role === DEMO_MEMBERSHIP_ROLE[persona] && !!row.emailVerifiedAt)?.membership;
  const [owner, manager, worker] = DEMO_PERSONAS.map(found);
  if (!owner || !manager || !worker || !manager.outletId || manager.outletId !== worker.outletId || !worker.workerId) return null;
  const [profile] = await db.select({ userId: workers.userId }).from(workers).where(and(eq(workers.id, worker.workerId), eq(workers.organisationId, config.organisationId), eq(workers.locationId, worker.outletId)));
  if (profile?.userId !== worker.userId) return null;
  if (!await organisationEntitled(db, config.organisationId) || !await workplaceComplete(db, config.organisationId)) return null;
  return { OWNER: owner, MANAGER: manager, WORKER: worker };
}

async function issue(db: DatabaseSession, config: DemoConfig, persona: DemoPersona, group: string, expiresAt: Date) {
  const identities = await demoIdentities(db, config);
  if (!identities) throw unavailable();
  const token = newToken(), membership = identities[persona];
  await db.insert(sessions).values({ id: randomUUID(), userId: membership.userId, tokenHash: tokenHash(token), expiresAt, membershipId: membership.id, demoPersona: persona, demoGroup: group });
  return token;
}

// A short-lived session for one persona. The only input is the persona's name.
export async function enterDemo(db: Database, config: DemoConfig | null, input: unknown, now = new Date()) {
  const persona = demoPersona.safeParse(input);
  if (!config || !persona.success) throw unavailable();
  await limited(db, "demo-entry", ENTRY_LIMIT);
  const group = randomUUID(), expiresAt = new Date(now.getTime() + DEMO_SESSION_MS);
  const token = await issue(db, config, persona.data, group, expiresAt);
  await demoAudit(db, config.organisationId, "DEMO_SESSION_ENTERED", group, { persona: persona.data });
  // The demo story's booked shift for tomorrow, if the day has rolled over since setup or the last reset.
  // Best effort: entry never fails because of it.
  try {
    const [worker] = await db.select({ workerId: memberships.workerId }).from(memberships).where(and(eq(memberships.id, config.WORKER), eq(memberships.organisationId, config.organisationId)));
    await ensureDemoBooking(db, { organisationId: config.organisationId, workerId: worker?.workerId ?? null, now });
  } catch { console.error("The demo booking could not be checked on entry."); }
  return { token, expiresAt, persona: persona.data };
}

// Changes who this demo session is, on the server. It updates the session in place rather than
// issuing a new token, so a slow response or a double click can't strand the visitor. The expiry
// is untouched, so switching can't extend a session, and only a demo session can be switched.
export async function switchDemoPersona(db: Database, config: DemoConfig | null, token: string | undefined, input: unknown, now = new Date()) {
  const persona = demoPersona.safeParse(input);
  if (!config || !persona.success || !token) throw unavailable();
  const [current] = await db.select().from(sessions).where(and(eq(sessions.tokenHash, tokenHash(token)), gt(sessions.expiresAt, now)));
  if (!current?.demoPersona || !current.demoGroup) throw unavailable();
  await limited(db, `demo-switch:${current.demoGroup}`, 120);
  const identities = await demoIdentities(db, config);
  if (!identities) throw unavailable();
  const membership = identities[persona.data];
  await db.update(sessions).set({ userId: membership.userId, membershipId: membership.id, demoPersona: persona.data }).where(and(eq(sessions.id, current.id), isNotNull(sessions.demoPersona)));
  await demoAudit(db, config.organisationId, "DEMO_PERSONA_SWITCHED", current.demoGroup, { from: current.demoPersona, persona: persona.data });
  return { persona: persona.data };
}

// Whether a user is one of the demo accounts, so password recovery can refuse them.
export async function isDemoAccount(db: DatabaseSession, config: DemoConfig | null, userId: string) {
  if (!config) return false;
  return (await db.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.userId, userId), inArray(memberships.id, DEMO_PERSONAS.map(persona => config[persona]))))).length > 0;
}

export async function limited(db: DatabaseSession, key: string, maximum: number) {
  try { await consumeLimit(db, key, maximum); }
  catch { throw new UserFacingError("demo-limit", "The demo is busy. Wait a few minutes and try again."); }
}
