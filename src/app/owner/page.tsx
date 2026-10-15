import Link from "next/link";

import { PageHeader, StatePanel, StatusBadge } from "@/app/components/product-ui";

export default function OwnerPage() {
  return (
    <div className="product-page">
      <PageHeader
        eyebrow="Company overview"
        title="Business operations, in one place"
        description="The owner workspace will connect location performance, next-week demand and staffing decisions. Multi-location intelligence is the next implementation stage."
      />
      <section className="overview-strip" aria-label="Integration readiness">
        <div><span>Worker payments</span><StatusBadge tone="success">PayPal Sandbox connected</StatusBadge></div>
        <div><span>Sales connection</span><StatusBadge tone="warning">Zettle needs verification</StatusBadge></div>
        <div><span>Portfolio view</span><StatusBadge>Not yet available</StatusBadge></div>
      </section>
      <StatePanel title="Owner intelligence is being prepared">
        <p>No multi-location figures are shown yet. The current verified workflow operates with one demo outlet and clearly labelled seeded sales history.</p>
        <Link className="text-link" href="/manager">Open the current manager workflow →</Link>
      </StatePanel>
      <section className="panel owner-roadmap" aria-labelledby="owner-capabilities">
        <div>
          <span className="eyebrow">Designed for the next stage</span>
          <h2 id="owner-capabilities">From commercial activity to staffing impact</h2>
        </div>
        <ul>
          <li>Compare factual demand across locations.</li>
          <li>Review next-week forecast and staffing implications.</li>
          <li>Understand recommended versus scheduled labour when those measures are implemented.</li>
        </ul>
      </section>
    </div>
  );
}
