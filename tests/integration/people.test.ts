import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { business, createOrganisation } from "../helpers/onboarding";
import { resolveScope, type Scope } from "@/server/auth/access";
import { createIdentityToken, redeemIdentityToken, registerIdentity } from "@/server/auth/identity";
import { inviteMember, resendInvitation, revokeInvitation } from "@/server/auth/tenancy";
import { createLocation, setLocationActive, updateLocation } from "@/server/billing/locations";
import { auditEvents, memberships, notificationDeliveries, notifications, outlets, shiftOffers, shifts, teamInvitations, workerAvailability, workers } from "@/server/db/schema";
import { dispatchNotification } from "@/server/notifications/service";
import { deactivatePerson, listPeople, updatePerson } from "@/server/people/people";
import { completeInvitedSignUp, openInvitation } from "@/server/people/sign-up";
import { createDepartment, createRequirement, createWorkPolicy, offerAssignment, respondToAssignment } from "@/server/scheduling/operations";

// Day 6, Owner decision 10 Nov 2026: people are added by invitation, become active only by signing up
// themselves, and are never deleted; locations are created, edited and deactivated by the Owner.
type DB = Awaited<ReturnType<typeof createTestDatabase>>["db"];
const password = "a-long-test-password-42";
async function identity(db: DB, email: string, verify = true) {
  const user = await registerIdentity(db, { email, password });
  if (verify) await redeemIdentityToken(db, await createIdentityToken(db, user.id, "VERIFY_EMAIL"), "VERIFY_EMAIL");
  return user;
}
async function company(db: DB) {
  const owner = await identity(db, "owner@example.test");
  const org = await createOrganisation(db, owner.id, { ...business, name: "Jacaranda Test Kitchen", locationName: "Main Street" });
  const scope = await resolveScope(db, owner.id, org.membershipId);
  return { owner, scope, ...org };
}
type Sent = { to: string; subject: string; text: string; html?: string };
const outbox = () => ({ send: vi.fn<(input: Sent) => Promise<{ status: "ACCEPTED"; messageId: string }>>(async () => ({ status: "ACCEPTED" as const, messageId: `msg-${randomUUID()}` })) });
const week = ["AVAILABLE", "AVAILABLE", "UNAVAILABLE", "AVAILABLE", "AVAILABLE", "AVAILABLE", "UNAVAILABLE"];

