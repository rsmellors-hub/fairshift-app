import { money } from "@/app/components/format";
import { StatusBadge } from "@/app/components/product-ui";
import { addRoleAction, newPayVersionAction, saveLocationTipsAction, saveLocationTradingAction, saveStaffingAndOffersAction, saveVenueDetailsAction } from "@/app/location-actions";
import { acknowledgeWageNotCheckedAction } from "@/app/operations-actions";
import { checkWage, wageCheckExplanation, type WageJurisdiction } from "@/server/domain/statutory-wage";
import { CUSTOMER_TYPES, CUSTOMER_TYPE_CHECKS, CUSTOMER_TYPE_LABEL, suggestCustomerTypes } from "@/server/intelligence/customer-types";
import { formatCoverageText, formatTradingText } from "@/server/intelligence/workload";
import type { getStaffingConfiguration } from "@/server/intelligence/business-policy";
import type { ShiftRules } from "@/server/scheduling/shift-rules";
import { WAGE_NOT_CHECKED_STATEMENT, type WageAcknowledgement } from "@/server/scheduling/wage-acknowledgement";

// The Owner's settings for one location, as collapsible sections whose headers show the key value
// (design: OwnerLocation, 10 Nov 2026). Each section saves on its own for this location.

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const VENUE_TYPES = { CAFE_RESTAURANT: "Café and restaurant", BAR: "Bar", TAKEAWAY: "Takeaway" } as const;
const ROLES = ["Floor", "Kitchen", "Bar", "Barista", "Scullery", "Host"];
const h = (minutes: number) => String(Math.round((minutes / 60) * 100) / 100);
const since = (date: Date) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(date);

type Location = { id: string; name: string; address: string | null; city: string | null; province: string | null; postalCode: string | null; country: string | null; timezone: string;
  latitude: number | null; longitude: number | null; pinConfirmedAt: Date | null; customerTypes: string[]; customerNote: string | null; venueType: string | null; seats: number | null;
  locationProfile: unknown };
const Hidden = ({ location }: { location: Location }) => <input type="hidden" name="locationId" value={location.id} />;
const Section = ({ id, title, summary, open, children }: { id: string; title: string; summary: string; open?: boolean; children: React.ReactNode }) =>
  <details className="panel disclosure location-section" id={id} open={open}><summary><span className="h4">{title}</span>{summary ? <span className="note"> · {summary}</span> : null}</summary>{children}</details>;

