import { requireScope } from "@/server/auth/request";
import { ProductShell } from "@/app/components/product-shell";
import "./owner.css";

const navigation = [
  { label: "Overview", href: "/owner" },
  { label: "Sales", href: "/owner/reporting" },
  { label: "Forecast", href: "/owner/forecast" },
  { label: "Locations", href: "/owner/locations" },
  { label: "Managers", href: "/owner/workforce" },
  { label: "Compensation", href: "/owner/policies" },
  { label: "Incentives", href: "/owner/policies#work-policies" },
  { label: "Payments / PayPal", href: "/owner/payments" },
  { label: "Settings", href: "/owner/settings" },
];

export default async function OwnerLayout({ children }: { children: React.ReactNode }) {
  const scope=await requireScope(["OWNER"]);
  return <ProductShell role="Owner" context={scope.organisationName} navigation={navigation}>{children}</ProductShell>;
}
