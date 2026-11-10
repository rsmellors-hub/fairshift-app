import type { ProductNavItem } from "@/app/components/product-shell";

// One Owner navigation across the business pages and the location operations they share with
// Managers. Operations act at the Owner's selected location.
export const ownerNavigation: ProductNavItem[] = [
  { label: "Overview", href: "/owner", group: "Demand" },
  { label: "Sales", href: "/owner/reporting" },
  { label: "Forecast", href: "/owner/forecast" },
  { label: "Locations", href: "/owner/locations" },
  { label: "Forecast & staffing", href: "/manager/plan", group: "Operations" },
  { label: "Fill shifts", href: "/manager/fill" },
  { label: "Allocations", href: "/manager/allocations" },
  { label: "Performance", href: "/manager/review#performance" },
  { label: "Review & pay", href: "/manager/review" },
  { label: "Tips", href: "/owner/tips", group: "Pay" },
  { label: "Payments", href: "/owner/payments" },
  { label: "Business settings", href: "/owner/settings", group: "Business" },
  { label: "Billing", href: "/owner/billing" },
  { label: "Proof", href: "/owner/proof" },
];
