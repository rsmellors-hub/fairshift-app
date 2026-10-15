import Link from "next/link";
import { signInAction, requestResetAction } from "@/app/auth-actions";
export default async function SignIn({searchParams}:{searchParams:Promise<{status?:string}>}) {
 const {status}=await searchParams;
 return <main className="centered-shell"><h1>Sign in to FairShift</h1>{status === "error" ? <p role="alert">Email or password was not accepted, or attempts are temporarily limited.</p>:null}{status === "reset-requested" ? <p>If an account exists and email delivery is available, a reset link has been requested.</p>:null}<form action={signInAction} className="workspace-form"><label>Email<input name="email" type="email" required autoComplete="email" /></label><label>Password<input name="password" type="password" required maxLength={128} autoComplete="current-password" /></label><button className="primary-button">Sign in</button></form><Link href="/register">Create an identity</Link><details><summary>Reset password</summary><form action={requestResetAction} className="workspace-form"><label>Email<input name="email" type="email" required /></label><button className="secondary-button">Request reset link</button></form></details></main>;
}
