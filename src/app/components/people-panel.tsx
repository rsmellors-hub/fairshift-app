import { StatusBadge } from "@/app/components/product-ui";
import { resendInvitationAction, revokeInvitationAction } from "@/app/auth-actions";
import { addPersonAction, deactivatePersonAction, updatePersonAction } from "@/app/people-actions";
import { PERSON_STATUS_LABEL, type Person, type PersonStatus } from "@/server/people/people";

// People (Day 6, Owner decision 10 Nov 2026). Adding someone invites them: they're "Invited — not yet
// signed up" until they complete sign-up themselves. The Owner manages everyone; a Manager manages the
// casual workers at their own location. Nothing is deleted: deactivation is recorded.

const TONE: Record<PersonStatus, "success" | "warning" | "neutral" | "danger"> = { ACTIVE: "success", INVITED: "warning", INVITE_EXPIRED: "danger", INVITE_REVOKED: "neutral", DEACTIVATED: "neutral" };
const ROLE = { MANAGER: "Manager", TEAM_MEMBER: "Casual worker", REGULAR: "Regular staff record" } as const;
const day = (date: Date, timezone: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: timezone }).format(date);

export function PeoplePanel({ people, locations, owner, currentLocationId, timezone, disabled }: {
  people: Person[]; locations: { id: string; name: string }[]; owner: boolean; currentLocationId: string; timezone: string; disabled?: boolean;
}) {
  const managers = people.filter(person => person.role === "MANAGER"), casual = people.filter(person => person.role === "TEAM_MEMBER"), regular = people.filter(person => person.role === "REGULAR");
  const row = (person: Person) => {
    const [first = "", ...rest] = person.name.split(" ");
    const editable = person.role !== "REGULAR" && person.status !== "DEACTIVATED" && person.status !== "INVITE_REVOKED";
    const canDeactivate = (person.role === "TEAM_MEMBER" && person.status !== "DEACTIVATED" && person.status !== "INVITE_REVOKED" && !!person.workerId) || (person.role === "MANAGER" && person.status === "ACTIVE" && owner);
    const invitationOpen = !!person.invitationId && (person.status === "INVITED" || person.status === "INVITE_EXPIRED");
    return <tr key={person.key}>
      <th scope="row">{person.name}<small>{person.email ?? ""}{person.telephone ? ` · ${person.telephone}` : ""}</small></th>
      <td data-label="Role">{ROLE[person.role]}</td>
      <td data-label="Location">{person.locations.map(place => place.name).join(", ") || "Not assigned"}</td>
      <td data-label="Status"><StatusBadge tone={TONE[person.status]}>{PERSON_STATUS_LABEL[person.status]}</StatusBadge>{invitationOpen && person.invitationExpiresAt ? <small>{person.status === "INVITE_EXPIRED" ? "Expired" : "Link expires"} {day(person.invitationExpiresAt, timezone)}</small> : null}</td>
      <td data-label="Manage">{disabled ? null : <details className="disclosure-inline"><summary>Manage</summary>
        {editable ? <form action={updatePersonAction} className="workspace-form form-grid"><input type="hidden" name="key" value={person.key} />
          <label>First name<input name="firstName" defaultValue={first} maxLength={100} required /></label>
          <label>Surname<input name="surname" defaultValue={rest.join(" ")} maxLength={100} required /></label>
          <label>Phone (optional)<input name="telephone" type="tel" defaultValue={person.telephone ?? ""} maxLength={30} /></label>
          {person.status !== "ACTIVE" ? <label>Email<input name="email" type="email" defaultValue={person.email ?? ""} maxLength={254} required /><small>Resend the invite after changing it.</small></label> : <p className="note">Their email is how they sign in, so only they can change it.</p>}
          <button className="secondary-button">Save details</button></form> : null}
        {invitationOpen ? <div className="button-row">
          <form action={resendInvitationAction}><input type="hidden" name="invitationId" value={person.invitationId!} /><button className="secondary-button">{person.status === "INVITE_EXPIRED" ? "Send a new invite" : "Resend invite"}</button></form>
          <form action={revokeInvitationAction}><input type="hidden" name="invitationId" value={person.invitationId!} /><button className="secondary-button">Revoke invite</button></form></div> : null}
        {canDeactivate && !invitationOpen ? <form action={deactivatePersonAction} className="workspace-form"><input type="hidden" name="key" value={person.key} />
          <label className="acceptance-check"><input type="checkbox" name="confirm" value="yes" required /> Deactivate {person.name}. {person.role === "MANAGER" ? "They lose access to this business’s locations." : "They won’t be offered work; open offers are withdrawn."} Their records are kept.</label>
          <button className="secondary-button">Deactivate</button></form> : null}
      </details>}</td>
    </tr>;
  };
  const table = (title: string, rows: Person[], empty: string) => <><h3>{title} · {rows.filter(person => person.status === "ACTIVE").length} active</h3>
    {rows.length ? <div className="table-frame"><table className="data-table"><caption className="visually-hidden">{title}</caption><thead><tr><th scope="col">Name</th><th scope="col">Role</th><th scope="col">Location</th><th scope="col">Status</th><th scope="col">Manage</th></tr></thead><tbody>{rows.map(row)}</tbody></table></div> : <p>{empty}</p>}</>;
  return <section className="panel" id="people" aria-labelledby="people-title">
    <h2 id="people-title">People</h2>
    <p className="panel-lede">Adding someone sends them the official FairShift invite. They’re active once they’ve signed up themselves; only active people can be offered shifts or manage a location.</p>
    {owner ? table("Managers", managers, "No managers yet. You can run a location yourself.") : null}
    {table("Casual workers", casual, "No casual workers yet.")}
    {regular.length ? <details className="disclosure-inline"><summary>Regular staff records · {regular.length}</summary><ul>{regular.map(person => <li key={person.key}>{person.name} · {person.locations.map(place => place.name).join(", ")}</li>)}</ul></details> : null}
    {disabled ? null : <details className="disclosure" open={!people.length}><summary>Add a person</summary>
      <form action={addPersonAction} className="workspace-form form-grid">
        {owner ? <label>Role<select name="role" defaultValue="TEAM_MEMBER"><option value="TEAM_MEMBER">Casual worker</option><option value="MANAGER">Manager</option></select></label> : <input type="hidden" name="role" value="TEAM_MEMBER" />}
        <label>First name<input name="firstName" maxLength={100} required /></label>
        <label>Surname<input name="surname" maxLength={100} required /></label>
        <label>Email<input name="email" type="email" maxLength={254} required /></label>
        <label>Phone (optional)<input name="telephone" type="tel" maxLength={30} /></label>
        {owner ? <fieldset className="form-span"><legend>Work location(s)</legend>{locations.map(place => <label className="acceptance-check" key={place.id}><input type="checkbox" name="locationIds" value={place.id} defaultChecked={place.id === currentLocationId} /> {place.name}</label>)}<small>A casual worker belongs to one location; a Manager can look after several.</small></fieldset>
          : <p className="form-span note">They join {locations.find(place => place.id === currentLocationId)?.name ?? "this location"}.</p>}
        <p className="form-span note">No home address is needed. They choose their own password, and casual workers add their availability and PayPal email when they sign up.</p>
        <button className="primary-button">Add and send invite</button>
      </form></details>}
  </section>;
}
