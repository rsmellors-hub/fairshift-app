import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { resolveScope, type Scope } from "@/server/auth/access";
import { hashPassword } from "@/server/auth/identity";
import { inviteMember, redeemInvitation } from "@/server/auth/tenancy";
import { organisationEntitled, workplaceComplete } from "@/server/billing/entitlement";
import type { Database } from "@/server/db/client";
import { memberships, users } from "@/server/db/schema";
import { provisionSaReferenceBusiness } from "@/server/reference/sa-provision";
import { SA_REFERENCE_ORGANISATION, saReferenceLocation } from "@/server/reference/sa-reference";
import { ensureDemoBooking } from "./booking";

// Demo setup for the fictional South African demo business: its locations and labelled reference
// history, three synthetic accounts for the public demo's personas (an Owner, the Rosebank Manager
// and a Rosebank casual worker), and the booked casual shift for tomorrow that the DEMO early notice
// needs (ensureDemoBooking). Idempotent: whatever exists is kept. It creates no subscription: the
// demo's PayPal Sandbox subscription is approved by a person in PayPal, and, as for any business,
// the Manager and the worker can be invited only once that subscription has made the business
// entitled, so until then this stops after the Owner and says so. The addresses use a reserved test
// domain, so nothing here can reach a real mailbox.
export const DEMO_ACCOUNTS = {
  OWNER: { email: "owner@jacaranda-demo.example.test", firstName: "Thandi", surname: "Owner" },
  MANAGER: { email: "manager.rosebank@jacaranda-demo.example.test", firstName: "Lerato", surname: "Rosebank" },
  WORKER: { email: "casual.rosebank@jacaranda-demo.example.test", firstName: "Ayanda", surname: "Casual" },
} as const;
type Account = (typeof DEMO_ACCOUNTS)[keyof typeof DEMO_ACCOUNTS];

export async function provisionSaDemo(db: Database, options: { password?: string; now?: Date; range?: { from?: string; through?: string } } = {}) {
  const now = options.now ?? new Date(), organisationId = SA_REFERENCE_ORGANISATION.id, rosebank = saReferenceLocation("SA01").id;
  const history = await provisionSaReferenceBusiness(db, options.range ?? {}, now);
  // Without a supplied password the accounts can't be signed in to; the public demo still uses them.
  const passwordHash = await hashPassword(options.password && options.password.length >= 12 ? options.password : randomBytes(32).toString("base64url"));
  async function user(account: Account) {
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, account.email));
    if (existing) return existing.id;
    const id = randomUUID();
    await db.insert(users).values({ id, email: account.email, name: `${account.firstName} ${account.surname}`, passwordHash, emailVerifiedAt: now });
    return id;
  }
  async function invited(by: Scope, account: Account, role: "MANAGER" | "TEAM_MEMBER") {
    const [existing] = await db.select({ id: memberships.id, workerId: memberships.workerId }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(users.email, account.email), eq(memberships.organisationId, organisationId), eq(memberships.state, "ACTIVE")));
    if (existing) return existing;
    const { token } = await inviteMember(db, by, { role, email: account.email, firstName: account.firstName, surname: account.surname, telephone: "+27 11 000 0000" });
    const created = await redeemInvitation(db, await user(account), { token });
    return { id: created.id, workerId: created.workerId };
  }

  const ownerId = await user(DEMO_ACCOUNTS.OWNER);
  let [owner] = await db.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.userId, ownerId), eq(memberships.organisationId, organisationId), eq(memberships.role, "OWNER")));
  if (!owner) [owner] = await db.insert(memberships).values({ id: randomUUID(), userId: ownerId, organisationId, role: "OWNER" }).returning({ id: memberships.id });
  const entitled = await organisationEntitled(db, organisationId) && await workplaceComplete(db, organisationId);
  let manager: { id: string } | null = null, worker: { id: string; workerId: string | null } | null = null;
  if (entitled) {
    manager = await invited(await resolveScope(db, ownerId, owner.id, rosebank), DEMO_ACCOUNTS.MANAGER, "MANAGER");
    worker = await invited(await resolveScope(db, ownerId, owner.id, rosebank), DEMO_ACCOUNTS.WORKER, "TEAM_MEMBER");
  }
  const booking = worker ? await ensureDemoBooking(db, { organisationId, workerId: worker.workerId, now }) : null;
  return {
    organisationId, entitled,
    memberships: { OWNER: owner.id, MANAGER: manager?.id ?? null, WORKER: worker?.id ?? null },
    workerId: worker?.workerId ?? null, booking,
    referenceHistory: { inserted: history.inserted, expected: history.expected },
  };
}
