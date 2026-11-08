import { randomUUID } from "node:crypto";
import type { Scope } from "@/server/auth/access";
import { StatePanel, StatusBadge } from "@/app/components/product-ui";
import { prepareDemoShiftAction, mapSquareTeamMemberAction, recordSquareSandboxSaleAction, removeSquareMappingAction } from "@/app/square-actions";
import { liveSquareConnection } from "@/server/commerce/square-connection";
import { demoToolsAllowed, MAX_DEMO_SALE_MINOR } from "@/server/commerce/square-demo";
import { getSquareMappings, listSquareTeamMembers } from "@/server/commerce/square-mapping";
import { getDatabase } from "@/server/db/client";
import { createSquareClient, type SquareTeamMember } from "@/server/integrations/square/client";
import { money } from "@/app/components/workspace-ui";

// Only for a location with a Square connection. Team members are listed live from Square and
// their names are not stored.
export async function SquarePanel({ scope, team }: { scope: Scope; team: readonly { id: string; displayName: string }[] }) {
  let connection;
  try { connection = await liveSquareConnection(getDatabase(), scope); } catch { return null; }
  if (!connection) return null;
  const mappings = await getSquareMappings(getDatabase(), scope);
  let members: SquareTeamMember[] | null;
  try { members = await listSquareTeamMembers(getDatabase(), scope, createSquareClient()); } catch { members = null; }
  const nameOf = (id: string) => members?.find(member => member.id === id)?.name ?? `Team member …${id.slice(-6)}`;
  const available = members?.filter(member => !mappings.some(row => row.teamMemberId === member.id)) ?? [];
  const unmapped = team.filter(worker => !mappings.some(row => row.workerId === worker.id));
  const demo = demoToolsAllowed(connection.providerEnvironment);
  return <>
    <section className="panel" id="square-identities" aria-labelledby="square-identities-title"><h2 id="square-identities-title">Square team members</h2>
      <p>Map a FairShift worker to a Square team-member identity. Square Sandbox payments carrying that identity can then count toward the worker’s sales during their accepted shift at this location. The Square Sandbox seller is a UK (GBP) test seller, not this business’s own till.</p>
      <p className="note">This maps an identity only. It doesn’t show who was logged in to a till or who physically made a sale.</p>
      {mappings.length ? <div className="table-scroll"><table><thead><tr><th>FairShift worker</th><th>Square team member</th><th><span className="visually-hidden">Action</span></th></tr></thead><tbody>{mappings.map(row => <tr key={row.id}><td>{row.workerName}</td><td>{nameOf(row.teamMemberId)}</td><td><form action={removeSquareMappingAction}><input type="hidden" name="mappingId" value={row.id} /><button className="secondary-button">Remove</button></form></td></tr>)}</tbody></table></div> : <p>No workers are mapped yet.</p>}
      {members === null ? <p role="alert">Square’s team list could not be loaded, so no new mapping can be made right now.</p> : unmapped.length && available.length ? <form action={mapSquareTeamMemberAction} className="workspace-form">
        <label>FairShift worker<select name="workerId" required>{unmapped.map(worker => <option key={worker.id} value={worker.id}>{worker.displayName}</option>)}</select></label>
        <label>Square team member<select name="teamMemberId" required>{available.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
        <button className="primary-button">Map to Square team member</button>
      </form> : <p className="note">Nothing left to map: every worker or every Square team member at this location already has a mapping.</p>}
    </section>
    {demo ? <section className="panel" id="square-demo" aria-labelledby="square-demo-title"><h2 id="square-demo-title">Sandbox demo tools</h2>
      <p><StatusBadge tone="warning">Square Sandbox · test money</StatusBadge></p>
      <p className="note">For demonstrations only. This asks Square to create a Sandbox payment. It is not a till, and FairShift counts the payment only after reading it back from Square.</p>
      {mappings.length ? <>
        <form action={prepareDemoShiftAction} className="workspace-form"><h3>Create a demo shift</h3>
          <p>Offers a short shift that is under way now: £96.00 fixed base, £25.00 bonus at £200.00 sales. The worker accepts it and you finalise it as usual.</p>
          <label>Worker<select name="workerId" required>{mappings.map(row => <option key={row.workerId} value={row.workerId}>{row.workerName}</option>)}</select></label>
          <label>Ends in (minutes)<input name="minutesUntilEnd" type="number" min={2} max={240} defaultValue={15} required /></label>
          <button className="secondary-button">Offer demo shift</button>
        </form>
        <form action={recordSquareSandboxSaleAction} className="workspace-form"><h3>Record Square Sandbox sale</h3>
          <input type="hidden" name="requestId" value={randomUUID()} />
          <label>Worker<select name="workerId" required>{mappings.map(row => <option key={row.workerId} value={row.workerId}>{row.workerName}</option>)}</select></label>
          <label>Amount (GBP)<input name="amount" inputMode="decimal" pattern="\d+\.\d{2}" placeholder="12.50" required /></label>
          <p className="note">Up to {money(MAX_DEMO_SALE_MINOR, "GBP")}.</p>
          <button className="primary-button">Record Square Sandbox sale</button>
        </form>
      </> : <StatePanel title="Map a worker first"><p>Sandbox sales are recorded against a mapped Square team member.</p></StatePanel>}
    </section> : null}
  </>;
}
