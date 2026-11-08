import Link from "next/link";
import { StatusBadge } from "@/app/components/product-ui";
import { AiFoundLabel } from "@/app/components/source-labels";
import { dateSpan } from "@/app/manager/local-intelligence";
import type { LocalSignalView } from "@/server/intelligence/local-intelligence-service";
import { formatClock } from "@/server/intelligence/workload";

// Owner alerts from high-severity capacity signals: something AI found, with its source, that could
// stop a location trading. Read-only here; what to do about shifts is the Owner's call.
export type DisruptionAlert = { outletId: string; outletName: string; timezone: string; signal: LocalSignalView };

export function DisruptionAlerts({ alerts }: { alerts: readonly DisruptionAlert[] }) {
  if (!alerts.length) return null;
  return <section className="panel disruption-alerts" id="disruption-alerts" aria-labelledby="disruption-alerts-title" role="status">
    <h2 id="disruption-alerts-title">Disruption alerts</h2>
    <p className="panel-lede">AI found something that could stop a location trading. Each alert has the source it was found in. Check it, and decide what to tell your team.</p>
    <ul className="context-signals">{alerts.map(({ outletId, outletName, signal }) => <li key={`${outletId}-${signal.key}`} className="context-signal">
      <p><strong>{outletName}: {signal.name}</strong> <StatusBadge tone="danger">{signal.closureLikely ? "Closure likely" : "High severity"}</StatusBadge></p>
      <p><AiFoundLabel url={signal.sourceUrl} title={signal.sourceTitle} /></p>
      <p>{signal.reasoning}</p>
      <p className="note">{dateSpan(signal.validFrom, signal.validTo)}{signal.startMinute !== null && signal.endMinute !== null ? ` · ${formatClock(signal.startMinute)}–${formatClock(signal.endMinute)}` : ""} · {signal.categoryLabel} · {signal.confidence.toLowerCase()} confidence · <Link className="text-link" href={`/owner/locations/${outletId}`}>Open {outletName}</Link></p>
    </li>)}</ul>
  </section>;
}
