import { ProductShell } from "@/app/components/product-shell";

const navigation = [
  { label: "Home", href: "/worker" },
  { label: "Shifts", href: "/worker/shifts" },
  { label: "Earnings", href: "/worker/earnings" },
  { label: "Profile", href: "/worker/profile" },
];

export default function WorkerLayout({ children }: { children: React.ReactNode }) {
  return <ProductShell role="Worker" context="Rosebank Kitchen" navigation={navigation} mobile>{children}</ProductShell>;
}
