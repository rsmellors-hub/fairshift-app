"use client";

import { useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { selectLocationAction } from "@/app/auth-actions";

const ALL = "all";
// Pages that act at the selected location: switching keeps the Owner on the same page there.
const LOCATION_PAGE = /^\/manager(\/(plan|fill|allocations|team|review))?$/;

// The Owner's location switch in the top bar (design, 10 Nov 2026): All locations first, and it
// switches on change with no extra button. Choosing a location uses the existing server action, which
// sets the operating location; on a business-wide page it opens that location's Today. Choosing All
// locations opens the Owner's business-wide Today. Nothing here grants access: the action checks it.
export function LocationSwitcher({ locations, current }: { locations: { id: string; name: string }[]; current: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);
  const atLocation = LOCATION_PAGE.test(pathname) || pathname === "/owner/tips";
  const next = atLocation ? pathname : "/manager";
  return <form ref={form} action={selectLocationAction} className="location-switcher" data-demo-write="">
    <input type="hidden" name="next" value={next} />
    <label>
      <span className="visually-hidden">Location</span>
      <select name="locationId" key={`${pathname}:${current}`} defaultValue={atLocation ? current : ALL} onChange={event => {
        if (event.currentTarget.value === ALL) router.push("/owner");
        else form.current?.requestSubmit();
      }}>
        <option value={ALL}>All locations · {locations.length}</option>
        {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
      </select>
    </label>
  </form>;
}
