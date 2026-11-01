import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { assertRole, type Scope } from "@/server/auth/access";
import { consumeLimit } from "@/server/auth/identity";
import { requireEntitlement } from "@/server/billing/entitlement";
import { audit } from "@/server/commerce/connections";
import { liveSquareConnection, squareToken } from "@/server/commerce/square-connection";
import type { Database } from "@/server/db/client";
import { commerceWorkerIdentities, departments, organisations, outlets, workPolicies, workers } from "@/server/db/schema";
import { resolveLocationCurrency } from "@/server/domain/currency";
import { UserFacingError } from "@/server/domain/errors";
import { SquareError, type SquareClient } from "@/server/integrations/square/client";
import { createDepartment, createRequirement, createWorkPolicy, offerAssignment } from "@/server/scheduling/operations";

// Sandbox demonstration tooling. It asks Square to create a genuine Sandbox payment and goes no
// further: the payment reaches FairShift only through the normal sync, like any other. Nothing here
// writes a sale or an attributed sale. It is not a point of sale and is never presented as one.
type DemoScope = Pick<Scope, "organisationId" | "locationId" | "role"> & { userId?: string };
const DEMO_CURRENCY = "GBP";
const DEMO_BASE_MINOR = 9_600, DEMO_TARGET_MINOR = 20_000, DEMO_BONUS_MINOR = 2_500;
export const MAX_DEMO_SALE_MINOR = 25_000;
const DEMO_DEPARTMENT = "Square Sandbox demo", DEMO_POLICY = "Square Sandbox demo terms";

// The switch is explicit, not the build mode: a hosted demo is a production build. Both must hold.
export const demoToolsAllowed = (connectionEnvironment: string | null | undefined, flag = process.env.FAIRSHIFT_DEMO_TOOLS) => flag === "enabled" && connectionEnvironment === "SANDBOX";

async function demoConnection(db: Database, scope: DemoScope) {
  assertRole(scope as Scope, ["OWNER", "MANAGER"]);
  await requireEntitlement(db, scope.organisationId);
  const connection = await liveSquareConnection(db, scope);
  if (!demoToolsAllowed(connection?.providerEnvironment)) throw new UserFacingError("square-demo-disabled", "Sandbox demo tools are not available here.");
  return connection!;
}

export async function recordSquareSandboxSale(db: Database, scope: DemoScope, input: { workerId: string; amountMinor: number; requestId: string }, client: SquareClient) {
  const connection = await demoConnection(db, scope);
  const parsed = z.object({ workerId: z.uuid(), amountMinor: z.number().int().min(1).max(MAX_DEMO_SALE_MINOR), requestId: z.uuid() }).safeParse(input);
  if (!parsed.success) throw new UserFacingError("square-demo-amount", "Enter an amount up to the Sandbox limit.");
  const [mapping] = await db.select({ teamMemberId: commerceWorkerIdentities.providerTeamMemberId }).from(commerceWorkerIdentities).where(and(eq(commerceWorkerIdentities.workerId, parsed.data.workerId), eq(commerceWorkerIdentities.organisationId, scope.organisationId), eq(commerceWorkerIdentities.outletId, scope.locationId), eq(commerceWorkerIdentities.status, "ACTIVE")));
  if (!mapping) throw new UserFacingError("square-demo-unmapped", "Map this worker to a Square team member first.");
  await consumeLimit(db, `square-demo-sale:${connection.id}`, 60);
  // The key comes from the page that was rendered, so a double submission is one payment.
  let payment;
  try { payment = await client.createSandboxPayment(squareToken(connection), { idempotencyKey: `fsd-${parsed.data.requestId}`, locationId: connection.providerLocationId!, teamMemberId: mapping.teamMemberId, amountMinor: parsed.data.amountMinor, currencyCode: DEMO_CURRENCY }); }
  catch (error) { if (error instanceof SquareError) throw new UserFacingError("square-demo-refused", "Square did not create this Sandbox payment. Nothing was recorded."); throw error; }
  await audit(db, scope, scope.locationId, "SQUARE_SANDBOX_SALE_REQUESTED", connection.id, { workerId: parsed.data.workerId, amountMinor: parsed.data.amountMinor });
  return { status: payment.status };
}

// A short shift starting just before now and ending shortly, so a sale recorded now falls inside it and
// the work can then be confirmed. It pays a fixed base rather than hours, because a long window reaching
// back would claim earlier Sandbox payments for the same team member. It uses the ordinary rules: the
// worker still accepts the offer themselves, the manager still finalises it, and the window that decides
// attribution is exactly the accepted one.
export async function prepareDemoShift(db: Database, scope: DemoScope, input: { workerId: string; minutesUntilEnd: number }, now = new Date()) {
  await demoConnection(db, scope);
  const parsed = z.object({ workerId: z.uuid(), minutesUntilEnd: z.number().int().min(2).max(240) }).safeParse(input);
  if (!parsed.success) throw new UserFacingError("square-demo-shift", "Choose a worker and when the shift ends.");
  const [worker] = await db.select({ id: workers.id }).from(workers).where(and(eq(workers.id, parsed.data.workerId), eq(workers.organisationId, scope.organisationId), eq(workers.locationId, scope.locationId)));
  if (!worker) throw new UserFacingError("square-demo-shift", "That worker is not available at this location.");
  const [place] = await db.select({ locationCountry: outlets.country, organisationCountry: organisations.country }).from(outlets).innerJoin(organisations, eq(organisations.id, outlets.organisationId)).where(eq(outlets.id, scope.locationId));
  if (resolveLocationCurrency(place) !== DEMO_CURRENCY) throw new UserFacingError("square-demo-shift", "The Sandbox demo uses fixed terms in pounds, and this location uses another currency.");
  const [department] = await db.select().from(departments).where(and(eq(departments.outletId, scope.locationId), eq(departments.name, DEMO_DEPARTMENT)));
  const departmentId = department?.id ?? (await createDepartment(db, DEMO_DEPARTMENT, scope))[0].id;
  const [policy] = await db.select().from(workPolicies).where(and(eq(workPolicies.outletId, scope.locationId), eq(workPolicies.name, DEMO_POLICY)));
  const policyId = policy?.id ?? (await createWorkPolicy(db, { earningsModel: "DAILY", rateMinor: DEMO_BASE_MINOR, incentiveTargetMinor: DEMO_TARGET_MINOR, incentiveBonusMinor: DEMO_BONUS_MINOR }, DEMO_POLICY, scope))[0].id;
  const endsAt = new Date(Math.ceil((now.getTime() + parsed.data.minutesUntilEnd * 60_000) / 60_000) * 60_000);
  const shift = await createRequirement(db, { departmentId, policyId, startsAt: new Date(Math.floor(now.getTime() / 60_000) * 60_000 - 60_000), endsAt, requiredHeadcount: 1 }, scope);
  const offer = await offerAssignment(db, shift.id, worker.id, scope);
  await audit(db, scope, scope.locationId, "SQUARE_SANDBOX_DEMO_SHIFT_CREATED", shift.id, { workerId: worker.id, endsAt: endsAt.toISOString() });
  return { shiftId: shift.id, offerId: offer.id, endsAt };
}
