import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { AuthShell } from "@/app/components/auth-shell";
import { SecureLinkForm } from "@/app/components/secure-link-form";
import { completeInvitationAction, openInvitationAction } from "@/app/people-actions";
import { currentIdentity } from "@/server/auth/request";
import { getDatabase } from "@/server/db/client";
import { openInvitation, type OpenInvitation } from "@/server/people/sign-up";

export const metadata: Metadata = { title: "Join your team" };
export const dynamic = "force-dynamic";

const MESSAGES: Record<string, string> = {
  "invitation-unavailable": "That invitation has expired, was already used, or was revoked. Ask the person who invited you to send a new one.",
  "invitation-email": "This invitation was sent to a different email. Sign out and sign in, or create an account, with the invited email.",
  "sign-up-details": "Check the highlighted details and try again.",
  "payout-email-mismatch": "The two PayPal email addresses don’t match.",
  "payout-email-invalid": "Enter a valid PayPal email.",
  error: "Something went wrong. Nothing was changed. Try again.",
};
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

// Joining by invitation (Day 6, Owner decision 10 Nov 2026): sign in or create an account with the
// invited email; open the invitation; then confirm your details (casual workers also give availability
// and their PayPal email). Only then are you active. The code from the email link stays out of URLs.
export default async function Invite({ searchParams }: { searchParams: Promise<{ status?: string; step?: string }> }) {
  const { status, step } = await searchParams;
  const identity = await currentIdentity();
  const demo = !!identity?.session.demoPersona;
  const alert = status ? <p className="form-alert" role="alert">{MESSAGES[status] ?? MESSAGES.error}</p> : null;
  if (!identity || demo) return <AuthShell title="Join your team on FairShift">{alert}
    <p>Create your account, or sign in, with the email your invitation was sent to. You’ll come straight back here to finish joining.</p>
    <SecureLinkForm kind="invitation" remember />
    <div className="button-row"><Link className="primary-button button-link" href="/register?next=invite">Create an account</Link><Link className="secondary-button button-link" href="/sign-in?next=invite">Sign in</Link></div>
  </AuthShell>;
  let invitation: OpenInvitation | null = null;
  const token = (await cookies()).get("fairshift_invite")?.value;
  if (step === "details" && token) { try { invitation = await openInvitation(getDatabase(), identity.user, token); } catch { invitation = null; } }
  if (!invitation) return <AuthShell title="Join your team on FairShift">{alert}
    <p>Signed in as <strong>{identity.user.email}</strong>. Open your invitation to see who invited you and finish joining.</p>
    <SecureLinkForm action={openInvitationAction} kind="invitation" />
  </AuthShell>;
  const worker = invitation.role === "TEAM_MEMBER";
  return <AuthShell title={`Join ${invitation.business || "your team"} on FairShift`}>{alert}
    <p>You’re joining as {worker ? "a casual worker" : "a Manager"} at <strong>{invitation.locations.join(", ")}</strong>. Confirm your details to finish.{worker ? " You’ll be offered shifts once you’ve joined." : ""}</p>
    <form action={completeInvitationAction} className="stack-form">
      <label>First name<input name="firstName" defaultValue={invitation.firstName} maxLength={100} required autoComplete="given-name" /></label>
      <label>Surname<input name="surname" defaultValue={invitation.surname} maxLength={100} required autoComplete="family-name" /></label>
      <label>Phone (optional)<input name="telephone" type="tel" defaultValue={invitation.telephone} maxLength={30} autoComplete="tel" /></label>
      {worker ? <>
        <fieldset><legend>When can you usually work?</legend>{DAYS.map((name, i) => <label key={name}>{name}<select name={`day${i + 1}`} defaultValue="AVAILABLE" required><option value="AVAILABLE">Available</option><option value="UNAVAILABLE">Not available</option></select></label>)}<small>You can change this any time in your profile.</small></fieldset>
        <label>PayPal email you’re paid at<input name="payoutEmail" type="email" maxLength={254} required /></label>
        <label>Type it again<input name="confirmPayoutEmail" type="email" maxLength={254} required autoComplete="off" /></label>
        <p className="note">FairShift hasn’t checked this email with PayPal, so make sure it’s right. Changing it later needs your password.</p>
      </> : null}
      <button className="primary-button">Join {invitation.business || "your team"}</button>
    </form>
  </AuthShell>;
}
