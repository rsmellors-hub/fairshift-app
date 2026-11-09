import { eq } from "drizzle-orm";
import type { Scope } from "@/server/auth/access";
import { hashPassword } from "@/server/auth/identity";
import { changePayoutDestination } from "@/server/auth/operations";
import type { Database } from "@/server/db/client";
import { users } from "@/server/db/schema";

// A worker changing their PayPal email through the re-confirmed path (Day 6, Step 3b): the new address
// twice and their current password, which the fixture sets first. Synthetic test password.
export const WORKER_TEST_PASSWORD = "worker-test-password-123";
export async function workerChangesPayoutEmail(db: Database, worker: Scope, email: string) {
  await db.update(users).set({ passwordHash: await hashPassword(WORKER_TEST_PASSWORD) }).where(eq(users.id, worker.userId));
  return changePayoutDestination(db, worker, { email, confirmEmail: email, password: WORKER_TEST_PASSWORD });
}
