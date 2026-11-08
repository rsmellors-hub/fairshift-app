import { addPermanentStaffAction, decideTipHoldAction, importTipsAction, refreshTipPayoutAction, retryTipCheckAction, saveBlockRosterAction, saveShiftBlocksAction, saveTipSettingsAction, setPermanentStaffStatusAction } from "@/app/tip-actions";
import { money } from "@/app/components/workspace-ui";
import { StatementLinkButton } from "@/app/owner/statement-link-button";
import type { OwnerTipView } from "@/server/tips/view";
import { formatMinute } from "@/server/tips/policy";
import { DataLabel } from "@/app/components/product-ui";

// The Owner's tip workspace for one location (FS-TIP-DEC-002, FS-TIP-AGENT-DEC-001): standing
// policy, blocks, roster and cap; permanent staff; imported POS evidence; allocations per block;
// the Pay Agent's decision; holds with their permanent decision history; release and Sandbox status.
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DISPOSITION: Record<string, string> = { POOL: "Pooled", DIRECT: "Direct to staff", CASUAL_SHIFT_PAY: "Casual shift pay (recorded, not paid by FairShift yet)", UNATTRIBUTED: "Unattributed: unallocated", OUTSIDE_BLOCKS: "Outside every block: unallocated" };
const EVENT_STATUS: Record<string, string> = { PENDING: "Waiting for the Pay Agent", CLAIMED: "Pay Agent checking", SKIPPED: "Nothing to release", BLOCKED: "Blocked", REJECTED_OUTPUT: "Answer rejected", FAILED_RETRYABLE: "Will retry", FAILED_TERMINAL: "Stopped", DECIDED_RELEASE: "Release recommended", DECIDED_HOLD: "Held for the Owner", HOLD_RELEASED: "Released by the Owner", SETTLING: "Running payment checks", SETTLED: "Payment checks done" };
const LINE_STATUS = (line: OwnerTipView["allocations"][number]["lines"][number]) => {
  if (line.payout?.status === "PAID") return "Paid (PayPal item SUCCESS) · released via FairShift";
  if (line.payout) return `Released via FairShift · PayPal ${line.payout.status.toLowerCase().replaceAll("_", " ")}`;
  if (line.gateOutcome === "DRY_RUN_ELIGIBLE") return "Dry run: every check passed, nothing sent";
  if (line.gateOutcome === "HELD") return "Held";
  if (line.gateOutcome?.startsWith("BLOCKED:")) return `Blocked: ${line.gateOutcome.slice(8)}`;
  return "Recorded";
};

