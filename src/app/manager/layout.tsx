import { requireScope } from "@/server/auth/request";
import { ProductShell } from "@/app/components/product-shell";
import { DemoBar } from "@/app/demo/demo-bar";
import { ownerNavigation } from "@/app/components/owner-navigation";
import { LocationSwitcher } from "@/app/components/location-switcher";
import { getDatabase } from "@/server/db/client";
import { activeLocations } from "@/server/product/locations";
import "@bryntum/scheduler/fontawesome/css/fontawesome.css";
import "@bryntum/scheduler/fontawesome/css/solid.css";
import "@bryntum/scheduler/scheduler.css";
import "@bryntum/scheduler/stockholm-light.css";
import "./allocations.css";

const navigation = [
  { label: "Today", href: "/manager" },
  { label: "Forecast & staffing", href: "/manager/plan" },
  { label: "Fill shifts", href: "/manager/fill" },
  { label: "Allocations", href: "/manager/allocations" },
  { label: "Workers", href: "/manager/team" },
  { label: "Review & pay", href: "/manager/review" },
];

export default async function ManagerLayout({ children }: { children: React.ReactNode }) {
  const scope=await requireScope(["OWNER","MANAGER"]);
  const banner=scope.demo ? <DemoBar persona={scope.demo.persona} /> : undefined;
  if (scope.role !== "OWNER") return <ProductShell banner={banner} role="Manager" context={scope.locationName} navigation={navigation}>{children}</ProductShell>;
  // An Owner operates a location here as themselves. A switch appears only when there is a choice;
  // if the list can't be read, the selected location still shows and the work goes on.
  let locations: { id: string; name: string }[] = [];
  try { locations = await activeLocations(getDatabase(), scope.organisationId); } catch { locations = []; }
  const control = locations.length > 1 ? <LocationSwitcher locations={locations} current={scope.locationId} /> : undefined;
  return <ProductShell banner={banner} role="Owner" context={scope.locationName} contextControl={control} navigation={ownerNavigation}>{children}</ProductShell>;
}
