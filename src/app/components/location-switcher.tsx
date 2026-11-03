"use client";

import { usePathname } from "next/navigation";
import { selectLocationAction } from "@/app/auth-actions";

// Changes the Owner's operating location and returns to the same operational page there.
export function LocationSwitcher({ locations, current }: { locations: { id: string; name: string }[]; current: string }) {
  const pathname = usePathname();
  return <form action={selectLocationAction} className="location-switcher" data-demo-write="">
    <input type="hidden" name="next" value={pathname} />
    <label>Operating location<select name="locationId" defaultValue={current}>{locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
    <button className="secondary-button">Switch</button>
  </form>;
}
