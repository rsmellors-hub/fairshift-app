import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { resolveScope, type Scope } from "../src/server/auth/access";
import { hashPassword } from "../src/server/auth/identity";
import { savePayoutDestination } from "../src/server/auth/operations";
import { inviteMember, redeemInvitation } from "../src/server/auth/tenancy";
import { sandboxOrganisationId } from "../src/server/config/deployment";
import { getDatabaseConfig, getPayPalPayoutConfig } from "../src/server/config/env";
import type { Database } from "../src/server/db/client";
import * as schema from "../src/server/db/schema";
import { memberships, payAgentEvents, users, workPayables, workPayouts } from "../src/server/db/schema";
import { localDateTimeToInstant } from "../src/server/domain/timezone";
import { PAYOUT_NEGATIVE_TEST_CODE_ENV, PAYOUT_NEGATIVE_TESTS_ENV, PayPalPayoutClient } from "../src/server/integrations/paypal/payout-client";
import { mintPayAgentCredentialForManager } from "../src/server/pay-agent/identity";
import { workerPayStatus } from "../src/server/pay-agent/presentation";
import { PAY_AGENT_DRY_RUN_ENV } from "../src/server/pay-agent/settlement";
import { payAgentFor, releasePayAgentHold } from "../src/server/pay-agent/service";
import { payoutPlainReason } from "../src/server/payments/payout-reasons";
import { payoutStatusFromProvider, refreshWorkPayout, submitWorkPayout } from "../src/server/payments/work-payouts";
import { allocateAssignment, confirmWork, createDepartment, createRequirement, createWorkPolicy, offerAssignment, respondToAssignment } from "../src/server/scheduling/operations";
import { SA_REFERENCE_ORGANISATION, saReferenceLocation } from "../src/server/reference/sa-reference";

// LOCAL PAYPAL SANDBOX NEGATIVE TESTING ONLY (Owner requirement, 7 Nov 2026, Checkpoint E).
// Each create-payout test value goes once through FairShift's real flow: a manager confirms work on
// preauthorised terms, the Pay Agent decides (genuine model), the settlement gates run and the
// shared payout engine calls PayPal Sandbox with items[0].note set to the code. Then the
// INTERNAL_ERROR payout is recovered through status reconciliation (identical resend), the rate-limit
// payout's immediate resend is checked against the backoff, and ERRPYO018 is read through the
// client's status GET. Refuses unless: local database, not production, Sandbox organisation,
// negative-test flag on. Prints IDs, statuses and codes only; never a credential or recipient.
const url = new URL(getDatabaseConfig().DATABASE_URL);
if (!["127.0.0.1", "localhost"].includes(url.hostname) || process.env.NODE_ENV === "production") throw new Error("Local database only.");
if (process.env[PAYOUT_NEGATIVE_TESTS_ENV] !== "enabled") throw new Error(`Set ${PAYOUT_NEGATIVE_TESTS_ENV}=enabled.`);
const ORG = SA_REFERENCE_ORGANISATION.id;
if (sandboxOrganisationId() !== ORG) throw new Error("The Jacaranda Table Demo must be the configured Sandbox organisation.");
if (getPayPalPayoutConfig().apiBaseUrl !== "https://api-m.sandbox.paypal.com") throw new Error("Sandbox only.");
process.env[PAY_AGENT_DRY_RUN_ENV] = "false";

const CODES = ["ERRPYO005", "ERRPYO006", "ERRPYO035", "ERRPYO036", "ERRPYO038", "ERRPYO039", "ERRPYO001", "ERRPYO003"];
const RECEIVER = "payouts-simulator-receiver@paypal.com";
const pool = new Pool({ connectionString: url.toString(), application_name: "fairshift-paypal-negative" });
const db = drizzle(pool, { schema }) as unknown as Database;
const paypal = new PayPalPayoutClient(getPayPalPayoutConfig());

