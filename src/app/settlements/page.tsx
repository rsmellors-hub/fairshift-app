import { ManagerWorkspace } from "@/app/manager/workspace";
import { ProductShell } from "@/app/components/product-shell";
import { requireFinancialScope } from "@/server/auth/request";

export const dynamic = "force-dynamic";

export default async function SettlementsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const scope = await requireFinancialScope(["OWNER", "MANAGER"]);
  const { status } = await searchParams;
  return <ProductShell
    role={scope.role === "OWNER" ? "Owner" : "Manager"}
    context={scope.locationName}
    navigation={[{ label: "Review & pay", href: "/settlements" }]}
  >
    {await ManagerWorkspace({ area: "review", status, financialScope: scope, financialOnly: true })}
  </ProductShell>;
}
