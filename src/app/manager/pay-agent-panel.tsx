import { StatusBadge } from "@/app/components/product-ui";
import { dateTime } from "@/app/components/workspace-ui";
import { rejectPayAgentHoldAction, releasePayAgentHoldAction, retryPayAgentAction } from "@/app/operations-actions";
import { managerPayAgentView, type PayAgentEventView } from "@/server/pay-agent/presentation";

// The FairShift Pay Agent's state for one payable (DEC-SA-011): its status, recommendation with
// reason and summary, the authoritative outcome or block reason, whether it was a dry run, and the
// model response ID. Forms post only an ID (and a rejection reason); the server reads the rest.
export function PayAgentPanel({ event, payableId, demo, timezone }: { event: PayAgentEventView; payableId: string; demo: boolean; timezone: string }) {
  const view = managerPayAgentView(event);
  const tone = event.status === "DECIDED_HOLD" || event.status === "SETTLEMENT_BLOCKED" || event.status === "FAILED_TERMINAL" || event.status === "REJECTED_OUTPUT" ? "warning" : event.status === "HOLD_REJECTED" ? "danger" : "neutral";
  return <section className="pay-agent" aria-label="Pay Agent">
    <p><strong>Pay Agent</strong> <StatusBadge tone={tone}>{view.status}</StatusBadge></p>
    <dl className="shift-terms">
      {view.decision ? <div><dt>Recommendation</dt><dd>{view.decision}{view.reason ? ` · ${view.reason}` : ""}</dd></div> : null}
      {view.summary ? <div><dt>Model summary</dt><dd>{view.summary}</dd></div> : null}
      {view.explanation ? <div><dt>{view.dryRun ? "Dry-run outcome" : "Outcome"}</dt><dd>{view.explanation}</dd></div> : null}
      {event.resolution ? <div><dt>Manager decision</dt><dd>{event.resolution === "RELEASED" ? "Released for payment checks" : "Rejected"}{event.resolvedAt ? ` · ${dateTime(event.resolvedAt, timezone)}` : ""}{event.resolutionNote ? ` · ${event.resolutionNote}` : ""}</dd></div> : null}
      {view.responseId ? <div><dt>Model response</dt><dd><code>{view.responseId}</code>{view.model ? ` · ${view.model}` : ""}</dd></div> : null}
    </dl>
    {demo ? null : <div className="pay-card-action">
      {view.canResolve ? <>
        <form action={releasePayAgentHoldAction}><input name="eventId" type="hidden" value={event.id} /><button className="primary-button">Release for payment checks</button></form>
        <form action={rejectPayAgentHoldAction} className="workspace-form"><input name="eventId" type="hidden" value={event.id} />
          <label>Reason for rejecting<input name="reason" maxLength={500} required /></label><button className="secondary-button">Reject payment</button></form>
      </> : null}
      {view.canRetry ? <form action={retryPayAgentAction}><input name="payableId" type="hidden" value={payableId} /><button className="secondary-button">Retry agent checks</button></form> : null}
    </div>}
  </section>;
}
