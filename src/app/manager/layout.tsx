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

export default function ManagerLayout({ children }: { children: React.ReactNode }) {
  return <ProductShell role="Manager" context="Rosebank Kitchen" navigation={navigation}>{children}</ProductShell>;
}
