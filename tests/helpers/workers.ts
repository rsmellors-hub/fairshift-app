import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "@/server/db/client";
import { teamInvitations, users, workers } from "@/server/db/schema";
import { tokenHash } from "@/server/auth/identity";
import { DEMO_ORGANISATION_ID, DEMO_OUTLET_ID } from "@/server/constants";

// A worker record as an earlier FairShift stored one before the person signed up (fixture only: in the
// product, people are added by invitation and become active only by signing up themselves).
type MemberInput = { firstName: string; surname: string; telephone: string; email: string };
export async function createTeamMember(db: Database, input: MemberInput, scope: { organisationId: string; locationId: string }) {
  if (![input.firstName, input.surname, input.email].every(value => value?.trim())) throw new Error("Name and email are required.");
  const [worker] = await db.insert(workers).values({ id: randomUUID(), organisationId: scope.organisationId, locationId: scope.locationId, ...input, displayName: `${input.firstName} ${input.surname}`, workerType: "CASUAL" }).returning();
  const [invitation] = await db.insert(teamInvitations).values({ id: randomUUID(), workerId: worker.id, token: tokenHash(randomUUID()), state: "CREATED_NOT_SENT" }).returning();
  return { worker, invitation };
}
// A team member who has activated their account, and so can be offered work.
export async function activateWorker(db: Database, workerId: string) {
  const userId = randomUUID();
  await db.insert(users).values({ id: userId, email: `worker-${userId}@example.test`, name: "Worker", passwordHash: "test", emailVerifiedAt: new Date() });
  const [worker] = await db.update(workers).set({ userId }).where(eq(workers.id, workerId)).returning();
  return worker;
}
export async function createActivatedTeamMember(db: Database, input: MemberInput, scope = { organisationId: DEMO_ORGANISATION_ID, locationId: DEMO_OUTLET_ID }) {
  const result = await createTeamMember(db, input, scope);
  return { ...result, worker: await activateWorker(db, result.worker.id) };
}
