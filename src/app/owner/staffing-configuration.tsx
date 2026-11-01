import { clearLocationLabourPolicyAction, clearOrganisationLabourPolicyAction, saveLocationLabourPolicyAction, saveOrganisationLabourPolicyAction, saveRegularCoverageAction } from "@/app/operations-actions";
import { labourHours, wholeMoney } from "@/app/components/staffing";
import type { getStaffingConfiguration } from "@/server/intelligence/business-policy";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
type Configuration = Awaited<ReturnType<typeof getStaffingConfiguration>>;
type Policy = Configuration["organisationPolicy"];
const policyText = (policy: NonNullable<Policy>) => `${wholeMoney(policy.salesMinorPerLabourHour, policy.currencyCode)} forecast sales per labour hour · version ${policy.version}${policy.source === "REFERENCE" ? " · reference company configuration" : ""}`;

function PolicyForm({ action, policy, evidenceCurrency, label }: { action: (form: FormData) => void | Promise<void>; policy: Policy; evidenceCurrency: string | null; label: string }) {
  return <form action={action} className="inline-form">
    <label>Forecast sales per labour hour<input name="salesPerLabourHour" inputMode="decimal" pattern="[0-9]+([.][0-9]{1,2})?" defaultValue={policy ? (policy.salesMinorPerLabourHour / 100).toFixed(2) : ""} required /></label>
    <label>Currency<input name="currencyCode" maxLength={3} defaultValue={policy?.currencyCode ?? evidenceCurrency ?? ""} required /></label>
    <button className="secondary-button">{label}</button>
  </form>;
}

// A business's own staffing inputs. Both are planning assumptions it chooses:
// FairShift supplies no default and does not present them as benchmarks.
export function StaffingConfiguration({ configuration, locationName }: { configuration: Configuration; locationName: string }) {
  const { organisationPolicy, locationPolicy, coverage, evidenceCurrency } = configuration;
  const resolved = locationPolicy ?? organisationPolicy;
  const mismatch = resolved && evidenceCurrency && resolved.currencyCode !== evidenceCurrency;
  return <>
    <section className="panel" id="labour-policy" aria-labelledby="labour-policy-title"><h2 id="labour-policy-title">Labour policy</h2>
      <p>How much forecast sales one labour hour covers in your business. FairShift converts forecast demand into required labour with this figure. It is your planning assumption, not an industry benchmark, and it is never converted between currencies.</p>
      <h3>Organisation default</h3>
      <p>{organisationPolicy ? policyText(organisationPolicy) : "Not configured. Locations without their own policy have no required labour until one is set."}</p>
      <PolicyForm action={saveOrganisationLabourPolicyAction} policy={organisationPolicy} evidenceCurrency={evidenceCurrency} label="Save organisation default" />
      {organisationPolicy ? <form action={clearOrganisationLabourPolicyAction}><button className="secondary-button">Remove organisation default</button></form> : null}
      <h3>{locationName} override</h3>
      <p>{locationPolicy ? policyText(locationPolicy) : organisationPolicy ? "None. This location uses the organisation default." : "None."}</p>
      <PolicyForm action={saveLocationLabourPolicyAction} policy={locationPolicy} evidenceCurrency={evidenceCurrency} label="Save location override" />
      {locationPolicy ? <form action={clearLocationLabourPolicyAction}><button className="secondary-button">Remove location override</button></form> : null}
      {mismatch ? <p role="status">This location’s sales history is in {evidenceCurrency}, but the policy that applies is in {resolved.currencyCode}. Required labour stays unavailable until they match; nothing is converted.</p> : null}
    </section>
    <section className="panel" id="regular-coverage" aria-labelledby="regular-coverage-title"><h2 id="regular-coverage-title">Regular coverage · {locationName}</h2>
      <p>Planned regular-staff hours for a normal week. Enter 0 for a day with no regular staff. Leave a day blank if it is not known: its casual labour gap then stays unavailable.</p>
      <form action={saveRegularCoverageAction} className="workspace-form form-grid">
        {WEEKDAYS.map((day, i) => <label key={day}>{day}<input name={`day${i + 1}`} inputMode="decimal" pattern="[0-9]+([.][0-9]{1,2})?" defaultValue={coverage[i] ? String(coverage[i]!.plannedMinutes / 60) : ""} aria-describedby="regular-coverage-state" /></label>)}
        <button className="primary-button">Save regular coverage</button>
      </form>
      <p id="regular-coverage-state" className="note">{coverage.every(row => row === null) ? "Not configured for this location." : `${coverage.reduce((sum, row) => sum + (row?.plannedMinutes ?? 0), 0) === 0 ? "0 h" : labourHours(coverage.reduce((sum, row) => sum + (row?.plannedMinutes ?? 0), 0))} a week across ${coverage.filter(Boolean).length} configured days${coverage.some(row => row?.source === "REFERENCE") ? " · reference company configuration" : ""}.`}</p>
    </section>
  </>;
}
