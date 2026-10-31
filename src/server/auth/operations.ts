import { requireEntitlement } from "@/server/billing/entitlement";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@/server/db/client";
import { randomUUID } from "node:crypto";
import { shiftOffers, shifts, workerAvailability, workers } from "@/server/db/schema";
import { UserFacingError } from "@/server/domain/errors";
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
  // A worker cannot take on work that has already finished. Repeating an earlier acceptance stays harmless.
  if(response==="ACCEPTED") {
    const [open]=await db.select({endsAt:shifts.endsAt}).from(shiftOffers).innerJoin(shifts,eq(shifts.id,shiftOffers.shiftId)).where(and(eq(shiftOffers.id,offerId),eq(shiftOffers.workerId,scope.workerId!),eq(shiftOffers.status,"OFFERED")));
    if(open&&open.endsAt<=new Date()) throw new UserFacingError("shift-ended","This shift has already finished.");
  }
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

// A worker's own weekly availability, Monday..Sunday. Null clears a day to not provided.
export async function saveWorkerAvailability(db:Database,scope:Scope,states:unknown) {
  assertRole(scope,["TEAM_MEMBER"]);
  await requireEntitlement(db,scope.organisationId);
  await workerIdentity(db,scope);
  const days=z.array(z.enum(["AVAILABLE","UNAVAILABLE"]).nullable()).length(7).parse(states);
  const workerId=scope.workerId!;
  return db.transaction(async tx=>{
    for (const [i,state] of days.entries()) {
      if (state === null) await tx.delete(workerAvailability).where(and(eq(workerAvailability.workerId,workerId),eq(workerAvailability.isoWeekday,i+1)));
      else await tx.insert(workerAvailability).values({id:randomUUID(),workerId,isoWeekday:i+1,state}).onConflictDoUpdate({target:[workerAvailability.workerId,workerAvailability.isoWeekday],set:{state,updatedAt:new Date()}});
    }
  });
}

async function workerIdentity(db:Database,scope:Scope) {
 if (!scope.workerId) throw new Error("Access denied.");
 const [worker]=await db.select({id:workers.id}).from(workers).where(and(eq(workers.id,scope.workerId),eq(workers.userId,scope.userId),eq(workers.organisationId,scope.organisationId),eq(workers.locationId,scope.locationId),eq(workers.status,"ACTIVE")));
 if (!worker) throw new Error("Access denied.");
}
