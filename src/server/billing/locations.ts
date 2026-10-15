import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Database, DatabaseSession } from "@/server/db/client";
import { organisations, outlets, subscriptions } from "@/server/db/schema";
import { locationLimitFor } from "./plans";
import { requireEntitlement } from "./entitlement";
import { requireCustomerOwner, type CustomerScope } from "./ownership";
// Caller holds the organisation row lock; serialize count + insertion/reactivation.
export async function assertLocationCapacity(db:DatabaseSession,organisationId:string) {
  const [sub]=await db.select().from(subscriptions).where(eq(subscriptions.organisationId,organisationId));
  const limit=sub?.tier === "SINGLE_OUTLET" || sub?.tier === "MULTI_OUTLET" ? locationLimitFor(sub.tier) : sub?.tier === "ENTERPRISE" ? sub.locationLimit : null;
  if (!limit || limit < 1) throw new Error("Your location entitlement needs configuration. Contact FairShift before adding a location.");
  const locations=await db.select({id:outlets.id}).from(outlets).where(and(eq(outlets.organisationId,organisationId),eq(outlets.active,true)));
  if (locations.length >= limit) throw new Error(`Your plan allows ${limit} active location${limit === 1 ? "" : "s"}. ${sub?.tier === "MULTI_OUTLET" ? "For 6+ locations, contact FairShift about Enterprise." : "Contact FairShift to discuss an upgrade."}`);
}
export async function createLocation(db:Database,scope:CustomerScope,input:unknown) {
  const value=z.object({name:z.string().trim().min(1).max(150)}).strict().parse(input);
  return db.transaction(async tx=>{
    await requireCustomerOwner(tx,scope);
    await tx.select().from(organisations).where(eq(organisations.id,scope.organisationId)).for("update");
    await requireEntitlement(tx,scope.organisationId);
    await assertLocationCapacity(tx,scope.organisationId);
    const [location]=await tx.insert(outlets).values({id:randomUUID(),organisationId:scope.organisationId,name:value.name,timezone:"Africa/Johannesburg"}).returning();
    return location;
  });
}
