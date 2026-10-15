import { notFound } from "next/navigation";
import { WorkerWorkspace, workerAreas, type WorkerArea } from "@/app/worker/workspace";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export default async function WorkerAreaPage({ params, searchParams }: { params: Promise<{ area: string }>; searchParams: Promise<{ status?: string }> }) {
  const { area } = await params;
  if (!workerAreas.includes(area as typeof workerAreas[number])) notFound();
  return <div className="product-page worker-page">{await WorkerWorkspace({ area: area as WorkerArea, status: (await searchParams).status })}</div>;
}
