import { ensureDefaultRules } from "@/server/scheduling/default-rules";
import { randomUUID } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";
import type { Database, DatabaseSession } from "@/server/db/client";
import { auditEvents, organisations, outlets, shifts, subscriptions } from "@/server/db/schema";
import { UserFacingError } from "@/server/domain/errors";
import { locationLimitFor } from "./plans";
import { requireEntitlement } from "./entitlement";
import { requireCustomerOwner, type CustomerScope } from "./ownership";
import { resolveLocationTimezone } from "@/server/domain/timezone";
// Caller holds the organisation row lock; serialize count + insertion/reactivation.
export async function assertLocationCapacity(db:DatabaseSession,organisationId:string) {
  const [sub]=await db.select().from(subscriptions).where(eq(subscriptions.organisationId,organisationId));
  const limit=sub?.tier === "SINGLE_OUTLET" || sub?.tier === "MULTI_OUTLET" ? locationLimitFor(sub.tier) : sub?.tier === "ENTERPRISE" ? sub.locationLimit : null;
  if (!limit || limit < 1) throw new Error("Your location entitlement needs configuration. Contact FairShift before adding a location.");
  const locations=await db.select({id:outlets.id}).from(outlets).where(and(eq(outlets.organisationId,organisationId),eq(outlets.active,true)));
  if (locations.length >= limit) throw new Error(`Your plan allows ${limit} active location${limit === 1 ? "" : "s"}. ${sub?.tier === "MULTI_OUTLET" ? "For 6+ locations, contact FairShift about Enterprise." : "Contact FairShift to discuss an upgrade."}`);
}
// Locations (Day 6, Owner decision 10 Nov 2026): the Owner creates, edits, deactivates and reactivates
// them; nothing is deleted, and every change is audited. A location's country is the business's, so its
// currency, time zone and wage rule follow; the street address is the workplace's, never a person's.
const locationAddress = {
  address:z.string().trim().max(200).optional(), city:z.string().trim().max(100).optional(),
  province:z.string().trim().max(100).optional(), postalCode:z.string().trim().max(20).optional(),
};
const optional = (value?: string) => value ? value : null;
async function auditLocation(db:DatabaseSession,scope:CustomerScope & {role?:string},outletId:string,action:string,detail:Record<string,unknown>) {
  await db.insert(auditEvents).values({id:randomUUID(),organisationId:scope.organisationId,outletId,action,entityType:"outlet",entityId:outletId,correlationId:`${action.toLowerCase()}:${outletId}:${Date.now()}`,
    metadata:{actorUserId:scope.userId,actorRole:"OWNER",sessionType:"SIGNED_IN",...detail}});
}
export async function createLocation(db:Database,scope:CustomerScope,input:unknown) {
  const value=z.object({name:z.string().trim().min(1).max(150),...locationAddress}).strict().parse(input);
  return db.transaction(async tx=>{
    await requireCustomerOwner(tx,scope);
    const [organisation]=await tx.select().from(organisations).where(eq(organisations.id,scope.organisationId)).for("update");
    await requireEntitlement(tx,scope.organisationId);
    await assertLocationCapacity(tx,scope.organisationId);
    const existing=await tx.select({timezone:outlets.timezone}).from(outlets).where(and(eq(outlets.organisationId,scope.organisationId),eq(outlets.active,true)));
    const timezone=resolveLocationTimezone({organisationCountry:organisation?.country,existingTimezones:existing.map(row=>row.timezone)});
    const [location]=await tx.insert(outlets).values({id:randomUUID(),organisationId:scope.organisationId,name:value.name,timezone,country:organisation?.country ?? null,
      address:optional(value.address),city:optional(value.city),province:optional(value.province),postalCode:optional(value.postalCode)}).returning();
    await ensureDefaultRules(tx,scope.organisationId,location.id,scope.userId);
    await auditLocation(tx,scope,location.id,"LOCATION_CREATED",{name:value.name});
    return location;
  });
}
export async function updateLocation(db:Database,scope:CustomerScope,outletId:string,input:unknown) {
  const value=z.object({name:z.string().trim().min(1).max(150),...locationAddress}).strict().parse(input);
  return db.transaction(async tx=>{
    await requireCustomerOwner(tx,scope);
    await requireEntitlement(tx,scope.organisationId);
    const [location]=await tx.select().from(outlets).where(and(eq(outlets.id,z.uuid().parse(outletId)),eq(outlets.organisationId,scope.organisationId))).for("update");
    if (!location) throw new Error("Location unavailable.");
    const next={name:value.name,address:optional(value.address),city:optional(value.city),province:optional(value.province),postalCode:optional(value.postalCode)};
    const changed=Object.entries(next).filter(([key,val])=>location[key as keyof typeof location] !== val).map(([key])=>key);
    if (changed.length) await tx.update(outlets).set({...next,updatedAt:new Date()}).where(eq(outlets.id,location.id));
    await auditLocation(tx,scope,location.id,"LOCATION_UPDATED",{fields:changed});
    return {changed};
  });
}
// Deactivating keeps every record. It is refused for the last active location, and while shifts there
// are still to be worked; managers keep their record but can no longer open it.
export async function setLocationActive(db:Database,scope:CustomerScope,outletId:string,active:boolean,now=new Date()) {
  return db.transaction(async tx=>{
    await requireCustomerOwner(tx,scope);
    await tx.select().from(organisations).where(eq(organisations.id,scope.organisationId)).for("update");
    await requireEntitlement(tx,scope.organisationId);
    const [location]=await tx.select().from(outlets).where(and(eq(outlets.id,z.uuid().parse(outletId)),eq(outlets.organisationId,scope.organisationId))).for("update");
    if (!location || location.active === active) throw new Error("Location unavailable.");
    if (active) await assertLocationCapacity(tx,scope.organisationId);
    else {
      const others=await tx.select({id:outlets.id}).from(outlets).where(and(eq(outlets.organisationId,scope.organisationId),eq(outlets.active,true)));
      if (others.length <= 1) throw new UserFacingError("location-last","This is your only active location, so it can't be deactivated.");
      const upcoming=await tx.select({id:shifts.id}).from(shifts).where(and(eq(shifts.outletId,location.id),eq(shifts.status,"PUBLISHED"),gt(shifts.endsAt,now)));
      if (upcoming.length) throw new UserFacingError("location-has-shifts",`This location has ${upcoming.length} upcoming shift${upcoming.length === 1 ? "" : "s"}. Cancel or finish them before deactivating it.`);
    }
    await tx.update(outlets).set({active,updatedAt:now}).where(eq(outlets.id,location.id));
    await auditLocation(tx,scope,location.id,active ? "LOCATION_REACTIVATED" : "LOCATION_DEACTIVATED",{name:location.name});
  });
}
