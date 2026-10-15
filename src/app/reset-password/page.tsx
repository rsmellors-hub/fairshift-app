import { SecureLinkForm } from "@/app/components/secure-link-form";
import { resetPasswordAction } from "@/app/auth-actions";
export default async function ResetPassword({searchParams}:{searchParams:Promise<{status?:string}>}) {
 return <main className="centered-shell"><h1>Reset your password</h1>{(await searchParams).status === "error" ? <p role="alert">Link expired or unavailable.</p>:null}<SecureLinkForm action={resetPasswordAction} kind="reset" password/></main>;
}
