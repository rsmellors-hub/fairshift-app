import { requireScope } from "@/server/auth/request";
import { ProductShell } from "@/app/components/product-shell";
import { DemoBar, SandboxBar } from "@/app/demo/demo-bar";
import { isDemoOrganisation } from "@/server/demo/organisation";

const navigation = [
  { label: "Home", href: "/worker" },
  { label: "Shifts", href: "/worker/shifts" },
  { label: "Earnings", href: "/worker/earnings" },
  { label: "Profile", href: "/worker/profile" },
];

export default async function WorkerLayout({ children }: { children: React.ReactNode }) {
  const scope=await requireScope(["TEAM_MEMBER"]);
  return <ProductShell banner={scope.demo ? <DemoBar persona={scope.demo.persona} /> : undefined} notice={!scope.demo && isDemoOrganisation(scope.organisationId) ? <SandboxBar /> : undefined} role="Worker" context={scope.locationName} navigation={navigation} mobile>{children}</ProductShell>;
}
