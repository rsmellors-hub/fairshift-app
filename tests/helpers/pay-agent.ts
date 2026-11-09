import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { vi } from "vitest";

import type { Scope } from "@/server/auth/access";
import type { AssessmentRequest, AssessmentResponse } from "@/server/integrations/openai/staffing-assessment";
import type { PayPalPayoutAdapter, PayoutResult } from "@/server/integrations/paypal/payout-client";
import { savePayoutDestination } from "@/server/auth/operations";
import type { Database } from "@/server/db/client";
import { organisations, outlets, subscriptions, users, workers } from "@/server/db/schema";
import { allocateAssignment, confirmWork, createDepartment, createRequirement, createWorkPolicy, offerAssignment, respondToAssignment } from "@/server/scheduling/operations";
import { entitled } from "./onboarding";
import { createActivatedTeamMember } from "./workers";

// Pay Agent fixtures built only through the normal FairShift operations: a tenant, preauthorised
// terms, an offer the worker accepts, an allocation and the manager's confirmation. Synthetic
// people and amounts; no provider is contacted.

// Tue 20 Oct 2026, 08:00 UTC: in the past, so the scheduled work has ended.
export const WORK_START = Date.parse("2026-10-20T08:00:00Z");
export const workAt = (hours: number) => new Date(WORK_START + hours * 3_600_000);

let n = 0;
export async function testUser(db: Database) {
  const id = randomUUID();
  await db.insert(users).values({ id, email: `pay-agent-user${++n}-${id.slice(0, 6)}@example.test`, name: "Test user", passwordHash: "test", emailVerifiedAt: new Date() });
  return id;
}

export async function payAgentCompany(db: Database, options: { country?: string; locations?: number } = {}) {
  const country = options.country ?? "United Kingdom";
  const organisationId = randomUUID();
  await db.insert(organisations).values({ id: organisationId, name: `${country} test company`, country });
  await db.insert(subscriptions).values({ id: randomUUID(), organisationId, requestId: randomUUID() });
  await entitled(db, organisationId);
  const timezone = country === "South Africa" ? "Africa/Johannesburg" : "Europe/London";
  const rows = Array.from({ length: options.locations ?? 1 }, (_, i) => ({ id: randomUUID(), organisationId, name: `Store ${i + 1}`, timezone }));
  await db.insert(outlets).values(rows);
  const scopes: Scope[] = [];
  for (const row of rows) scopes.push({ userId: await testUser(db), organisationId, locationId: row.id, role: "MANAGER", organisationName: `${country} test company`, locationName: row.name });
  return { organisationId, scopes };
}

export type WorkOptions = { paymentEmail?: string | null; incentive?: boolean; commission?: boolean; startsAt?: Date; endsAt?: Date };

// Shift with preauthorised terms → offer → the worker's acceptance → allocation.
export async function allocatedWork(db: Database, manager: Scope, options: WorkOptions = {}) {
  const [department] = await createDepartment(db, `Floor ${randomUUID().slice(0, 6)}`, manager);
  const terms = options.commission
    ? { earningsModel: "COMMISSION" as const, commissionBps: 500, commissionBasis: "VERIFIED_ATTRIBUTED_SALES" as const }
    : { earningsModel: "HOURLY" as const, rateMinor: 1_300, ...(options.incentive ? { incentiveTargetMinor: 50_000, incentiveBonusMinor: 2_000 } : {}) };
  const [policy] = await createWorkPolicy(db, terms, "Casual terms", manager);
  const shift = await createRequirement(db, { departmentId: department.id, policyId: policy.id, startsAt: options.startsAt ?? workAt(0), endsAt: options.endsAt ?? workAt(6), requiredHeadcount: 1 }, manager);
  const { worker } = await createActivatedTeamMember(db, { firstName: "Casual", surname: `Worker ${++n}`, telephone: "+441132000000", email: `casual${n}@example.test` }, manager);
  const workerScope: Scope = { ...manager, userId: await testUser(db), workerId: worker.id, role: "TEAM_MEMBER" };
  await db.update(workers).set({ userId: workerScope.userId }).where(eq(workers.id, worker.id));
  if (options.paymentEmail !== null) await savePayoutDestination(db, workerScope, options.paymentEmail ?? "casual.sandbox@example.test");
  const offer = await offerAssignment(db, shift.id, worker.id, manager);
  await respondToAssignment(db, worker.id, offer.id, 1, "ACCEPTED", true, manager);
  await allocateAssignment(db, offer.id, manager);
  return { offer, worker, workerScope, policy, shift };
}

// An in-process model double that answers with a decision for the payable it was shown.
export function fakePayAgentModel(reply: (payableId: string) => unknown = payableId => ({ action: "settle_confirmed_work", payableId, checks: { hours: "OK", overlap: "OK", timing: "OK", records: "OK" } })) {
  const assess = vi.fn(async (request: AssessmentRequest): Promise<AssessmentResponse> => {
    const { payableId } = JSON.parse(request.input) as { payableId: string };
    return { responseId: "resp_test_1", responseModel: "test-model-2026-01-01", text: JSON.stringify({ decision: reply(payableId) }) };
  });
  return { provider: "OPENAI" as const, model: "test-model", assess };
}
// A payout client double: PayPal accepts the batch and reports nothing paid.
export function fakePayoutClient() {
  return {
    createPayout: vi.fn(async (input: { senderBatchId: string }): Promise<PayoutResult> => ({ batchId: `PPB${input.senderBatchId.slice(-8)}`, itemId: null, status: "PENDING", batchStatus: "PENDING", itemStatus: null, transactionId: null })),
    getPayout: vi.fn(),
  } as unknown as PayPalPayoutAdapter & { createPayout: ReturnType<typeof vi.fn> };
}

// …then the manager's explicit confirmation, which records the payable and its Pay Agent event.
export async function confirmedWork(db: Database, manager: Scope, options: WorkOptions = {}) {
  const allocated = await allocatedWork(db, manager, options);
  const confirmation = await confirmWork(db, allocated.offer.id, manager);
  return { ...allocated, ...confirmation };
}
