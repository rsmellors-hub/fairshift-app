import { InvitationPreview } from "@/app/components/invitation-preview";
import { requireScope } from "@/server/auth/request";
import { invitationEmailData } from "@/server/auth/tenancy";
import { getDatabase } from "@/server/db/client";

export const dynamic = "force-dynamic";
export default async function ManagerInvitationPreview() {
  const scope = await requireScope(["MANAGER"]);
  const email = await invitationEmailData(getDatabase(), { organisationId: scope.organisationId, inviterId: scope.userId, role: "TEAM_MEMBER", outletIds: [scope.locationId], invitee: null });
  return <InvitationPreview email={email} />;
}
