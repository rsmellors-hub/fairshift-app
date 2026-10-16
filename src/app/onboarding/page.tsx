import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { requireIdentity, requireOwnerCustomer } from "@/server/auth/request";
import { getDatabase } from "@/server/db/client";
import { organisations, outlets } from "@/server/db/schema";
import { organisationEntitled, workplaceComplete } from "@/server/billing/entitlement";
import { signOutAction } from "@/app/auth-actions";
import { WorkplaceForm } from "@/app/components/workplace-form";
import { AcquisitionProgress } from "@/app/components/acquisition-progress";
export const dynamic="force-dynamic";
export default async function Onboarding() {
  const {user}=await requireIdentity(),scope=await requireOwnerCustomer(),db=getDatabase();
  if (!await organisationEntitled(db,scope.organisationId)) redirect("/subscribe");
  if (await workplaceComplete(db,scope.organisationId)) redirect("/owner");
  const [business]=await db.select().from(organisations).where(eq(organisations.id,scope.organisationId));
  const locations=await db.select().from(outlets).where(eq(outlets.organisationId,scope.organisationId));
  const location=locations.find(row=>row.active);
  return <main className="acquisition-shell workplace-shell">
    <header className="acquisition-header"><div className="acquisition-brand">FairShift</div><form action={signOutAction}><button className="acquisition-signout">Sign out</button></form></header>
    <AcquisitionProgress current="Workplace"/>
    <div className="workplace-heading"><h1>Set up your workplace</h1><p>Just a few details before you start.</p></div>
    <WorkplaceForm email={user.email} initial={{firstName:user.firstName ?? "",surname:user.surname ?? "",position:user.position ?? "",telephone:user.telephone ?? "",
      name:business?.name ?? "",locationName:location?.name ?? "",locationAddress:location?.address ?? "",locationCity:location?.city ?? "",
      locationPostalCode:location?.postalCode ?? "",locationCountry:location?.country ?? "",sameAddress:true,
      businessAddress:business?.businessAddress ?? "",city:business?.city ?? "",postalCode:business?.postalCode ?? "",country:business?.country ?? ""}}/>
  </main>;
}
