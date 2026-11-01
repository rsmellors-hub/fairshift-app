import { requireScope } from "@/server/auth/request";
import { ProductShell } from "@/app/components/product-shell";
import { DemoBar } from "@/app/demo/demo-bar";

const navigation = [
  { label: "Overview", href: "/owner", group: "Demand" },
  { label: "Sales", href: "/owner/reporting" },
  { label: "Forecast", href: "/owner/forecast" },
  { label: "Locations", href: "/owner/locations" },
  { label: "Managers", href: "/owner/workforce", group: "People & pay" },
  { label: "Compensation", href: "/owner/policies" },
  { label: "Incentives", href: "/owner/policies#work-policies" },
  { label: "Payments", href: "/owner/payments" },
  { label: "Settings", href: "/owner/settings", group: "Business" },
];

export default async function OwnerLayout({ children }: { children: React.ReactNode }) {
  const scope=await requireScope(["OWNER"]);
  return <ProductShell banner={scope.demo ? <DemoBar persona={scope.demo.persona} /> : undefined} role="Owner" context={scope.organisationName} navigation={navigation}>{children}</ProductShell>;
}
