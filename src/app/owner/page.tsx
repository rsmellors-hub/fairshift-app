import { OwnerWorkspace } from "@/app/owner/workspace";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export default async function OwnerPage() {
  return <div className="product-page">{await OwnerWorkspace({ area: "overview" })}</div>;
}
