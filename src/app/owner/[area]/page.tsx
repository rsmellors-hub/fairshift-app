import { notFound } from "next/navigation";
import { OwnerWorkspace, ownerAreas, type OwnerArea } from "@/app/owner/workspace";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export default async function OwnerAreaPage({ params, searchParams }: { params: Promise<{ area: string }>; searchParams?: Promise<{ status?: string }> }) {
  const { area } = await params;
  if (!ownerAreas.includes(area as typeof ownerAreas[number])) notFound();
  return <div className="product-page">{await OwnerWorkspace({ area: area as OwnerArea, status: (await searchParams)?.status })}</div>;
}
