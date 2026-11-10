import { updateBusinessAction } from "@/app/settings-actions";

// The business's name and address (Day 6, item 3). The country is fixed after setup: it sets each
// location's currency, time zone and minimum wage rule.
type Business = { name: string; businessAddress: string | null; city: string | null; province: string | null; postalCode: string | null; country: string | null };
export function BusinessSettings({ business, locationCount, disabled }: { business: Business; locationCount: number; disabled?: boolean }) {
  return <section className="panel" id="business" aria-labelledby="business-title">
    <h2 id="business-title">Business</h2>
    <p className="panel-lede">{locationCount} {locationCount === 1 ? "location" : "locations"} · country {business.country ?? "not recorded"}</p>
    <form action={updateBusinessAction} className="workspace-form form-grid">
      <label>Business name<input name="name" defaultValue={business.name} maxLength={150} required disabled={disabled} /></label>
      <label>Street address<input name="businessAddress" defaultValue={business.businessAddress ?? ""} maxLength={300} required disabled={disabled} /></label>
      <label>City or town<input name="city" defaultValue={business.city ?? ""} maxLength={100} required disabled={disabled} /></label>
      <label>Province or region<input name="province" defaultValue={business.province ?? ""} maxLength={100} disabled={disabled} /></label>
      <label>Postal code<input name="postalCode" defaultValue={business.postalCode ?? ""} maxLength={30} required disabled={disabled} /></label>
      <p className="form-span note">The country can’t be changed here: it sets every location’s currency and minimum wage rule. Contact FairShift if it’s wrong.</p>
      {disabled ? null : <button className="secondary-button">Save business details</button>}
    </form>
  </section>;
}
