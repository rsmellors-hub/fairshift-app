import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { PinMap } from "@/app/components/pin-map";
import { confirmPinAction } from "@/app/location-actions";
import { requireScope } from "@/server/auth/request";
import { getDatabase } from "@/server/db/client";
import { outlets } from "@/server/db/schema";

export const dynamic = "force-dynamic";

// The venue's map pin (design: OwnerLocation "Move pin", Setup step 3). FairShift uses it for weather,
// public holidays and what's happening nearby; it's never shown to customers or staff.
export default async function PinPage({ params, searchParams }: { params: Promise<{ locationId: string }>; searchParams?: Promise<{ next?: string }> }) {
  const { locationId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(locationId)) notFound();
  const scope = await requireScope(["OWNER"]);
  const [location] = await getDatabase().select().from(outlets).where(and(eq(outlets.id, locationId), eq(outlets.organisationId, scope.organisationId)));
  if (!location) notFound();
  const next = (await searchParams)?.next === "setup" ? "setup" : "location";
  const initial = location.latitude !== null && location.longitude !== null ? { latitude: location.latitude, longitude: location.longitude } : null;
  return <div className="product-page"><div className="owner-heading"><div><p className="eyebrow"><Link href={`/owner/locations/${location.id}`}>{location.name}</Link> › Map pin</p><h1>Where is {location.name}?</h1></div></div>
    <section className="panel"><p className="panel-lede">{[location.address, location.city, location.postalCode].filter(Boolean).join(", ") || "No street address saved yet."} Find the suburb or town, then drag the pin onto your venue.</p>
      <form action={confirmPinAction} className="workspace-form"><input type="hidden" name="locationId" value={location.id} /><input type="hidden" name="next" value={next} />
        <PinMap initial={initial} initialQuery={location.city ?? ""} />
        {scope.demo ? null : <button className="primary-button">The pin is on my venue</button>}
      </form></section></div>;
}
