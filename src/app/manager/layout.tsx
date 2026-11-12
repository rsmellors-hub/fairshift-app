import { requireScope } from "@/server/auth/request";
import { ProductShell } from "@/app/components/product-shell";
import { ownerNavigation } from "@/app/components/owner-navigation";
import { ownerLocationControl, shellStrips } from "@/app/components/shell-chrome";
import "@bryntum/scheduler/fontawesome/css/fontawesome.css";
import "@bryntum/scheduler/fontawesome/css/solid.css";
import "@bryntum/scheduler/scheduler.css";
import "@bryntum/scheduler/stockholm-light.css";
import "./allocations.css";

// Design, 10 Nov 2026 (Manager · Today): Today, Plan, Fill shifts, Schedule, Confirm work, Team.
const navigation = [
  { label: "Today", href: "/manager" },
  { label: "Plan", href: "/manager/plan" },
  { label: "Fill shifts", href: "/manager/fill" },
  { label: "Schedule", href: "/manager/allocations" },
  { label: "Confirm work", href: "/manager/review" },
  { label: "Team", href: "/manager/team" },
];

export default async function ManagerLayout({ children }: { children: React.ReactNode }) {
  const scope=await requireScope(["OWNER","MANAGER"]);
  const strips=shellStrips(scope, `${scope.organisationName} · ${scope.locationName}`);
  if (scope.role !== "OWNER") return <ProductShell {...strips} role="Manager" context={scope.locationName} navigation={navigation}>{children}</ProductShell>;
  // An Owner operates a location here as themselves, with the location switch in the top bar.
  return <ProductShell {...strips} role="Owner" context={scope.locationName} contextControl={await ownerLocationControl(scope)} navigation={ownerNavigation}>{children}</ProductShell>;
}
