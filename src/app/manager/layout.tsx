import { requireScope } from "@/server/auth/request";
import { ProductShell } from "@/app/components/product-shell";
import { DemoBar } from "@/app/demo/demo-bar";
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
  return <ProductShell banner={scope.demo ? <DemoBar persona={scope.demo.persona} /> : undefined} role="Manager" context={scope.locationName} navigation={navigation}>{children}</ProductShell>;
}