export function OwnerTips({ view, locationName, devLinks, demoData = false }: { view: OwnerTipView; locationName: string; devLinks: boolean; demoData?: boolean }) {
  const { settings, blocks, staff } = view;
  return <>
    <section className="panel" id="tip-settings">
      <h2>Tip policy at {locationName}</h2>
      <p className="panel-lede">Set before tips are imported; each import keeps the policy it was imported under. FairShift calculates every amount; the Pay Agent checks the evidence and can only release or hold; nobody edits amounts or recipients.</p>
      <form action={saveTipSettingsAction} className="inline-form">
        <label>Policy<select name="policy" defaultValue={settings?.policy ?? "DIRECT"}><option value="DIRECT">Direct: each tip to the staff member on the POS row</option><option value="SHIFT_POOL">Shift pool: equal shares per shift block</option></select></label>
        <label>Auto-release cap per staff member per day (R)<input name="cap" inputMode="decimal" required defaultValue={settings ? (settings.autoReleaseCapMinor / 100).toFixed(2) : ""} /></label>
        <button className="secondary-button">Save tip policy</button>
      </form>
      {settings ? <p className="note">Current: {settings.policy === "SHIFT_POOL" ? "shift pool" : "direct"}, cap {money(settings.autoReleaseCapMinor, settings.currencyCode)} per staff member per day.</p> : <p className="note">No tip policy yet, so tips can&apos;t be imported here.</p>}
      {settings?.policy === "SHIFT_POOL" ? <form action={saveShiftBlocksAction} className="inline-form">
        <label>Shift blocks (local time)<input name="blocks" required defaultValue={blocks.map(block => `${block.name} ${formatMinute(block.startMinute)}-${formatMinute(block.endMinute)}`).join(", ")} placeholder="Morning 07:00-12:00, Afternoon 12:00-17:00, Evening 17:00-23:00" /></label>
        <button className="secondary-button">Save blocks</button>
      </form> : null}
    </section>

    <section className="panel" id="permanent-staff">
      <h2>Permanent staff</h2>
      {demoData ? <p><DataLabel kind="demo">Fictional demo staff</DataLabel> These people and their records are fictional, made for the demonstration.</p> : null}
      <p className="panel-lede">Lightweight records: no FairShift login and no shift offers. FairShift keeps only name, contact email, PayPal destination, status and block roster. POS reference is the code on their till rows.</p>
      {staff.length ? <div className="table-frame"><table className="data-table"><caption className="visually-hidden">Permanent staff</caption>
        <thead><tr><th scope="col">Name</th><th scope="col">POS reference</th><th scope="col">PayPal</th><th scope="col">Status</th>{settings?.policy === "SHIFT_POOL" ? <th scope="col">Block roster</th> : null}<th scope="col">Statement</th></tr></thead>
        <tbody>{staff.map(person => <tr key={person.id}>
          <th scope="row">{person.name}<br /><small>{person.email}</small></th>
          <td data-label="POS reference"><code>{person.code}</code></td>
          <td data-label="PayPal">{person.destinationState === "CONFIRMED" ? "Confirmed by staff" : person.destinationState === "CHANGED" ? `Changed by staff ${person.destinationChangedAt?.toISOString().slice(0, 16).replace("T", " ")} UTC` : "Awaiting staff confirmation"}</td>
          <td data-label="Status"><form action={setPermanentStaffStatusAction}><input type="hidden" name="workerId" value={person.id} /><input type="hidden" name="status" value={person.status === "ACTIVE" ? "INACTIVE" : "ACTIVE"} />{person.status === "ACTIVE" ? "Active" : "Inactive"} <button className="text-button">{person.status === "ACTIVE" ? "Deactivate" : "Reactivate"}</button></form></td>
          {settings?.policy === "SHIFT_POOL" ? <td data-label="Block roster"><form action={saveBlockRosterAction} className="roster-grid"><input type="hidden" name="workerId" value={person.id} />
            {blocks.map(block => <div key={block.id}><span>{block.name}</span>{WEEKDAYS.map((day, index) => <label key={day}><input type="checkbox" name="slot" value={`${index + 1}:${block.id}`} defaultChecked={person.roster.some(entry => entry.blockId === block.id && entry.isoWeekday === index + 1)} />{day}</label>)}</div>)}
            <button className="text-button">Save roster</button></form></td> : null}
          <td data-label="Statement">{devLinks ? <StatementLinkButton workerId={person.id} /> : <small>Delivery not connected</small>}</td>
        </tr>)}</tbody></table></div> : <p>No permanent staff recorded at this location.</p>}
      <form action={addPermanentStaffAction} className="inline-form">
        <label>First name<input name="firstName" required /></label><label>Surname<input name="surname" required /></label>
        <label>Contact email<input name="email" type="email" required /></label><label>PayPal email<input name="paypalEmail" type="email" required /></label>
        <button className="secondary-button">Add permanent staff</button>
      </form>
    </section>

    <section className="panel" id="tip-import">
      <h2>Import tips</h2>
      {demoData ? <p><DataLabel kind="demo">Synthetic demo POS export</DataLabel> The tips here come from a synthetic CSV made for the demonstration, not from any till.</p> : null}
      <p className="panel-lede">Imported POS evidence: a CSV export with the header <code>source,location,row_ref,transaction_at,staff_ref,bill_amount,tip_amount,currency</code>. The whole file is checked before anything is stored; a file or row already imported is not counted twice. Imported rows are not live Square or South African POS data.</p>
      <form action={importTipsAction} className="stack-form">
        <label>CSV file<input type="file" name="file" accept=".csv,text/csv" /></label>
        <label>…or paste the CSV<textarea name="csv" rows={4} /></label>
        <button className="secondary-button" disabled={!settings}>Import tips</button>
      </form>
      {view.imports.map(row => <div className="record-row" key={row.id}>
        <span>Imported POS evidence{demoData ? " · Synthetic demo POS export" : ""} · {row.importedAt.toISOString().slice(0, 16).replace("T", " ")} UTC · {row.rowCount} rows ({row.duplicateRowsSkipped} already recorded) · {money(row.totalTipMinor, row.currencyCode)} · policy {row.policy === "SHIFT_POOL" ? "shift pool" : "direct"}</span>
        {row.unallocated.length ? <ul>{row.unallocated.map(evidence => <li key={evidence.id}>{evidence.rowRef} · {evidence.transactionAt.toISOString().slice(0, 16).replace("T", " ")} UTC · {money(evidence.tipMinor, evidence.currencyCode)} · {DISPOSITION[evidence.disposition]}{evidence.staffName ? ` · ${evidence.staffName}` : ""}</li>)}</ul> : null}
      </div>)}
    </section>

    <section className="panel" id="tip-allocations">
      <h2>Allocations</h2>
      {view.allocations.length ? view.allocations.map(allocation => <article className="tip-allocation" key={allocation.id} id={`allocation-${allocation.id}`}>
        <h3>{allocation.localDate} · {allocation.blockName ? `${allocation.blockName} ${formatMinute(allocation.blockStartMinute!)}–${formatMinute(allocation.blockEndMinute!)}` : "Whole day (direct)"}</h3>
        <p>Total {money(allocation.totalTipMinor, allocation.currencyCode)} · allocated {money(allocation.allocatedMinor, allocation.currencyCode)} · unallocated {money(allocation.unallocatedMinor, allocation.currencyCode)}</p>
        <div className="table-frame"><table className="data-table"><caption className="visually-hidden">Shares</caption><thead><tr><th scope="col">Staff</th><th scope="col">Basis</th><th scope="col">Share</th><th scope="col">Release</th></tr></thead>
          <tbody>{allocation.lines.map(line => <tr key={line.id}><th scope="row">{line.name}{line.workerType === "CASUAL" ? " (casual)" : ""}</th><td data-label="Basis">{line.membership === "ROSTER" ? "Block roster" : line.membership === "CONFIRMED_SHIFT" ? "Confirmed shift" : "POS row"}</td>
            <td data-label="Share">{money(line.shareMinor, line.currencyCode)}</td>
            <td data-label="Release">{LINE_STATUS(line)}{line.payout ? <><br /><small>Sandbox batch {line.payout.paypalBatchId ?? "not yet returned"} · item {line.payout.paypalItemId ?? "not yet returned"} · {money(line.payout.providerAmountMinor, line.payout.providerCurrency)}{line.payout.fxRateMicros ? ` at ${(line.payout.fxRateMicros / 1e6).toFixed(4)} (${line.payout.fxRateSource})` : ""}</small>
              <form action={refreshTipPayoutAction}><input type="hidden" name="lineId" value={line.id} /><button className="text-button">Refresh PayPal status</button></form></> : null}</td></tr>)}</tbody></table></div>
        <details><summary>{allocation.rows.length} evidence rows</summary><ul>{allocation.rows.map(row => <li key={row.id}>{row.rowRef} · {row.transactionAt.toISOString().slice(0, 16).replace("T", " ")} UTC · bill {money(row.billMinor, row.currencyCode)} · tip {money(row.tipMinor, row.currencyCode)} · {row.staffName ?? (row.staffRef ? `unknown reference ${row.staffRef}` : "no staff reference")} · {DISPOSITION[row.disposition]}</li>)}</ul></details>
        {allocation.event ? <p className="note">Pay Agent: {EVENT_STATUS[allocation.event.status] ?? allocation.event.status}{allocation.event.decision ? ` · decision ${allocation.event.decision === "RELEASE" ? "release" : "hold"}` : ""}{allocation.event.reasonCode ? ` · ${allocation.event.reasonCode}` : ""}{allocation.event.summary ? ` · “${allocation.event.summary}”` : ""}{allocation.event.outcomeCode ? ` · ${allocation.event.outcomeCode}` : ""}{allocation.event.dryRun ? " · dry run" : ""}{allocation.event.responseId ? <><br /><small>Decision {allocation.event.id} · response {allocation.event.responseId}</small></> : null}</p> : null}
        {allocation.event && ["FAILED_RETRYABLE", "FAILED_TERMINAL", "REJECTED_OUTPUT", "SETTLED"].includes(allocation.event.status) ? <form action={retryTipCheckAction}><input type="hidden" name="eventId" value={allocation.event.id} /><button className="text-button">Run the tip check again</button></form> : null}
        {allocation.holds.map(hold => {
          const released = hold.decisions.some(decision => decision.decision === "RELEASED");
          return <div className="hold-record" key={hold.id}>
            <p><strong>{released ? "Hold released" : "On hold"}</strong> · {hold.source === "MODEL" ? "Pay Agent" : "FairShift rule"} · {hold.reasonCode} · {hold.summary}{hold.lineId ? ` · ${allocation.lines.find(line => line.id === hold.lineId)?.name ?? ""}` : " · whole allocation"} · {hold.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC</p>
            {hold.decisions.length ? <ul>{hold.decisions.map(decision => <li key={decision.id}>{decision.decision === "RELEASED" ? "Released as calculated" : "Kept held"} by {decision.decidedByName || "the Owner"} · {decision.decidedAt.toISOString().slice(0, 16).replace("T", " ")} UTC · “{decision.reason}”</li>)}</ul> : null}
            {released ? null : <form action={decideTipHoldAction} className="inline-form"><input type="hidden" name="holdId" value={hold.id} />
              <label>Reason (required)<input name="reason" required maxLength={500} /></label>
              <button className="secondary-button" name="decision" value="RELEASED">Release as calculated</button>
              <button className="text-button" name="decision" value="KEPT_HELD">Keep held</button></form>}
          </div>;
        })}
      </article>) : <p>No tips imported yet.</p>}
    </section>
  </>;
}
