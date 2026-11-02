import { clearLocationWorkloadPolicyAction, clearOrganisationWorkloadPolicyAction, saveLocationWorkloadPolicyAction, saveOrganisationWorkloadPolicyAction, saveRegularCoverageAction, saveTradingHoursAction } from "@/app/operations-actions";
import { policySummary } from "@/app/components/staffing";
import type { getStaffingConfiguration } from "@/server/intelligence/business-policy";
import { formatCoverageText, formatTradingText } from "@/server/intelligence/workload";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
type Configuration = Awaited<ReturnType<typeof getStaffingConfiguration>>;
type Policy = Configuration["organisationPolicy"];
const policyText = (policy: NonNullable<Policy>) => `${policySummary(policy)} · version ${policy.version}${policy.source === "REFERENCE" ? " · reference company configuration" : ""}`;

function PolicyForm({ action, policy, label }: { action: (form: FormData) => void | Promise<void>; policy: Policy; label: string }) {
  return <form action={action} className="workspace-form form-grid">
    <label>Service capacity<span className="field-hint">How many completed transactions can one staff member typically support in an hour?</span><input name="transactionsPerStaffHour" inputMode="numeric" pattern="[0-9]+" defaultValue={policy ? String(policy.transactionsPerStaffHour) : ""} required /></label>
    <label>Minimum coverage<span className="field-hint">Minimum staff required while this location is open.</span><input name="minimumStaffWhileOpen" inputMode="numeric" pattern="[0-9]+" defaultValue={policy ? String(policy.minimumStaffWhileOpen) : ""} required /></label>
    <button className="secondary-button">{label}</button>
  </form>;
}

const stateOf = (rows: readonly ({ source: string } | null)[], word: string) => {
  const set = rows.filter(Boolean).length;
  if (!set) return `Not set for this location, so its ${word} is unavailable.`;
  return `${set} of 7 days set${rows.some(row => row?.source === "REFERENCE") ? " · reference company configuration" : ""}.${set < 7 ? " Days left blank stay unavailable." : ""}`;
};

// A business's own staffing inputs. FairShift supplies no value and doesn't suggest one.
export function StaffingConfiguration({ configuration, locationName }: { configuration: Configuration; locationName: string }) {
  const { organisationPolicy, locationPolicy, trading, coverage } = configuration;
  return <>
    <section className="panel" id="workload-policy" aria-labelledby="workload-policy-title"><h2 id="workload-policy-title">Service capacity and minimum cover</h2>
      <p>FairShift turns expected transactions into the staff capacity you need using these two figures. They’re your own policy. FairShift doesn’t know the right values and sets none for you. Sales value isn’t part of this.</p>
      <h3>Organisation default</h3>
      <p>{organisationPolicy ? policyText(organisationPolicy) : <strong>Not set. Locations without their own policy have no staff requirement until one is set.</strong>}</p>
      <PolicyForm action={saveOrganisationWorkloadPolicyAction} policy={organisationPolicy} label="Save organisation default" />
      {organisationPolicy ? <form action={clearOrganisationWorkloadPolicyAction}><button className="secondary-button">Remove organisation default</button></form> : null}
      <h3>{locationName} override</h3>
      <p>{locationPolicy ? policyText(locationPolicy) : organisationPolicy ? "None. This location uses the organisation default." : "None."}</p>
      <PolicyForm action={saveLocationWorkloadPolicyAction} policy={locationPolicy} label="Save location override" />
      {locationPolicy ? <form action={clearLocationWorkloadPolicyAction}><button className="secondary-button">Remove location override</button></form> : null}
    </section>
    <section className="panel" id="trading-hours" aria-labelledby="trading-hours-title"><h2 id="trading-hours-title">Trading hours · {locationName}</h2>
      <p>When this location is open. Write times like <code>09:00-17:00</code>, separate two openings with a comma, and write <code>closed</code> for a closed day. A blank day isn’t the same as closed: its planning stays unavailable.</p>
      <form action={saveTradingHoursAction} className="workspace-form form-grid">
        {WEEKDAYS.map((day, i) => <label key={day}>{day}<input name={`trading${i + 1}`} defaultValue={formatTradingText(trading[i]?.windows ?? null)} aria-describedby="trading-hours-state" /></label>)}
        <button className="primary-button">Save trading hours</button>
      </form>
      <p id="trading-hours-state" className="note">{stateOf(trading, "planning")}</p>
    </section>
    <section className="panel" id="regular-coverage" aria-labelledby="regular-coverage-title"><h2 id="regular-coverage-title">Regular coverage · {locationName}</h2>
      <p>How many regular staff are in at each time of a normal week. This is capacity for planning, not a roster. Write <code>07:00-12:00 x3, 12:00-15:00 x4</code>, and <code>none</code> for a day with no regular staff. A blank day isn’t the same as none: its casual requirement stays unavailable.</p>
      <form action={saveRegularCoverageAction} className="workspace-form form-grid">
        {WEEKDAYS.map((day, i) => <label key={day}>{day}<input name={`coverage${i + 1}`} defaultValue={formatCoverageText(coverage[i]?.windows ?? null)} aria-describedby="regular-coverage-state" /></label>)}
        <button className="primary-button">Save regular coverage</button>
      </form>
      <p id="regular-coverage-state" className="note">{stateOf(coverage, "casual requirement")}</p>
    </section>
  </>;
}
