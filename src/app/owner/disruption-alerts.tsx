import Link from "next/link";
import { DataLabel, StatusBadge } from "@/app/components/product-ui";
import { AiFoundLabel, DemoScenarioLabel, stamp } from "@/app/components/source-labels";
import { sendEarlyNoticeAction } from "@/app/local-intelligence-actions";
import { dateSpan } from "@/app/manager/local-intelligence";
import type { AffectedShift } from "@/server/intelligence/early-notice";
import type { LocalSignalView } from "@/server/intelligence/local-intelligence-service";
import { formatClock } from "@/server/intelligence/workload";

// Owner alerts from high-severity capacity signals: something AI found, with its source, that could
// stop a location trading. When closure is likely, FairShift recommends an early notice to the casual
// workers whose allocated shifts it covers, so a short-notice cancellation is avoided. Only the Owner
// sends it, after checking the source; in the public demo, the Owner persona may send only the DEMO
// scenario's notice. It cancels nothing and changes no pay.
export type DisruptionAlert = { outletId: string; outletName: string; timezone: string; signal: LocalSignalView; affected?: AffectedShift[] };

// Public demo visitors are simulated (Owner decision, 9 November 2026): they see who would be told, and
// that sending is simulated; the server refuses a demo send too. Signed-in accounts send it for real.
function EarlyNotice({ alert, canSend, demoVisitor }: { alert: DisruptionAlert; canSend: boolean; demoVisitor: boolean }) {
  const allowed = canSend && !demoVisitor;
  if (!alert.affected) return <p className="note">Closure is likely: the Overview shows which casual workers it affects, so you can tell them early.</p>;
  const affected = alert.affected;
  if (!affected.length) return <p className="note">No allocated casual shift falls in this time, so no early notice is needed.</p>;
  const pending = affected.filter(row => !row.noticeAt);
  const when = (row: AffectedShift) => `${new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: alert.timezone }).format(row.startsAt)} ${new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: alert.timezone }).format(row.startsAt)}–${new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: alert.timezone }).format(row.endsAt)}`;
  return <div className="early-notice">
    <p><strong>Recommended:</strong> tell the {affected.length === 1 ? "casual worker" : `${affected.length} casual workers`} whose shifts this covers now, so a short-notice cancellation is avoided. The notice cancels nothing and changes no pay or terms.</p>
    <ul>{affected.map(row => <li key={row.offerId}>{row.workerName} · {when(row)}{row.noticeAt ? ` · early notice sent ${stamp(row.noticeAt, alert.timezone)}` : ""}</li>)}</ul>
    {!pending.length ? <p className="note">Everyone this affects has had the early notice.</p>
      : !allowed ? <p className="note"><DataLabel kind="demo">Simulated in the public demo</DataLabel> No notice is sent from here. Signed-in Owner accounts send it to the workers above, in FairShift.</p>
      : <form action={sendEarlyNoticeAction} className="workspace-form"><input type="hidden" name="outletId" value={alert.outletId} /><input type="hidden" name="signalKey" value={alert.signal.key} />
        <label className="acceptance-check"><input type="checkbox" name="confirmed" value="yes" required /> {alert.signal.demo ? "I understand this is a DEMO scenario and want to give this early notice." : "I’ve checked the source and want to give this early notice."}</label>
        <button className="primary-button">Send early notice to {pending.length === 1 ? "1 casual worker" : `${pending.length} casual workers`}</button></form>}
  </div>;
}

// A DEMO scenario's stored name already says "DEMO scenario: … (synthetic)"; the label below says it once.
const demoTitle = (name: string) => { const plain = name.replace(/^DEMO scenario:\s*/i, "").replace(/\s*\(synthetic\)\s*$/i, ""); return plain.charAt(0).toUpperCase() + plain.slice(1); };

export function DisruptionAlerts({ alerts, canSend = false, demoVisitor = false }: { alerts: readonly DisruptionAlert[]; canSend?: boolean; demoVisitor?: boolean }) {
  if (!alerts.length) return null;
  return <section className="panel disruption-alerts" id="disruption-alerts" aria-labelledby="disruption-alerts-title" role="status">
    <h2 id="disruption-alerts-title">Disruption alerts</h2>
    <p className="panel-lede">{alerts.every(alert => alert.signal.demo) ? "How FairShift alerts you when something could stop a location trading." : "AI found something that could stop a location trading. Each alert has the source it was found in. Check it, and decide what to tell your team."}</p>
    <ul className="context-signals">{alerts.map(({ outletId, outletName, signal }) => <li key={`${outletId}-${signal.key}`} className="context-signal">
      <p><strong>{outletName}: {signal.demo ? demoTitle(signal.name) : signal.name}</strong> <StatusBadge tone="danger">{signal.closureLikely ? "Closure likely" : "High severity"}</StatusBadge></p>
      <p>{signal.demo ? <DemoScenarioLabel /> : <AiFoundLabel url={signal.sourceUrl} title={signal.sourceTitle} />}</p>
      {signal.demo ? null : <p>{signal.reasoning}</p>}
      <p className="note">{dateSpan(signal.validFrom, signal.validTo)}{signal.startMinute !== null && signal.endMinute !== null ? ` · ${formatClock(signal.startMinute)}–${formatClock(signal.endMinute)}` : ""} · {signal.categoryLabel}{signal.demo ? "" : ` · ${signal.confidence.toLowerCase()} confidence`} · <Link className="text-link" href={`/owner/locations/${outletId}`}>Open {outletName}</Link></p>
      {signal.closureLikely ? <EarlyNotice alert={alerts.find(row => row.outletId === outletId && row.signal.key === signal.key)!} canSend={canSend} demoVisitor={demoVisitor} /> : null}
    </li>)}</ul>
  </section>;
}
