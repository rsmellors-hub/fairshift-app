import { eq } from "drizzle-orm";
import type { Scope } from "@/server/auth/access";
import { hashPassword } from "@/server/auth/identity";
import { changePayoutDestination } from "@/server/auth/operations";
import { confirmPayoutChange } from "@/server/worker/payout-destination";
import type { Database } from "@/server/db/client";
import { users } from "@/server/db/schema";

// A worker changing their PayPal email through the re-confirmed path (Day 6, Step 3b): the new address
// twice and their current password, which the fixture sets first. Synthetic test password.
export const WORKER_TEST_PASSWORD = "worker-test-password-123";
export async function workerChangesPayoutEmail(db: Database, worker: Scope, email: string, confirm = true) {
  await db.update(users).set({ passwordHash: await hashPassword(WORKER_TEST_PASSWORD) }).where(eq(users.id, worker.userId));
  const result = await changePayoutDestination(db, worker, { email, confirmEmail: email, password: WORKER_TEST_PASSWORD });
  // A change waits for the link emailed to the new address (design, 10 Nov 2026); the fixture follows it.
  if (confirm && "pending" in result && result.pending) await confirmPayoutChange(db, result.pending.secureLink.split("#")[1]);
  return result;
}
