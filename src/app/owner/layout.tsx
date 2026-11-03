import { requireScope } from "@/server/auth/request";
import { ProductShell } from "@/app/components/product-shell";
import { DemoBar } from "@/app/demo/demo-bar";
import { ownerNavigation } from "@/app/components/owner-navigation";

export default async function OwnerLayout({ children }: { children: React.ReactNode }) {
  const scope=await requireScope(["OWNER"]);
  return <ProductShell banner={scope.demo ? <DemoBar persona={scope.demo.persona} /> : undefined} role="Owner" context={scope.organisationName} navigation={ownerNavigation}>{children}</ProductShell>;
}
