import { exitDemoAction, resetDemoAction, switchDemoPersonaAction } from "@/app/demo/actions";
import { DEMO_PERSONAS, type DemoPersona } from "@/server/demo/config";
import "./demo.css";

const LABEL: Record<DemoPersona, string> = { OWNER: "Owner", MANAGER: "Manager", WORKER: "Worker" };

// Everything the public demo adds to the product: who you are viewing as, reset and exit.
export function DemoBar({ persona }: { persona: DemoPersona }) {
  return <aside className="demo-bar" aria-label="Demo">
    <div className="demo-bar-row">
      <strong>Demo</strong>
      <div className="demo-personas" role="group" aria-label="View the demo as">
        {DEMO_PERSONAS.map(option => <form action={switchDemoPersonaAction} key={option}><input type="hidden" name="persona" value={option} /><button aria-current={option === persona ? "true" : undefined}>{LABEL[option]}</button></form>)}
      </div>
      <details className="demo-reset"><summary>Reset demo</summary>
        <div>
          <p>This restores the prepared demonstration state for everyone using the demo. New shifts and offers are removed. The earlier completed shift isn’t changed.</p>
          <form action={resetDemoAction}><button>Reset demo</button></form>
        </div>
      </details>
      <form action={exitDemoAction}><button className="demo-exit">Exit</button></form>
    </div>
    <p>A prepared business shared with other visitors. No real money moves. <span className="demo-bar-more">It includes an earlier completed shift so you can explore the full performance and payout journey.</span></p>
  </aside>;
}

// Marks a record from before this visit, so it can't be mistaken for a shift accepted just now.
export function EarlierEvidenceLabel() {
  return <p className="demo-evidence"><strong>Earlier completed shift.</strong> Prepared demonstration evidence, not something that happened in this visit. It can’t be changed.</p>;
}
