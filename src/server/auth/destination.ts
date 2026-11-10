import { getDatabase } from "@/server/db/client";
import { organisationEntitled, ownerDestination, workplaceComplete } from "@/server/billing/entitlement";

// Where a signed-in person goes for a membership: the Owner to setup or their workspace; anyone else to
// their workspace, or to an explanation when the business's subscription or setup isn't ready.
export async function membershipDestination(member: { organisationId: string; role: string }) {
  if (member.role === "OWNER") return ownerDestination(getDatabase(), member.organisationId);
  if (!await organisationEntitled(getDatabase(), member.organisationId)) return "/account?status=subscription-required";
  if (!await workplaceComplete(getDatabase(), member.organisationId)) return "/account?status=setup-required";
  return member.role === "MANAGER" ? "/manager" : "/worker";
}
