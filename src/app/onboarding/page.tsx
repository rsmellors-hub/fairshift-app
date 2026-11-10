import Link from "next/link";
import { redirect } from "next/navigation";
import { and, eq, isNull } from "drizzle-orm";
import { signOutAction } from "@/app/auth-actions";
import { AcquisitionProgress, type SetupStepName } from "@/app/components/acquisition-progress";
import { FirstLook } from "@/app/components/first-look";
import { FairShiftBrand } from "@/app/components/product-shell";
import { ActionFeedback } from "@/app/components/workspace-ui";
import { addRoleAction, saveLocationTipsAction } from "@/app/location-actions";
import { addPersonAction } from "@/app/people-actions";
import { connectSquareAction } from "@/app/square-actions";
import { addAnotherLocationAction, continueSetupAction, finishSetupAction, importSalesCsvAction, sampleHistoryAction, saveSetupVenueAction } from "@/app/setup-actions";
import { money } from "@/app/components/format";
import { requireOwnerCustomer } from "@/server/auth/request";
import { organisationEntitled } from "@/server/billing/entitlement";
import { locationLimitFor } from "@/server/billing/plans";
import { squareSandboxCredentials } from "@/server/commerce/square-connection";
import { getDatabase } from "@/server/db/client";
import { organisations, outlets, subscriptions, teamInvitations, workPolicies } from "@/server/db/schema";
import { checkWage, wageJurisdiction } from "@/server/domain/statutory-wage";
import { CUSTOMER_TYPES, CUSTOMER_TYPE_CHECKS, CUSTOMER_TYPE_LABEL } from "@/server/intelligence/customer-types";
import { localDate } from "@/server/intelligence/forecast";
import { setupProgress, SETUP_STEPS, type SetupStep } from "@/server/onboarding/setup";
import { importedHistoryLabels } from "@/server/sales/history-sources";

export const dynamic = "force-dynamic";

// The design's setup flow (Setup, 10 Nov 2026), steps 3–6 after the account and the PayPal Sandbox
// trial. Nothing here is hardcoded to a country or to the demo business: the business's country sets
// currency, time zone and wage rule, and the venue's own answers shape everything else.
const STEP_NAME: Record<SetupStep, SetupStepName> = { venue: "Venue", sales: "Sales history", pay: "Pay terms", team: "Team" };
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const TYPICAL_HOURS = { CAFE_RESTAURANT: "07:00-17:00", BAR: "16:00-23:00", TAKEAWAY: "10:00-21:00" } as const;
const ROLES = ["Floor", "Kitchen", "Bar", "Barista", "Scullery", "Host"];
const VENUE_TYPES = { CAFE_RESTAURANT: "Café and restaurant", BAR: "Bar", TAKEAWAY: "Takeaway" } as const;

