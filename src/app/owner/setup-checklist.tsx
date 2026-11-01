import Link from "next/link";
import type { OwnerSetupStep } from "@/server/product/owner-setup";

// A first-run guide built from what the business has actually set up. It shrinks as steps
// are completed and is gone once nothing is left to do.
export function OwnerSetupChecklist({ steps, welcome = false }: { steps: readonly OwnerSetupStep[]; welcome?: boolean }) {
  const left = steps.filter(step => !step.done);
  if (!left.length) return null;
  const next = left[0];
  return <section className="setup-checklist" aria-labelledby="setup-title">
    <div className="setup-head">
      <div><h2 id="setup-title">{welcome ? "Your workspace is ready. Here’s what makes FairShift work" : "Finish setting up FairShift"}</h2><p>{steps.length - left.length} of {steps.length} done. Your forecast and staffing gap appear as you go.</p></div>
      <Link className="primary-button button-link" href={next.href}>{next.action}</Link>
    </div>
    <ol>{steps.map(step => <li key={step.key} data-done={step.done || undefined}>
      <span className="setup-mark" aria-hidden="true">{step.done ? "✓" : ""}</span>
      <div><Link href={step.href}><strong>{step.title}</strong></Link>{step.done ? <span className="visually-hidden"> (done)</span> : <small>{step.detail}</small>}</div>
    </li>)}</ol>
  </section>;
}
