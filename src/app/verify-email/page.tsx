import { SecureLinkForm } from "@/app/components/secure-link-form";
import { verifyEmailAction } from "@/app/auth-actions";
export default async function VerifyEmail({searchParams}:{searchParams:Promise<{status?:string}>}) {
 return <main className="centered-shell"><h1>Verify your email</h1>{(await searchParams).status === "error" ? <p role="alert">Link expired or unavailable.</p>:null}<SecureLinkForm action={verifyEmailAction} kind="verify"/></main>;
}