export default async function Onboarding({ searchParams }: { searchParams?: Promise<{ step?: string; location?: string; status?: string; from?: string }> }) {
  const query = await searchParams;
  const scope = await requireOwnerCustomer(), db = getDatabase();
  if (!await organisationEntitled(db, scope.organisationId)) redirect("/subscribe");
  const [business] = await db.select().from(organisations).where(eq(organisations.id, scope.organisationId));
  const all = await db.select().from(outlets).where(eq(outlets.organisationId, scope.organisationId));
  const location = (query?.location ? all.find(row => row.id === query.location) : null) ?? all.find(row => row.active) ?? null;
  const step: SetupStep = SETUP_STEPS.includes(query?.step as SetupStep) ? query!.step as SetupStep : "venue";
  // Once set up, the flow is only for steps someone asks for; otherwise go to the workspace.
  if (business?.setupCompletedAt && !query?.step) redirect("/owner");
  if (step !== "venue" && (!business?.setupCompletedAt || !location)) redirect("/onboarding?step=venue");
  const progress = await setupProgress(db, scope.organisationId, location?.id ?? null);
  const [subscription] = await db.select().from(subscriptions).where(eq(subscriptions.organisationId, scope.organisationId));
  const limit = subscription?.tier === "SINGLE_OUTLET" || subscription?.tier === "MULTI_OUTLET" ? locationLimitFor(subscription.tier) : subscription?.locationLimit ?? 1;
  const activeCount = all.filter(row => row.active).length;
  const at = location ? `&location=${location.id}` : "";
  const hidden = location ? <input type="hidden" name="locationId" value={location.id} /> : null;
  const nav = (back: SetupStep | null) => <div className="button-row">{back ? <Link className="secondary-button button-link" href={`/onboarding?step=${back}${at}`}>Back</Link> : null}
    <form action={continueSetupAction}>{hidden}<input type="hidden" name="step" value={step} /><button className="primary-button">Continue</button></form></div>;

  return <main className="acquisition-shell workplace-shell">
    <header className="acquisition-header"><FairShiftBrand /><div className="button-row"><Link className="link-button" href="/owner">Save and finish later</Link><form action={signOutAction}><button className="link-button">Sign out</button></form></div></header>
    <AcquisitionProgress current={STEP_NAME[step]} />
    <p className="eyebrow">Step {SETUP_STEPS.indexOf(step) + 3} of 6 · {business?.name}</p>
    <ActionFeedback status={query?.status} />

    {step === "venue" ? <>
      <div className="workplace-heading"><h1>{location && progress.venue ? `Your venue: ${location.name}` : "Where is your venue?"}</h1>
        <p>FairShift uses the address to check weather, public holidays and what’s happening nearby. Nothing is shared with your customers or staff.</p></div>
      <form action={saveSetupVenueAction} className="workspace-form form-grid">{hidden}
        <label>Venue name<input name="name" defaultValue={location?.name ?? ""} required maxLength={150} /></label>
        <label>Street address<input name="address" defaultValue={location?.address ?? ""} required maxLength={200} /></label>
        <label>City or town<input name="city" defaultValue={location?.city ?? ""} required maxLength={100} /></label>
        <label>Postal code<input name="postalCode" defaultValue={location?.postalCode ?? ""} maxLength={20} /></label>
        <label>Venue type<select name="venueType" defaultValue={location?.venueType ?? "CAFE_RESTAURANT"}>{Object.entries(VENUE_TYPES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label>Seats<input name="seats" type="number" min={1} max={5000} defaultValue={location?.seats ?? ""} required /></label>
        <fieldset className="form-span customer-types"><legend>Who are your customers? Pick all that apply</legend>
          {CUSTOMER_TYPES.map(type => <label className="acceptance-check" key={type}><input type="checkbox" name="customerTypes" value={type} defaultChecked={location?.customerTypes.includes(type)} /> <span><strong>{CUSTOMER_TYPE_LABEL[type]}</strong><small>AI checks: {CUSTOMER_TYPE_CHECKS[type]}</small></span></label>)}
          <small>Each choice decides exactly which local signals the AI looks for at this location, so results are consistent and explainable.</small></fieldset>
        <label className="form-span">Nothing fits? Add a short note (optional; it can only narrow the search)<input name="customerNote" defaultValue={location?.customerNote ?? ""} maxLength={200} /></label>
        <fieldset className="form-span"><legend>When are you open? (e.g. 07:00-17:00, or closed)</legend>{DAYS.map((day, i) => <label key={day}>{day}<input name={`trading${i + 1}`} defaultValue={TYPICAL_HOURS[(location?.venueType ?? "CAFE_RESTAURANT") as keyof typeof TYPICAL_HOURS]} required /></label>)}</fieldset>
        <label>Bills one person serves an hour<input name="transactionsPerStaffHour" inputMode="numeric" required /><small>Your own figure: FairShift doesn’t guess it.</small></label>
        <label>Minimum on the floor while open<input name="minimumStaffWhileOpen" inputMode="numeric" required /></label>
        <fieldset className="form-span"><legend>Permanent staff already on each day (optional, e.g. 08:00-16:00 x2, or none)</legend>{DAYS.map((day, i) => <label key={day}>{day}<input name={`coverage${i + 1}`} defaultValue="none" /></label>)}</fieldset>
        <button className="primary-button form-span">Save venue and place the pin</button>
      </form>
      {location && progress.venue ? <p className="note">{progress.pin ? <>Pin confirmed · {location.latitude?.toFixed(3)}, {location.longitude?.toFixed(3)} · <Link className="link" href={`/owner/locations/${location.id}/pin?next=setup`}>Move pin</Link></> : <Link className="primary-button button-link" href={`/owner/locations/${location.id}/pin?next=setup`}>Place the pin on your venue</Link>}</p> : null}
      {location ? await FirstLook({ organisationId: scope.organisationId, location }) : null}
      {location && progress.venue && progress.pin ? nav(null) : null}
    </> : null}

    {step === "sales" && location ? <>
      <div className="workplace-heading"><h1>How busy is {location.name} usually?</h1><p>Sales by day and hour give the forecast its starting point. The AI only adjusts it up or down from there.</p></div>
      {await (async () => { const labels = await importedHistoryLabels(db, location.id); return labels.length ? <p className="note">In use: {labels.map(row => `${row.label} · ${row.transactions.toLocaleString("en-GB")} transactions`).join("; ")}.</p> : null; })()}
      <div className="setup-options">
        <section className="panel"><h2>Connect Square</h2><p className="panel-lede">Sales and card tips per worker import nightly. Read-only access. PayPal Sandbox and Square Sandbox in this environment.</p>
          {squareSandboxCredentials() ? <form action={connectSquareAction}><input type="hidden" name="outletId" value={location.id} /><input type="hidden" name="next" value="setup" /><button className="secondary-button">Connect Square</button></form> : <p className="note">Square isn’t set up in this environment.</p>}</section>
        <section className="panel"><h2>Upload past sales (CSV)</h2><p className="panel-lede">Daily or hourly totals: a header row with date, transactions and optionally hour and sales. Shown as “Imported” everywhere it’s used.</p>
          <form action={importSalesCsvAction} className="workspace-form">{hidden}<input type="file" name="file" accept=".csv,text/csv" required /><button className="secondary-button">Upload</button></form></section>
        <section className="panel"><h2>Start with sample history</h2><p className="panel-lede">Scaled to your {location.seats ?? "venue’s"} seats and venue type. Always labelled “Sample (synthetic)” until you add real sales.</p>
          <form action={sampleHistoryAction}>{hidden}<button className="secondary-button">Use sample history for my venue</button></form></section>
      </div>
      {nav("venue")}
    </> : null}

    {step === "pay" && location ? await PayStep({ location, country: business?.country ?? null, nav: nav("sales") }) : null}

    {step === "team" && location ? <>
      <div className="workplace-heading"><h1>Who works at {location.name}?</h1><p>Add people now or later. Each gets an official FairShift invitation and becomes active once they sign up. No home address is needed.</p></div>
      {await (async () => { const invited = await db.select().from(teamInvitations).where(and(eq(teamInvitations.organisationId, scope.organisationId), eq(teamInvitations.outletId, location.id)));
        return invited.length ? <ul className="role-list">{invited.map(row => <li key={row.id}>{[row.firstName, row.surname].filter(Boolean).join(" ") || row.email} · {row.role === "MANAGER" ? "Manager" : "Casual worker"} · invitation sent</li>)}</ul> : null; })()}
      <form action={addPersonAction} className="workspace-form form-grid"><input type="hidden" name="next" value={`/onboarding?step=team&location=${location.id}`} /><input type="hidden" name="locationIds" value={location.id} />
        <label>First name<input name="firstName" required maxLength={100} autoComplete="off" /></label><label>Surname<input name="surname" required maxLength={100} autoComplete="off" /></label>
        <label>Email<input name="email" type="email" required maxLength={254} autoComplete="off" /></label>
        <label>Role<select name="role" defaultValue="TEAM_MEMBER"><option value="TEAM_MEMBER">Casual worker</option><option value="MANAGER">Manager</option></select></label>
        <button className="secondary-button">Add and send invitation</button>
        <p className="form-span note"><Link href={`/owner/invitation-preview?location=${location.id}`} target="_blank">Preview the invitation email</Link></p></form>
      <section className="panel"><p><strong>{location.name} is set up</strong> · location {all.filter(row => row.active).findIndex(row => row.id === location.id) + 1} of {limit}</p>
        {activeCount < limit ? <details className="disclosure-inline"><summary>+ Add another location</summary><form action={addAnotherLocationAction} className="inline-form">{hidden}<label>Location name<input name="name" required maxLength={150} /></label><button className="secondary-button">Add and set it up</button></form></details> : <p className="note">Add your next venue later from Locations.</p>}</section>
      <div className="button-row"><Link className="secondary-button button-link" href={`/onboarding?step=pay${at}`}>Back</Link><form action={finishSetupAction}><button className="primary-button">{progress.team ? "Finish" : "Skip and finish"}</button></form></div>
    </> : null}
  </main>;
}

async function PayStep({ location, country, nav }: { location: typeof outlets.$inferSelect; country: string | null; nav: React.ReactNode }) {
  const db = getDatabase();
  const roles = await db.select().from(workPolicies).where(and(eq(workPolicies.outletId, location.id), eq(workPolicies.earningsModel, "HOURLY"), isNull(workPolicies.supersededAt)));
  const jurisdiction = wageJurisdiction({ locationCountry: location.country, organisationCountry: country });
  const today = localDate(new Date(), location.timezone);
  return <>
    <div className="workplace-heading"><h1>What do casual shifts pay?</h1><p>Workers see these terms on every offer. Pay is hourly only.</p></div>
    {roles.length ? <ul className="role-list">{roles.map(role => { const check = checkWage({ jurisdiction, date: today, currencyCode: role.currencyCode, terms: { earningsModel: "HOURLY", rateMinor: role.rateMinor! } });
      return <li key={role.id}><strong>{role.name} · {money(role.rateMinor!, role.currencyCode)} an hour</strong> <small>{check.status === "RATE_CHECKED" ? `✓ At or above ${check.floorMinor !== null ? money(check.floorMinor, role.currencyCode) : "the minimum wage"}` : "Minimum wage not checked here"}</small></li>; })}</ul> : <p>No roles yet.</p>}
    <form action={addRoleAction} className="workspace-form form-grid"><input type="hidden" name="locationId" value={location.id} /><input type="hidden" name="next" value="setup:pay" />
      <label>Role<input name="role" list="setup-roles" required maxLength={100} /><datalist id="setup-roles">{ROLES.map(role => <option key={role} value={role} />)}</datalist></label>
      <label>Hourly rate<input name="rate" inputMode="decimal" required /></label>
      <button className="secondary-button">+ Add role</button>
      <p className="form-span note">Each role is offered at its own rate. Every rate is checked against the minimum wage for your country before it’s saved, and you can’t continue without at least one role.</p></form>
    <form action={saveLocationTipsAction} className="workspace-form form-grid"><input type="hidden" name="locationId" value={location.id} /><input type="hidden" name="next" value="setup:pay" />
      <fieldset className="form-span"><legend>Card tips</legend>
        <label className="acceptance-check"><input type="radio" name="policy" value="SHIFT_POOL" defaultChecked /> <span><strong>Shared by everyone on the shift</strong><small>split equally per service block</small></span></label>
        <label className="acceptance-check"><input type="radio" name="policy" value="DIRECT" /> <span><strong>Go to the person who earned them</strong><small>follows the till record</small></span></label></fieldset>
      <label>Release automatically up to, per person per day<input name="cap" inputMode="decimal" required /></label>
      <button className="secondary-button">Save tip rule</button></form>
    <p className="note">You can change roles and rates later in Locations. The wage floor is a reference check, not legal advice.</p>
    {nav}
  </>;
}
