import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { resolveScope, type Scope } from "../src/server/auth/access";
import { hashPassword } from "../src/server/auth/identity";
import { savePayoutDestination } from "../src/server/auth/operations";
import { inviteMember, redeemInvitation } from "../src/server/auth/tenancy";
import { getDatabaseConfig } from "../src/server/config/env";
import type { Database } from "../src/server/db/client";
import * as schema from "../src/server/db/schema";
import { memberships, shiftOffers, shifts, subscriptions, users, workers, workPolicies } from "../src/server/db/schema";
import { provisionSaReferenceBusiness } from "../src/server/reference/sa-provision";
import { SA_REFERENCE_ORGANISATION, saReferenceLocation } from "../src/server/reference/sa-reference";
import { allocateAssignment, createDepartment, createRequirement, createWorkPolicy, offerAssignment, respondToAssignment } from "../src/server/scheduling/operations";

// LOCAL RUNTIME FIXTURES ONLY. Makes the fictional Jacaranda Table Demo business usable on a local
// scratch database so the real server can be exercised: an Owner, a Manager per demo location, two
// casual workers, preauthorised ZAR terms and allocated work awaiting the manager's confirmation.
// People and accounts are synthetic (*.example.test); nobody here is a customer. The subscription
// row is a labelled LOCAL fixture, not a PayPal subscription, and this script refuses any database
// that isn't on this machine. Passwords come from FAIRSHIFT_LOCAL_DEMO_PASSWORD and are never printed.

const url = new URL(getDatabaseConfig().DATABASE_URL);
if (!["127.0.0.1", "localhost"].includes(url.hostname) || process.env.NODE_ENV === "production") throw new Error("Local runtime fixtures run only against a database on this machine.");
const password = process.env.FAIRSHIFT_LOCAL_DEMO_PASSWORD ?? "";
if (password.length < 12) throw new Error("Set FAIRSHIFT_LOCAL_DEMO_PASSWORD (12+ characters) for the local fixture accounts.");
const recipient = process.env.FAIRSHIFT_LOCAL_SANDBOX_RECIPIENT?.trim() || null;

const ORG = SA_REFERENCE_ORGANISATION.id;
const ROSEBANK = saReferenceLocation("SA01"), SANDTON = saReferenceLocation("SA02");
const pool = new Pool({ connectionString: url.toString(), application_name: "fairshift-sa-runtime-seed" });
const db = drizzle(pool, { schema }) as unknown as Database;

async function user(email: string, name: string) {
  const [existing] = await db.select().from(users).where(eq(users.email, email));
  if (existing) return existing.id;
  const id = randomUUID();
  await db.insert(users).values({ id, email, name, passwordHash: await hashPassword(password), emailVerifiedAt: new Date() });
  return id;
}

async function invited(owner: Scope, email: string, role: "MANAGER" | "TEAM_MEMBER", firstName: string, surname: string) {
  const [membership] = await db.select({ id: memberships.id, userId: memberships.userId }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(users.email, email), eq(memberships.organisationId, ORG)));
  if (membership) return resolveScope(db, membership.userId, membership.id, owner.locationId);
  const { token } = await inviteMember(db, owner, { role, email, firstName, surname, telephone: "+27 11 000 0000" });
  const userId = await user(email, `${firstName} ${surname}`);
  const created = await redeemInvitation(db, userId, { token });
  return resolveScope(db, userId, created.id, owner.locationId);
}

// Allocated work on preauthorised terms, accepted by the worker, awaiting manager confirmation.
async function allocated(manager: Scope, worker: Scope, label: string, startsAt: Date, endsAt: Date) {
  const [existing] = await db.select({ id: shifts.id }).from(shifts).where(and(eq(shifts.outletId, manager.locationId), eq(shifts.roleName, label)));
  if (existing) return existing.id;
  const [department] = await createDepartment(db, label, manager);
  const shift = await createRequirement(db, { departmentId: department.id, policyId: (await policy(manager)).id, startsAt, endsAt, requiredHeadcount: 1 }, manager);
  const offer = await offerAssignment(db, shift.id, worker.workerId!, manager);
  await respondToAssignment(db, worker.workerId!, offer.id, 1, "ACCEPTED", true, manager);
  await allocateAssignment(db, offer.id, manager);
  return shift.id;
}
async function policy(manager: Scope) {
  const [existing] = await db.select().from(workPolicies).where(and(eq(workPolicies.outletId, manager.locationId), eq(workPolicies.name, "Casual floor terms")));
  if (existing) return existing;
  // R45.00 an hour: fictional reference terms, above the R30.23 national minimum for the date.
  const [created] = await createWorkPolicy(db, { earningsModel: "HOURLY", rateMinor: 4_500 }, "Casual floor terms", manager);
  return created;
}
const quarter = (date: Date) => new Date(Math.floor(date.getTime() / 900_000) * 900_000);

