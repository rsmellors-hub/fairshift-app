import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { entitled } from "../helpers/onboarding";
import { resolveScope } from "@/server/auth/access";
import { checkPassword } from "@/server/auth/identity";
import { auditEvents, memberships, shiftOffers, users, workAllocations, workers, workPayables } from "@/server/db/schema";
import { DEMO_ACCOUNTS, provisionSaDemo } from "@/server/demo/provision";
import { createOverlapScenario, DEMO_PEOPLE, OVERLAP_SCENARIO_LABEL, provisionDemoPeople } from "@/server/demo/people";
import { loadConfirmedWork, preModelCheck } from "@/server/pay-agent/evidence";
import { workerLocationIds } from "@/server/people/worker-locations";
import { SA_REFERENCE_LOCATIONS, SA_REFERENCE_ORGANISATION } from "@/server/reference/sa-reference";
import { confirmWork } from "@/server/scheduling/operations";

vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); }, notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// The demo business's extra fictional workers and the held-payment scenario (Owner add-on, 12 Nov 2026).
const NOW = new Date("2026-12-01T06:00:00Z");
const ORG = SA_REFERENCE_ORGANISATION.id;
const at = (code: string) => SA_REFERENCE_LOCATIONS.find(row => row.code === code)!.id;
const RECEIVERS = { THABO: "fs-thabo@personal.example.com", SIPHO: "fs-sipho@personal.example.com" };
const PASSWORDS = { THABO: "t".repeat(24), SIPHO: "s".repeat(24) };
type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("FAIRSHIFT_DEPLOYMENT_MODE", "HOSTED_SANDBOX_DEMO"); vi.stubEnv("FAIRSHIFT_SANDBOX_ORGANISATION_ID", ORG);
  vi.stubEnv("PAYPAL_ENV", "sandbox"); vi.stubEnv("PAYPAL_ENVIRONMENT", "sandbox");
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function setUp(db: Db) {
  await provisionSaDemo(db, { now: NOW, range: { from: "2026-11-24", through: "2026-11-30" } });
  await entitled(db, ORG);
  await provisionSaDemo(db, { now: NOW, range: { from: "2026-11-24", through: "2026-11-30" } });
}
async function ownerAt(db: Db, code: string) {
  const [owner] = await db.select({ id: memberships.id, userId: memberships.userId }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(users.email, DEMO_ACCOUNTS.OWNER.email), eq(memberships.organisationId, ORG), eq(memberships.role, "OWNER")));
  return resolveScope(db, owner.userId, owner.id, at(code));
}

