import { and, eq } from "drizzle-orm";
import type { DatabaseSession } from "@/server/db/client";
import { memberships, organisations, outlets, workers } from "@/server/db/schema";
export type Role = "OWNER" | "MANAGER" | "TEAM_MEMBER";
export type Scope = {userId:string; organisationId:string; locationId:string; workerId?:string; role:Role; organisationName:string; locationName:string; demo?:{persona:"OWNER"|"MANAGER"|"WORKER"; group:string}};
export class AccessError extends Error { constructor() {super("Access denied.");} }
export async function resolveScope(db: DatabaseSession, userId: string, membershipId: string, locationId?: string, roles: Role[] = ["OWNER","MANAGER","TEAM_MEMBER"]): Promise<Scope> {
  const [membership] = await db.select().from(memberships).where(and(eq(memberships.id,membershipId),eq(memberships.userId,userId),eq(memberships.state,"ACTIVE")));
  if (!membership || !roles.includes(membership.role as Role)) throw new AccessError();
  const candidates = await db.select({location:outlets,organisation:organisations}).from(outlets).innerJoin(organisations,eq(organisations.id,outlets.organisationId))
    .where(and(eq(outlets.organisationId,membership.organisationId),eq(outlets.active,true)));
  const selected = candidates.find(r => r.location.id === (membership.outletId ?? locationId)) ?? (membership.role === "OWNER" && !locationId ? candidates[0] : undefined);
  if (!selected || (locationId && selected.location.id !== locationId)) throw new AccessError();
  if (membership.workerId) {
    const [worker] = await db.select().from(workers).where(and(eq(workers.id,membership.workerId),eq(workers.userId,userId),eq(workers.organisationId,membership.organisationId),eq(workers.locationId,selected.location.id),eq(workers.status,"ACTIVE")));
    if (!worker) throw new AccessError();
  }
  return {userId,organisationId:membership.organisationId,locationId:selected.location.id,workerId:membership.workerId ?? undefined,role:membership.role as Role,organisationName:selected.organisation.name,locationName:selected.location.name};
}
export function assertRole(scope: Scope, roles: Role[]) {if (!roles.includes(scope.role)) throw new AccessError();}
