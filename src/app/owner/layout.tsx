import { requireScope } from "@/server/auth/request";
import { ProductShell } from "@/app/components/product-shell";

const navigation = [
  { label: "Overview", href: "/owner" },
  { label: "Locations", href: "/owner/locations" },
  { label: "Forecast & Staffing", href: "/owner/forecast" },
  { label: "Reporting & Analytics", href: "/owner/reporting" },
  { label: "Workforce / Managers", href: "/owner/workforce" },
  { label: "Policies", href: "/owner/policies" },
  { label: "Payments", href: "/owner/payments" },
  { label: "Settings / Integrations", href: "/owner/settings" },
];

export default async function OwnerLayout({ children }: { children: React.ReactNode }) {
  const scope=await requireScope(["OWNER"]);
  return <ProductShell role="Owner" context={scope.organisationName} navigation={navigation}>{children}</ProductShell>;
}