describe("people: add by invitation, active only after sign-up", () => {
  it("invites a casual worker with the official email, and activates them only when they complete sign-up", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      const result = await inviteMember(t.db, c.scope, { role: "TEAM_MEMBER", email: "casey@fairshift-mail.dev", firstName: "Casey", surname: "Mokoena" });
      // Status before sign-up, and no offers yet.
      let people = await listPeople(t.db, c.scope);
      expect(people.find(p => p.email === "casey@fairshift-mail.dev")).toMatchObject({ role: "TEAM_MEMBER", status: "INVITED", telephone: null, locations: [{ name: "Main Street" }] });
      expect(result.invitation.expiresAt.getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
      // The official email: subject, inviter, location, role, expiry; HTML and text; logged in the outbox.
      const adapter = outbox();
      await dispatchNotification(t.db, adapter, result.notificationId, `/invite#${result.token}`);
      const sent = adapter.send.mock.calls[0][0];
      expect(sent.subject).toBe("You're invited to work shifts at Jacaranda Test Kitchen");
      expect(sent.text).toContain("Sam Taylor invited you to work shifts at Jacaranda Test Kitchen");
      expect(sent.text).toContain("Role: Casual worker");
      expect(sent.text).toContain("Invited by: Sam Taylor, Owner");
      expect(sent.text).toMatch(/expires on \w{3}, \d{1,2} Nov 2026 \(7 days\)/);
      expect(sent.html).toContain("Accept invitation and sign up");
      expect(sent.html).toContain(`/invite#${result.token}`);
      const [delivery] = await t.db.select().from(notificationDeliveries).innerJoin(notifications, eq(notifications.id, notificationDeliveries.notificationId)).where(eq(notifications.id, result.notificationId));
      expect(delivery.notification_deliveries).toMatchObject({ status: "ACCEPTED", destination: "casey@fairshift-mail.dev" });
      expect((await t.db.select().from(teamInvitations).where(eq(teamInvitations.id, result.invitation.id)))[0].state).toBe("SENT");
      const [worker] = await t.db.select().from(workers).where(eq(workers.email, "casey@fairshift-mail.dev"));
      const [department] = await createDepartment(t.db, "Floor", c.scope);
      const [policy] = await createWorkPolicy(t.db, { earningsModel: "HOURLY", rateMinor: 3_900 }, "Casual", c.scope);
      const shift = await createRequirement(t.db, { departmentId: department.id, policyId: policy.id, startsAt: new Date("2026-11-20T08:00:00Z"), endsAt: new Date("2026-11-20T14:00:00Z"), requiredHeadcount: 1 }, c.scope);
      await expect(offerAssignment(t.db, shift.id, worker.id, c.scope)).rejects.toMatchObject({ feedback: "worker-not-activated" });

      // Sign-up: the invited email only; every detail is checked before anything is redeemed.
      const stranger = await identity(t.db, "someone@example.test", false);
      await expect(openInvitation(t.db, stranger, result.token)).rejects.toMatchObject({ feedback: "invitation-email" });
      const casey = await identity(t.db, "casey@fairshift-mail.dev", false);
      await expect(completeInvitedSignUp(t.db, casey, result.token, { firstName: "Casey", surname: "Mokoena", telephone: "", availability: week.slice(0, 3), payoutEmail: "casey.pp@example.test", confirmPayoutEmail: "casey.pp@example.test" })).rejects.toMatchObject({ feedback: "sign-up-details" });
      await expect(completeInvitedSignUp(t.db, casey, result.token, { firstName: "Casey", surname: "Mokoena", telephone: "", availability: week, payoutEmail: "casey.pp@example.test", confirmPayoutEmail: "casey.p@example.test" })).rejects.toMatchObject({ feedback: "payout-email-mismatch" });
      expect(await t.db.select().from(memberships).where(eq(memberships.userId, casey.id))).toHaveLength(0);
      const membership = await completeInvitedSignUp(t.db, casey, result.token, { firstName: "Casey", surname: "Mokoena-Dube", telephone: "+27 82 000 0000", availability: week, payoutEmail: "casey.pp@example.test", confirmPayoutEmail: "Casey.PP@example.test" });
      expect(membership).toMatchObject({ role: "TEAM_MEMBER", workerId: worker.id, state: "ACTIVE" });
      expect((await t.db.select().from(workers).where(eq(workers.id, worker.id)))[0]).toMatchObject({ userId: casey.id, displayName: "Casey Mokoena-Dube", telephone: "+27 82 000 0000", paypalPayoutEmail: "casey.pp@example.test" });
      expect(await t.db.select().from(workerAvailability).where(eq(workerAvailability.workerId, worker.id))).toHaveLength(7);
      expect(await t.db.select().from(auditEvents).where(eq(auditEvents.action, "PERSON_SIGNED_UP"))).toHaveLength(1);
      people = await listPeople(t.db, c.scope);
      expect(people.find(p => p.workerId === worker.id)?.status).toBe("ACTIVE");
      await expect(offerAssignment(t.db, shift.id, worker.id, c.scope)).resolves.toMatchObject({ status: "OFFERED" });
      // The link can't be used twice.
      await expect(openInvitation(t.db, casey, result.token)).rejects.toMatchObject({ feedback: "invitation-unavailable" });
    } finally { await t.close(); }
  });

  it("invites one Manager to several locations with one email, and lets a Manager add only casual workers at their own location", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      const second = await createLocation(t.db, c.scope, { name: "Harbour", address: "2 Quay", city: "Durban", postalCode: "4001" });
      const result = await inviteMember(t.db, c.scope, { role: "MANAGER", email: "morgan@example.test", firstName: "Morgan", surname: "Naidoo", locationIds: [c.locationId, second.id] });
      expect(result.invitations).toHaveLength(2);
      expect(await t.db.select().from(notifications).where(eq(notifications.recipientEmail, "morgan@example.test"))).toHaveLength(1);
      expect((await t.db.select().from(notifications).where(eq(notifications.id, result.notificationId)))[0].body).toContain("Locations: Main Street, Johannesburg and Harbour, Durban");
      expect((await listPeople(t.db, c.scope)).filter(p => p.role === "MANAGER")).toEqual([expect.objectContaining({ name: "Morgan Naidoo", status: "INVITED", locations: [expect.objectContaining({ name: "Main Street" }), expect.objectContaining({ name: "Harbour" })] })]);
      // A casual worker may belong to several locations (Owner decision 10 Nov 2026): one invitation, both places.
      const both = await inviteMember(t.db, c.scope, { role: "TEAM_MEMBER", email: "two@example.test", firstName: "Two", surname: "Places", locationIds: [c.locationId, second.id] });
      expect(both.invitations).toHaveLength(1);
      expect((await listPeople(t.db, c.scope)).find(p => p.email === "two@example.test")?.locations.map(place => place.name)).toEqual(["Main Street", "Harbour"]);
      const morgan = await identity(t.db, "morgan@example.test", false);
      const first = await completeInvitedSignUp(t.db, morgan, result.token, { firstName: "Morgan", surname: "Naidoo", telephone: "" });
      expect(await t.db.select().from(memberships).where(and(eq(memberships.userId, morgan.id), eq(memberships.state, "ACTIVE")))).toHaveLength(2);
      expect((await listPeople(t.db, c.scope)).filter(p => p.role === "MANAGER")).toEqual([expect.objectContaining({ status: "ACTIVE", userId: morgan.id })]);

      const manager = await resolveScope(t.db, morgan.id, first.id);
      await expect(inviteMember(t.db, manager, { role: "MANAGER", email: "x@example.test", firstName: "X", surname: "Y" })).rejects.toThrow();
      await expect(inviteMember(t.db, manager, { role: "TEAM_MEMBER", email: "x@example.test", firstName: "X", surname: "Y", locationIds: [first.outletId === c.locationId ? second.id : c.locationId] })).rejects.toThrow("Access denied.");
      await inviteMember(t.db, manager, { role: "TEAM_MEMBER", email: "jo@example.test", firstName: "Jo", surname: "Dlamini" });
      // A Manager sees only their own location's workers.
      expect((await listPeople(t.db, manager)).map(p => p.email).sort()).toEqual(["jo@example.test", "two@example.test"]);
    } finally { await t.close(); }
  });

  it("resends an expired invite with a new link, revokes an unaccepted one, and edits details", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      const first = await inviteMember(t.db, c.scope, { role: "TEAM_MEMBER", email: "lee@example.test", firstName: "Lee", surname: "Smith" });
      await t.db.update(teamInvitations).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(teamInvitations.id, first.invitation.id));
      expect((await listPeople(t.db, c.scope)).find(p => p.email === "lee@example.test")?.status).toBe("INVITE_EXPIRED");
      const lee = await identity(t.db, "lee@example.test", false);
      await expect(openInvitation(t.db, lee, first.token)).rejects.toMatchObject({ feedback: "invitation-unavailable" });
      const again = await resendInvitation(t.db, c.scope, first.invitation.id);
      expect((await t.db.select().from(notifications).where(eq(notifications.id, again.notificationId)))[0].title).toBe("You're invited to work shifts at Jacaranda Test Kitchen");
      await expect(openInvitation(t.db, lee, again.token)).resolves.toMatchObject({ role: "TEAM_MEMBER" });
      expect(await t.db.select().from(auditEvents).where(eq(auditEvents.action, "INVITATION_RESENT"))).toHaveLength(1);

      // Edits before sign-up may change the email; the person's record follows.
      const key = (await listPeople(t.db, c.scope)).find(p => p.email === "lee@example.test")!.key;
      await expect(updatePerson(t.db, c.scope, key, { firstName: "Lee", surname: "Smith-Jones", telephone: "+27 11 000 0000", email: "lee.sj@example.test" })).resolves.toEqual({ emailChanged: true });
      expect((await listPeople(t.db, c.scope)).find(p => p.key === key)).toMatchObject({ name: "Lee Smith-Jones", email: "lee.sj@example.test", telephone: "+27 11 000 0000" });
      expect((await t.db.select().from(teamInvitations).where(eq(teamInvitations.id, first.invitation.id)))[0].email).toBe("lee.sj@example.test");

      await revokeInvitation(t.db, c.scope, first.invitation.id);
      expect((await listPeople(t.db, c.scope)).find(p => p.key === key)?.status).toBe("INVITE_REVOKED");
      expect(await t.db.select().from(auditEvents).where(eq(auditEvents.action, "INVITATION_REVOKED"))).toHaveLength(1);
      await expect(openInvitation(t.db, lee, again.token)).rejects.toMatchObject({ feedback: "invitation-unavailable" });
    } finally { await t.close(); }
  });

  it("deactivates people without deleting them, refusing while a worker has upcoming accepted work", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      const invite = await inviteMember(t.db, c.scope, { role: "TEAM_MEMBER", email: "ari@example.test", firstName: "Ari", surname: "Khan" });
      const ari = await identity(t.db, "ari@example.test", false);
      const membership = await completeInvitedSignUp(t.db, ari, invite.token, { firstName: "Ari", surname: "Khan", telephone: "", availability: Array(7).fill("AVAILABLE"), payoutEmail: "ari@example.test", confirmPayoutEmail: "ari@example.test" });
      const [department] = await createDepartment(t.db, "Floor", c.scope);
      const [policy] = await createWorkPolicy(t.db, { earningsModel: "HOURLY", rateMinor: 3_900 }, "Casual", c.scope);
      const later = (day: number) => ({ departmentId: department.id, policyId: policy.id, startsAt: new Date(Date.now() + day * 86_400_000), endsAt: new Date(Date.now() + day * 86_400_000 + 6 * 3_600_000), requiredHeadcount: 1 });
      const accepted = await createRequirement(t.db, later(3), c.scope), open = await createRequirement(t.db, later(5), c.scope);
      const offer = await offerAssignment(t.db, accepted.id, membership.workerId!, c.scope);
      await respondToAssignment(t.db, membership.workerId!, offer.id, 1, "ACCEPTED", true, c.scope);
      const pending = await offerAssignment(t.db, open.id, membership.workerId!, c.scope);
      const key = `worker:${membership.workerId}`;
      await expect(deactivatePerson(t.db, c.scope, key)).rejects.toMatchObject({ feedback: "person-has-shifts" });
      // Once that shift is cancelled, nothing upcoming is left.
      await t.db.update(shifts).set({ status: "CANCELLED" }).where(eq(shifts.id, accepted.id));
      await expect(deactivatePerson(t.db, c.scope, key)).resolves.toEqual({ offersWithdrawn: 1 });
      expect((await t.db.select().from(shiftOffers).where(eq(shiftOffers.id, pending.id)))[0].status).toBe("CANCELLED");
      expect((await t.db.select().from(workers).where(eq(workers.id, membership.workerId!)))[0]).toMatchObject({ status: "INACTIVE", userId: ari.id });
      expect((await t.db.select().from(memberships).where(eq(memberships.id, membership.id)))[0].state).toBe("REVOKED");
      expect((await listPeople(t.db, c.scope)).find(p => p.key === key)?.status).toBe("DEACTIVATED");
      expect((await t.db.select().from(auditEvents).where(eq(auditEvents.action, "PERSON_DEACTIVATED")))[0].metadata).toMatchObject({ offersWithdrawn: 1, signedUp: true });
      await expect(offerAssignment(t.db, open.id, membership.workerId!, c.scope)).rejects.toThrow();
      // The Owner can't be deactivated here.
      await expect(deactivatePerson(t.db, c.scope, `manager:${c.owner.id}`)).rejects.toThrow();
    } finally { await t.close(); }
  });
});

