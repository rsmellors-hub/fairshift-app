import { InvitationPreview } from "@/app/components/invitation-preview";
import { requireScope } from "@/server/auth/request";
import { invitationEmailData } from "@/server/auth/tenancy";
import { getDatabase } from "@/server/db/client";

export const dynamic = "force-dynamic";
export default async function OwnerInvitationPreview({ searchParams }: { searchParams?: Promise<{ location?: string }> }) {
  const location = (await searchParams)?.location;
  const scope = await requireScope(["OWNER"], location && /^[0-9a-f-]{36}$/.test(location) ? { locationId: location } : {});
  const email = await invitationEmailData(getDatabase(), { organisationId: scope.organisationId, inviterId: scope.userId, role: "TEAM_MEMBER", outletIds: [scope.locationId], invitee: null });
  return <InvitationPreview email={email} />;
}
