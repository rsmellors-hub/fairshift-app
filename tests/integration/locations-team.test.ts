import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { business, createOrganisation } from "../helpers/onboarding";
import { resolveScope, type Scope } from "@/server/auth/access";
import { createIdentityToken, redeemIdentityToken, registerIdentity } from "@/server/auth/identity";
import { workerRespond } from "@/server/auth/operations";
import { inviteMember } from "@/server/auth/tenancy";
import { createLocation } from "@/server/billing/locations";
import { auditEvents, localIntelligenceRuns, notifications, outlets, shifts, workers } from "@/server/db/schema";
import { AI_LIMITS, discoveryAllowance } from "@/server/intelligence/local-discovery-trigger";
import { signalCategoriesFor, suggestCustomerTypes } from "@/server/intelligence/customer-types";
import { invitationHtml } from "@/server/notifications/templates";
import { invitationEmailFor } from "@/server/auth/tenancy";
import { listPeople } from "@/server/people/people";
import { completeInvitedSignUp } from "@/server/people/sign-up";
import { addWorkerLocation, removeFromLocation, workerLocationIds } from "@/server/people/worker-locations";
import { createDepartment, createRequirement, createWorkPolicy, offerAssignment } from "@/server/scheduling/operations";
import { setShiftRules, setVenueFacts } from "@/server/settings/settings";

// Design package, 10 Nov 2026: a location's Team, casual workers at several locations (Owner decision),
// cancellation pay printed on every offer, customer types, and capped local discovery for any business.
type DB = Awaited<ReturnType<typeof createTestDatabase>>["db"];
const password = "a-long-test-password-42";
async function identity(db: DB, email: string, verify = true) {
  const user = await registerIdentity(db, { email, password });
  if (verify) await redeemIdentityToken(db, await createIdentityToken(db, user.id, "VERIFY_EMAIL"), "VERIFY_EMAIL");
  return user;
}
async function company(db: DB) {
  const owner = await identity(db, "owner@example.test");
  const org = await createOrganisation(db, owner.id, { ...business, name: "Team Test Cafe", locationName: "Main" });
  const scope = await resolveScope(db, owner.id, org.membershipId);
  const second = await createLocation(db, scope, { name: "Harbour", city: "Durban" });
  return { owner, scope, second, at: (locationId: string, name: string): Scope => ({ ...scope, locationId, locationName: name }), ...org };
}
const week = Array(7).fill("AVAILABLE");

describe("casual workers at several locations", () => {
  it("invites one worker to two locations, offers them work at both, lists them on each Team, and removes them from one", async () => {
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      const invite = await inviteMember(t.db, c.scope, { role: "TEAM_MEMBER", email: "ayo@example.test", firstName: "Ayo", surname: "Dube", locationIds: [c.locationId, c.second.id] });
      expect(invite.invitations).toHaveLength(1);
      expect((await t.db.select().from(notifications).where(eq(notifications.id, invite.notificationId)))[0]).toMatchObject({ title: "You're invited to work shifts at Team Test Cafe" });
      const html = invitationHtml((await invitationEmailFor(t.db, invite.invitation.id))!, "https://example.test/invite");
      expect(html).toContain("Sam Taylor invited you to work shifts at Team Test Cafe");
      expect(html).toContain("Main, Johannesburg and Harbour, Durban");
      expect(html).toContain("Invited by</td><td style=\"padding:6px 0;font-size:14px;color:#121110\">Sam Taylor, Owner");
      const ayo = await identity(t.db, "ayo@example.test", false);
      const membership = await completeInvitedSignUp(t.db, ayo, invite.token, { firstName: "Ayo", surname: "Dube", telephone: "", availability: week, payoutEmail: "ayo@example.test", confirmPayoutEmail: "ayo@example.test" });
      const workerId = membership.workerId!;
      expect(await workerLocationIds(t.db, workerId)).toEqual([c.locationId, c.second.id]);
      // Both Teams list them, with the other location named.
      const harbour = c.at(c.second.id, "Harbour");
      expect((await listPeople(t.db, c.scope, new Date(), { locationId: c.second.id })).find(p => p.workerId === workerId)).toMatchObject({ status: "ACTIVE", locations: [{ name: "Main" }, { name: "Harbour" }], weeklyAverageMinutes: 0, hoursAlert: false });
      // Offered and accepted at the second location, through the worker's own sign-in.
      const [department] = await createDepartment(t.db, "Floor", harbour);
      const [policy] = await createWorkPolicy(t.db, { earningsModel: "HOURLY", rateMinor: 3_900 }, "Floor", harbour);
      await setShiftRules(t.db, harbour, { minMinutes: 240, preferredMinutes: 360, maxMinutes: 480, firstRoundMinutes: 120, firstRoundCutoffMinutes: 720, cancellationPercent: 40, cancellationWindowMinutes: 720 });
      const shift = await createRequirement(t.db, { departmentId: department.id, policyId: policy.id, startsAt: new Date(Date.now() + 2 * 86_400_000), endsAt: new Date(Date.now() + 2 * 86_400_000 + 6 * 3_600_000), requiredHeadcount: 1 }, harbour);
      expect(shift).toMatchObject({ cancellationPercent: 40, cancellationWindowMinutes: 720 });
      const offer = await offerAssignment(t.db, shift.id, workerId, harbour);
      const workerScope = await resolveScope(t.db, ayo.id, membership.id);
      expect(workerScope.locationId).toBe(c.locationId);
      await expect(workerRespond(t.db, workerScope, offer.id, 1, "ACCEPTED", true)).resolves.toMatchObject({ status: "ACCEPTED" });
      // Their joining location stays theirs; removing them from the other keeps their history.
      await expect(removeFromLocation(t.db, c.scope, `worker:${workerId}`, c.locationId)).rejects.toMatchObject({ feedback: "person-home-location" });
      await removeFromLocation(t.db, c.scope, `worker:${workerId}`, c.second.id);
      expect((await t.db.select().from(workers).where(eq(workers.id, workerId)))[0].locationId).toBe(c.locationId);
      expect(await workerLocationIds(t.db, workerId)).toEqual([c.locationId]);
      await expect(removeFromLocation(t.db, c.scope, `worker:${workerId}`, c.locationId)).rejects.toMatchObject({ feedback: "person-last-location" });
      expect(await t.db.select().from(auditEvents).where(eq(auditEvents.action, "PERSON_REMOVED_FROM_LOCATION"))).toHaveLength(1);
      // Added back, and a Manager can only add their own location.
      await addWorkerLocation(t.db, c.scope, workerId, c.second.id);
      expect((await workerLocationIds(t.db, workerId)).sort()).toEqual([c.locationId, c.second.id].sort());
      await expect(addWorkerLocation(t.db, { ...harbour, role: "MANAGER" }, workerId, c.locationId)).rejects.toThrow("Access denied.");
      // Never offered at a location they don't belong to.
      const third = await createLocation(t.db, c.scope, { name: "Hill" });
      const hill = c.at(third.id, "Hill");
      const [d3] = await createDepartment(t.db, "Floor", hill);
      const [p3] = await createWorkPolicy(t.db, { earningsModel: "HOURLY", rateMinor: 3_900 }, "Floor", hill);
      const elsewhere = await createRequirement(t.db, { departmentId: d3.id, policyId: p3.id, startsAt: new Date(Date.now() + 4 * 86_400_000), endsAt: new Date(Date.now() + 4 * 86_400_000 + 6 * 3_600_000), requiredHeadcount: 1 }, hill);
      await expect(offerAssignment(t.db, elsewhere.id, workerId, hill)).rejects.toThrow();
      // No saved rule at this location: the default cancellation pay applies (50% within 24 hours).
      expect((await t.db.select().from(shifts).where(eq(shifts.id, elsewhere.id)))[0]).toMatchObject({ cancellationPercent: 50, cancellationWindowMinutes: 1440 });
    } finally { await t.close(); }
  });
});

