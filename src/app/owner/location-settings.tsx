import { setLocationActiveAction, updateLocationAction } from "@/app/people-actions";

// The Owner's details for one location (Day 6, Owner decision 10 Nov 2026): name and workplace address
// are editable; the country is the business's and sets currency, time zone and wage rule. Deactivating
// keeps every record and is reversible.
type Location = { id: string; name: string; address: string | null; city: string | null; province: string | null; postalCode: string | null; country: string | null; active: boolean; timezone: string };

export function LocationSettings({ location, disabled }: { location: Location; disabled?: boolean }) {
  return <section className="panel" id="location-settings" aria-labelledby="location-settings-title">
    <h2 id="location-settings-title">Location details</h2>
    {location.active ? null : <p className="note"><strong>Deactivated.</strong> Nobody can plan or offer shifts here until you reactivate it.</p>}
    <form action={updateLocationAction} className="workspace-form form-grid"><input type="hidden" name="locationId" value={location.id} />
      <label>Location name<input name="name" defaultValue={location.name} maxLength={150} required disabled={disabled} /></label>
      <label>Street address<input name="address" defaultValue={location.address ?? ""} maxLength={200} disabled={disabled} /></label>
      <label>City or town<input name="city" defaultValue={location.city ?? ""} maxLength={100} disabled={disabled} /></label>
      <label>Province or region<input name="province" defaultValue={location.province ?? ""} maxLength={100} disabled={disabled} /></label>
      <label>Postal code<input name="postalCode" defaultValue={location.postalCode ?? ""} maxLength={20} disabled={disabled} /></label>
      <p className="form-span note">Country: {location.country ?? "the business’s country"} · time zone {location.timezone}. The country sets this location’s currency and minimum wage rule.</p>
      {disabled ? null : <button className="secondary-button">Save location details</button>}
    </form>
    {disabled ? null : <form action={setLocationActiveAction} className="workspace-form"><input type="hidden" name="locationId" value={location.id} /><input type="hidden" name="active" value={location.active ? "no" : "yes"} />
      {location.active ? <label className="acceptance-check"><input type="checkbox" name="confirm" value="yes" required /> Deactivate {location.name}. Its records are kept; managers can’t open it and no shifts can be planned there until you reactivate it.</label> : null}
      <button className="secondary-button">{location.active ? "Deactivate location" : "Reactivate location"}</button></form>}
  </section>;
}
