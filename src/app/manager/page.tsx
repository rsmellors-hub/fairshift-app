import { ManagerWorkspace } from "@/app/manager/workspace";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export default async function ManagerPage({ searchParams }: { searchParams?: Promise<{ status?: string }> }) {
  return <div className="product-page">{await ManagerWorkspace({ area: "overview", status: (await searchParams)?.status })}</div>;
}
