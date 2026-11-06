import { and, eq, inArray, ne } from "drizzle-orm";
import type { Database } from "@/server/db/client";
import { organisations, outlets } from "@/server/db/schema";
import { provisionCompanyHistory } from "@/server/reference/provision";
import { SA_REFERENCE_COMPANY, SA_REFERENCE_DATASET, SA_REFERENCE_LOCATIONS, SA_REFERENCE_ORGANISATION, type SaReferenceStoreCode } from "@/server/reference/sa-reference";

// Makes the one South African reference business available: its organisation and five locations,
// under their fixed identifiers, then its labelled reference history and stated configuration.
// Idempotent. Records that already exist are kept as they are; anything that would make a second
// copy of the business, or put it in the wrong country or time zone, is refused before any write.
// It creates no people, accounts, pay terms, subscriptions or provider connections.
export async function provisionSaReferenceBusiness(db: Database, range: { from?: string; through?: string } = {}, now = new Date()) {
  const organisation = SA_REFERENCE_ORGANISATION;
  const ids = SA_REFERENCE_LOCATIONS.map(row => row.id);
  await db.transaction(async tx => {
    const [duplicate] = await tx.select({ id: organisations.id }).from(organisations).where(and(eq(organisations.name, organisation.name), ne(organisations.id, organisation.id))).limit(1);
    if (duplicate) throw new Error(`Another organisation is already named ${organisation.name}; refusing to create a second reference business.`);
    await tx.insert(organisations).values({ ...organisation, setupCompletedAt: now }).onConflictDoNothing();
    const [stored] = await tx.select().from(organisations).where(eq(organisations.id, organisation.id));
    if (stored.country !== organisation.country) throw new Error(`Organisation ${organisation.id} isn’t recorded in ${organisation.country}.`);
    // An identifier taken by another organisation is never moved into this one.
    const taken = await tx.select({ id: outlets.id, organisationId: outlets.organisationId }).from(outlets).where(inArray(outlets.id, ids));
    const foreign = taken.find(row => row.organisationId !== organisation.id);
    if (foreign) throw new Error(`Location ${foreign.id} belongs to another organisation.`);
    await tx.insert(outlets).values(SA_REFERENCE_LOCATIONS.map(row => ({ id: row.id, organisationId: organisation.id, name: row.name, city: row.city, province: row.province,
      country: organisation.country, timezone: SA_REFERENCE_DATASET.timezone }))).onConflictDoNothing();
  });
  const mapping = Object.fromEntries(SA_REFERENCE_LOCATIONS.map(row => [row.code, row.id])) as Record<SaReferenceStoreCode, string>;
  return provisionCompanyHistory(db, SA_REFERENCE_COMPANY, { organisationId: organisation.id, outlets: mapping, ...range }, now);
}
