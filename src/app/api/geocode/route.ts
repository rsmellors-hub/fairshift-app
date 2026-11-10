import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireScope } from "@/server/auth/request";
import { consumeLimit } from "@/server/auth/identity";
import { getDatabase } from "@/server/db/client";
import { organisations } from "@/server/db/schema";
import { geocodePlace } from "@/server/integrations/open-meteo/geocoding";

// Place search for the Owner's pin (design: Setup step 3, OwnerLocation). Signed-in Owners only, rate
// limited, limited to the business's country; the provider response isn't logged or stored.
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const scope = await requireScope(["OWNER"]);
  if (scope.demo) return NextResponse.json({ results: [] });
  try { await consumeLimit(getDatabase(), `geocode:${scope.userId}`, 40); } catch { return NextResponse.json({ error: "limited" }, { status: 429 }); }
  const query = new URL(request.url).searchParams.get("q") ?? "";
  const [organisation] = await getDatabase().select({ country: organisations.country }).from(organisations).where(eq(organisations.id, scope.organisationId));
  try { return NextResponse.json({ results: await geocodePlace(query, organisation?.country ?? null) }); }
  catch { return NextResponse.json({ error: "unavailable" }, { status: 502 }); }
}