try {
  await provisionSaReferenceBusiness(db);
  const [subscription] = await db.select().from(subscriptions).where(eq(subscriptions.organisationId, ORG));
  const fixture = { status: "ACTIVE", verifiedAt: new Date(), providerId: "LOCAL-RUNTIME-FIXTURE", planId: "LOCAL-RUNTIME-FIXTURE", tier: "MULTI_OUTLET", billingPeriod: "MONTHLY", locationLimit: 5 };
  if (!subscription) await db.insert(subscriptions).values({ id: randomUUID(), organisationId: ORG, requestId: randomUUID(), ...fixture });

  const ownerId = await user("owner@jacaranda-runtime.example.test", "Thandi Owner");
  let [ownerMembership] = await db.select().from(memberships).where(and(eq(memberships.userId, ownerId), eq(memberships.organisationId, ORG)));
  if (!ownerMembership) [ownerMembership] = await db.insert(memberships).values({ id: randomUUID(), userId: ownerId, organisationId: ORG, role: "OWNER" }).returning();
  const ownerAt = (locationId: string) => resolveScope(db, ownerId, ownerMembership.id, locationId);

  const rosebankManager = await invited(await ownerAt(ROSEBANK.id), "manager.rosebank@jacaranda-runtime.example.test", "MANAGER", "Lerato", "Rosebank");
  const sandtonManager = await invited(await ownerAt(SANDTON.id), "manager.sandton@jacaranda-runtime.example.test", "MANAGER", "Sipho", "Sandton");
  const casual = await invited(rosebankManager, "casual.rosebank@jacaranda-runtime.example.test", "TEAM_MEMBER", "Ayanda", "Casual");
  const poolCasual = await invited(sandtonManager, "casual.sandton@jacaranda-runtime.example.test", "TEAM_MEMBER", "Naledi", "Casual");
  if (recipient) await savePayoutDestination(db, casual, recipient);

  const now = Date.now();
  // Clean work: ended two hours ago, to be confirmed now (within 24 hours of the end).
  const clean = await allocated(rosebankManager, casual, "Runtime clean floor", quarter(new Date(now - 6 * 3_600_000)), quarter(new Date(now - 2 * 3_600_000)));
  // Genuine discrepancy: work that ended nine days ago and was never confirmed until now.
  const late = await allocated(rosebankManager, casual, "Runtime late confirmation", quarter(new Date(now - 9 * 86_400_000 - 6 * 3_600_000)), quarter(new Date(now - 9 * 86_400_000 - 2 * 3_600_000)));
  // Work for the stop/restart recovery proof.
  const recovery = await allocated(rosebankManager, casual, "Runtime recovery floor", quarter(new Date(now - 30 * 3_600_000)), quarter(new Date(now - 26 * 3_600_000)));

  const offers = await db.select({ shiftId: shiftOffers.shiftId, offerId: shiftOffers.id }).from(shiftOffers).where(eq(shiftOffers.status, "ACCEPTED"));
  const offerOf = (shiftId: string) => offers.find(row => row.shiftId === shiftId)?.offerId;
  const people = await db.select({ id: workers.id, type: workers.workerType, locationId: workers.locationId, payout: workers.paypalPayoutEmail }).from(workers).where(eq(workers.organisationId, ORG));
  console.log(JSON.stringify({
    organisationId: ORG, rosebank: ROSEBANK.id, sandton: SANDTON.id,
    accounts: ["owner", "manager.rosebank", "manager.sandton", "casual.rosebank", "casual.sandton"].map(name => `${name}@jacaranda-runtime.example.test`),
    shifts: { clean: { shiftId: clean, offerId: offerOf(clean) }, late: { shiftId: late, offerId: offerOf(late) }, recovery: { shiftId: recovery, offerId: offerOf(recovery) } },
    casualWorkerId: casual.workerId, poolCasualWorkerId: poolCasual.workerId,
    payoutDestinationSaved: people.some(row => row.id === casual.workerId && !!row.payout),
  }, null, 2));
} finally {
  await pool.end();
}
