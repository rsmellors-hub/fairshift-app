import type { Metadata } from "next";
import { AuthShell } from "@/app/components/auth-shell";
import { SecureLinkForm } from "@/app/components/secure-link-form";
import { resetPasswordAction } from "@/app/auth-actions";

export const metadata: Metadata = { title: "Reset your password" };

export default async function ResetPassword({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  return <AuthShell title="Reset your password">
    {(await searchParams).status === "error" ? <p className="form-alert" role="alert">That link has expired or was already used. Request a new one from the sign-in page.</p> : null}
    <SecureLinkForm action={resetPasswordAction} kind="reset" password />
  </AuthShell>;
}
