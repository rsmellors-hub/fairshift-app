import { ProductShell } from "@/app/components/product-shell";

const navigation = [
  { label: "Home", href: "/worker" },
  { label: "Shifts" },
  { label: "Schedule" },
  { label: "Earnings" },
  { label: "Profile" },
];

export default function WorkerLayout({ children }: { children: React.ReactNode }) {
  return <ProductShell role="Worker" context="Rosebank Kitchen" navigation={navigation} mobile>{children}</ProductShell>;
}
