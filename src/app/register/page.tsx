import Link from "next/link";
import { registerAction } from "@/app/auth-actions";
export default async function Register({searchParams}:{searchParams:Promise<{status?:string}>}) {
 const {status}=await searchParams;
 return <main className="centered-shell"><h1>Create your FairShift identity</h1><p>Owners create organisations. Managers and Team Members join through an invitation.</p>{status === "error" ? <p role="alert">Registration could not be completed. Check your details or sign in if you already have an account.</p>:null}<form action={registerAction} className="workspace-form"><label>Your name<input name="name" maxLength={150} required autoComplete="name" /></label><label>Email<input name="email" type="email" required autoComplete="email" /></label><label>Password · at least 12 characters<input name="password" type="password" minLength={12} maxLength={128} required autoComplete="new-password" /></label><button className="primary-button">Create identity</button></form><Link href="/sign-in">Sign in</Link></main>;
}
