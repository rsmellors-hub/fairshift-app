import type { Metadata } from "next";
import Link from "next/link";
import { signInAction, requestResetAction } from "@/app/auth-actions";
import { AuthShell } from "@/app/components/auth-shell";
import { PasswordField } from "@/app/components/password-field";

export const metadata: Metadata = { title: "Sign in" };

const NOTICE: Record<string, string> = {
  verified: "Email verified. Sign in to continue on this browser.",
  "reset-requested": "If that email has an account, we’ve sent a password reset link.",
  "password-reset": "Your password has been changed. Sign in with your new password.",
};

export default async function SignIn({ searchParams }: { searchParams: Promise<{ status?: string; next?: string }> }) {
  const { status, next } = await searchParams;
  const invited = next === "invite";
  return <AuthShell title="Sign in to FairShift">
    {status === "error" ? <p className="form-alert" role="alert">That email or password wasn’t accepted, or there have been too many attempts. Try again shortly.</p> : null}
    {status && NOTICE[status] ? <p className="form-notice" role="status">{NOTICE[status]}</p> : null}
    <form action={signInAction} className="stack-form">
      {invited ? <input type="hidden" name="next" value="invite" /> : null}
      <label>Email<input name="email" type="email" required autoComplete="email" /></label>
      <PasswordField label="Password" autoComplete="current-password" />
      <button className="primary-button">Sign in</button>
    </form>
    <details className="auth-disclosure"><summary>Forgotten your password?</summary>
      <form action={requestResetAction} className="stack-form">
        <label>Email<input name="email" type="email" required autoComplete="email" /></label>
        <button className="secondary-button">Send reset link</button>
      </form>
    </details>
    <p className="auth-switch">New to FairShift? <Link href={invited ? "/register?next=invite" : "/register"}>Create an account</Link></p>
  </AuthShell>;
}