export function VenueDetails({ location, currency, disabled, open }: { location: Location; currency: string; disabled?: boolean; open?: boolean }) {
  // An earlier free-text profile suggests types for the Owner to confirm; nothing changes until saved.
  const profileText = location.locationProfile && typeof location.locationProfile === "object" ? Object.values(location.locationProfile as Record<string, unknown>).filter(v => typeof v === "string").join(" ") : "";
  const suggested = !location.customerTypes.length && profileText ? suggestCustomerTypes(profileText) : [];
  const chosen = location.customerTypes.length ? location.customerTypes : suggested;
  const where = [location.address, location.city].filter(Boolean).join(", ");
  return <Section id="venue" title="Venue details" summary={where || "Address not set"} open={open}>
    <form action={saveVenueDetailsAction} className="workspace-form form-grid"><Hidden location={location} />
      <label>Name<input name="name" defaultValue={location.name} maxLength={150} required disabled={disabled} /></label>
      <label>Street address<input name="address" defaultValue={location.address ?? ""} maxLength={200} disabled={disabled} /></label>
      <label>City or town<input name="city" defaultValue={location.city ?? ""} maxLength={100} disabled={disabled} /></label>
      <label>Province or region<input name="province" defaultValue={location.province ?? ""} maxLength={100} disabled={disabled} /></label>
      <label>Postal code<input name="postalCode" defaultValue={location.postalCode ?? ""} maxLength={20} disabled={disabled} /></label>
      <p className="form-span note">{location.latitude !== null && location.longitude !== null
        ? <>{location.pinConfirmedAt ? "Pin confirmed" : "Pin not confirmed yet"} · {location.latitude.toFixed(3)}, {location.longitude.toFixed(3)} · <a className="link" href={`/owner/locations/${location.id}/pin`}>Move pin</a></>
        : <>No map pin yet. <a className="link" href={`/owner/locations/${location.id}/pin`}>Find the address and confirm the pin</a> so FairShift can check weather and what’s happening nearby.</>}</p>
      <label>Venue type<select name="venueType" defaultValue={location.venueType ?? ""} disabled={disabled}><option value="">Not set</option>{Object.entries(VENUE_TYPES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label>Seats<input name="seats" type="number" min={1} max={5000} defaultValue={location.seats ?? ""} disabled={disabled} /></label>
      <fieldset className="form-span customer-types"><legend>Who are your customers? Pick all that apply</legend>
        {suggested.length ? <p className="note">Suggested from your earlier description of this location. Check them and save to confirm.</p> : null}
        {CUSTOMER_TYPES.map(type => <label className="acceptance-check" key={type}><input type="checkbox" name="customerTypes" value={type} defaultChecked={chosen.includes(type)} disabled={disabled} /> <span><strong>{CUSTOMER_TYPE_LABEL[type]}</strong><small>AI checks: {CUSTOMER_TYPE_CHECKS[type]}</small></span></label>)}
        <small>Each choice decides exactly which local signals the AI looks for at this location, so results are consistent and explainable.</small></fieldset>
      <label className="form-span">Nothing fits? Add a short note (optional; it can only narrow the search)<input name="customerNote" defaultValue={location.customerNote ?? ""} maxLength={200} disabled={disabled} /></label>
      <p className="form-span note">Time zone {location.timezone} · currency {currency}. The business’s country sets these and the minimum wage rule.</p>
      {disabled ? null : <button className="primary-button">Save venue details</button>}
    </form>
  </Section>;
}

type Configuration = Awaited<ReturnType<typeof getStaffingConfiguration>>;
export function TradingHours({ location, configuration, disabled }: { location: Location; configuration: Configuration; disabled?: boolean }) {
  const set = configuration.trading.filter(Boolean).length;
  return <Section id="trading" title="Trading hours" summary={set ? `${set} of 7 days set` : "Not set"}>
    <p className="panel-lede">Write times like 09:00-17:00, separate two openings with a comma, and write closed for a closed day.</p>
    <form action={saveLocationTradingAction} className="workspace-form form-grid"><Hidden location={location} />
      {DAYS.map((day, i) => <label key={day}>{day}<input name={`trading${i + 1}`} defaultValue={formatTradingText(configuration.trading[i]?.windows ?? null)} disabled={disabled} /></label>)}
      {disabled ? null : <div className="button-row form-span"><button className="primary-button">Save trading hours</button><button className="secondary-button" name="copy" value="monday">Copy to all days</button></div>}
    </form>
  </Section>;
}

export function StaffingAndOffers({ location, configuration, rules, disabled }: { location: Location; configuration: Configuration; rules: ShiftRules | null; disabled?: boolean }) {
  const policy = configuration.locationPolicy ?? configuration.organisationPolicy;
  const summary = rules ? `${h(rules.minMinutes)}–${h(rules.maxMinutes)} h shifts · cancellation ${rules.cancellationPercent}% under ${h(rules.cancellationWindowMinutes)} h` : "Shift rules not set";
  return <Section id="staffing" title="Staffing and offers" summary={summary}>
    <form action={saveStaffingAndOffersAction} className="workspace-form form-grid"><Hidden location={location} />
      <label>Bills one person serves an hour<input name="transactionsPerStaffHour" inputMode="numeric" defaultValue={policy ? String(policy.transactionsPerStaffHour) : ""} required disabled={disabled} /></label>
      <label>Minimum on the floor<input name="minimumStaffWhileOpen" inputMode="numeric" defaultValue={policy ? String(policy.minimumStaffWhileOpen) : ""} required disabled={disabled} /></label>
      <label>Shortest shift (h)<input name="minHours" type="number" min={1} max={16} step={0.25} defaultValue={rules ? h(rules.minMinutes) : ""} required disabled={disabled} /></label>
      <label>Usual shift (h)<input name="preferredHours" type="number" min={1} max={16} step={0.25} defaultValue={rules ? h(rules.preferredMinutes) : ""} required disabled={disabled} /></label>
      <label>Longest shift (h)<input name="maxHours" type="number" min={1} max={16} step={0.25} defaultValue={rules ? h(rules.maxMinutes) : ""} required disabled={disabled} /></label>
      <label>Cancellation pay (%)<input name="cancellationPercent" type="number" min={0} max={100} defaultValue={rules?.cancellationPercent ?? 50} required disabled={disabled} /><small>Printed on every offer.</small></label>
      <label>…if cancelled less than this many hours before<input name="cancellationHours" type="number" min={0} max={168} step={0.5} defaultValue={rules ? h(rules.cancellationWindowMinutes) : 24} required disabled={disabled} /></label>
      <label>First offer round lasts (h)<input name="firstRoundHours" type="number" min={0} max={168} step={0.25} defaultValue={rules ? h(rules.firstRoundMinutes) : ""} required disabled={disabled} /><small>Goes to people who want more hours first.</small></label>
      <label>…or ends this many hours before the shift<input name="cutoffHours" type="number" min={0} max={168} step={0.25} defaultValue={rules ? h(rules.firstRoundCutoffMinutes) : ""} required disabled={disabled} /></label>
      <fieldset className="form-span"><legend>Regular cover already on shift (e.g. 08:00-17:00 x2, or none)</legend>{DAYS.map((day, i) => <label key={day}>{day}<input name={`coverage${i + 1}`} defaultValue={formatCoverageText(configuration.coverage[i]?.windows ?? null)} disabled={disabled} /></label>)}</fieldset>
      {disabled ? null : <button className="primary-button form-span">Save staffing and offers</button>}
    </form>
  </Section>;
}

type Policy = { id: string; name: string; earningsModel: string; rateMinor: number | null; currencyCode: string; effectiveFrom: Date };
export function PayTerms({ location, policies, jurisdiction, today, acknowledgement, disabled }: { location: Location; policies: Policy[]; jurisdiction: WageJurisdiction; today: string; acknowledgement: WageAcknowledgement | null; disabled?: boolean }) {
  const hourly = policies.filter(p => p.earningsModel === "HOURLY" && p.rateMinor !== null);
  const lowest = hourly.length ? Math.min(...hourly.map(p => p.rateMinor!)) : null;
  const currency = policies[0]?.currencyCode ?? "";
  const check = (rateMinor: number) => checkWage({ jurisdiction, date: today, currencyCode: currency, terms: { earningsModel: "HOURLY", rateMinor } });
  const unchecked = jurisdiction.jurisdiction === null;
  return <Section id="pay-terms" title="Pay terms for casual shifts" summary={hourly.length ? `${hourly.length} ${hourly.length === 1 ? "role" : "roles"} from ${money(lowest!, currency)} an hour` : "No roles yet"} open={!hourly.length}>
    {hourly.length ? <ul className="role-list">{hourly.map(p => { const wage = check(p.rateMinor!);
      return <li key={p.id}><p><strong>{p.name} · {money(p.rateMinor!, p.currencyCode)} an hour</strong> <small>In force since {since(p.effectiveFrom)} · hourly only</small></p>
        <p className="note">{wage.status === "RATE_CHECKED" ? <StatusBadge tone="success">✓</StatusBadge> : <StatusBadge tone="warning">!</StatusBadge>} {wageCheckExplanation(wage, minor => money(minor, wage.floorCurrency ?? currency))}</p>
        {disabled ? null : <details className="disclosure-inline"><summary>New version…</summary><form action={newPayVersionAction} className="workspace-form form-grid"><Hidden location={location} /><input type="hidden" name="policyId" value={p.id} /><input type="hidden" name="name" value={p.name} />
          <label>New hourly rate<input name="rate" inputMode="decimal" defaultValue={(p.rateMinor! / 100).toFixed(2)} required /></label>
          <p className="form-span note">Applies from now. Shifts already created or accepted keep {money(p.rateMinor!, p.currencyCode)}. The minimum wage is checked again before it’s saved.</p>
          <button className="secondary-button">Save new version</button></form></details>}</li>; })}</ul> : <p>No roles yet, so shifts can’t be offered here.</p>}
    {disabled ? null : <details className="disclosure-inline" open={!hourly.length}><summary>+ Add role</summary><form action={addRoleAction} className="workspace-form form-grid"><Hidden location={location} />
      <label>Role<input name="role" list={`roles-${location.id}`} maxLength={100} required /><datalist id={`roles-${location.id}`}>{ROLES.map(role => <option key={role} value={role} />)}</datalist></label>
      <label>Hourly rate<input name="rate" inputMode="decimal" required /></label>
      <p className="form-span note">Each role is offered at its own rate, checked against the minimum wage for this location’s country before it can be saved.</p>
      <button className="secondary-button">Add role</button></form></details>}
    {unchecked ? <div className="wage-acknowledgement"><p><StatusBadge tone="warning">Minimum wage not checked</StatusBadge> FairShift holds no minimum wage rule for {jurisdiction.country ?? "this location’s country"}.</p>
      {acknowledgement ? <p className="note">Acknowledged by the Owner: “{WAGE_NOT_CHECKED_STATEMENT}”</p> : disabled ? null : <form action={acknowledgeWageNotCheckedAction} className="workspace-form"><Hidden location={location} /><input type="hidden" name="next" value={`/owner/locations/${location.id}#pay-terms`} />
        <label className="acceptance-check"><input type="checkbox" name="confirmed" value="yes" required /> {WAGE_NOT_CHECKED_STATEMENT}</label><button className="secondary-button">Acknowledge and allow offers</button></form>}</div> : null}
    <p className="note">Changing a rate creates a new version from now. Shifts already accepted keep the terms the worker saw.</p>
  </Section>;
}

export function CardTips({ location, settings, currency, disabled }: { location: Location; settings: { policy: string; autoReleaseCapMinor: number } | null; currency: string; disabled?: boolean }) {
  const label = settings?.policy === "DIRECT" ? "tips go to the person who earned them" : settings?.policy === "SHIFT_POOL" ? "shared by everyone on the shift" : "not set";
  return <Section id="tips" title="Card tips" summary={label}>
    <form action={saveLocationTipsAction} className="workspace-form form-grid"><Hidden location={location} />
      <fieldset className="form-span"><legend>How card tips are shared</legend>
        <label className="acceptance-check"><input type="radio" name="policy" value="SHIFT_POOL" defaultChecked={settings?.policy !== "DIRECT"} disabled={disabled} /> <span><strong>Shared by everyone on the shift</strong><small>Each service block is split equally between the people working it.</small></span></label>
        <label className="acceptance-check"><input type="radio" name="policy" value="DIRECT" defaultChecked={settings?.policy === "DIRECT"} disabled={disabled} /> <span><strong>Go to the person who earned them</strong><small>Each tip follows the staff member on its till record.</small></span></label></fieldset>
      <label>Release automatically up to ({currency}) per person per day<input name="cap" inputMode="decimal" defaultValue={settings ? (settings.autoReleaseCapMinor / 100).toFixed(2) : ""} required disabled={disabled} /><small>Above this, the Pay Agent holds for you.</small></label>
      <p className="form-span note">Set before a period’s tips are imported. Shown to staff on every statement.</p>
      {disabled ? null : <button className="primary-button">Save card tips</button>}
    </form>
  </Section>;
}
