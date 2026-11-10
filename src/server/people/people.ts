import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { assertRole, type Scope } from "@/server/auth/access";
import { auditActor } from "@/server/auth/audit-actor";
import { requireEntitlement } from "@/server/billing/entitlement";
import type { Database, DatabaseSession } from "@/server/db/client";
import { auditEvents, memberships, outlets, shiftOffers, shifts, teamInvitations, users, workerLocations, workers } from "@/server/db/schema";
import { worksAt } from "@/server/people/worker-locations";
import { approvedMinutes } from "@/server/scheduling/shift-suggestions";
import { loadHoursRule } from "@/server/scheduling/shift-rules";
import { UserFacingError } from "@/server/domain/errors";

// People in a business (Day 6, Owner decision 10 Nov 2026): Managers and casual workers, each with a
// status the Owner can act on. A person is added by invitation (tenancy.ts inviteMember) and is active
// only once they have signed up themselves. Nobody is ever hard-deleted: deactivation is recorded and
// audited, and a deactivated person can't be offered work or manage a location.

export type PersonStatus = "INVITED" | "INVITE_EXPIRED" | "INVITE_REVOKED" | "ACTIVE" | "DEACTIVATED";
export const PERSON_STATUS_LABEL: Record<PersonStatus, string> = {
  INVITED: "Invited — not yet signed up", INVITE_EXPIRED: "Invite expired", INVITE_REVOKED: "Invite revoked", ACTIVE: "Active", DEACTIVATED: "Deactivated",
};
export type Person = {
  key: string; role: "MANAGER" | "TEAM_MEMBER" | "REGULAR"; name: string; email: string | null; telephone: string | null;
  locations: { id: string; name: string }[]; status: PersonStatus;
  invitationId: string | null; invitationExpiresAt: Date | null; workerId: string | null; userId: string | null;
  // Casual workers: approved hours per week over the business's reference period, across all their
  // locations, and whether that reaches the regular-hours alert; and their own "I want more hours".
  weeklyAverageMinutes: number | null; hoursAlert: boolean; wantsMoreHours: boolean;
};

const OPEN = ["CREATED_NOT_SENT", "SENT", "DELIVERY_FAILED"] as const;
const invitationStatus = (row: { state: string; expiresAt: Date }, now: Date): PersonStatus =>
  row.state === "REVOKED" ? "INVITE_REVOKED" : row.state === "EXPIRED" || row.expiresAt <= now ? "INVITE_EXPIRED" : "INVITED";

