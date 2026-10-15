import { notFound } from "next/navigation";
import { OwnerWorkspace, ownerAreas, type OwnerArea } from "@/app/owner/workspace";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export default async function OwnerAreaPage({ params }: { params: Promise<{ area: string }> }) {
  const { area } = await params;
  if (!ownerAreas.includes(area as typeof ownerAreas[number])) notFound();
  return <div className="product-page">{await OwnerWorkspace({ area: area as OwnerArea })}</div>;
}
