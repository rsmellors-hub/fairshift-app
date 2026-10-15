import Link from "next/link";
import { SecureLinkForm } from "@/app/components/secure-link-form";
import { redeemInvitationAction } from "@/app/auth-actions";
export default async function Invite({searchParams}:{searchParams:Promise<{status?:string}>}) {
 return <main className="centered-shell"><h1>Join your FairShift organisation</h1><p>Sign in or create your own identity with the invited email, then redeem this invitation. Your role and location are assigned by the invitation.</p>{(await searchParams).status === "error" ? <p role="alert">Invitation unavailable, expired, already used, or for a different email.</p>:null}<p><Link href="/sign-in">Sign in</Link> · <Link href="/register">Create identity</Link></p><SecureLinkForm action={redeemInvitationAction} kind="invitation"/></main>;
}
