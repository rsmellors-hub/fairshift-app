import { eq } from "drizzle-orm";
import type { DatabaseSession } from "@/server/db/client";
import { subscriptions } from "@/server/db/schema";

// Only a reconciled provider state grants operational access. Approval and browser
// navigation are not evidence of entitlement; absence and unknown states fail closed.
export function isEntitled(subscription: Pick<typeof subscriptions.$inferSelect, "status" | "verifiedAt" | "providerId" | "planId"> | null | undefined) {
  return subscription?.status === "ACTIVE" && !!subscription.verifiedAt && !!subscription.providerId && !!subscription.planId;
}
export async function organisationEntitled(db: DatabaseSession, organisationId: string) {
  const [subscription] = await db.select().from(subscriptions).where(eq(subscriptions.organisationId, organisationId));
  return isEntitled(subscription);
}
export async function requireEntitlement(db: DatabaseSession, organisationId: string) {
  if (!await organisationEntitled(db, organisationId)) throw new Error("An active organisation subscription is required.");
}