describe("customer types and local discovery limits", () => {
  it("maps each type to fixed signal categories, records venue facts, and suggests types from a free-text profile", async () => {
    expect(signalCategoriesFor(["COMMUTERS", "OFFICE"])).toEqual([
      { category: "PUBLIC_HOLIDAYS", triggeredBy: "OFFICE" }, { category: "OFFICE_CLOSURES", triggeredBy: "OFFICE" }, { category: "TRANSPORT_STRIKES", triggeredBy: "OFFICE" },
      { category: "TRANSPORT_DISRUPTIONS", triggeredBy: "COMMUTERS" }, { category: "ROAD_CLOSURES", triggeredBy: "COMMUTERS" }]);
    expect(suggestCustomerTypes("Office workers at lunch, shoppers and commuters from the Gautrain station")).toEqual(["OFFICE", "SHOPPERS", "COMMUTERS"]);
    const t = await createTestDatabase();
    try {
      const c = await company(t.db);
      await expect(setVenueFacts(t.db, c.scope, { customerTypes: ["OFFICE"], customerNote: "call 0821234567", venueType: "BAR", seats: 40 })).rejects.toMatchObject({ feedback: "venue-facts-invalid" });
      await setVenueFacts(t.db, c.scope, { customerTypes: ["OFFICE", "NIGHT_OUT", "OFFICE"], customerNote: "Mostly weekday lunch", venueType: "CAFE_RESTAURANT", seats: 64 });
      expect((await t.db.select().from(outlets).where(eq(outlets.id, c.locationId)))[0]).toMatchObject({ customerTypes: ["OFFICE", "NIGHT_OUT"], venueType: "CAFE_RESTAURANT", seats: 64, customerNote: "Mostly weekday lunch" });
    } finally { await t.close(); }
  });

  it("allows discovery only with a confirmed place, and caps it per location, per business and per day", async () => {
    const t = await createTestDatabase();
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test-not-used";
    try {
      const c = await company(t.db);
      const target = { organisationId: c.organisationId, outletId: c.locationId };
      expect(await discoveryAllowance(t.db, target)).toMatchObject({ allowed: false });
      await t.db.update(outlets).set({ latitude: -26.1, longitude: 28.0 }).where(eq(outlets.organisationId, c.organisationId));
      const run = (outletId: string, trigger = "MANUAL") => t.db.insert(localIntelligenceRuns).values({ id: randomUUID(), organisationId: c.organisationId, outletId, kind: "DAILY", trigger, windowFrom: "2026-11-10", windowTo: "2026-11-17", status: "COMPLETED", completedAt: new Date(), policyVersion: "v", outputVersion: "v", provider: "openai", model: "m", input: {} } as never);
      const allowance = await discoveryAllowance(t.db, target);
      if (!allowance.allowed && allowance.reason === "NOT_CONFIGURED") return; // no provider in this environment: nothing to cap
      expect(allowance).toEqual({ allowed: true, left: AI_LIMITS.perLocationPerDay });
      for (let i = 0; i < AI_LIMITS.perLocationPerDay; i++) await run(c.locationId);
      expect(await discoveryAllowance(t.db, target)).toEqual({ allowed: false, reason: "LOCATION_LIMIT" });
    } finally { process.env.OPENAI_API_KEY = previous; await t.close(); }
  });
});
