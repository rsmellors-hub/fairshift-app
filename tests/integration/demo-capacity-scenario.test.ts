import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { entitled } from "../helpers/onboarding";
import { activateWorker } from "../helpers/workers";
import { resolveScope, type Scope } from "@/server/auth/access";
import { localIntelligenceRuns, localIntelligenceSignals, memberships, notifications, organisations, outlets, shiftOffers, shifts, subscriptions, users, workAllocations } from "@/server/db/schema";
import type { LocalDiscoveryProvider } from "@/server/integrations/openai/web-discovery";
import { affectedShifts, sendEarlyNotice } from "@/server/intelligence/early-notice";
import { runLocalDiscovery } from "@/server/intelligence/local-intelligence-service";
import { getWeeklyStaffing } from "@/server/intelligence/staffing";
import { provisionSaReferenceBusiness } from "@/server/reference/sa-provision";
import { SA_REFERENCE_LOCATIONS, SA_REFERENCE_ORGANISATION } from "@/server/reference/sa-reference";
import { allocateAssignment, createDepartment, createRequirement, createTeamMember, createWorkPolicy, offerAssignment, respondToAssignment } from "@/server/scheduling/operations";
import { LocalIntelligencePanel } from "@/app/manager/local-intelligence";
import { DisruptionAlerts } from "@/app/owner/disruption-alerts";

vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); }, notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// The DEMO capacity scenario (Owner instruction, 8 November 2026) on the fictional South African demo
// business. Monday 9 November 2026, 08:00 in Johannesburg: the scenario is dated Tuesday 10 November.
const NOW = new Date("2026-11-09T06:00:00Z");
const TOMORROW = "2026-11-10";
const RANGE = { from: "2026-11-02", through: "2026-11-08" };
const ORG = SA_REFERENCE_ORGANISATION.id;
const ROSEBANK = SA_REFERENCE_LOCATIONS.find(row => row.code === "SA01")!.id;
const TZ = "Africa/Johannesburg";

