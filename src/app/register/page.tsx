import Link from "next/link";
import { registerAction } from "@/app/auth-actions";
export default async function Register({searchParams}:{searchParams:Promise<{status?:string}>}) {
 const {status}=await searchParams;
 return <main className="centered-shell registration-shell"><h1>Create your FairShift account</h1><p>Set up a business, or join your team with an invitation.</p>{status === "error" ? <p role="alert">Registration could not be completed. Check your details or sign in if you already have an account.</p>:null}<form action={registerAction} className="workspace-form registration-form"><label>Email<input name="email" type="email" required autoComplete="email" /></label><label>Password · at least 12 characters<input name="password" type="password" minLength={12} maxLength={128} required autoComplete="new-password" /></label><button className="primary-button">Create account</button></form><Link href="/sign-in">Sign in</Link></main>;
}
