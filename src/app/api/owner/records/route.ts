import { NextResponse } from "next/server";
import { requireScope } from "@/server/auth/request";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { getProofPanel } from "@/server/product/proof";
import { recordsCsv } from "@/server/product/records-csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// "Download CSV" on PayPal & AI records (design, 10 Nov 2026): the Owner's own business only, with the
// same identifiers the page shows. No recipient, token, secret or contact detail is included.
export async function GET() {
  const scope = await requireScope(["OWNER"]);
  if (!getConfigurationStatus().databaseConfigured) return NextResponse.json({ error: "UNAVAILABLE" }, { status: 503 });
  const data = await getProofPanel(getDatabase(), scope).catch(() => null);
  if (!data) return NextResponse.json({ error: "UNAVAILABLE" }, { status: 503 });
  const month = new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric", timeZone: data.timezone }).format(new Date()).toLowerCase().replace(" ", "-");
  return new NextResponse(recordsCsv(data), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="fairshift-records-${month}.csv"`, "cache-control": "no-store" } });
}
