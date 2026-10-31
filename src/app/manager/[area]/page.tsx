import { notFound, redirect } from "next/navigation";
import { ManagerWorkspace, managerAreas, type ManagerArea } from "@/app/manager/workspace";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export default async function ManagerAreaPage({ params, searchParams }: { params: Promise<{ area: string }>; searchParams: Promise<{ status?: string; date?: string; department?: string; ai?: string; importResult?: string }> }) {
  const { area } = await params;
  const legacy: Record<string, string> = { forecast: "plan", "fill-shifts": "plan", allocations: "plan", workers: "team", performance: "review", payments: "review" };
  if (legacy[area]) redirect(`/manager/${legacy[area]}`);
  if (!managerAreas.includes(area as typeof managerAreas[number])) notFound();
  return <div className="product-page">{await ManagerWorkspace({ area: area as ManagerArea, ...(await searchParams) })}</div>;
}
