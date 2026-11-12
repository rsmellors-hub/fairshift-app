import { requireScope } from "@/server/auth/request";
import { ProductShell } from "@/app/components/product-shell";
import { ownerNavigation } from "@/app/components/owner-navigation";
import { ownerLocationControl, shellStrips } from "@/app/components/shell-chrome";

export default async function OwnerLayout({ children }: { children: React.ReactNode }) {
  const scope=await requireScope(["OWNER"]);
  return <ProductShell {...shellStrips(scope, scope.organisationName)} contextControl={await ownerLocationControl(scope)} role="Owner" context={scope.organisationName} navigation={ownerNavigation}>{children}</ProductShell>;
}
