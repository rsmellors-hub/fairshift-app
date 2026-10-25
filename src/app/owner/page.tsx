import { requireScope } from "@/server/auth/request";
import { getDatabase } from "@/server/db/client";
import { getConfigurationStatus } from "@/server/config/env";
import { getOwnerOverview } from "@/server/product/owner-overview";
import { OwnerOverview, OwnerReload } from "@/app/owner/overview";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export default async function OwnerPage() {
  const scope = await requireScope(["OWNER"]);
  if (!getConfigurationStatus().databaseConfigured) return <OwnerOverviewUnavailable />;
  let data;
  try { data = await getOwnerOverview(getDatabase(), scope); }
  catch { return <OwnerOverviewUnavailable />; }
  return <div className="product-page"><OwnerOverview data={data} /></div>;
}

function OwnerOverviewUnavailable() {
  return <div className="product-page owner-overview"><h1>Overview</h1><section className="owner-empty" role="alert"><h2>Overview could not be loaded</h2><p>Your organisation’s operating information is unavailable. Reload to try again.</p><OwnerReload /></section></div>;
}
