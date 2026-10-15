import { and, eq } from "drizzle-orm";
import type { DatabaseSession } from "@/server/db/client";
import { memberships, users } from "@/server/db/schema";
export type CustomerScope = {userId:string; organisationId:string; role:string};
export async function requireCustomerOwner(db:DatabaseSession,scope:CustomerScope) {
  if (scope.role !== "OWNER") throw new Error("Access denied.");
  const [row]=await db.select().from(memberships).innerJoin(users,eq(users.id,memberships.userId))
    .where(and(eq(memberships.userId,scope.userId),eq(memberships.organisationId,scope.organisationId),eq(memberships.role,"OWNER"),eq(memberships.state,"ACTIVE")));
  if (!row?.auth_users.emailVerifiedAt) throw new Error("Access denied. Verify your email first.");
  return row.auth_users;
}
