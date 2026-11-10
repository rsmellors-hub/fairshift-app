import type { ProductNavItem } from "@/app/components/product-shell";

// The Owner's navigation (design, 10 Nov 2026): Today, Plan, Fill shifts, Schedule, Pay, Locations,
// PayPal & AI records, Business settings, Billing. Operations act at the Owner's selected location.
export const ownerNavigation: ProductNavItem[] = [
  { label: "Today", href: "/owner" },
  { label: "Plan", href: "/manager/plan" },
  { label: "Fill shifts", href: "/manager/fill" },
  { label: "Schedule", href: "/manager/allocations" },
  { label: "Pay", href: "/manager/review" },
  { label: "Locations", href: "/owner/locations" },
  { label: "PayPal & AI records", href: "/owner/proof" },
  { label: "Business settings", href: "/owner/settings" },
  { label: "Billing", href: "/owner/billing" },
];
