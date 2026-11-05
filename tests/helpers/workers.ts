import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "@/server/db/client";
import { users, workers } from "@/server/db/schema";
import { createTeamMember } from "@/server/scheduling/operations";
import { DEMO_ORGANISATION_ID, DEMO_OUTLET_ID } from "@/server/constants";

// A team member who has activated their account, and so can be offered work.
export async function activateWorker(db: Database, workerId: string) {
  const userId = randomUUID();
  await db.insert(users).values({ id: userId, email: `worker-${userId}@example.test`, name: "Worker", passwordHash: "test", emailVerifiedAt: new Date() });
  const [worker] = await db.update(workers).set({ userId }).where(eq(workers.id, workerId)).returning();
  return worker;
}
export async function createActivatedTeamMember(db: Database, input: Parameters<typeof createTeamMember>[1], scope = { organisationId: DEMO_ORGANISATION_ID, locationId: DEMO_OUTLET_ID }) {
  const result = await createTeamMember(db, input, scope);
  return { ...result, worker: await activateWorker(db, result.worker.id) };
}
