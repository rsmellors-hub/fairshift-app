import { setLocationActiveAction } from "@/app/people-actions";

// Deactivating a location keeps every record and is reversible (Day 6, Owner decision 10 Nov 2026). Its
// name and address are edited under Venue details.
type Location = { id: string; name: string; active: boolean };

export function LocationSettings({ location, disabled }: { location: Location; disabled?: boolean }) {
  if (disabled) return null;
  return <section className="panel" id="location-settings" aria-label={location.active ? "Deactivate location" : "Reactivate location"}>
    <form action={setLocationActiveAction} className="workspace-form"><input type="hidden" name="locationId" value={location.id} /><input type="hidden" name="active" value={location.active ? "no" : "yes"} />
      {location.active ? <label className="acceptance-check"><input type="checkbox" name="confirm" value="yes" required /> Deactivate {location.name}. Its records are kept; managers can’t open it and no shifts can be planned there until you reactivate it.</label> : null}
      <button className="secondary-button">{location.active ? "Deactivate location" : "Reactivate location"}</button></form>
  </section>;
}