describe("locations: create, edit, deactivate, reactivate (audited)", () => {
  it("keeps every record and refuses to strand the business or upcoming work", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      await expect(setLocationActive(t.db, c.scope, c.locationId, false)).rejects.toMatchObject({ feedback: "location-last" });
      const harbour = await createLocation(t.db, c.scope, { name: "Harbour", address: "2 Quay", city: "Durban", postalCode: "4001" });
      expect(harbour).toMatchObject({ country: "South Africa", address: "2 Quay", city: "Durban", active: true });
      await expect(updateLocation(t.db, c.scope, harbour.id, { name: "Harbour Front", address: "3 Quay", city: "Durban", postalCode: "4001" })).resolves.toEqual({ changed: ["name", "address"] });
      const harbourScope: Scope = { ...c.scope, locationId: harbour.id, locationName: "Harbour Front" };
      const [department] = await createDepartment(t.db, "Floor", harbourScope);
      const [policy] = await createWorkPolicy(t.db, { earningsModel: "HOURLY", rateMinor: 3_900 }, "Casual", harbourScope);
      const shift = await createRequirement(t.db, { departmentId: department.id, policyId: policy.id, startsAt: new Date(Date.now() + 2 * 86_400_000), endsAt: new Date(Date.now() + 2 * 86_400_000 + 4 * 3_600_000), requiredHeadcount: 1 }, harbourScope);
      await expect(setLocationActive(t.db, c.scope, harbour.id, false)).rejects.toMatchObject({ feedback: "location-has-shifts" });
      await t.db.update(shifts).set({ status: "CANCELLED" }).where(eq(shifts.id, shift.id));
      await setLocationActive(t.db, c.scope, harbour.id, false);
      expect((await t.db.select().from(outlets).where(eq(outlets.id, harbour.id)))[0]).toMatchObject({ active: false, name: "Harbour Front" });
      await setLocationActive(t.db, c.scope, harbour.id, true);
      expect((await t.db.select({ action: auditEvents.action }).from(auditEvents).where(eq(auditEvents.entityId, harbour.id))).map(row => row.action))
        .toEqual(expect.arrayContaining(["LOCATION_CREATED", "LOCATION_UPDATED", "LOCATION_DEACTIVATED", "LOCATION_REACTIVATED"]));
    } finally { await t.close(); }
  });
});
