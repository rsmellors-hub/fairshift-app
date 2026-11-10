import { redirect } from "next/navigation";
import { getDatabase } from "@/server/db/client";
import { organisationEntitled } from "@/server/billing/entitlement";
import { ManagerWorkspace } from "@/app/manager/workspace";
import { ProductShell } from "@/app/components/product-shell";
import { requireFinancialScope } from "@/server/auth/request";

export const dynamic = "force-dynamic";

export default async function SettlementsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const scope = await requireFinancialScope(["OWNER", "MANAGER"]);
  const { status } = await searchParams;
  if (await organisationEntitled(getDatabase(), scope.organisationId)) {
    redirect(`/manager/review${status ? `?status=${encodeURIComponent(status)}` : ""}`);
  }
  return <ProductShell
    role={scope.role === "OWNER" ? "Owner" : "Manager"}
    context={scope.locationName}
    navigation={[{ label: "Pay", href: "/settlements" }]}
  >
    {await ManagerWorkspace({ area: "review", status, financialScope: scope, financialOnly: true })}
  </ProductShell>;
}
