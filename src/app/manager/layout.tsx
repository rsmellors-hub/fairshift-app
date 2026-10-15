import { ProductShell } from "@/app/components/product-shell";

const navigation = [
  { label: "Overview", href: "/manager" },
  { label: "Forecast & Staffing", href: "/manager/forecast" },
  { label: "Fill Shifts", href: "/manager/fill-shifts" },
  { label: "Shift Allocations", href: "/manager/allocations" },
  { label: "Worker Pool", href: "/manager/workers" },
  { label: "Performance", href: "/manager/performance" },
  { label: "Payments & Approvals", href: "/manager/payments" },
];

export default function ManagerLayout({ children }: { children: React.ReactNode }) {
  return <ProductShell role="Manager" context="Rosebank Kitchen" navigation={navigation}>{children}</ProductShell>;
}