const asDemo = () => {
  vi.stubEnv("FAIRSHIFT_DEPLOYMENT_MODE", "HOSTED_SANDBOX_DEMO"); vi.stubEnv("FAIRSHIFT_SANDBOX_ORGANISATION_ID", ORG);
  vi.stubEnv("PAYPAL_ENV", "sandbox"); vi.stubEnv("PAYPAL_ENVIRONMENT", "sandbox");
};
beforeEach(() => { vi.useFakeTimers({ now: NOW, toFake: ["Date"] }); vi.spyOn(console, "error").mockImplementation(() => {}); asDemo(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];
// The provisioned demo business with an entitlement fixture and a real (non-demo) Owner account.
async function demoBusiness(db: Db) {
  await provisionSaReferenceBusiness(db, RANGE, NOW);
  await db.insert(subscriptions).values({ id: randomUUID(), organisationId: ORG, requestId: randomUUID() });
  await entitled(db, ORG);
  const userId = randomUUID(), membershipId = randomUUID();
  await db.insert(users).values({ id: userId, email: `owner-${userId}@example.test`, name: "Owner", passwordHash: "x", emailVerifiedAt: NOW });
  await db.insert(memberships).values({ id: membershipId, userId, organisationId: ORG, role: "OWNER" });
  return { owner: await resolveScope(db, userId, membershipId, ROSEBANK) };
}
// A casual shift at Rosebank, offered, accepted by the worker and finalised.
async function bookedShift(db: Db, startsAt: string, endsAt: string) {
  const site = { organisationId: ORG, locationId: ROSEBANK };
  const [department] = await createDepartment(db, "Floor", site);
  const [policy] = await createWorkPolicy(db, { earningsModel: "HOURLY", rateMinor: 4_500 }, "Fixture casual terms", site);
  const worker = await activateWorker(db, (await createTeamMember(db, { firstName: "Fixture", surname: "Casual", telephone: "+27110000000", email: "casual.fixture@example.test" }, site)).worker.id);
  const shift = await createRequirement(db, { departmentId: department.id, policyId: policy.id, startsAt: new Date(startsAt), endsAt: new Date(endsAt), requiredHeadcount: 1 }, site);
  const offer = await offerAssignment(db, shift.id, worker.id, site);
  await respondToAssignment(db, worker.id, offer.id, 1, "ACCEPTED", true, site);
  await allocateAssignment(db, offer.id, site);
  return { worker, shift, offer };
}
const rosebankOf = async (db: Db, scope: Scope, at = NOW) => (await getWeeklyStaffing(db, scope, at)).outlets.find(row => row.outletId === ROSEBANK)!;
const demoKeys = async (db: Db, scope: Scope, at = NOW) => ((await rosebankOf(db, scope, at)).localIntelligence?.alerts ?? []).filter(signal => signal.demo).map(signal => signal.key);

describe("DEMO capacity scenario", () => {
  it("gives the Owner a DEMO capacity alert for tomorrow at Rosebank and an early shift notice the Owner can confirm, labelled DEMO and never as AI-found", async () => {
    const { db, close } = await createTestDatabase();
    const { owner } = await demoBusiness(db);
    // Tuesday 10:00–14:00 in Johannesburg.
    const booked = await bookedShift(db, "2026-11-10T08:00:00Z", "2026-11-10T12:00:00Z");
    const staffing = await getWeeklyStaffing(db, owner, NOW);
    const rosebank = staffing.outlets.find(row => row.outletId === ROSEBANK)!;
    const alert = rosebank.localIntelligence!.alerts.find(signal => signal.demo)!;
    expect(alert).toMatchObject({ effectType: "CAPACITY", severity: "HIGH", closureLikely: true, validFrom: TOMORROW, validTo: TOMORROW, name: expect.stringContaining("DEMO") });
    // Only Rosebank has it, and it moves no demand: there is no adjustment on any day.
    expect(staffing.outlets.filter(row => row.outletId !== ROSEBANK).flatMap(row => row.localIntelligence?.alerts ?? [])).toEqual([]);
    expect(rosebank.localIntelligence!.days.every(day => day.adjusted.length === 0)).toBe(true);
    // The Manager's plan shows it on tomorrow's planning blocks as a trading risk.
    expect(rosebank.localIntelligence!.days.find(day => day.date === TOMORROW)!.risks.some(block => block.capacity.includes(alert.key))).toBe(true);
    // Nothing is stored as a finding, so it never counts as an AI call or an AI-found signal.
    expect(await db.select().from(localIntelligenceRuns)).toEqual([]);
    expect(await db.select().from(localIntelligenceSignals)).toEqual([]);

    const target = { organisationId: ORG, outletId: ROSEBANK, timezone: TZ };
    const affected = await affectedShifts(db, target, alert, NOW);
    expect(affected.map(row => row.offerId)).toEqual([booked.offer.id]);
    const card = (canSend: boolean) => renderToStaticMarkup(DisruptionAlerts({ alerts: [{ outletId: ROSEBANK, outletName: "Rosebank", timezone: TZ, signal: alert, affected }], canSend }));
    expect(card(true)).toContain("DEMO scenario");
    expect(card(true)).toContain("not a real event");
    expect(card(true)).not.toContain("AI-found");
    expect(card(true)).toContain("Send early notice to 1 casual worker");
    expect(card(false)).toContain("turned off in the public demo");
    const panel = renderToStaticMarkup(LocalIntelligencePanel({ outlet: rosebank, selectedDate: TOMORROW, demo: false }));
    expect(panel).toContain("DEMO scenario");
    expect(panel).not.toContain("AI found something");

    // The Owner confirms. The notice says it is a DEMO scenario, and nothing is cancelled or changed.
    const readAlert = async (outletId: string, signalKey: string) => {
      const outlet = (await getWeeklyStaffing(db, owner, NOW)).outlets.find(row => row.outletId === outletId);
      const signal = outlet?.localIntelligence?.alerts.find(row => row.key === signalKey);
      return outlet && signal ? { signal, outletId, outletName: outlet.outletName, timezone: outlet.timezone } : null;
    };
    await expect(sendEarlyNotice(db, { ...owner, role: "MANAGER" }, { outletId: ROSEBANK, signalKey: alert.key }, readAlert, NOW)).rejects.toThrow();
    expect(await sendEarlyNotice(db, owner, { outletId: ROSEBANK, signalKey: alert.key }, readAlert, NOW)).toEqual({ sent: 1, workerIds: [booked.worker.id] });
    const [notice] = await db.select().from(notifications).where(eq(notifications.kind, "EARLY_SHIFT_NOTICE"));
    expect(notice).toMatchObject({ workerId: booked.worker.id, recipientEmail: "casual.fixture@example.test", entityId: booked.offer.id });
    expect(notice.title).toMatch(/^DEMO: /);
    expect(notice.body).toContain("DEMO scenario");
    expect(notice.body).toContain("not a real event");
    expect(notice.body).toContain("doesn’t cancel your shift");
    expect((await db.select().from(shifts).where(eq(shifts.id, booked.shift.id)))[0].status).toBe("PUBLISHED");
    expect((await db.select().from(shiftOffers).where(eq(shiftOffers.id, booked.offer.id)))[0].status).toBe("ACCEPTED");
    expect((await db.select().from(workAllocations).where(eq(workAllocations.offerId, booked.offer.id)))[0].state).toBe("ALLOCATED");
    await close();
  });

  it("survives re-provisioning and discovery runs, moves with the date, and exists for no other business", async () => {
    const { db, close } = await createTestDatabase();
    const { owner } = await demoBusiness(db);
    expect(await demoKeys(db, owner)).toEqual([`demo_capacity_${TOMORROW}`]);
    // Re-provisioning the demo business keeps it.
    await provisionSaReferenceBusiness(db, RANGE, NOW);
    expect(await demoKeys(db, owner)).toEqual([`demo_capacity_${TOMORROW}`]);
    // A genuine discovery run at Rosebank doesn't displace it, and the scenario uses none of the AI cap.
    const model: LocalDiscoveryProvider = { provider: "OPENAI", model: "fixture-model", discover: vi.fn(async () => ({ responseId: "resp_fixture", responseModel: "fixture-model", text: JSON.stringify({ coverage: [], signals: [] }), searches: [], consultedUrls: [], citedUrls: [] })) };
    expect((await runLocalDiscovery(db, { organisationId: ORG, outletId: ROSEBANK }, { kind: "DAILY", trigger: "SCHEDULE", provider: model, checkSource: async () => ({ outcome: "REACHABLE", httpStatus: 200 }), now: NOW, cap: 1 })).status).toBe("COMPLETED");
    expect(await demoKeys(db, owner)).toEqual([`demo_capacity_${TOMORROW}`]);
    // The next day it is dated the new tomorrow.
    expect(await demoKeys(db, owner, new Date("2026-11-10T06:00:00Z"))).toEqual(["demo_capacity_2026-11-11"]);

    // An ordinary business with its own Rosebank location never has it.
    const other = randomUUID(), outletId = randomUUID(), userId = randomUUID(), membershipId = randomUUID();
    await db.insert(organisations).values({ id: other, name: "Fixture ordinary cafe", country: "South Africa" });
    await db.insert(subscriptions).values({ id: randomUUID(), organisationId: other, requestId: randomUUID() });
    await entitled(db, other);
    await db.insert(outlets).values({ id: outletId, organisationId: other, name: "Rosebank", timezone: TZ, city: "Johannesburg", province: "Gauteng", country: "South Africa" });
    await db.insert(users).values({ id: userId, email: `owner-${userId}@example.test`, name: "Owner", passwordHash: "x", emailVerifiedAt: NOW });
    await db.insert(memberships).values({ id: membershipId, userId, organisationId: other, role: "OWNER" });
    const ordinary = await resolveScope(db, userId, membershipId, outletId);
    expect((await getWeeklyStaffing(db, ordinary, NOW)).outlets.flatMap(row => row.localIntelligence?.alerts ?? [])).toEqual([]);

    // Once the fictional business is no longer a configured demo organisation, it is gone too.
    vi.unstubAllEnvs();
    vi.stubEnv("FAIRSHIFT_DEPLOYMENT_MODE", "LIVE_CUSTOMER");
    expect(await demoKeys(db, owner)).toEqual([]);
    await close();
  });
});
