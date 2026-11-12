import type { Metadata } from "next";
import Link from "next/link";
import { registerAction } from "@/app/auth-actions";
import { AcquisitionProgress } from "@/app/components/acquisition-progress";
import { AuthShell } from "@/app/components/auth-shell";
import { PasswordField } from "@/app/components/password-field";

export const metadata: Metadata = { title: "Create your account" };

// Step 1 of 6 (design: SignUp, 10 Nov 2026). An invited person signs up with only email and password and
// completes their details on their invitation.
export default async function Register({ searchParams }: { searchParams: Promise<{ status?: string; next?: string }> }) {
  const { status, next } = await searchParams;
  const invited = next === "invite";
  // Design (SignUp): beside the form, what setup involves, in the app's own order (Plan is step 2).
  const aside = invited ? undefined : <>
    <p className="auth-aside-title">Thirty days free. Set up in about ten minutes.</p>
    <ol className="auth-aside-steps">
      <li><span>01</span>Create your account and business</li>
      <li><span>02</span>Choose your plan and approve it in PayPal</li>
      <li><span>03</span>Add your first venue by its address</li>
      <li><span>04</span>Add sales history, your pay terms and your team</li>
    </ol>
    <p className="auth-aside-note">This deployment uses PayPal Sandbox. No real money moves.</p></>;
  return <AuthShell title={invited ? "Create your account to join your team" : "Create your account"} eyebrow={invited ? undefined : "Step 1 of 6 · Account"} aside={aside} progress={invited ? undefined : <AcquisitionProgress current="Account" />}>
    {status === "error" ? <p className="form-alert" role="alert">We couldn’t create that account. Check your details and that you’ve agreed to the terms, or sign in if you already have an account.</p> : null}
    {invited ? null : <p className="auth-switch auth-switch-top">Already using FairShift? <Link href="/sign-in">Sign in</Link></p>}
    {invited ? null : <p className="note auth-sandbox-phone">Thirty days free. This deployment uses PayPal Sandbox: no real money moves.</p>}
    <form action={registerAction} className="stack-form">
      {invited ? <input type="hidden" name="next" value="invite" /> : <label>Your name<input name="name" required maxLength={200} autoComplete="name" /></label>}
      <label>{invited ? "Email" : "Work email"}<input name="email" type="email" required autoComplete="email" />{invited ? null : <small>We’ll send a link to confirm it.</small>}</label>
      <PasswordField label="Password" autoComplete="new-password" minLength={12} hint="At least 12 characters" />
      {invited ? null : <>
        <label>Business name<input name="businessName" required maxLength={150} autoComplete="organization" /></label>
        <label>Country<select name="country" defaultValue="South Africa"><option>South Africa</option><option>United Kingdom</option><option>Other</option></select>
          <small>Sets your currency, the minimum-wage check and public holidays.</small></label>
        <label>If other, which country?<input name="otherCountry" maxLength={100} /></label>
        <label className="acceptance-check"><input type="checkbox" name="terms" value="yes" required /> <span>I agree to the <Link href="/faq#terms">terms</Link> and <Link href="/faq#privacy">privacy notice</Link>.</span></label>
      </>}
      <button className="primary-button">Create account</button>
    </form>
    {invited ? <p className="auth-switch">Already using FairShift? <Link href="/sign-in?next=invite">Sign in</Link></p> : null}
    {invited ? <p className="auth-switch">Use the email your invitation was sent to.</p> : <p className="auth-switch">Joining a team? Use the link in your invitation email.</p>}
  </AuthShell>;
}
