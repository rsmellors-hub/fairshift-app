import { requireScope } from "@/server/auth/request";
import { ProductShell } from "@/app/components/product-shell";
import { DemoBar, SandboxBar } from "@/app/demo/demo-bar";
import { isDemoOrganisation } from "@/server/demo/organisation";
import { ownerNavigation } from "@/app/components/owner-navigation";
import { LocationSwitcher } from "@/app/components/location-switcher";
import { getDatabase } from "@/server/db/client";
import { activeLocations } from "@/server/product/locations";
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
  const banner=scope.demo ? <DemoBar persona={scope.demo.persona} /> : undefined;
  const notice=!scope.demo && isDemoOrganisation(scope.organisationId) ? <SandboxBar /> : undefined;
  if (scope.role !== "OWNER") return <ProductShell banner={banner} notice={notice} role="Manager" context={scope.locationName} navigation={navigation}>{children}</ProductShell>;
  // An Owner operates a location here as themselves. A switch appears only when there is a choice;
  // if the list can't be read, the selected location still shows and the work goes on.
  let locations: { id: string; name: string }[] = [];
  try { locations = await activeLocations(getDatabase(), scope.organisationId); } catch { locations = []; }
  const control = locations.length > 1 ? <LocationSwitcher locations={locations} current={scope.locationId} /> : undefined;
  return <ProductShell banner={banner} notice={notice} role="Owner" context={scope.locationName} contextControl={control} navigation={ownerNavigation}>{children}</ProductShell>;
}
