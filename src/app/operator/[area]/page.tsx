import { notFound } from "next/navigation";
import { OperatorWorkspace, operatorAreas, type OperatorArea } from "@/app/operator/workspace";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export default async function OperatorAreaPage({ params, searchParams }: { params: Promise<{ area: string }>; searchParams: Promise<{ status?: string }> }) {
  const { area } = await params;
  if (!operatorAreas.includes(area as typeof operatorAreas[number])) notFound();
  return <div className="product-page">{await OperatorWorkspace({ area: area as OperatorArea, status: (await searchParams).status })}</div>;
}
