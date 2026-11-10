"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "@/app/revalidate";
import { requireIdentity, requireScope, selectMembership } from "@/server/auth/request";
import { membershipDestination } from "@/server/auth/destination";
import { inviteMember } from "@/server/auth/tenancy";
import { setLocationActive, updateLocation } from "@/server/billing/locations";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { UserFacingError } from "@/server/domain/errors";
import { dispatchNotification } from "@/server/notifications/service";
import { getEmailAdapter } from "@/server/notifications/email";
import { deactivatePerson, updatePerson } from "@/server/people/people";
import { removeFromLocation } from "@/server/people/worker-locations";
import { completeInvitedSignUp, openInvitation } from "@/server/people/sign-up";

// People and places (Day 6, Owner decision 10 Nov 2026). Every write is server-checked: the Owner acts on
// the whole business; a Manager only on casual workers at their own location. Closed to the public demo.

const field = (form: FormData, name: string) => String(form.get(name) ?? "");
const feedback = (error: unknown) => error instanceof UserFacingError ? error.feedback : "error";
// Back to the page the person acted on: a location's Team, or the Manager's team page.
const safeNext = (form: FormData) => { const next = String(form.get("next") ?? ""); return /^\/(owner\/locations\/[0-9a-f-]{36}|manager\/team)$/.test(next) ? next : null; };
const pathFor = (role: string, form?: FormData) => (form && safeNext(form)) ?? (role === "OWNER" ? "/owner/locations" : "/manager/team");
function refresh() { for (const role of ["owner", "manager", "worker"]) revalidatePath(`/${role}`, "layout"); }

export async function addPersonAction(form: FormData) {
  const scope = await requireScope(["OWNER", "MANAGER"]);
  const path = pathFor(scope.role, form);
  let outcome = "person-invited";
  if (!getConfigurationStatus().databaseConfigured) redirect(`${path}?status=error`);
  try {
    const role = field(form, "role") === "MANAGER" ? "MANAGER" : "TEAM_MEMBER";
    const locationIds = form.getAll("locationIds").map(String).filter(Boolean);
    const result = await inviteMember(getDatabase(), scope, { role, email: field(form, "email"), firstName: field(form, "firstName"), surname: field(form, "surname"), telephone: field(form, "telephone"),
      ...(locationIds.length ? { locationIds } : {}) });
    // The official invite email goes at once; the outbox keeps the record whatever the provider says.
    await dispatchNotification(getDatabase(), getEmailAdapter(), result.notificationId, `/invite#${result.token}`);
  } catch (error) { outcome = feedback(error); }
  refresh();
  redirect(`${path}?status=${outcome}#team`);
}

export async function updatePersonAction(form: FormData) {
  const scope = await requireScope(["OWNER", "MANAGER"]);
  const path = pathFor(scope.role, form);
  let outcome = "person-updated";
  try {
    const email = field(form, "email");
    const result = await updatePerson(getDatabase(), scope, field(form, "key"), { firstName: field(form, "firstName"), surname: field(form, "surname"), telephone: field(form, "telephone"), ...(email ? { email } : {}) });
    if (result.emailChanged) outcome = "person-email-changed";
  } catch (error) { outcome = feedback(error); }
  refresh();
  redirect(`${path}?status=${outcome}#team`);
}

export async function deactivatePersonAction(form: FormData) {
  const scope = await requireScope(["OWNER", "MANAGER"]);
  const path = pathFor(scope.role, form);
  let outcome = "person-deactivated";
  try {
    if (field(form, "confirm") !== "yes") throw new UserFacingError("person-confirm", "Confirm the deactivation.");
    await deactivatePerson(getDatabase(), scope, field(form, "key"));
  } catch (error) { outcome = feedback(error); }
  refresh();
  redirect(`${path}?status=${outcome}#team`);
}

export async function removeFromLocationAction(form: FormData) {
  const scope = await requireScope(["OWNER", "MANAGER"]);
  const path = pathFor(scope.role, form);
  let outcome = "person-removed";
  try { await removeFromLocation(getDatabase(), scope, field(form, "key"), field(form, "locationId")); } catch (error) { outcome = feedback(error); }
  refresh();
  redirect(`${path}?status=${outcome}#team`);
}

export async function updateLocationAction(form: FormData) {
  const scope = await requireScope(["OWNER"]);
  const id = field(form, "locationId");
  let outcome = "location-updated";
  try { await updateLocation(getDatabase(), scope, id, { name: field(form, "name"), address: field(form, "address"), city: field(form, "city"), province: field(form, "province"), postalCode: field(form, "postalCode") }); }
  catch (error) { outcome = feedback(error); }
  refresh();
  redirect(`/owner/locations/${id}?status=${outcome}#venue`);
}

export async function setLocationActiveAction(form: FormData) {
  const scope = await requireScope(["OWNER"]);
  const active = field(form, "active") === "yes";
  let outcome = active ? "location-reactivated" : "location-deactivated";
  try {
    if (!active && field(form, "confirm") !== "yes") throw new UserFacingError("location-confirm", "Confirm the deactivation.");
    await setLocationActive(getDatabase(), scope, field(form, "locationId"), active);
  } catch (error) { outcome = error instanceof UserFacingError ? error.feedback : error instanceof Error && /plan allows/.test(error.message) ? "location-plan-limit" : "error"; }
  (await cookies()).delete("fairshift_location");
  refresh();
  redirect(`/owner/locations?status=${outcome}`);
}

// Invited sign-up, step 1: the code from the email link (kept out of URLs) is held in a short-lived,
// HTTP-only cookie while the person completes their details.
const INVITE_COOKIE = "fairshift_invite";
export async function openInvitationAction(form: FormData) {
  const { user } = await requireIdentity();
  const token = field(form, "token");
  try { await openInvitation(getDatabase(), user, token); }
  catch (error) { redirect(`/invite?status=${feedback(error)}`); }
  (await cookies()).set(INVITE_COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 60 * 60 });
  redirect("/invite?step=details");
}

// Step 2: name and contact details; for a casual worker also availability and PayPal email. Only now is
// the invitation redeemed and the person active.
export async function completeInvitationAction(form: FormData) {
  const { user } = await requireIdentity();
  const jar = await cookies();
  const token = jar.get(INVITE_COOKIE)?.value ?? "";
  let membershipId: string;
  try {
    const availability = Array.from({ length: 7 }, (_, i) => field(form, `day${i + 1}`));
    const membership = await completeInvitedSignUp(getDatabase(), user, token, { firstName: field(form, "firstName"), surname: field(form, "surname"), telephone: field(form, "telephone"),
      availability, payoutEmail: field(form, "payoutEmail"), confirmPayoutEmail: field(form, "confirmPayoutEmail") });
    membershipId = membership.id;
  } catch (error) { redirect(`/invite?step=details&status=${feedback(error)}`); }
  jar.delete(INVITE_COOKIE);
  jar.delete("fairshift_location");
  const member = await selectMembership(membershipId);
  refresh();
  redirect(await membershipDestination(member));
}