describe("demo people", () => {
  it("invites Thabo at two locations and Sipho at Rosebank, each with their own receiver, and is safe to run again", async () => {
    const { db, close } = await createTestDatabase();
    try {
      await setUp(db);
      const first = await provisionDemoPeople(db, { passwords: PASSWORDS, receivers: RECEIVERS, now: NOW });
      expect(first.created.sort()).toEqual(["SIPHO", "THABO"]);
      const [thabo] = await db.select().from(workers).where(eq(workers.id, first.people.THABO!.workerId));
      expect(thabo).toMatchObject({ workerType: "CASUAL", status: "ACTIVE", paypalPayoutEmail: RECEIVERS.THABO, displayName: "Thabo Molefe" });
      expect((await workerLocationIds(db, thabo.id)).sort()).toEqual([at("SA01"), at("SA03")].sort());
      const [sipho] = await db.select({ worker: workers, hash: users.passwordHash }).from(workers).innerJoin(users, eq(users.id, workers.userId)).where(eq(workers.id, first.people.SIPHO!.workerId));
      expect(sipho.worker).toMatchObject({ locationId: at("SA01"), paypalPayoutEmail: RECEIVERS.SIPHO });
      expect(await workerLocationIds(db, sipho.worker.id)).toEqual([at("SA01")]);
      expect(await checkPassword(PASSWORDS.SIPHO, sipho.hash)).toBe(true);

      const again = await provisionDemoPeople(db, { passwords: { THABO: "x".repeat(24), SIPHO: "y".repeat(24) }, receivers: RECEIVERS, now: NOW });
      expect(again).toEqual({ created: [], people: first.people });
      expect(await checkPassword(PASSWORDS.SIPHO, (await db.select({ hash: users.passwordHash }).from(users).where(eq(users.email, DEMO_PEOPLE.SIPHO.email)))[0].hash)).toBe(true);
      expect(await db.select().from(auditEvents).where(eq(auditEvents.action, "PAYOUT_DESTINATION_ADDED"))).toHaveLength(2);
    } finally { await close(); }
  });

  it("sets up only the people asked for", async () => {
    const { db, close } = await createTestDatabase();
    try {
      await setUp(db);
      const result = await provisionDemoPeople(db, { passwords: { SIPHO: PASSWORDS.SIPHO }, receivers: { SIPHO: RECEIVERS.SIPHO }, only: ["SIPHO"], now: NOW });
      expect(result.created).toEqual(["SIPHO"]);
      expect(Object.keys(result.people)).toEqual(["SIPHO"]);
      expect(await db.select().from(users).where(eq(users.email, DEMO_PEOPLE.THABO.email))).toHaveLength(0);
    } finally { await close(); }
  });

  it("never reuses another worker's receiving account", async () => {
    const { db, close } = await createTestDatabase();
    try {
      await setUp(db);
      // Thabo is set up first with Sipho's receiver, so Sipho's own run must be refused.
      await expect(provisionDemoPeople(db, { passwords: PASSWORDS, receivers: { THABO: RECEIVERS.SIPHO, SIPHO: RECEIVERS.SIPHO }, now: NOW })).rejects.toThrow("Sipho's receiving account is already used by another worker");
      expect(await db.select().from(users).where(eq(users.email, DEMO_PEOPLE.SIPHO.email))).toHaveLength(0);
    } finally { await close(); }
  });

  it("books Pretoria Central normally, writes the refused overlapping Rosebank booking as a DEMO scenario, and leaves confirmation and the Pay Agent to the product", async () => {
    const { db, close } = await createTestDatabase();
    try {
      await setUp(db);
      const { people } = await provisionDemoPeople(db, { passwords: PASSWORDS, receivers: RECEIVERS, now: NOW });
      const window = { workerId: people.THABO!.workerId, startsAt: new Date(NOW.getTime() + 3_600_000), endsAt: new Date(NOW.getTime() + 7_200_000) };
      const scenario = await createOverlapScenario(db, window);
      expect(scenario).toMatchObject({ label: OVERLAP_SCENARIO_LABEL, clashCheck: "worker-working", created: true });
      for (const offerId of [scenario.normalOfferId, scenario.scenarioOfferId] as string[]) {
        expect((await db.select().from(shiftOffers).where(eq(shiftOffers.id, offerId)))[0]).toMatchObject({ status: "ACCEPTED", workerId: people.THABO!.workerId });
        expect((await db.select().from(workAllocations).where(eq(workAllocations.offerId, offerId)))[0]).toMatchObject({ state: "ALLOCATED", confirmedAt: null });
      }
      const [audit] = await db.select().from(auditEvents).where(eq(auditEvents.action, "DEMO_SCENARIO_CREATED"));
      expect(audit.metadata).toMatchObject({ label: OVERLAP_SCENARIO_LABEL, synthetic: true, clashCheck: "worker-working" });
      // Nothing is confirmed or payable yet, and a second run changes nothing.
      expect(await db.select().from(workPayables).where(eq(workPayables.workerId, people.THABO!.workerId))).toHaveLength(0);
      expect(await createOverlapScenario(db, window)).toMatchObject({ scenarioOfferId: scenario.scenarioOfferId, created: false });

      // After both end, a person confirms each through the normal operation; the Pay Agent's evidence
      // for the second sees the first as overlapping confirmed work, and nothing is missing from it.
      vi.setSystemTime(new Date(NOW.getTime() + 3 * 3_600_000));
      const pretoria = await ownerAt(db, "SA03"), rosebank = await ownerAt(db, "SA01");
      await confirmWork(db, scenario.normalOfferId as string, pretoria);
      const second = await confirmWork(db, scenario.scenarioOfferId as string, rosebank);
      expect(second.payable).toMatchObject({ status: "PENDING_REVIEW", baseAmountMinor: 4_500, currencyCode: "ZAR" });
      const evidence = (await loadConfirmedWork(db, { organisationId: ORG, locationId: at("SA01") }, second.payable!.id))!;
      expect(evidence.overlappingConfirmedWork).toBe(1);
      expect({ check: preModelCheck(evidence), missing: evidence.missing }).toEqual({ check: null, missing: [] });
    } finally { await close(); }
  });
});