// Everyone the caller may manage: the Owner sees the whole business; a Manager sees the workers at
// their own location only.
export async function listPeople(db: DatabaseSession, scope: Scope, now = new Date(), options: { locationId?: string } = {}): Promise<Person[]> {
  assertRole(scope, ["OWNER", "MANAGER"]);
  const owner = scope.role === "OWNER";
  // One location's team: a Manager's own, or the one the Owner is looking at.
  const at = owner ? options.locationId ?? null : scope.locationId;
  const places = await db.select({ id: outlets.id, name: outlets.name }).from(outlets).where(eq(outlets.organisationId, scope.organisationId));
  const place = (id: string | null) => places.find(row => row.id === id);
  const invitations = await db.select().from(teamInvitations)
    .where(and(eq(teamInvitations.organisationId, scope.organisationId), at ? eq(teamInvitations.outletId, at) : undefined))
    .orderBy(desc(teamInvitations.createdAt));
  const people: Person[] = [];

  const staff = await db.select().from(workers).where(and(eq(workers.organisationId, scope.organisationId), at ? worksAt(at) : undefined));
  const extra = staff.length ? await db.select({ workerId: workerLocations.workerId, outletId: workerLocations.outletId }).from(workerLocations)
    .where(and(inArray(workerLocations.workerId, staff.map(row => row.id)), isNull(workerLocations.removedAt))) : [];
  const rule = await loadHoursRule(db, scope.organisationId);
  const weeks = rule?.referenceWeeks ?? 12;
  const approved = await approvedMinutes(db, scope.organisationId, staff.filter(row => row.workerType === "CASUAL").map(row => row.id), new Date(now.getTime() - weeks * 7 * 86_400_000));
  for (const worker of staff) {
    const invitation = invitations.find(row => row.workerId === worker.id);
    const status: PersonStatus = worker.status === "INACTIVE" ? (invitation && !worker.userId && invitation.state === "REVOKED" ? "INVITE_REVOKED" : "DEACTIVATED")
      : worker.userId ? "ACTIVE" : invitation ? invitationStatus(invitation, now) : "INVITED";
    people.push({ key: `worker:${worker.id}`, role: worker.workerType === "CASUAL" ? "TEAM_MEMBER" : "REGULAR", name: worker.displayName, email: worker.email, telephone: worker.telephone,
      locations: [worker.locationId, ...extra.filter(row => row.workerId === worker.id).map(row => row.outletId)].map(id => place(id)).filter((row): row is { id: string; name: string } => !!row), status,
      invitationId: invitation && !worker.userId ? invitation.id : null, invitationExpiresAt: invitation?.expiresAt ?? null, workerId: worker.id, userId: worker.userId,
      ...(() => { if (worker.workerType !== "CASUAL") return { weeklyAverageMinutes: null, hoursAlert: false, wantsMoreHours: false };
        const weekly = Math.round((approved.get(worker.id) ?? 0) / weeks);
        return { weeklyAverageMinutes: weekly, hoursAlert: !!rule && weekly >= rule.weeklyThresholdMinutes, wantsMoreHours: worker.wantsMoreHours }; })() });
  }
  if (!owner && scope.role === "MANAGER") return people;

  // Managers who have signed up, one row per person with all their locations.
  const managers = (await db.select({ membership: memberships, user: users }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.organisationId, scope.organisationId), eq(memberships.role, "MANAGER"))))
    .filter((row, _, all) => !at || all.some(other => other.user.id === row.user.id && other.membership.outletId === at));
  const byUser = new Map<string, typeof managers>();
  for (const row of managers) byUser.set(row.user.id, [...(byUser.get(row.user.id) ?? []), row]);
  for (const [userId, rows] of byUser) {
    const active = rows.filter(row => row.membership.state === "ACTIVE");
    const user = rows[0].user;
    people.push({ key: `manager:${userId}`, role: "MANAGER", name: [user.firstName, user.surname].filter(Boolean).join(" ") || user.name || user.email, email: user.email, telephone: user.telephone,
      locations: (active.length ? active : rows).map(row => place(row.membership.outletId)).filter((row): row is { id: string; name: string } => !!row),
      status: (at ? rows.some(row => row.membership.outletId === at && row.membership.state === "ACTIVE") : active.length) ? "ACTIVE" : "DEACTIVATED", invitationId: null, invitationExpiresAt: null, workerId: null, userId,
      weeklyAverageMinutes: null, hoursAlert: false, wantsMoreHours: false });
  }
  // Manager invitations not yet accepted, one row per batch.
  const seen = new Set<string>();
  for (const invitation of invitations.filter(row => row.role === "MANAGER" && row.state !== "REDEEMED")) {
    const batch = invitation.batchId ?? invitation.id;
    if (seen.has(batch)) continue;
    seen.add(batch);
    const siblings = invitations.filter(row => (row.batchId ?? row.id) === batch);
    if ([...byUser.values()].some(rows => rows[0].user.email === invitation.email && rows.some(row => row.membership.state === "ACTIVE") && siblings.every(s => rows.some(row => row.membership.outletId === s.outletId)))) continue;
    people.push({ key: `invitation:${batch}`, role: "MANAGER", name: [invitation.firstName, invitation.surname].filter(Boolean).join(" ") || invitation.email || "Invited manager", email: invitation.email, telephone: invitation.telephone,
      locations: siblings.map(row => place(row.outletId)).filter((row): row is { id: string; name: string } => !!row), status: invitationStatus(invitation, now),
      invitationId: invitation.id, invitationExpiresAt: invitation.expiresAt, workerId: null, userId: null, weeklyAverageMinutes: null, hoursAlert: false, wantsMoreHours: false });
  }
  return people;
}

