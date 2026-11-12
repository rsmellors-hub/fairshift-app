import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { entitled } from "../helpers/onboarding";
import { auditEvents, memberships, shiftOffers, shifts, users, workAllocations, workers } from "@/server/db/schema";
import { DEMO_ACCOUNTS, provisionSaDemo } from "@/server/demo/provision";
import { JUDGE_ACCOUNTS, provisionJudgeAccounts } from "@/server/demo/judges";
import { JOBS, runDueJobs } from "@/server/scheduler/feeds";
import { SA_REFERENCE_LOCATIONS, SA_REFERENCE_ORGANISATION } from "@/server/reference/sa-reference";

vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); }, notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// With the public demo off (12 Nov 2026), judges use the demo business through signed-in accounts: the
// hourly demo job keeps booking the demo worker (Ayanda Casual) for tomorrow, and gives the Judge Worker
// one open offer each day, for the day after tomorrow. 1 December 2026, 08:00 in Johannesburg.
const NOW = new Date("2026-12-01T06:00:00Z");
const ORG = SA_REFERENCE_ORGANISATION.id;
const ROSEBANK = SA_REFERENCE_LOCATIONS.find(row => row.code === "SA01")!.id;
const HOUR = 3_600_000;
type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];
const bookingJob = JOBS.filter(job => job.key === "demo:booking");
const tick = (db: Db, at: Date) => runDueJobs(db, { now: () => at, demoOrganisationIds: [ORG], aiSchedule: false }, bookingJob);

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  vi.spyOn(console, "error").mockImplementation(() => {});
  // The hosted Sandbox deployment, with FAIRSHIFT_PUBLIC_DEMO off.
  vi.stubEnv("FAIRSHIFT_DEPLOYMENT_MODE", "HOSTED_SANDBOX_DEMO"); vi.stubEnv("FAIRSHIFT_SANDBOX_ORGANISATION_ID", ORG);
  vi.stubEnv("PAYPAL_ENV", "sandbox"); vi.stubEnv("PAYPAL_ENVIRONMENT", "sandbox"); vi.stubEnv("FAIRSHIFT_PUBLIC_DEMO", "off");
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function accountWorker(db: Db, email: string) {
  const [row] = await db.select({ workerId: memberships.workerId }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(and(eq(users.email, email), eq(memberships.organisationId, ORG)));
  return row.workerId!;
}
async function bookedWorker(db: Db, date: string) {
  const rows = await db.select({ workerId: shiftOffers.workerId }).from(workAllocations).innerJoin(shiftOffers, eq(shiftOffers.id, workAllocations.offerId)).innerJoin(shifts, eq(shifts.id, shiftOffers.shiftId))
    .where(and(eq(shifts.outletId, ROSEBANK), eq(shifts.shiftDate, date), eq(shiftOffers.status, "ACCEPTED"), eq(workAllocations.state, "ALLOCATED")));
  return rows.map(row => row.workerId);
}
async function openOffers(db: Db, workerId: string, date: string) {
  return db.select({ offer: shiftOffers, shift: shifts }).from(shiftOffers).innerJoin(shifts, eq(shifts.id, shiftOffers.shiftId))
    .where(and(eq(shiftOffers.workerId, workerId), eq(shiftOffers.status, "OFFERED"), eq(shifts.outletId, ROSEBANK), eq(shifts.shiftDate, date)));
}

describe("the demo business with the public demo off", () => {
  it("books the demo worker for tomorrow and gives the Judge Worker one open offer a day, for the day after tomorrow", async () => {
    const { db, close } = await createTestDatabase();
    try {
      await provisionSaDemo(db, { now: NOW, range: { from: "2026-11-24", through: "2026-11-30" } });
      await entitled(db, ORG);
      await provisionSaDemo(db, { now: NOW, range: { from: "2026-11-24", through: "2026-11-30" } });
      await provisionJudgeAccounts(db, { OWNER: "o".repeat(24), MANAGER: "m".repeat(24), WORKER: "w".repeat(24) }, { now: NOW });
      // Another signed-up Rosebank casual whose worker ID sorts first: the booking must not move to them.
      const [other] = await db.insert(users).values({ id: "00000000-0000-4000-8000-0000000000aa", email: "first.casual@people.jacaranda-demo.example.test", name: "First Casual", passwordHash: "x", emailVerifiedAt: NOW }).returning();
      await db.insert(workers).values({ id: "00000000-0000-4000-8000-000000000001", organisationId: ORG, displayName: "First Casual", userId: other.id, email: other.email, locationId: ROSEBANK, workerType: "CASUAL" });
      const ayanda = await accountWorker(db, DEMO_ACCOUNTS.WORKER.email), judge = await accountWorker(db, JUDGE_ACCOUNTS.WORKER.email);

      expect(await tick(db, NOW)).toEqual([{ key: "demo:booking", outcome: "RAN", ok: true, code: null }]);
      expect(await bookedWorker(db, "2026-12-02")).toEqual([ayanda]);
      const [offer] = await openOffers(db, judge, "2026-12-03");
      expect(offer.shift).toMatchObject({ status: "PUBLISHED", requiredHeadcount: 1, startsAt: new Date("2026-12-03T13:00:00Z"), endsAt: new Date("2026-12-03T17:00:00Z") });

      // An hour later nothing is added; the next day brings tomorrow's booking (the offer's shift on that
      // date doesn't stop it) and a new open offer.
      await tick(db, new Date(NOW.getTime() + HOUR));
      expect(await db.select().from(auditEvents).where(eq(auditEvents.action, "DEMO_OFFER_CREATED"))).toHaveLength(1);
      vi.setSystemTime(new Date(NOW.getTime() + 24 * HOUR));
      await tick(db, new Date(NOW.getTime() + 24 * HOUR));
      expect(await bookedWorker(db, "2026-12-03")).toEqual([ayanda]);
      expect(await openOffers(db, judge, "2026-12-04")).toHaveLength(1);
      expect(await openOffers(db, judge, "2026-12-03")).toHaveLength(1);
      expect(await db.select().from(auditEvents).where(eq(auditEvents.action, "DEMO_OFFER_CREATED"))).toHaveLength(2);
    } finally { await close(); }
  });
});
