import { WorkerWorkspace } from "@/app/worker/workspace";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export default async function WorkerPage({ searchParams }: { searchParams?: Promise<{ status?: string }> }) {
  return <div className="product-page worker-page">{await WorkerWorkspace({ area: "home", status: (await searchParams)?.status })}</div>;
}