const audit = (db: DatabaseSession, scope: Scope, outletId: string | null, action: string, entityType: string, entityId: string, detail: Record<string, unknown>) =>
  db.insert(auditEvents).values({ id: randomUUID(), organisationId: scope.organisationId, outletId, action, entityType, entityId, correlationId: `${action.toLowerCase()}:${entityId}:${Date.now()}`, metadata: { ...auditActor(scope), ...detail } });

const editInput = z.object({
  firstName: z.string().trim().min(1).max(100), surname: z.string().trim().min(1).max(100),
  telephone: z.union([z.literal(""), z.string().trim().regex(/^\+?[0-9 ()-]{6,30}$/)]),
  email: z.string().trim().toLowerCase().email().max(254).optional(),
});

// Edits a person's name and contact details. Their email can change only before they've signed up
// (it is their sign-in once they have); a changed email needs the invitation resent.
export async function updatePerson(db: Database, scope: Scope, key: string, input: unknown) {
  assertRole(scope, ["OWNER", "MANAGER"]);
  await requireEntitlement(db, scope.organisationId);
  const value = editInput.parse(input);
  const telephone = value.telephone || null;
  const [kind, id] = key.split(":");
  z.uuid().parse(id);
  return db.transaction(async tx => {
    if (kind === "worker") {
      const [worker] = await tx.select().from(workers).where(and(eq(workers.id, id), eq(workers.organisationId, scope.organisationId), scope.role === "OWNER" ? undefined : eq(workers.locationId, scope.locationId))).for("update");
      if (!worker) throw new Error("Person unavailable.");
      const email = value.email && !worker.userId ? value.email : worker.email;
      if (email !== worker.email) {
        const [clash] = await tx.select({ id: workers.id }).from(workers).where(and(eq(workers.organisationId, scope.organisationId), eq(workers.email, email!), ne(workers.id, worker.id)));
        if (clash) throw new UserFacingError("person-exists", "Someone with this email is already in this business.");
        await tx.update(teamInvitations).set({ email }).where(and(eq(teamInvitations.workerId, worker.id), inArray(teamInvitations.state, [...OPEN, "EXPIRED"])));
      }
      await tx.update(workers).set({ firstName: value.firstName, surname: value.surname, displayName: `${value.firstName} ${value.surname}`, telephone, email, updatedAt: new Date() }).where(eq(workers.id, worker.id));
      await tx.update(teamInvitations).set({ firstName: value.firstName, surname: value.surname, telephone }).where(eq(teamInvitations.workerId, worker.id));
      await audit(tx, scope, worker.locationId, "PERSON_UPDATED", "worker", worker.id, { fields: ["name", "telephone", ...(email !== worker.email ? ["email"] : [])], emailChanged: email !== worker.email });
      return { emailChanged: email !== worker.email };
    }
    assertRole(scope, ["OWNER"]);
    if (kind === "manager") {
      const [user] = await tx.select().from(users).where(eq(users.id, id));
      const [member] = await tx.select().from(memberships).where(and(eq(memberships.userId, id), eq(memberships.organisationId, scope.organisationId), eq(memberships.role, "MANAGER")));
      if (!user || !member) throw new Error("Person unavailable.");
      await tx.update(users).set({ firstName: value.firstName, surname: value.surname, name: `${value.firstName} ${value.surname}`, telephone }).where(eq(users.id, id));
      await audit(tx, scope, member.outletId, "PERSON_UPDATED", "manager", id, { fields: ["name", "telephone"], emailChanged: false });
      return { emailChanged: false };
    }
    if (kind === "invitation") {
      const rows = await tx.select().from(teamInvitations).where(and(eq(teamInvitations.organisationId, scope.organisationId), eq(teamInvitations.role, "MANAGER"), inArray(teamInvitations.state, [...OPEN, "EXPIRED"])))
        .for("update");
      const batch = rows.filter(row => (row.batchId ?? row.id) === id);
      if (!batch.length) throw new Error("Person unavailable.");
      const email = value.email ?? batch[0].email;
      await tx.update(teamInvitations).set({ firstName: value.firstName, surname: value.surname, telephone, email }).where(inArray(teamInvitations.id, batch.map(row => row.id)));
      await audit(tx, scope, batch[0].outletId, "PERSON_UPDATED", "team_invitation", batch[0].id, { fields: ["name", "telephone", ...(email !== batch[0].email ? ["email"] : [])], emailChanged: email !== batch[0].email });
      return { emailChanged: email !== batch[0].email };
    }
    throw new Error("Person unavailable.");
  });
}

