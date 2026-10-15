import { OperatorWorkspace } from "@/app/operator/workspace";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export default async function OperatorPage() {
  return <div className="product-page">{await OperatorWorkspace({ area: "overview" })}</div>;
}
