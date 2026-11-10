import Link from "next/link";
import { StatusBadge } from "@/app/components/product-ui";
import { resendInvitationAction, revokeInvitationAction } from "@/app/auth-actions";
import { addPersonAction, deactivatePersonAction, removeFromLocationAction, updatePersonAction } from "@/app/people-actions";
import { PERSON_STATUS_LABEL, type Person, type PersonStatus } from "@/server/people/people";

// "Team at {location}" (design: OwnerLocation, 10 Nov 2026). Everyone who can be offered or manage
// shifts here, with each casual worker's hours and the regular-hours alert. Adding someone sends the
// official invitation; they're active once they've signed up. Removing someone from this location keeps
// their history; Deactivate stops them working at every location. Server-checked throughout.

export const TEAM_FILTERS = { everyone: "Everyone", managers: "Managers", casual: "Casual", permanent: "Permanent", invited: "Invited", deactivated: "Deactivated" } as const;
export type TeamFilter = keyof typeof TEAM_FILTERS;
const TONE: Record<PersonStatus, "success" | "warning" | "neutral" | "danger"> = { ACTIVE: "success", INVITED: "warning", INVITE_EXPIRED: "danger", INVITE_REVOKED: "neutral", DEACTIVATED: "neutral" };
const ROLE = { MANAGER: "Manager", TEAM_MEMBER: "Casual", REGULAR: "Permanent" } as const;
const hours = (minutes: number) => `${Math.round((minutes / 60) * 10) / 10} h / wk`;
const day = (date: Date, timezone: string) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: timezone }).format(date);

function matches(person: Person, filter: TeamFilter) {
  switch (filter) {
    case "managers": return person.role === "MANAGER";
    case "casual": return person.role === "TEAM_MEMBER";
    case "permanent": return person.role === "REGULAR";
    case "invited": return person.status === "INVITED" || person.status === "INVITE_EXPIRED";
    case "deactivated": return person.status === "DEACTIVATED" || person.status === "INVITE_REVOKED";
    default: return person.status !== "DEACTIVATED" && person.status !== "INVITE_REVOKED";
  }
}

