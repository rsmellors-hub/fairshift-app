import { notFound, redirect } from "next/navigation";
import { WorkerWorkspace, workerAreas, type WorkerArea } from "@/app/worker/workspace";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export default async function WorkerAreaPage({ params, searchParams }: { params: Promise<{ area: string }>; searchParams: Promise<{ status?: string; view?: string; offer?: string }> }) {
  const { area } = await params;
  if (area === "schedule") redirect("/worker/shifts");
  if (area === "performance" || area === "earnings") redirect("/worker/pay");
  if (!workerAreas.includes(area as typeof workerAreas[number])) notFound();
  return <div className="product-page worker-page">{await (async () => { const query = await searchParams; return WorkerWorkspace({ area: area as WorkerArea, status: query.status, view: query.view, offer: query.offer }); })()}</div>;
}
