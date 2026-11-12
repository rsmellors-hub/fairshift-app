import { money } from "@/app/components/format";
import { revisePolicyAction } from "@/app/operations-actions";
import { setHoursRuleAction, setShiftRulesAction } from "@/app/settings-actions";
import type { HoursRule, ShiftRules } from "@/server/scheduling/shift-rules";

// Owner settings stored as dated versions (Day 6, item 3): a location's shift lengths and offer rounds,
// and the business's guaranteed-hours alert. Saving writes a new version; earlier ones are kept.

const h = (minutes: number) => String(Math.round((minutes / 60) * 100) / 100);
const since = (date: Date) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(date);

export function ShiftRulesSettings({ rules, locationName, disabled }: { rules: ShiftRules | null; locationName: string; disabled?: boolean }) {
  return <section className="panel" id="shift-rules" aria-labelledby="shift-rules-title">
    <h2 id="shift-rules-title">Shift lengths and offer rounds · {locationName}</h2>
    <p className="panel-lede">FairShift cuts this location’s casual gap into shifts of these lengths and offers each one first to workers here who want more hours, then to everyone eligible. {rules ? `Current since ${since(rules.createdAt)}${rules.source === "DEMO_SEED" ? " (demo values)" : ""}.` : "Not set yet, so no shifts are suggested here."}</p>
    <form action={setShiftRulesAction} className="workspace-form form-grid">
      <label>Shortest shift (hours)<input name="minHours" type="number" min={1} max={16} step={0.25} defaultValue={rules ? h(rules.minMinutes) : ""} required disabled={disabled} /></label>
      <label>Usual shift (hours)<input name="preferredHours" type="number" min={1} max={16} step={0.25} defaultValue={rules ? h(rules.preferredMinutes) : ""} required disabled={disabled} /></label>
      <label>Longest shift (hours)<input name="maxHours" type="number" min={1} max={16} step={0.25} defaultValue={rules ? h(rules.maxMinutes) : ""} required disabled={disabled} /></label>
      <label>First offer round lasts (hours)<input name="firstRoundHours" type="number" min={0} max={168} step={0.25} defaultValue={rules ? h(rules.firstRoundMinutes) : ""} required disabled={disabled} /><small>Workers here who want more hours, fewest hours to the alert first.</small></label>
      <label>…or ends this many hours before the shift<input name="cutoffHours" type="number" min={0} max={168} step={0.25} defaultValue={rules ? h(rules.firstRoundCutoffMinutes) : ""} required disabled={disabled} /><small>Whichever is sooner. Then it’s open to all eligible workers here.</small></label>
      {disabled ? null : <button className="secondary-button">Save shift rules</button>}
    </form>
  </section>;
}

export function HoursRuleSettings({ rule, disabled }: { rule: HoursRule | null; disabled?: boolean }) {
  return <details className="panel disclosure" id="hours-rule"><summary><span className="h4">Hours alert</span><span className="note"> · {rule ? `${h(rule.weeklyThresholdMinutes)} h a week over ${rule.referenceWeeks} weeks` : "not set"}</span></summary>
    <p className="panel-lede">FairShift alerts you when a casual worker averages this many hours a week or more over the reference period. It only alerts: it never offers anyone regular hours. {rule ? `Current since ${since(rule.createdAt)}${rule.source === "DEMO_SEED" ? " (demo values)" : ""}.` : "Not set yet, so no alert is shown."}</p>
    <form action={setHoursRuleAction} className="workspace-form form-grid">
      <label>Average hours a week<input name="weeklyHours" type="number" min={1} max={80} step={0.5} defaultValue={rule ? h(rule.weeklyThresholdMinutes) : ""} required disabled={disabled} /></label>
      <label>Over this many weeks<input name="referenceWeeks" type="number" min={1} max={52} step={1} defaultValue={rule?.referenceWeeks ?? ""} required disabled={disabled} /></label>
      {disabled ? null : <button className="secondary-button">Save alert</button>}
    </form>
  </details>;
}

// Changing pay terms writes a new version from now; shifts already created keep the terms they were made with.
type Policy = { id: string; name: string; earningsModel: string; rateMinor: number | null; currencyCode: string; incentiveTargetMinor: number | null; incentiveBonusMinor: number | null; effectiveFrom: Date };
const major = (minor: number | null) => minor === null ? "" : (minor / 100).toFixed(2);
export function PolicyRevision({ policy, disabled }: { policy: Policy; disabled?: boolean }) {
  if (disabled || policy.earningsModel === "COMMISSION") return <small>Since {since(policy.effectiveFrom)}</small>;
  return <details className="disclosure-inline"><summary>Change terms</summary>
    <form action={revisePolicyAction} className="workspace-form form-grid"><input type="hidden" name="policyId" value={policy.id} />
      <label>Name<input name="name" defaultValue={policy.name} maxLength={100} required /></label>
      <label>Basis<select name="earningsModel" defaultValue={policy.earningsModel}><option value="HOURLY">Hourly</option><option value="DAILY">Daily, fixed for the shift</option></select></label>
      <label>Pay ({policy.currencyCode})<input name="rate" inputMode="decimal" defaultValue={major(policy.rateMinor)} required /></label>
      {/* F13: the commission-era sales bonus folds away; its fields are still sent, so saving keeps today's values. */}
      <details className="disclosure-inline form-span"><summary>Sales bonus (optional) · {policy.incentiveTargetMinor !== null && policy.incentiveBonusMinor !== null ? `${money(policy.incentiveBonusMinor, policy.currencyCode)} at ${money(policy.incentiveTargetMinor, policy.currencyCode)} in sales` : "none"}</summary><div className="form-grid">
        <label>Sales target (optional)<input name="incentiveTarget" inputMode="decimal" defaultValue={major(policy.incentiveTargetMinor)} /></label>
        <label>Bonus (optional)<input name="incentiveBonus" inputMode="decimal" defaultValue={major(policy.incentiveBonusMinor)} /></label></div></details>
      <p className="form-span note">Saves a new version from now. Shifts already created, offered or accepted keep {money(policy.rateMinor ?? 0, policy.currencyCode)} and their other terms. The minimum wage is checked again.</p>
      <button className="secondary-button">Save new version</button>
    </form><small>Current since {since(policy.effectiveFrom)}</small></details>;
}
