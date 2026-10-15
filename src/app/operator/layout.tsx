import { requireOperator } from "@/server/auth/request";
import { ProductShell } from "@/app/components/product-shell";
export default async function OperatorLayout({ children }: { children: React.ReactNode }) {
  await requireOperator();
  return <ProductShell role="Operator" context="FairShift platform" navigation={[
    { label: "Overview", href: "/operator" }, { label: "Demo Environment", href: "/operator/environment" }, { label: "Integration Health", href: "/operator/integrations" },
  ]}>{children}</ProductShell>;
}
