import { requireScope } from "@/server/auth/request";
import { ProductShell } from "@/app/components/product-shell";
import { DemoBar, SandboxBar } from "@/app/demo/demo-bar";
import { isDemoOrganisation } from "@/server/demo/organisation";
import { ownerNavigation } from "@/app/components/owner-navigation";

export default async function OwnerLayout({ children }: { children: React.ReactNode }) {
  const scope=await requireScope(["OWNER"]);
  return <ProductShell banner={scope.demo ? <DemoBar persona={scope.demo.persona} /> : undefined} notice={!scope.demo && isDemoOrganisation(scope.organisationId) ? <SandboxBar /> : undefined} role="Owner" context={scope.organisationName} navigation={ownerNavigation}>{children}</ProductShell>;
}
