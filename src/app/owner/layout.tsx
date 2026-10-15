import { ProductShell } from "@/app/components/product-shell";

const navigation = [
  { label: "Overview", href: "/owner" },
  { label: "Forecast & Staffing" },
  { label: "Locations" },
  { label: "Reporting & Analytics" },
];

export default function OwnerLayout({ children }: { children: React.ReactNode }) {
  return <ProductShell role="Owner" context="FairShift demo company" navigation={navigation}>{children}</ProductShell>;
}