async function managerScope(): Promise<Scope> {
  const [row] = await db.select({ id: memberships.id, userId: memberships.userId }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(users.email, "manager.rosebank@jacaranda-runtime.example.test"), eq(memberships.organisationId, ORG)));
  if (!row) throw new Error("Run scripts/seed-sa-runtime.ts first.");
  return resolveScope(db, row.userId, row.id, saReferenceLocation("SA01").id);
}
// Held payments are the Owner's to decide (Owner decision, 9 November 2026).
async function ownerScope(): Promise<Scope> {
  const [row] = await db.select({ id: memberships.id, userId: memberships.userId }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(users.email, "owner@jacaranda-runtime.example.test"), eq(memberships.organisationId, ORG), eq(memberships.role, "OWNER")));
  if (!row) throw new Error("Run scripts/seed-sa-runtime.ts first.");
  return resolveScope(db, row.userId, row.id, saReferenceLocation("SA01").id);
}
async function negativeWorker(manager: Scope): Promise<Scope> {
  const email = "negative.tests@jacaranda-runtime.example.test";
  const [existing] = await db.select({ id: memberships.id, userId: memberships.userId }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(and(eq(users.email, email), eq(memberships.organisationId, ORG)));
  if (existing) return resolveScope(db, existing.userId, existing.id, manager.locationId);
  const { token } = await inviteMember(db, manager, { role: "TEAM_MEMBER", email, firstName: "Negative", surname: "Tests", telephone: "+27 11 000 0001" });
  const userId = randomUUID();
  await db.insert(users).values({ id: userId, email, name: "Negative Tests", passwordHash: await hashPassword(randomUUID()), emailVerifiedAt: new Date() });
  const membership = await redeemInvitation(db, userId, { token });
  const scope = await resolveScope(db, userId, membership.id, manager.locationId);
  // PayPal's Payouts simulator receiver, through the worker's own payment-settings path.
  await savePayoutDestination(db, scope, RECEIVER);
  return scope;
}

const out: Record<string, unknown>[] = [];
// `--release <code>=<eventId> ...`: a manager releases a Pay Agent hold on a code's work (the
// existing hold-release path), and the settlement runs once with that code as the test note.
const releases = process.argv.includes("--release") ? process.argv.slice(process.argv.indexOf("--release") + 1).map(arg => arg.split("=")) : [];
if (releases.length) {
  try {
    const owner = await ownerScope();
    const agent = payAgentFor(db);
    for (const [code, eventId] of releases) {
      if (!CODES.includes(code)) throw new Error(`Unknown test value ${code}.`);
      const released = await releasePayAgentHold(db, owner, eventId, `Negative payout test ${code}: released to exercise the PayPal refusal path.`);
      process.env[PAYOUT_NEGATIVE_TEST_CODE_ENV] = code;
      const run = await agent.process({ eventId: released.eventId }, released.credential);
      delete process.env[PAYOUT_NEGATIVE_TEST_CODE_ENV];
      const [event] = await db.select().from(payAgentEvents).where(eq(payAgentEvents.id, eventId));
      const [row] = await db.select().from(workPayables).where(eq(workPayables.id, event.payableId));
      const [payout] = await db.select().from(workPayouts).where(eq(workPayouts.payableId, event.payableId));
      const lastError = payout?.lastError as { code?: string; httpStatus?: number; outcome?: string } | null;
      out.push({ code, via: "manager released hold", journal: event.status, journalOutcome: event.outcomeCode, payable: row.status, payout: payout?.status ?? null,
        paypalHttp: lastError?.httpStatus ?? null, paypalError: lastError?.code ?? null, outcome: lastError?.outcome ?? null,
        worker: workerPayStatus({ workConfirmed: true, hasPayable: true, approved: row.status === "APPROVED", payoutStatus: payout?.status ?? null, agentStatus: event.status }),
        ownerReason: payoutPlainReason(lastError?.code), run: run.status });
    }
    console.log(JSON.stringify(out, null, 1));
  } finally { await pool.end(); }
  process.exit(0);
}
try {
  const manager = await managerScope();
  const worker = await negativeWorker(manager);
  const [department] = await createDepartment(db, `Negative tests ${new Date().toISOString().slice(0, 16)}`, manager);
  const [policy] = await createWorkPolicy(db, { earningsModel: "HOURLY", rateMinor: 4_500 }, "Negative test terms", manager);
  const agent = payAgentFor(db);
  const credential = mintPayAgentCredentialForManager(manager);
  for (const [index, code] of CODES.entries()) {
    // One-hour shifts earlier today, confirmed within 24 hours of their end.
    const startsAt = localDateTimeToInstant(`2026-11-07T${String(index).padStart(2, "0")}:00`, "Africa/Johannesburg");
    const shift = await createRequirement(db, { departmentId: department.id, policyId: policy.id, startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000), requiredHeadcount: 1 }, manager);
    const offer = await offerAssignment(db, shift.id, worker.workerId!, manager);
    await respondToAssignment(db, worker.workerId!, offer.id, 1, "ACCEPTED", true, manager);
    await allocateAssignment(db, offer.id, manager);
    const { payable, payAgentEvent } = await confirmWork(db, offer.id, manager);
    process.env[PAYOUT_NEGATIVE_TEST_CODE_ENV] = code;
    const run = await agent.process({ eventId: payAgentEvent!.id }, credential);
    delete process.env[PAYOUT_NEGATIVE_TEST_CODE_ENV];
    const [event] = await db.select().from(payAgentEvents).where(eq(payAgentEvents.id, payAgentEvent!.id));
    const [row] = await db.select().from(workPayables).where(eq(workPayables.id, payable!.id));
    const [payout] = await db.select().from(workPayouts).where(eq(workPayouts.payableId, payable!.id));
    const lastError = payout?.lastError as { code?: string; httpStatus?: number; outcome?: string } | null;
    out.push({ code, decision: event.decision, responseId: event.responseId, journal: event.status, journalOutcome: event.outcomeCode, payable: row.status,
      payout: payout?.status ?? null, paypalHttp: lastError?.httpStatus ?? null, paypalError: lastError?.code ?? null, outcome: lastError?.outcome ?? null,
      senderBatchId: payout?.senderBatchId ?? null, paypalBatchId: payout?.paypalBatchId ?? null,
      worker: workerPayStatus({ workConfirmed: true, hasPayable: true, approved: row.status === "APPROVED", payoutStatus: payout?.status ?? null, agentStatus: event.status }),
      ownerReason: payoutPlainReason(lastError?.code), run: run.status, payableId: row.id });
  }

  // INTERNAL_ERROR recovery: the identical request is resent (same sender_batch_id), no test note.
  const internal = out.find(row => row.code === "ERRPYO006");
  if (internal?.payout === "RECONCILIATION_REQUIRED") {
    const recovered = await refreshWorkPayout(db, paypal, manager, String(internal.payableId));
    const rows = await db.select().from(workPayouts).where(eq(workPayouts.payableId, String(internal.payableId)));
    out.push({ step: "ERRPYO006 recovery", payout: recovered.status, senderBatchId: recovered.senderBatchId, sameSenderBatchId: recovered.senderBatchId === internal.senderBatchId,
      paypalBatchId: recovered.paypalBatchId, paypalItemStatus: recovered.paypalStatus, payoutRows: rows.length, attempts: recovered.attempts });
  }
  // Rate limit: an immediate resend is refused by the backoff, with no PayPal call.
  const limited = out.find(row => row.code === "ERRPYO035");
  if (limited?.payout === "NOT_SENT") {
    try { await submitWorkPayout(db, paypal, manager, String(limited.payableId)); out.push({ step: "ERRPYO035 immediate resend", result: "SENT (unexpected)" }); }
    catch (error) { out.push({ step: "ERRPYO035 immediate resend", refused: (error as { feedback?: string }).feedback ?? "error" }); }
  }
  // ERRPYO018 through the client's status read and FairShift's status mapping.
  try {
    const result = await paypal.getPayout("ERRPYO018", "FSWP-I-NEGATIVE-TEST");
    out.push({ step: "ERRPYO018 status read", batchStatus: result.batchStatus, itemFound: result.itemId !== null, itemStatus: result.itemStatus, fairshiftStatus: payoutStatusFromProvider(result) });
  } catch (error) {
    out.push({ step: "ERRPYO018 status read", error: (error as { code?: string }).code, http: (error as { status?: number }).status });
  }
  console.log(JSON.stringify(out.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "payableId"))), null, 1));
} finally {
  await pool.end();
}
