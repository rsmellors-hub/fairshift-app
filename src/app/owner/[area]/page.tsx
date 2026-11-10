import { notFound, redirect } from "next/navigation";
import { requireScope } from "@/server/auth/request";
import { OwnerWorkspace, ownerAreas, type OwnerArea } from "@/app/owner/workspace";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export default async function OwnerAreaPage({ params, searchParams }: { params: Promise<{ area: string }>; searchParams?: Promise<{ status?: string; ai?: string; location?: string; source?: string; range?: string }> }) {
  const { area } = await params;
  // Design, 10 Nov 2026: people and pay terms live on each location's page; Locations opens the
  // selected location.
  if (area === "locations" || area === "workforce" || area === "policies") {
    const scope = await requireScope(["OWNER"]);
    redirect(`/owner/locations/${scope.locationId}${area === "workforce" ? "#team" : area === "policies" ? "#pay-terms" : ""}`);
  }
  if (!ownerAreas.includes(area as typeof ownerAreas[number])) notFound();
  const query = await searchParams;
  return <div className="product-page">{await OwnerWorkspace({ area: area as OwnerArea, status: query?.status, ai: query?.ai, salesFilter: { location: query?.location, source: query?.source, range: query?.range } })}</div>;
}
