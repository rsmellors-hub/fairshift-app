export function AcquisitionProgress({current}: {current: "Plan" | "Workplace"}) {
  const steps = ["Account", "Plan", "Workplace", "Ready"];
  const active = steps.indexOf(current);
  return <ol className="acquisition-progress" aria-label="Setup progress">
    {steps.map((step, index) => <li key={step} aria-current={index === active ? "step" : undefined} className={index < active ? "complete" : undefined}>
      <span className="step-number" aria-hidden="true">{index < active ? "✓" : index + 1}</span>{step}
      {index < active ? <span className="visually-hidden"> completed</span> : null}
    </li>)}
  </ol>;
}
