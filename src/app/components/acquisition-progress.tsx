// The design's six setup steps (SignUp, Setup, 10 Nov 2026): Account, Plan, Venue, Sales history, Pay
// terms, Team. Earlier steps show as done.
const STEPS = ["Account", "Plan", "Venue", "Sales history", "Pay terms", "Team"] as const;
export type SetupStepName = typeof STEPS[number];
const LEGACY: Record<string, SetupStepName> = { Verify: "Account", Workplace: "Venue" };

export function AcquisitionProgress({ current }: { current: SetupStepName | "Verify" | "Workplace" }) {
  const name = LEGACY[current] ?? current as SetupStepName;
  const active = STEPS.indexOf(name);
  return <ol className="acquisition-progress" aria-label={`Step ${active + 1} of 6`}>
    {STEPS.map((step, index) => <li key={step} aria-current={index === active ? "step" : undefined} className={index < active ? "complete" : undefined}>
      <span className="step-number" aria-hidden="true">{index < active ? "✓" : index + 1}</span>{step}
      {index < active ? <span className="visually-hidden"> completed</span> : null}
    </li>)}
  </ol>;
}
