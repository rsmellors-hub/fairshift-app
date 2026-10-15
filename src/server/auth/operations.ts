import { requireEntitlement } from "@/server/billing/entitlement";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@/server/db/client";
import { workers } from "@/server/db/schema";
import { assertRole, type Scope } from "./access";
import { respondToAssignment } from "@/server/scheduling/operations";
import { getWorkerWorkspace } from "@/server/product/workspace";
export async function workerWorkspace(db:Database,scope:Scope) {
  assertRole(scope,["TEAM_MEMBER"]);
  await requireEntitlement(db,scope.organisationId);
  await workerIdentity(db,scope);
  return getWorkerWorkspace(db,scope);
}
export async function workerRespond(db:Database,scope:Scope,offerId:string,version:number,response:"ACCEPTED"|"DECLINED",acknowledged:boolean) {
  assertRole(scope,["TEAM_MEMBER"]);
  await requireEntitlement(db,scope.organisationId);
  await workerIdentity(db,scope);
  return respondToAssignment(db,scope.workerId!,offerId,version,response,acknowledged,scope);
}
export async function savePayoutDestination(db:Database,scope:Scope,value:string) {
  assertRole(scope,["TEAM_MEMBER"]);
  await requireEntitlement(db,scope.organisationId);
  if (!scope.workerId) throw new Error("Access denied.");
  const [row]=await db.update(workers).set({paypalPayoutEmail:z.string().trim().email().max(254).parse(value),updatedAt:new Date()})
    .where(and(eq(workers.id,scope.workerId),eq(workers.userId,scope.userId),eq(workers.organisationId,scope.organisationId),eq(workers.locationId,scope.locationId))).returning();
  if (!row) throw new Error("Access denied.");
  return row;
}

async function workerIdentity(db:Database,scope:Scope) {
 if (!scope.workerId) throw new Error("Access denied.");
 const [worker]=await db.select({id:workers.id}).from(workers).where(and(eq(workers.id,scope.workerId),eq(workers.userId,scope.userId),eq(workers.organisationId,scope.organisationId),eq(workers.locationId,scope.locationId),eq(workers.status,"ACTIVE")));
 if (!worker) throw new Error("Access denied.");
}
