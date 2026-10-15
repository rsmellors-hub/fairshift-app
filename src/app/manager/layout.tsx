import { ProductShell } from "@/app/components/product-shell";

const navigation = [
  { label: "Overview", href: "/manager" },
  { label: "Forecast & Staffing" },
  { label: "Fill Shifts" },
  { label: "Shift Allocations" },
  { label: "Worker Pool" },
  { label: "Performance" },
  { label: "Payments & Approvals" },
];

export default function ManagerLayout({ children }: { children: React.ReactNode }) {
  return <ProductShell role="Manager" context="Rosebank Kitchen" navigation={navigation}>{children}</ProductShell>;
}