// Deactivates a person: never a deletion. A casual worker with upcoming accepted work can't be
// deactivated until it is reassigned; their open offers are withdrawn. A Manager loses access to the
// business's locations. Open invitations are revoked. The Owner can't be deactivated here.
export async function deactivatePerson(db: Database, scope: Scope, key: string, now = new Date()) {
  assertRole(scope, ["OWNER", "MANAGER"]);
  await requireEntitlement(db, scope.organisationId);
  const [kind, id] = key.split(":");
  z.uuid().parse(id);
  return db.transaction(async tx => {
    if (kind === "worker") {
      const [worker] = await tx.select().from(workers).where(and(eq(workers.id, id), eq(workers.organisationId, scope.organisationId), scope.role === "OWNER" ? undefined : eq(workers.locationId, scope.locationId))).for("update");
      if (!worker || worker.status === "INACTIVE") throw new Error("Person unavailable.");
      const upcoming = await tx.select({ id: shiftOffers.id }).from(shiftOffers).innerJoin(shifts, eq(shifts.id, shiftOffers.shiftId))
        .where(and(eq(shiftOffers.workerId, worker.id), eq(shiftOffers.status, "ACCEPTED"), gt(shifts.endsAt, now), eq(shifts.status, "PUBLISHED")));
      if (upcoming.length) throw new UserFacingError("person-has-shifts", "This worker has upcoming accepted shifts. Reassign them before deactivating.");
      const withdrawn = await tx.update(shiftOffers).set({ status: "CANCELLED", updatedAt: now }).where(and(eq(shiftOffers.workerId, worker.id), eq(shiftOffers.status, "OFFERED"))).returning({ id: shiftOffers.id });
      await tx.update(workers).set({ status: "INACTIVE", updatedAt: now }).where(eq(workers.id, worker.id));
      await tx.update(memberships).set({ state: "REVOKED" }).where(and(eq(memberships.workerId, worker.id), eq(memberships.organisationId, scope.organisationId)));
      await tx.update(teamInvitations).set({ state: "REVOKED" }).where(and(eq(teamInvitations.workerId, worker.id), inArray(teamInvitations.state, [...OPEN, "EXPIRED"])));
      await audit(tx, scope, worker.locationId, "PERSON_DEACTIVATED", "worker", worker.id, { role: "TEAM_MEMBER", offersWithdrawn: withdrawn.length, signedUp: !!worker.userId });
      return { offersWithdrawn: withdrawn.length };
    }
    assertRole(scope, ["OWNER"]);
    if (kind === "manager") {
      if (id === scope.userId) throw new Error("You can't deactivate yourself.");
      const revoked = await tx.update(memberships).set({ state: "REVOKED" }).where(and(eq(memberships.userId, id), eq(memberships.organisationId, scope.organisationId), eq(memberships.role, "MANAGER"), eq(memberships.state, "ACTIVE"))).returning();
      if (!revoked.length) throw new Error("Person unavailable.");
      await audit(tx, scope, revoked[0].outletId, "PERSON_DEACTIVATED", "manager", id, { role: "MANAGER", locations: revoked.map(row => row.outletId) });
      return { offersWithdrawn: 0 };
    }
    throw new Error("Person unavailable.");
  });
}
