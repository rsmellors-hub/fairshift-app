import type { Metadata } from "next";
import Link from "next/link";
import { registerAction } from "@/app/auth-actions";
import { AcquisitionProgress } from "@/app/components/acquisition-progress";
import { AuthShell } from "@/app/components/auth-shell";
import { PasswordField } from "@/app/components/password-field";

export const metadata: Metadata = { title: "Create your account" };

export default async function Register({ searchParams }: { searchParams: Promise<{ status?: string; next?: string }> }) {
  const { status, next } = await searchParams;
  const invited = next === "invite";
  return <AuthShell title={invited ? "Create your account to join your team" : "Start your business on FairShift"} progress={invited ? undefined : <AcquisitionProgress current="Account" />}>
    {status === "error" ? <p className="form-alert" role="alert">We couldn’t create that account. Check your details, or sign in if you already have one.</p> : null}
    <form action={registerAction} className="stack-form">
      {invited ? <input type="hidden" name="next" value="invite" /> : null}
      <label>Email<input name="email" type="email" required autoComplete="email" /></label>
      <PasswordField label="Password" autoComplete="new-password" minLength={12} hint="At least 12 characters" />
      <button className="primary-button">Create account</button>
    </form>
    <p className="auth-switch">Already have an account? <Link href={invited ? "/sign-in?next=invite" : "/sign-in"}>Sign in</Link></p>
    {invited ? <p className="auth-switch">Use the email your invitation was sent to.</p> : <p className="auth-switch">Joining a team? Use the link in your invitation email.</p>}
  </AuthShell>;
}
