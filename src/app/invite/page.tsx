import type { Metadata } from "next";
import Link from "next/link";
import { AuthShell } from "@/app/components/auth-shell";
import { SecureLinkForm } from "@/app/components/secure-link-form";
import { redeemInvitationAction } from "@/app/auth-actions";
import { currentIdentity } from "@/server/auth/request";

export const metadata: Metadata = { title: "Join your team" };
export const dynamic = "force-dynamic";

// The invitation code stays in this browser, so signing in or registering first doesn't lose it.
export default async function Invite({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const identity = await currentIdentity();
  const demo = !!identity?.session.demoPersona;
  return <AuthShell title="Join your team on FairShift">
    {(await searchParams).status === "error" ? <p className="form-alert" role="alert">That invitation has expired, was already used, or is for a different email.</p> : null}
    {identity && !demo ? <>
      <p>Signed in as <strong>{identity.user.email}</strong>. Your role and location come from the invitation.</p>
      <SecureLinkForm action={redeemInvitationAction} kind="invitation" />
    </> : <>
      <p>Sign in, or create an account, with the email your invitation was sent to. You’ll come straight back here.</p>
      <SecureLinkForm kind="invitation" remember />
      <div className="button-row"><Link className="primary-button button-link" href="/register?next=invite">Create an account</Link><Link className="secondary-button button-link" href="/sign-in?next=invite">Sign in</Link></div>
    </>}
  </AuthShell>;
}
