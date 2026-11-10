import { WorkerWorkspace } from "@/app/worker/workspace";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export default async function WorkerPayPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  return <div className="product-page worker-page">{await WorkerWorkspace({ area: "pay", status: (await searchParams).status })}</div>;
}
