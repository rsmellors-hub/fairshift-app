import { ProductShell } from "@/app/components/product-shell";
export default function OperatorLayout({ children }: { children: React.ReactNode }) {
  return <ProductShell role="Operator" context="FairShift platform" navigation={[
    { label: "Overview", href: "/operator" }, { label: "Demo Environment", href: "/operator/environment" }, { label: "Integration Health", href: "/operator/integrations" },
  ]}>{children}</ProductShell>;
}
