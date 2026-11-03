import { and, asc, eq } from "drizzle-orm";
import type { DatabaseSession } from "@/server/db/client";
import { outlets } from "@/server/db/schema";

// The active locations an Owner may choose to operate. Only the names and ids are read.
export async function activeLocations(db: DatabaseSession, organisationId: string) {
  return db.select({ id: outlets.id, name: outlets.name }).from(outlets)
    .where(and(eq(outlets.organisationId, organisationId), eq(outlets.active, true))).orderBy(asc(outlets.name));
}
