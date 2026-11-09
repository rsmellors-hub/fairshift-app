import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { resolveScope } from "@/server/auth/access";
import { hashPassword } from "@/server/auth/identity";
import { inviteMember, redeemInvitation } from "@/server/auth/tenancy";
import type { Database } from "@/server/db/client";
import { auditEvents, memberships, users, workers } from "@/server/db/schema";
import { SA_REFERENCE_ORGANISATION, saReferenceLocation } from "@/server/reference/sa-reference";
import { DEMO_ACCOUNTS } from "./provision";
import { DEMO_SCENARIO_LOCATION } from "./capacity-scenario";

// Judges' signed-in accounts for the fictional demo business (Owner decision, 9 November 2026): an
// Owner, the Rosebank Manager and a Rosebank casual worker, with live permissions in the PayPal Sandbox.
// Their credentials go only to the judges' private instructions; nothing here prints or stores them in
// the repository. The worker is paid to the same PayPal Sandbox personal account as the demo worker.
// The addresses use a reserved test domain, so no mail can reach a real mailbox. Idempotent: existing
// accounts are kept, and a password is set only for an account created now or when reset is asked for.
export const JUDGE_ACCOUNTS = {
  OWNER: { email: "owner@judges.jacaranda-demo.example.test", firstName: "Judge", surname: "Owner" },
  MANAGER: { email: "manager.rosebank@judges.jacaranda-demo.example.test", firstName: "Judge", surname: "Manager" },
  WORKER: { email: "casual.rosebank@judges.jacaranda-demo.example.test", firstName: "Judge", surname: "Worker" },
} as const;
export type JudgeRole = keyof typeof JUDGE_ACCOUNTS;

export async function provisionJudgeAccounts(db: Database, passwords: Record<JudgeRole, string>, options: { resetPasswords?: boolean; now?: Date } = {}) {
  const now = options.now ?? new Date(), organisationId = SA_REFERENCE_ORGANISATION.id, rosebank = saReferenceLocation(DEMO_SCENARIO_LOCATION).id;
  for (const value of Object.values(passwords)) if (value.length < 16) throw new Error("Judge passwords must be at least 16 characters.");
  const [demoOwner] = await db.select({ id: memberships.id, userId: memberships.userId }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(users.email, DEMO_ACCOUNTS.OWNER.email), eq(memberships.organisationId, organisationId), eq(memberships.role, "OWNER")));
  if (!demoOwner) throw new Error("Demo setup hasn't run: the demo Owner doesn't exist.");
  const created: JudgeRole[] = [];
  async function user(role: JudgeRole) {
    const account = JUDGE_ACCOUNTS[role];
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, account.email));
    if (existing) {
      if (options.resetPasswords) await db.update(users).set({ passwordHash: await hashPassword(passwords[role]) }).where(eq(users.id, existing.id));
      return existing.id;
    }
    const id = randomUUID();
    await db.insert(users).values({ id, email: account.email, name: `${account.firstName} ${account.surname}`, firstName: account.firstName, surname: account.surname, passwordHash: await hashPassword(passwords[role]), emailVerifiedAt: now });
    created.push(role);
    return id;
  }
  const ownerUser = await user("OWNER");
  let [owner] = await db.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.userId, ownerUser), eq(memberships.organisationId, organisationId), eq(memberships.role, "OWNER")));
  if (!owner) [owner] = await db.insert(memberships).values({ id: randomUUID(), userId: ownerUser, organisationId, role: "OWNER" }).returning({ id: memberships.id });
  const inviter = await resolveScope(db, demoOwner.userId, demoOwner.id, rosebank);
  async function invited(role: "MANAGER" | "WORKER") {
    const account = JUDGE_ACCOUNTS[role];
    const [existing] = await db.select({ id: memberships.id, workerId: memberships.workerId }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(users.email, account.email), eq(memberships.organisationId, organisationId), eq(memberships.state, "ACTIVE")));
    if (existing) { await user(role); return existing; }
    const { token } = await inviteMember(db, inviter, { role: role === "MANAGER" ? "MANAGER" : "TEAM_MEMBER", email: account.email, firstName: account.firstName, surname: account.surname, telephone: "+27 11 000 0000" });
    const membership = await redeemInvitation(db, await user(role), { token });
    return { id: membership.id, workerId: membership.workerId };
  }
  const manager = await invited("MANAGER");
  const worker = await invited("WORKER");
  // Paid in the PayPal Sandbox to the demo worker's Sandbox personal account, if the judge worker has none.
  if (worker.workerId) {
    const [demoWorker] = await db.select({ email: workers.paypalPayoutEmail }).from(workers).innerJoin(memberships, eq(memberships.workerId, workers.id)).innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(users.email, DEMO_ACCOUNTS.WORKER.email), eq(workers.organisationId, organisationId)));
    if (demoWorker?.email) await db.update(workers).set({ paypalPayoutEmail: demoWorker.email, updatedAt: now }).where(and(eq(workers.id, worker.workerId), eq(workers.organisationId, organisationId), isNull(workers.paypalPayoutEmail)));
  }
  await db.insert(auditEvents).values({ id: randomUUID(), organisationId, action: "JUDGE_ACCOUNTS_PROVISIONED", entityType: "organisation", entityId: organisationId, correlationId: `judges:${organisationId}`,
    metadata: { created, passwordsReset: !!options.resetPasswords, memberships: { OWNER: owner.id, MANAGER: manager.id, WORKER: worker.id } } });
  return { organisationId, created, memberships: { OWNER: owner.id, MANAGER: manager.id, WORKER: worker.id }, workerId: worker.workerId };
}