export function LocationTeam({ people, location, otherLocations, owner, filter, basePath, timezone, disabled, previewHref }: {
  people: Person[]; location: { id: string; name: string }; otherLocations: { id: string; name: string }[]; owner: boolean;
  filter: TeamFilter; basePath: string; timezone: string; disabled?: boolean; previewHref: string;
}) {
  const shown = people.filter(person => matches(person, filter));
  const active = people.filter(person => person.status === "ACTIVE").length;
  const row = (person: Person) => {
    const [first = "", ...rest] = person.name.split(" ");
    const elsewhere = person.locations.filter(place => place.id !== location.id).map(place => place.name);
    const invitationOpen = !!person.invitationId && (person.status === "INVITED" || person.status === "INVITE_EXPIRED");
    const editable = person.role !== "REGULAR" && person.status !== "DEACTIVATED" && person.status !== "INVITE_REVOKED";
    const deactivatable = ((person.role === "TEAM_MEMBER" && !!person.workerId) || (person.role === "MANAGER" && owner)) && person.status === "ACTIVE";
    const removable = person.status === "ACTIVE" && ((person.role === "TEAM_MEMBER" && person.locations.length > 1) || (person.role === "MANAGER" && owner && person.locations.length > 1));
    return <tr key={person.key}>
      <th scope="row">{person.name}<small>{[person.wantsMoreHours ? "Wants more hours" : null, elsewhere.length ? `also ${elsewhere.join(", ")}` : null, person.email].filter(Boolean).join(" · ")}</small></th>
      <td data-label="Role">{ROLE[person.role]}</td>
      <td data-label="Status"><StatusBadge tone={TONE[person.status]}>{PERSON_STATUS_LABEL[person.status]}</StatusBadge>{invitationOpen && person.invitationExpiresAt ? <small>{person.status === "INVITE_EXPIRED" ? "Expired" : "Link expires"} {day(person.invitationExpiresAt, timezone)}</small> : null}</td>
      <td data-label="Hours · avg">{person.weeklyAverageMinutes === null ? "—" : <>{hours(person.weeklyAverageMinutes)}{person.hoursAlert ? <> <StatusBadge tone="warning">Alert</StatusBadge></> : null}</>}</td>
      <td data-label="Manage">{disabled ? null : <details className="disclosure-inline"><summary>Edit</summary>
        {editable ? <form action={updatePersonAction} className="workspace-form form-grid"><input type="hidden" name="key" value={person.key} /><input type="hidden" name="next" value={basePath} />
          <label>First name<input name="firstName" defaultValue={first} maxLength={100} required /></label>
          <label>Surname<input name="surname" defaultValue={rest.join(" ")} maxLength={100} required /></label>
          <label>Mobile (optional)<input name="telephone" type="tel" defaultValue={person.telephone ?? ""} maxLength={30} /></label>
          {person.status !== "ACTIVE" ? <label>Email<input name="email" type="email" defaultValue={person.email ?? ""} maxLength={254} required /><small>Send a new invite after changing it.</small></label> : <p className="note">Their email is how they sign in, so only they can change it.</p>}
          <button className="secondary-button">Save details</button></form> : null}
        {invitationOpen ? <div className="button-row">
          <form action={resendInvitationAction}><input type="hidden" name="invitationId" value={person.invitationId!} /><input type="hidden" name="next" value={basePath} /><button className="secondary-button">{person.status === "INVITE_EXPIRED" ? "Send a new invite" : "Resend invite"}</button></form>
          <form action={revokeInvitationAction}><input type="hidden" name="invitationId" value={person.invitationId!} /><input type="hidden" name="next" value={basePath} /><button className="secondary-button">Revoke invite</button></form></div> : null}
        {deactivatable ? <form action={deactivatePersonAction} className="workspace-form"><input type="hidden" name="key" value={person.key} /><input type="hidden" name="next" value={basePath} />
          <label className="acceptance-check"><input type="checkbox" name="confirm" value="yes" required /> Deactivate {person.name}: {person.role === "MANAGER" ? "they lose access to this business’s locations" : "they stop working at every location and open offers are withdrawn"}. Records are kept.</label>
          <button className="secondary-button">Deactivate</button></form> : null}
      </details>}
        {removable && !disabled ? <form action={removeFromLocationAction}><input type="hidden" name="key" value={person.key} /><input type="hidden" name="locationId" value={location.id} /><input type="hidden" name="next" value={basePath} /><button className="link-button">Remove from {location.name}</button></form> : null}</td>
    </tr>;
  };
  return <details className="panel disclosure location-section" id="team" open>
    <summary><span className="h4">Team at {location.name} · {active}</span></summary>
    <p className="panel-lede">Everyone who can be offered or manage shifts here.</p>
    <form method="get" action={basePath} className="filter-row"><label>Show<select name="team" defaultValue={filter}>{Object.entries(TEAM_FILTERS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><button className="secondary-button">Filter</button></form>
    {shown.length ? <div className="table-frame"><table className="data-table"><caption className="visually-hidden">Team at {location.name}</caption><thead><tr><th scope="col">Name</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Hours · avg</th><th scope="col">Manage</th></tr></thead><tbody>{shown.map(row)}</tbody></table></div>
      : <p>{filter === "everyone" ? "Nobody here yet. Add your first team member below." : `No one matches “${TEAM_FILTERS[filter]}”.`}</p>}
    <p className="note">Removing someone from {location.name} keeps their history and pay records. Deactivate (under Edit) stops someone working at every location; invited and deactivated people show in the filter.</p>
    {disabled ? null : <details className="disclosure" id="add-team-member" open={!people.length}><summary>+ Add team member</summary>
      <form action={addPersonAction} className="workspace-form form-grid"><input type="hidden" name="next" value={basePath} /><input type="hidden" name="locationIds" value={location.id} />
        <label>First name<input name="firstName" maxLength={100} required autoComplete="off" /></label>
        <label>Surname<input name="surname" maxLength={100} required autoComplete="off" /></label>
        <label>Email<input name="email" type="email" maxLength={254} required autoComplete="off" /></label>
        <label>Mobile (optional)<input name="telephone" type="tel" maxLength={30} autoComplete="off" /></label>
        {owner ? <label>Role<select name="role" defaultValue="TEAM_MEMBER"><option value="TEAM_MEMBER">Casual worker</option><option value="MANAGER">Manager</option></select></label> : <input type="hidden" name="role" value="TEAM_MEMBER" />}
        {owner && otherLocations.length ? <details className="disclosure-inline form-span"><summary>Also works at other locations (optional)</summary>{otherLocations.map(place => <label className="acceptance-check" key={place.id}><input type="checkbox" name="locationIds" value={place.id} /> {place.name}</label>)}</details> : null}
        <p className="form-span note">We’ll email an official FairShift invitation. They become active once they confirm their email and finish signing up. No home address is needed. <Link href={previewHref} target="_blank">Preview the invitation email</Link></p>
        <button className="primary-button">Add and send invitation</button>
      </form></details>}
  </details>;
}
