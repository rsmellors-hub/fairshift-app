import { requireScope } from "@/server/auth/request";
import { ProductShell } from "@/app/components/product-shell";

const navigation = [
  { label: "Home", href: "/worker" },
  { label: "Shifts", href: "/worker/shifts" },
  { label: "Earnings", href: "/worker/earnings" },
  { label: "Availability", href: "/worker/availability" },
  { label: "Profile", href: "/worker/profile" },
];

export default async function WorkerLayout({ children }: { children: React.ReactNode }) {
  const scope=await requireScope(["TEAM_MEMBER"]);
  return <ProductShell role="Worker" context={scope.locationName} navigation={navigation} mobile>{children}</ProductShell>;
}
