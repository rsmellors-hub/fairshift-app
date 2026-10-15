import { requireScope } from "@/server/auth/request";
import { ProductShell } from "@/app/components/product-shell";
import "@bryntum/scheduler/fontawesome/css/fontawesome.css";
import "@bryntum/scheduler/fontawesome/css/solid.css";
import "@bryntum/scheduler/scheduler.css";
import "@bryntum/scheduler/stockholm-light.css";
import "./allocations.css";

const navigation = [
  { label: "Today", href: "/manager" },
  { label: "Plan", href: "/manager/plan" },
  { label: "Team", href: "/manager/team" },
  { label: "Review", href: "/manager/review" },
];

export default async function ManagerLayout({ children }: { children: React.ReactNode }) {
  const scope=await requireScope(["OWNER","MANAGER"]);
  return <ProductShell role="Manager" context={scope.locationName} navigation={navigation}>{children}</ProductShell>;
}
